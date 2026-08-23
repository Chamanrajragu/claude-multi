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

const limits = require('./limits');

// Errors that merely contain the word "limit" but are NOT the plan's usage
// limit. Calling one of these a usage limit parks a perfectly healthy account
// in a multi-hour cooldown and rotates away from it, which burns every account
// in minutes. Checked before the usage-limit patterns.
const NOT_A_USAGE_LIMIT = new RegExp([
  'context (?:window|length)', 'prompt is too long', 'too many tokens',
  'max_tokens', 'output (?:token )?limit', 'exceeds? (?:the )?maximum',
  'rate[_ ]?limit', '\\b429\\b', 'overloaded', 'concurrent',
  'character limit', 'file (?:size )?too large', 'request too large',
  'invalid_request', 'tool result', 'timed? ?out',
].join('|'), 'i');

function extractResetAt(text, now = Date.now()) {
  return limits.parseResetTime(text, now) || 0;
}

function classifyError(text) {
  const s = String(text || '');
  if (/not logged in|authentication_failed|please run \/login|invalid api key/i.test(s)) return 'auth';
  if (NOT_A_USAGE_LIMIT.test(s)) return 'error';
  return limits.classify(s).kind === 'reached' ? 'limit' : 'error';
}

// The CLI tells us *why* a turn stopped. `blocking_limit` is the only reason
// that means "this account is out of quota" — everything else is an ordinary
// failure and must never park the account in a cooldown. Falls back to
// classifyError() when the field is absent (older CLI builds).
const TERMINAL_REASON_TEXT = {
  prompt_too_long: 'This chat is too long for the model. Compact it or start a new chat.',
  max_turns: 'Stopped at the turn cap for this chat (Settings → Budget).',
  budget_exhausted: 'Stopped at the spend cap for this chat (Settings → Budget).',
  rapid_refill_breaker: 'Claude paused this account for sending turns too quickly. Wait a moment.',
};
function classifyTerminalReason(reason) {
  if (!reason) return null;
  if (reason === 'blocking_limit') return 'limit';
  if (reason === 'completed') return null;
  return 'error';
}

