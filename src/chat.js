// Chat engine — drives Claude Code through the official Agent SDK
// (@anthropic-ai/claude-agent-sdk) in headless streaming mode, and turns its
// events into high-level chat events for the UI. One ChatSession owns one
// long-lived SDK query for the active account.
//
// Why the SDK (not the bare CLI): interactive per-tool permission prompts
// ("ask each time") require the can_use_tool handshake that the SDK performs.
// The SDK also gives token streaming, session resume, and works with the
// user's *subscription* login via CLAUDE_CONFIG_DIR (no API key needed —
// verified: apiKeySource "none").
//
// onEvent payloads (plain data, forwarded to the renderer):
//   { type:'ready', sessionId, model }
//   { type:'assistant_delta', text }        incremental token
//   { type:'assistant_text', text }         final text block (reconcile)
//   { type:'thinking', text }
//   { type:'tool_use', id, name, input }
//   { type:'tool_result', id, isError, text }
//   { type:'permission', requestId, tool, input }
//   { type:'turn_end', usage, costUsd, sessionId }
//   { type:'limit', text, resetAt }
//   { type:'auth_failed' }
//   { type:'error', text }
//   { type:'exit' }

// File-mutating tools that "Auto-accept edits" mode approves without asking.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update', 'ApplyPatch']);