class ChatSession {
  constructor({ claudePath, configDir, cwd, model, effort, resumeId, permissionMode, approvalMode, onEvent,
    maxBudgetUsd, maxTurns, disallowedTools, autoCompact }) {
    this.claudePath = claudePath;
    this.configDir = configDir;
    this.cwd = cwd;
    this.model = model || '';
    this.effort = effort || '';
    this.resumeId = resumeId || '';
    this.permissionMode = permissionMode || 'default';
    // Token-budget guards. 0 / empty = no cap.
    this.maxBudgetUsd = Number(maxBudgetUsd) || 0;
    this.maxTurns = Number(maxTurns) || 0;
    // Tools whose schemas are dropped from the system prompt entirely.
    this.disallowedTools = Array.isArray(disallowedTools) ? disallowedTools.filter(Boolean) : [];
    this.autoCompact = autoCompact !== false;
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
      // Without this the SDK sends a MINIMAL system prompt, so the model behaves
      // like a bare LLM instead of Claude Code — the whole reason chats felt
      // "not as good as real Claude". The preset is Claude Code's own system
      // prompt (tool guidance, coding conventions, agent behavior).
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Load the same settings the CLI does — CLAUDE.md, user/project/local
      // settings — so behavior matches the real `claude` command. The 0.3.x SDK
      // does not load these unless asked.
      settingSources: ['user', 'project', 'local'],
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: this.configDir, FORCE_COLOR: '0' }),
      canUseTool: (toolName, toolInput) => this._canUseTool(toolName, toolInput),
      stderr: () => {},
    };
    if (this.model) options.model = this.model;
    if (this.resumeId) options.resume = this.resumeId;
    if (this.claudePath) options.pathToClaudeCodeExecutable = this.claudePath;
    // Effort → the SDK's real effort control. The previous mapping set the
    // deprecated maxThinkingTokens and left 'low' unset, so picking "Low" fell
    // through to the SDK default ('high') — the slider could only ever raise
    // token use, never lower it.
    // Five levels straight through to the SDK. 'ultra' is the old label for the
    // xhigh ("Ultra think") tier — keep it mapped for backward compatibility
    // with any per-chat override saved before the rename.
    const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'xhigh', max: 'max' };
    const level = EFFORT[this.effort] || 'medium';
    options.effort = level;
    options.thinking = level === 'low' ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' };

    // Hard stops for runaway agent loops — the single most expensive failure
    // mode on a subscription, since a loop can burn an hour of quota unattended.
    if (this.maxBudgetUsd > 0) options.maxBudgetUsd = this.maxBudgetUsd;
    if (this.maxTurns > 0) options.maxTurns = this.maxTurns;
    // Dropping a tool removes its schema from the system prompt on EVERY turn.
    if (this.disallowedTools.length) options.disallowedTools = this.disallowedTools.slice();
    // Auto-compact keeps a long chat from re-sending a full context every turn.
    options.settings = { autoCompactEnabled: this.autoCompact };

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

  // Live setting changes. Restarting a session to apply these would re-send the
  // whole transcript on the next turn (a cache miss the size of the chat), so
  // apply them in place whenever the SDK supports it.
  setApprovalMode(mode) {
    this.approvalMode = mode || 'ask';
    // 'plan' is the one mode the engine itself has to know about — it stops
    // tools running at all, so Claude researches and proposes instead of
    // building. Cheaper than letting it build the wrong thing and redo it.
    const engineMode = this.approvalMode === 'plan' ? 'plan' : 'default';
    if (this.permissionMode === engineMode) return true;
    this.permissionMode = engineMode;
    if (!this.q || typeof this.q.setPermissionMode !== 'function') return false;
    this.q.setPermissionMode(engineMode).catch(() => {});
    return true;
  }

  setAutoCompact(on) {
    this.autoCompact = on !== false;
    if (!this.q || typeof this.q.applyFlagSettings !== 'function') return false;
    this.q.applyFlagSettings({ autoCompactEnabled: this.autoCompact }).catch(() => {});
    return true;
  }

  setModel(model) {
    this.model = model || '';
    if (!this.q || typeof this.q.setModel !== 'function') return false;
    this.q.setModel(this.model || undefined).catch(() => {});
    return true;
  }

  // The `/context` breakdown: what is actually occupying the context window
  // (memory files, tool schemas, MCP servers, skills, past messages), each with
  // a token count. This is what makes the other savings measurable.
  async contextUsage() {
    if (!this.q || typeof this.q.getContextUsage !== 'function') return null;
    try { return await this.q.getContextUsage(); } catch { return null; }
  }

  // Summarize the conversation so far and drop the intermediate reasoning.
  // Handled by the CLI as a slash command on the normal input channel.
  compact(instructions) {
    if (this._ended) return false;
    this.busy = true;
    const text = '/compact' + (instructions ? ' ' + instructions : '');
    this._queue.push({ type: 'user', message: { role: 'user', content: text } });
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    return true;
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
        } else if (msg.subtype === 'compact_boundary') {
          const m = msg.compact_metadata || {};
          this.onEvent({ type: 'compacted', trigger: m.trigger || 'auto', preTokens: m.pre_tokens || 0, postTokens: m.post_tokens || 0 });
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
      const text = String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join('\n') : '') || '');
      this._emitError(text, msg.terminal_reason);
      return;
    }
    // The result reports the running model's real context window, so the meter
    // never has to assume 200K. Take the largest if several models ran.
    let contextWindow = 0;
    for (const m of Object.values(msg.modelUsage || {})) {
      if (m && m.contextWindow > contextWindow) contextWindow = m.contextWindow;
    }
    this.onEvent({
      type: 'turn_end',
      usage: msg.usage || null,
      costUsd: msg.total_cost_usd || 0,
      contextWindow,
      sessionId: this.sessionId,
    });
  }

  _emitError(text, terminalReason) {
    // Prefer the CLI's structured reason; fall back to reading the message.
    const kind = classifyTerminalReason(terminalReason) || classifyError(text);
    if (kind === 'auth') this.onEvent({ type: 'auth_failed' });
    else if (kind === 'limit') this.onEvent({ type: 'limit', text, resetAt: extractResetAt(text) });
    else this.onEvent({ type: 'error', text: TERMINAL_REASON_TEXT[terminalReason] || text || 'Something went wrong.' });
  }

  _handleThrow(e) {
    const text = String((e && e.message) || e || '');
    // The SDK throws on an error result; if we already surfaced it via the
    // result event, don't double-report.
    if (this._sawError) return;
    this._sawError = true; // prevent any subsequent exit event from re-reporting
    // Strip the SDK's wrapper prefix.
    const clean = text.replace(/^Claude Code returned an error result:\s*/i, '');
    // A stale/expired session ID produces "No conversation found with session ID".
    // Signal this specially so the caller can retry without --resume.
    if (/no conversation found with session id/i.test(clean)) {
      this.onEvent({ type: 'error', text: clean, code: 'session_not_found' });
      return;
    }
    this._emitError(clean);
  }
}

module.exports = { ChatSession, extractResetAt, classifyError, classifyTerminalReason };