let sdkPromise = null;
let permCounter = 0; // globally-unique permission request ids across all sessions
function loadSdk() {
  // The SDK is ESM; load it from CommonJS via dynamic import (cached).
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

function extractResetAt(text, now = Date.now()) {
  const m = String(text).match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return 0;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  const d = new Date(now);
  d.setHours(hour, min, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 3600e3;
  return t;
}

function classifyError(text) {
  const s = String(text || '');
  if (/not logged in|authentication_failed|please run \/login|invalid api key/i.test(s)) return 'auth';
  if (/limit/i.test(s)) return 'limit';
  return 'error';
}

class ChatSession {
  constructor({ claudePath, configDir, cwd, model, effort, resumeId, permissionMode, approvalMode, onEvent }) {
    this.claudePath = claudePath;
    this.configDir = configDir;
    this.cwd = cwd;
    this.model = model || '';
    this.effort = effort || '';
    this.resumeId = resumeId || '';
    this.permissionMode = permissionMode || 'default';
    // How to answer tool-permission requests:
    //   'ask'          — prompt the user for every tool (default, safest)
    //   'acceptEdits'  — auto-allow file edits, prompt for the rest
    //   'bypass'       — auto-allow everything, never prompt
    this.approvalMode = approvalMode || 'ask';
    this.onEvent = onEvent || (() => {});
    this.q = null;
    this.alive = false;
    this.busy = false;
    this.sessionId = '';
    this._queue = [];
    this._wake = null;
    this._ended = false;
    this._perms = new Map();
    this._permSeq = 0;
    this._sawError = false;
  }

  async start() {
    const self = this;
    // Mark alive synchronously so messages queued before the (async) SDK import
    // finishes are held and delivered, rather than dropped.
    this.alive = true;
    this._ended = false;

    let query;
    try {
      ({ query } = await loadSdk());
    } catch (e) {
      this.alive = false;
      this.onEvent({ type: 'error', text: 'Could not load Claude engine: ' + (e.message || e) });
      this.onEvent({ type: 'exit' });
      return;
    }

    async function* input() {
      while (!self._ended) {
        if (self._queue.length) {
          yield self._queue.shift();
        } else {
          await new Promise((r) => { self._wake = r; });
        }
      }
    }

    const options = {
      cwd: this.cwd,
      includePartialMessages: true,
      permissionMode: this.permissionMode,
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: this.configDir, FORCE_COLOR: '0' }),
      canUseTool: (toolName, toolInput) => this._canUseTool(toolName, toolInput),
      stderr: () => {},
    };
    if (this.model) options.model = this.model;
    if (this.resumeId) options.resume = this.resumeId;
    if (this.claudePath) options.pathToClaudeCodeExecutable = this.claudePath;
    // Effort → extended-thinking budget. 'low'/'' leaves the model default.
    const THINK = { medium: 8000, high: 16000, ultra: 31999 };
    if (this.effort && THINK[this.effort]) options.maxThinkingTokens = THINK[this.effort];

    try {
      this.q = query({ prompt: input(), options });
    } catch (e) {
      this.alive = false;
      this.onEvent({ type: 'error', text: 'Could not start Claude: ' + (e.message || e) });
      return;
    }
    this._loop();
  }

  async _loop() {
    try {
      for await (const msg of this.q) this._handle(msg);
    } catch (e) {
      this._handleThrow(e);
    } finally {
      this.alive = false;
      this.busy = false;
      // Reject any dangling permission prompts so the UI doesn't hang.
      for (const [, p] of this._perms) { try { p.resolve({ behavior: 'deny', message: 'Session ended' }); } catch { /* noop */ } }
      this._perms.clear();
      this.onEvent({ type: 'exit' });
    }
  }

  send(text, attachments = []) {
    // Queue even before the SDK finishes loading; the input generator drains
    // the queue once the query starts. Only refuse after the session ended.
    if (this._ended) return false;
    this.busy = true;
    const fs = require('fs');
    const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const images = [];
    const fileNotes = [];
    for (const p of attachments || []) {
      try {
        const ext = String(p).split('.').pop().toLowerCase();
        if (IMG[ext]) {
          const data = fs.readFileSync(p).toString('base64');
          images.push({ type: 'image', source: { type: 'base64', media_type: IMG[ext], data } });
        } else {
          fileNotes.push(p);
        }
      } catch { /* skip unreadable attachment */ }
    }
    let textOut = String(text || '');
    if (fileNotes.length) textOut += (textOut ? '\n\n' : '') + fileNotes.map((f) => `[Attached file: ${f}]`).join('\n');
    // A plain string keeps the simple path fast; use blocks only when needed.
    const content = images.length ? [{ type: 'text', text: textOut }, ...images] : textOut;
    this._queue.push({ type: 'user', message: { role: 'user', content } });
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    return true;
  }

  _canUseTool(toolName, toolInput) {
    // Auto-approval modes skip the prompt entirely.
    if (this.approvalMode === 'bypass') return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
    if (this.approvalMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
    return new Promise((resolve) => {
      const id = 'perm_' + (++permCounter);
      this._perms.set(id, { resolve, input: toolInput });
      this.onEvent({ type: 'permission', requestId: id, tool: toolName, input: toolInput || {} });
    });
  }

  respondPermission(requestId, allow, message) {
    const p = this._perms.get(requestId);
    if (!p) return;
    this._perms.delete(requestId);
    p.resolve(allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: message || 'Denied by user' });
  }

  interrupt() {
    if (this.q && typeof this.q.interrupt === 'function') {
      this.q.interrupt().catch(() => {});
    }
  }

  stop() {
    this._ended = true;
    this.alive = false;
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    this.interrupt();
  }

  _handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id || this.sessionId;
          this.onEvent({ type: 'ready', sessionId: this.sessionId, model: msg.model });
        }
        break;
      case 'stream_event':
        this._handleStreamEvent(msg.event);
        break;
      case 'assistant':
        this._handleAssistant(msg.message || msg);
        break;
      case 'user':
        this._handleUser(msg.message || msg);
        break;
      case 'result':
        this._handleResult(msg);
        break;
      default:
        break;
    }
  }

  _handleStreamEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) {
        this.onEvent({ type: 'assistant_delta', text: ev.delta.text });
      } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
        this.onEvent({ type: 'thinking', text: ev.delta.thinking });
      }
    }
  }

  _handleAssistant(message) {
    if (!message || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        this.onEvent({ type: 'assistant_text', text: block.text });
      } else if (block.type === 'tool_use') {
        this.onEvent({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
      }
    }
  }

  _handleUser(message) {
    if (!message || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        let text = '';
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          text = block.content.map((c) => (c && c.type === 'text' ? c.text : '')).join('');
        }
        this.onEvent({ type: 'tool_result', id: block.tool_use_id, isError: !!block.is_error, text });
      }
    }
  }

  _handleResult(msg) {
    this.busy = false;
    if (msg.session_id) this.sessionId = msg.session_id;
    if (msg.is_error) {
      this._sawError = true;
      this._emitError(String(msg.result || ''));
      return;
    }
    this.onEvent({
      type: 'turn_end',
      usage: msg.usage || null,
      costUsd: msg.total_cost_usd || 0,
      sessionId: this.sessionId,
    });
  }

  _emitError(text) {
    const kind = classifyError(text);
    if (kind === 'auth') this.onEvent({ type: 'auth_failed' });
    else if (kind === 'limit') this.onEvent({ type: 'limit', text, resetAt: extractResetAt(text) });
    else this.onEvent({ type: 'error', text: text || 'Something went wrong.' });
  }

  _handleThrow(e) {
    const text = String((e && e.message) || e || '');
    // The SDK throws on an error result; if we already surfaced it via the
    // result event, don't double-report.
    if (this._sawError) return;
    // Strip the SDK's wrapper prefix.
    const clean = text.replace(/^Claude Code returned an error result:\s*/i, '');
    this._emitError(clean);
  }
}

module.exports = { ChatSession, extractResetAt, classifyError };
