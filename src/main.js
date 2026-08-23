// Electron main process (chat rebuild).
// Responsibilities:
//   - account store + settings + project folder
//   - CHAT: drive Claude via the Agent SDK (src/chat.js), one session per
//     active account, with in-chat permission prompts, usage-limit detection,
//     and account switching that carries the conversation across accounts.
//   - LOGIN: a small interactive terminal (pty-host) used only to run /login
//     once per account (OAuth can't run in headless chat mode).
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, Tray, nativeImage, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { Store, readAccountInfo } = require('./accounts');
const cooldown = require('./cooldown');
const { ChatSession, extractResetAt } = require('./chat');
const { parseRelease, shouldCheck, updateAvailable } = require('./update');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_COOLDOWN_MS = 5 * 3600e3;
let win = null;
let store = null;

// ---- runtime state --------------------------------------------------------
// Multitasking model: many chats can run at once. Each chat ("conversation")
// carries its OWN folder and its OWN Claude session, so starting or opening a
// second chat never disturbs the first. Only one chat is *on screen* at a time
// (state.currentConvoId); the rest keep running in the background and persist
// their results. The transcript log is assembled here in main (not the
// renderer) so background chats save correctly even when unobserved.
const state = {
  currentConvoId: '',        // the chat currently shown in the UI
  lastFolder: '',            // default folder for the next new-chat picker
  lastAccountId: null,       // last account used (default for a fresh chat)
  sessions: new Map(),       // convoId -> ChatSession (live sessions)
  genConvos: new Set(),      // convoIds whose turn is in progress
  turnBuf: new Map(),        // convoId -> { blocks, curText, tools } assembling the live turn
  pending: new Map(),        // convoId -> { text, attachments } the last turn's prompt, kept until it completes
  perms: new Map(),          // convoId -> Map(requestId -> { tool, input }) unresolved permission prompts
  switchCount: 0,
  update: null,              // { version, tag, name, url } once a newer release is seen
  lastDeleted: null,         // { folder, index, convo, wasCurrent } — one level of undo
};

function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || ''); }
// Mirror of the renderer's tool summary so saved tool cards read the same.
function toolSummary(name, i) {
  if (!i) return '';
  return i.command || i.file_path || i.path || i.pattern || i.url ||
    (i.prompt ? String(i.prompt).slice(0, 80) : (JSON.stringify(i) === '{}' ? '' : JSON.stringify(i).slice(0, 80)));
}
function safeJson(x) { try { return typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x); } catch { return ''; } }
// A filesystem-safe base name for an exported chat: strips path chars, trims
// after truncating, and avoids Windows reserved device names (CON, PRN, …).
function safeFileName(title) {
  let s = String(title || 'chat').replace(/[^a-z0-9\-_ ]+/gi, '').slice(0, 50).trim() || 'chat';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s;
}
// Extract a compact old→new diff from a file-editing tool's input, so the UI can
// show a red/green diff. Strings are capped to keep the saved log reasonable.
function diffFromInput(name, input) {
  const n = String(name || '').toLowerCase();
  if (!input || typeof input !== 'object') return null;
  const cap = (s) => String(s == null ? '' : s).slice(0, 4000);
  const file = input.file_path || input.path || input.notebook_path || '';
  if (n === 'edit' || n === 'update' || n === 'notebookedit') return { file, hunks: [{ old: cap(input.old_string), new: cap(input.new_string) }] };
  if (n === 'multiedit' && Array.isArray(input.edits)) return { file, hunks: input.edits.slice(0, 30).map((e) => ({ old: cap(e && e.old_string), new: cap(e && e.new_string) })) };
  if (n === 'write' && typeof input.content === 'string') return { file, hunks: [{ old: '', new: cap(input.content) }] };
  return null;
}

// ---- helpers --------------------------------------------------------------
function findClaudePath() {
  const override = store.getSettings().claudePath;
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const out = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not found */ }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

// Conversations are scoped to a PROJECT (not an account) and there can be many
// per project (the history sidebar). Each stores the Claude session id (so any
// account can --resume it), which account last ran it (so we know where to copy
// the transcript FROM on a switch), and the display log.
//   projectChats[project] = { conversations: [ {id,title,sessionId,lastAccount,log,createdAt,updatedAt} ], currentId }
function genId() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
function titleFromLog(log) {
  const u = (log || []).find((m) => m.role === 'user');
  if (!u) return 'New chat';
  return (String(u.text || '').replace(/\s+/g, ' ').trim().slice(0, 46)) || 'New chat';
}
// Render a stored conversation log to a portable Markdown transcript.
function conversationToMarkdown(c) {
  const lines = [];
  lines.push('# ' + (c.title || 'Claude Multi chat'));
  lines.push('');
  lines.push('_Exported from Claude Multi on ' + new Date().toLocaleString() + '_');
  lines.push('');
  for (const m of c.log || []) {
    if (m.role === 'user') {
      lines.push('## 🧑 You');
      lines.push('');
      lines.push(String(m.text || ''));
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push('## ✳ Claude');
      lines.push('');
      for (const b of m.blocks || []) {
        if (b.type === 'text') { lines.push(String(b.text || '')); lines.push(''); }
        else if (b.type === 'tool') {
          lines.push('> **🛠 ' + (b.name || 'tool') + '**' + (b.summary ? ' — `' + b.summary + '`' : ''));
          lines.push('');
        }
      }
    }
  }
  return lines.join('\n');
}

function getProjectData(project) {
  const m = store.get('projectChats') || {};
  let d = m[project];
  if (!d) return { conversations: [], currentId: '' };
  if (!Array.isArray(d.conversations)) {
    // migrate the old single-conversation shape
    const has = (Array.isArray(d.log) && d.log.length) || d.sessionId;
    const conv = { id: genId(), title: titleFromLog(d.log), sessionId: d.sessionId || '', lastAccount: d.lastAccount || '', log: Array.isArray(d.log) ? d.log : [], createdAt: Date.now(), updatedAt: Date.now() };
    d = { conversations: has ? [conv] : [], currentId: has ? conv.id : '' };
    saveProjectData(project, d);
  }
  return d;
}
function saveProjectData(project, d) {
  if (!project) return;
  const m = store.get('projectChats') || {};
  m[project] = d;
  // Chat logs are by far the biggest thing in the store and they change on
  // every turn, so this write is coalesced. store.flush() on quit makes sure
  // the last one lands.
  store.setSoon('projectChats', m);
}
function createConvo(project) {
  const d = getProjectData(project);
  const c = { id: genId(), title: 'New chat', sessionId: '', lastAccount: '', log: [], createdAt: Date.now(), updatedAt: Date.now() };
  d.conversations.unshift(c);
  d.currentId = c.id;
  saveProjectData(project, d);
  return c;
}
function updateConvo(project, id, patch) {
  const d = getProjectData(project);
  const c = d.conversations.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch, { updatedAt: Date.now() });
  saveProjectData(project, d);
}

// ---- cross-folder aggregation (the flat "all chats" view) -----------------
// Conversations stay stored under their folder bucket, but the UI presents them
// as one flat list, each tagged with the folder it lives in.
function eachConvo(cb) {
  const m = store.get('projectChats') || {};
  for (const folder of Object.keys(m)) {
    const d = getProjectData(folder); // migrates the old single-convo shape
    for (const c of d.conversations) cb(c, folder);
  }
}
function findConvo(id) {
  let found = null;
  eachConvo((c, folder) => { if (c.id === id) found = { convo: c, folder }; });
  return found;
}
function updateConvoById(id, patch) { const f = findConvo(id); if (f) updateConvo(f.folder, id, patch); }

// Assemble the transcript log for a chat from its session events, so the log is
// correct even for chats running off-screen. Shape matches what the renderer's
// renderHistory() expects: user = {role,text}; assistant = {role,blocks,usage,costUsd}.
function turnBuf(id) {
  let b = state.turnBuf.get(id);
  if (!b) { b = { blocks: [], curText: null, tools: new Map() }; state.turnBuf.set(id, b); }
  return b;
}
function accumulate(id, ev) {
  const b = turnBuf(id);
  switch (ev.type) {
    case 'assistant_delta':
      if (!b.curText) { b.curText = { type: 'text', text: '' }; b.blocks.push(b.curText); }
      b.curText.text += ev.text || ''; break;
    case 'assistant_text':
      if (!b.curText) { b.curText = { type: 'text', text: '' }; b.blocks.push(b.curText); }
      b.curText.text = ev.text || ''; b.curText = null; break;
    case 'thinking': break; // live-only, not persisted (matches renderHistory)
    case 'tool_use': {
      b.curText = null;
      const blk = { type: 'tool', name: ev.name, summary: toolSummary(ev.name, ev.input), state: 'running', output: safeJson(ev.input) };
      const ed = diffFromInput(ev.name, ev.input);
      if (ed) blk.edit = ed; // enables a red/green diff view in the UI
      b.blocks.push(blk); b.tools.set(ev.id, blk); break;
    }
    case 'tool_result': {
      const blk = b.tools.get(ev.id);
      if (blk) { blk.state = ev.isError ? 'err' : 'ok'; if (ev.text) blk.output = String(ev.text).slice(0, 8000); }
      break;
    }
    default: break;
  }
}
function finalizeTurn(id, ev) {
  const b = state.turnBuf.get(id);
  state.turnBuf.delete(id);
  if (!b || !b.blocks.length) return;
  const f = findConvo(id); if (!f) return;
  const log = Array.isArray(f.convo.log) ? f.convo.log.slice() : [];
  log.push({ role: 'assistant', blocks: b.blocks, usage: (ev && ev.usage) || null, costUsd: (ev && ev.costUsd) || 0, ts: Date.now() });
  const patch = { log };
  if (!f.convo.title || f.convo.title === 'New chat') { const t = titleFromLog(log); if (t) patch.title = t; }
  updateConvoById(id, patch);
}
// Snapshot of the in-flight (not-yet-finalized) assistant turn as a log-shaped
// message, so switching TO a still-generating chat replays everything streamed
// so far instead of showing a blank turn. Returns null if nothing is buffered.
function bufferedTurnMessage(id) {
  const b = state.turnBuf.get(id);
  if (!b || !b.blocks.length) return null;
  // Deep-ish copy so the caller can't mutate the live buffer.
  return { role: 'assistant', blocks: b.blocks.map((blk) => ({ ...blk })), usage: null, costUsd: 0, ts: Date.now(), provisional: true };
}
// The full transcript to show for a chat: finalized log + any live in-flight
// turn. Used by openConvo / getHistory so background chats never look empty.
function logWithLiveTurn(id) {
  const f = findConvo(id);
  const log = (f && Array.isArray(f.convo.log)) ? f.convo.log.slice() : [];
  const live = bufferedTurnMessage(id);
  if (live) log.push(live);
  return log;
}
// Bill a finished turn to the account that ran it. Cache reads are counted at
// full weight because that is how they land against a plan's quota.
function recordAccountUsage(accountId, ev) {
  if (!accountId || !ev) return;
  const u = ev.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0)
    + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (!tokens && !ev.costUsd) return;
  store.recordUsage(accountId, { tokens, costUsd: Number(ev.costUsd) || 0 });
}
function appendUserMessage(id, text, attachments) {
  const f = findConvo(id); if (!f) return;
  let display = String(text || '');
  const names = (attachments || []).map((p) => '📎 ' + baseName(p));
  if (names.length) display += (display ? '\n' : '') + names.join('\n');
  const log = Array.isArray(f.convo.log) ? f.convo.log.slice() : [];
  log.push({ role: 'user', text: display, ts: Date.now() });
  const patch = { log };
  if (!f.convo.title || f.convo.title === 'New chat') { const t = titleFromLog(log); if (t) patch.title = t; }
  updateConvoById(id, patch);
}

function notify(title, body) {
  try {
    if (!store.getSettings().notify || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  } catch { /* noop */ }
}

function toRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- update check ---------------------------------------------------------
// Asks GitHub for the latest published release and tells the renderer when it
// is newer than what's running. Entirely best-effort: no network, a rate limit
// or a malformed body all just mean "no update to show", never an error popup.
const UPDATE_REPO = 'Chamanrajragu/claude-multi';
const UPDATE_INTERVAL_MS = 6 * 3600e3;
async function checkForUpdate(force) {
  const current = require('../package.json').version;
  const settings = store.getSettings();
  if (!force && settings.checkUpdates === false) return { ok: false, skipped: 'disabled' };
  const last = Number(store.get('lastUpdateCheck')) || 0;
  if (!force && !shouldCheck(last, Date.now(), UPDATE_INTERVAL_MS)) {
    return { ok: true, current, update: state.update, cached: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-multi/' + current },
    });
    store.set('lastUpdateCheck', Date.now());
    if (!res.ok) return { ok: false, error: 'GitHub returned ' + res.status, current };
    const release = parseRelease(await res.json());
    state.update = updateAvailable(release, current) ? release : null;
    toRenderer('app:update', { current, update: state.update });
    return { ok: true, current, update: state.update };
  } catch (e) {
    // Offline, DNS failure or timeout — stay quiet, try again next launch.
    return { ok: false, error: String((e && e.message) || e), current };
  } finally {
    clearTimeout(timer);
  }
}

function convoTitle(convoId) { const f = findConvo(convoId); return (f && f.convo.title && f.convo.title !== 'New chat') ? f.convo.title : 'a chat'; }
function fmtTokens(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }
// Bounce the taskbar/dock when a background chat needs attention (and the window
// isn't focused), so multitasking users don't miss it.
function flashWindow() {
  try { if (win && !win.isFocused()) { if (process.platform === 'darwin') { try { app.dock.bounce('informational'); } catch { /* noop */ } } else win.flashFrame(true); } } catch { /* noop */ }
}
// Reflect how many chats are working in the window title.
function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  const n = state.genConvos.size;
  try { win.setTitle(n > 0 ? `● ${n} working — Claude Multi` : 'Claude Multi'); } catch { /* noop */ }
}

function conversationList() {
  const items = [];
  eachConvo((c, folder) => {
    items.push({
      id: c.id,
      title: c.title || 'New chat',
      folder,
      folderName: baseName(folder),
      updatedAt: c.updatedAt || 0,
      pinned: !!c.pinned,
      empty: !(c.log && c.log.length),
      generating: state.genConvos.has(c.id),
      running: state.sessions.has(c.id),
      awaiting: state.perms.has(c.id),
      accountId: c.lastAccount || '',
      sortIndex: (typeof c.sortIndex === 'number') ? c.sortIndex : null,
    });
  });
  // Pinned first; then manual drag order (sortIndex) where set, otherwise
  // most-recently-updated. Non-reordered (e.g. brand-new) chats float to the top.
  const rank = (c) => (c.sortIndex != null ? c.sortIndex : -(c.updatedAt || 0) / 1e10);
  items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || rank(a) - rank(b));
  return { conversations: items, currentConvoId: state.currentConvoId };
}
function statePayload() {
  const conv = conversationList();
  const cur = state.currentConvoId ? findConvo(state.currentConvoId) : null;
  return {
    accounts: store.list(),
    // A brand-new chat has no bound account yet; fall back to the last account
    // you used so the composer is ready and the first send "just works" instead
    // of being blocked by a "choose an account" toast. The send handler already
    // starts the session on this same lastAccountId fallback.
    activeAccountId: (cur && cur.convo.lastAccount) || state.lastAccountId || null,
    projectDir: cur ? cur.folder : '',      // folder of the chat on screen
    running: state.sessions.has(state.currentConvoId),
    generating: state.genConvos.has(state.currentConvoId),
    switchCount: state.switchCount,
    settings: store.getSettings(),
    availableCount: cooldown.availableCount(store.list()),
    conversations: conv.conversations,
    currentConvoId: conv.currentConvoId,
    activeCount: state.sessions.size,       // how many chats are running at once
    chatModel: (cur && typeof cur.convo.model === 'string') ? cur.convo.model : null,   // per-chat override, or null = use default
    chatEffort: (cur && typeof cur.convo.effort === 'string') ? cur.convo.effort : null,
  };
}
function pushState() { toRenderer('app:state', statePayload()); updateTray(); updateWindowTitle(); }

// ---- chat engine ----------------------------------------------------------
// Stop ONE chat's session (leaves every other running chat alone).
function stopSession(convoId) {
  const s = state.sessions.get(convoId);
  if (s) { try { s.stop(); } catch { /* noop */ } state.sessions.delete(convoId); }
  state.genConvos.delete(convoId);
  state.turnBuf.delete(convoId);
  state.perms.delete(convoId);
}
function stopAllSessions() { for (const id of [...state.sessions.keys()]) stopSession(id); }

// Switch the on-screen chat's model without tearing the session down. Falls
// back to a restart only if the SDK can't change it live.
function applyModelToCurrent(model) {
  const id = state.currentConvoId;
  const sess = id && state.sessions.get(id);
  if (!sess) return;
  if (sess.setModel(model)) return;
  const f = findConvo(id);
  if (f && f.convo.lastAccount) useAccountForChat(f.convo.lastAccount, id);
}

function startSession(convoId, accountId, resumeId) {
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  const f = findConvo(convoId);
  if (!f) return { ok: false, error: 'Chat not found' };
  const folder = f.folder;
  if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'This chat’s folder is missing' };
  if (!readAccountInfo(acc.configDir).loggedIn) return { ok: false, error: 'not_logged_in' };

  stopSession(convoId); // replace only THIS chat's session
  const s = store.getSettings();
  // Per-chat override wins over the global default when set.
  const model = (typeof f.convo.model === 'string') ? f.convo.model : (s.model || '');
  const effort = (typeof f.convo.effort === 'string') ? f.convo.effort : (s.effort || '');
  const session = new ChatSession({
    configDir: acc.configDir,
    cwd: folder,
    model,
    effort,
    resumeId: resumeId || '',
    // The engine only needs to know about 'plan' (it blocks tool execution);
    // every other mode is decided by approvalMode in the can_use_tool handshake.
    permissionMode: (s.permissionMode === 'plan') ? 'plan' : 'default',
    approvalMode: s.permissionMode || 'ask', // 'ask' | 'acceptEdits' | 'bypass'
    maxBudgetUsd: s.maxBudgetUsd || 0,
    maxTurns: s.maxTurns || 0,
    disallowedTools: Array.isArray(s.disabledTools) ? s.disabledTools : [],
    autoCompact: s.autoCompact !== false,
    onEvent: (ev) => onChatEvent(convoId, session, accountId, ev),
  });
  state.sessions.set(convoId, session);
  state.lastAccountId = accountId;
  store.recordLaunch(accountId);
  store.setProjectAccount(folder, accountId);
  session.start();
  pushState();
  return { ok: true };
}

// "Use account X for chat <id> (defaults to the on-screen chat)." Carries the
// chat's transcript onto X (copy + resume) so it continues seamlessly across
// accounts, then renders the stored history if that chat is the one on screen.
function useAccountForChat(accountId, convoId) {
  const id = convoId || state.currentConvoId;
  const f = id && findConvo(id);
  if (!f) return { ok: false, error: 'Open or create a chat first' };
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  if (!readAccountInfo(acc.configDir).loggedIn) return { ok: false, error: 'not_logged_in' };

  const chat = f.convo;
  let resumeId = '';
  let carried = false;
  if (chat.sessionId) {
    if (chat.lastAccount && chat.lastAccount !== accountId) {
      const fromAcc = store.byId(chat.lastAccount);
      if (fromAcc && carryTranscripts(fromAcc.configDir, acc.configDir, f.folder, chat.sessionId)) {
        resumeId = chat.sessionId;
        carried = true;
      }
    } else {
      resumeId = chat.sessionId; // same account — resume its own conversation
    }
  }
  const res = startSession(id, accountId, resumeId);
  if (!res.ok) return res;
  updateConvoById(id, { lastAccount: accountId });
  if (id === state.currentConvoId) toRenderer('chat:history', { log: chat.log || [] });
  return { ok: true, carried };
}

// Carry a chat onto another account AND automatically re-issue the turn that
// was cut off by a usage limit, so the new account's Claude continues the work
// without the user copy-pasting anything.
function resumeInterrupted(convoId, accountId) {
  const res = useAccountForChat(accountId, convoId);
  if (!res.ok) return res;
  const p = state.pending.get(convoId);
  const session = state.sessions.get(convoId);
  const acc = store.byId(accountId);
  toRenderer('chat:event', { convoId, type: 'info', text: '↻ Continued on ' + ((acc && acc.name) || 'another account') + ' after a usage limit.' });
  if (p && session) {
    // Re-send the same instruction; --resume already carries the full context,
    // so Claude picks up where it left off. We don't re-log the user message
    // (it's already in the transcript from the first attempt).
    session.send(p.text, p.attachments || []);
    state.genConvos.add(convoId);
  }
  pushState();
  return { ok: true, carried: res.carried, continued: !!p };
}

function onChatEvent(convoId, session, accountId, ev) {
  // Drop events from a session that is no longer this chat's live one (e.g. a
  // stopped/replaced session's trailing stream). This is what makes each chat
  // independent and makes "New chat" truly fresh.
  if (state.sessions.get(convoId) !== session) return;
  switch (ev.type) {
    case 'ready':
      if (ev.sessionId) updateConvoById(convoId, { sessionId: ev.sessionId, lastAccount: accountId });
      break;
    case 'assistant_delta':
    case 'assistant_text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
      accumulate(convoId, ev);
      break;
    case 'permission': {
      // Remember unresolved prompts so a background chat's request can be
      // replayed (and answered) when the user opens that chat.
      let m = state.perms.get(convoId); if (!m) { m = new Map(); state.perms.set(convoId, m); }
      m.set(ev.requestId, { tool: ev.tool, input: ev.input });
      // A chat you're not looking at needs you — nudge the OS + taskbar.
      if (convoId !== state.currentConvoId) { notify('Approval needed', `“${convoTitle(convoId)}” wants to use ${ev.tool}`); flashWindow(); }
      break;
    }
    case 'turn_end':
      state.genConvos.delete(convoId);
      state.pending.delete(convoId); // completed cleanly — nothing to resume
      state.perms.delete(convoId);
      recordAccountUsage(accountId, ev);
      finalizeTurn(convoId, ev);
      if (ev.sessionId) updateConvoById(convoId, { sessionId: ev.sessionId, lastAccount: accountId });
      if (convoId !== state.currentConvoId) notify('Claude finished', `”${convoTitle(convoId)}” is ready`);
      notifyAutoLoopWaiters(convoId);
      pushState();
      break;
    case 'compacted': {
      const saved = Math.max(0, (ev.preTokens || 0) - (ev.postTokens || 0));
      toRenderer('chat:event', { convoId, type: 'info',
        text: `🗜 Compacted ${ev.trigger === 'auto' ? 'automatically' : ''} — context ${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)} (${fmtTokens(saved)} freed).`.replace(/\s+/g, ' ') });
      break;
    }
    case 'limit':
      state.genConvos.delete(convoId);
      state.turnBuf.delete(convoId);
      state.perms.delete(convoId);
      notifyAutoLoopWaiters(convoId);
      handleLimit(convoId, accountId, ev);
      break;
    case 'error':
      state.genConvos.delete(convoId);
      state.turnBuf.delete(convoId);
      state.perms.delete(convoId);
      // A stale/expired session ID: the CLI can't --resume it. Clear it and
      // transparently restart the session from scratch so the user doesn't have
      // to do anything. The existing transcript is preserved.
      if (ev.code === 'session_not_found') {
        updateConvoById(convoId, { sessionId: '' });
        const f2 = findConvo(convoId);
        const accId = f2 && f2.convo.lastAccount;
        if (accId) {
          toRenderer('chat:event', { convoId, type: 'info', text: '↻ Session expired — restarting automatically. Your transcript is intact.' });
          toRenderer('app:toast', { text: 'Session expired — restarted automatically', kind: 'ok' });
          startSession(convoId, accId, '');
          return;
        }
      }
      notifyAutoLoopWaiters(convoId);
      pushState();
      break;
    case 'auth_failed':
      state.genConvos.delete(convoId);
      state.turnBuf.delete(convoId);
      state.perms.delete(convoId);
      notifyAutoLoopWaiters(convoId);
      pushState();
      break;
    case 'exit':
      state.genConvos.delete(convoId);
      state.perms.delete(convoId);
      notifyAutoLoopWaiters(convoId);
      if (session && !session.alive) state.sessions.delete(convoId);
      pushState();
      break;
    default:
      break;
  }
  // Forward to the UI, tagged so the renderer only draws the chat on screen.
  toRenderer('chat:event', Object.assign({ convoId }, ev));
}

function handleLimit(convoId, accountId, ev) {
  const until = ev.resetAt || (Date.now() + DEFAULT_COOLDOWN_MS);
  store.setCooldown(accountId, until, ev.text || '');
  const next = cooldown.pickNext(store.list(), accountId, Date.now(), store.getSettings().switchStrategy);
  // pickNext falls back to the soonest-to-reset account even when ALL accounts
  // are cooling. We must NOT auto-continue onto a still-limited account, or we'd
  // bounce limit→switch→limit forever, re-sending the prompt and spawning a new
  // SDK process each hop. Only auto-continue onto an account free right now.
  const nextAvailable = !!(next && cooldown.isAvailable(next));
  const cur = store.byId(accountId);
  const autoSwitch = store.getSettings().autoSwitch;
  let handled = false;
  if (autoSwitch && nextAvailable) {
    state.switchCount += 1;
    const r = resumeInterrupted(convoId, next.id);
    handled = !!r.ok;
  }
  notify('Usage limit reached',
    (cur ? cur.name : 'Account') + ' hit its limit.' +
    (handled ? ` Continued on ${next.name}.` : (nextAvailable ? ` You can switch to ${next.name}.` : ' No other account is available right now.')));
  toRenderer('chat:limit', {
    convoId,
    accountId,
    resetAt: until,
    text: ev.text || '',
    autoSwitch,
    handled,
    canContinue: !!state.pending.get(convoId),
    next: next ? { id: next.id, name: next.name, email: next.email, resetAt: next.cooldownUntil || 0 } : null,
    nextAvailable,
  });
  pushState();
}

// Copy the active project's transcripts from one account to another so the
// switched-to account can resume the same conversation.
function carryTranscripts(fromDir, toDir, projectDir, sessionId) {
  try {
    const enc = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    const src = path.join(fromDir, 'projects', enc);
    const dst = path.join(toDir, 'projects', enc);
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(dst, { recursive: true });
    // Prefer copying ONLY this chat's session transcript, so two chats sharing a
    // folder on different accounts can't clobber each other's history.
    if (sessionId) {
      const file = sessionId + '.jsonl';
      const sf = path.join(src, file);
      if (fs.existsSync(sf)) { fs.copyFileSync(sf, path.join(dst, file)); return true; }
    }
    // Fallback (unknown session filename): copy the whole folder.
    fs.cpSync(src, dst, { recursive: true });
    return true;
  } catch (e) { console.error('[carryTranscripts]', e); }
  return false;
}

function switchAccount(targetId) {
  // Persist the live session id of the CURRENT chat before we tear it down, so
  // the carry works even if no turn has completed yet.
  const id = state.currentConvoId;
  const session = id && state.sessions.get(id);
  if (session && session.sessionId) {
    const f = findConvo(id);
    updateConvoById(id, { sessionId: session.sessionId, lastAccount: (f && f.convo.lastAccount) || state.lastAccountId });
  }
  const toAcc = store.byId(targetId);
  if (!toAcc) return { ok: false, error: 'Target account not found' };
  state.switchCount += 1;
  const res = useAccountForChat(targetId);
  if (res.ok) notify('Switched account', `Now using ${toAcc.name}` + (res.carried ? ' · conversation carried over' : ''));
  return res;
}

// ---- login terminal (pty-host, used only for /login) ----------------------
let host = null;
let hostBuf = '';
let loginAccountId = null;
let loginPoll = null;

// Locate the system Node. The pty host must run under real Node (not Electron)
// so the prebuilt node-pty binary matches the ABI, so process.execPath is no
// help here.
function findNodePath() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* noop */ } }
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'command -v node';
    const out = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not found */ }
  return 'node'; // last resort: hope it is on PATH
}

// Anything that stops the login terminal starting has to reach the user. This
// used to go to console.error only, so a failure looked like an empty terminal
// that never did anything.
function loginError(text) { toRenderer('login:data', `\r\n[error] ${text}\r\n`); }

function startHost() {
  if (host) return;
  // No `shell: true` here. With a shell, Windows concatenates the argv without
  // quoting, so any install path containing a space — "D:\Claude Multi\…",
  // anything under "Program Files" — was split and Node tried to load
  // "D:\Claude". Login could never work from such a path.
  try {
    host = spawn(findNodePath(), [path.join(__dirname, 'pty-host.js')], {
      cwd: APP_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    loginError(`Could not start the login terminal: ${e.message}\r\nInstall Node.js 18+ and make sure it is on your PATH.`);
    host = null;
    return;
  }
  host.on('error', (e) => {
    loginError(`Could not start the login terminal: ${e.message}\r\nInstall Node.js 18+ and make sure it is on your PATH.`);
    host = null;
  });
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', onHostData);
  // Buffer stderr rather than streaming it into the terminal: the host emits
  // harmless warnings that would otherwise appear as noise above Claude's own
  // output. It is only worth showing if the host actually dies.
  let hostErr = '';
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (d) => { hostErr = (hostErr + d).slice(-2000); console.error('[pty-host]', d); });
  host.on('exit', (code) => {
    if (code) loginError(`Login terminal stopped unexpectedly (exit ${code}).${hostErr ? '\r\n' + hostErr.trim() : ''}`);
    host = null;
  });
}
function sendToHost(obj) {
  if (!host || !host.stdin || !host.stdin.writable) return;
  try { host.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { console.error('[sendToHost] write error', e.message); }
}
function onHostData(chunk) {
  hostBuf += chunk;
  let i;
  while ((i = hostBuf.indexOf('\n')) >= 0) {
    const line = hostBuf.slice(0, i); hostBuf = hostBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === 'data') toRenderer('login:data', Buffer.from(msg.d, 'base64').toString('utf8'));
    else if (msg.t === 'exit') { toRenderer('login:exit', msg.code); stopLoginPoll(); }
    else if (msg.t === 'error') toRenderer('login:data', `\r\n[error] ${msg.message}\r\n`);
  }
}
function startLoginPoll(accountId) {
  stopLoginPoll();
  const acc = store.byId(accountId);
  if (!acc) return;
  loginPoll = setInterval(() => {
    store.invalidateInfoCache(accountId); // force fresh read from disk
    const info = readAccountInfo(acc.configDir);
    if (info.loggedIn) {
      stopLoginPoll();
      toRenderer('login:success', { accountId, email: info.email });
      pushState();
    }
  }, 1500);
}
function stopLoginPoll() { if (loginPoll) { clearInterval(loginPoll); loginPoll = null; } }

function startLogin(accountId) {
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  // Don't run chat + /login on the same account at once.
  for (const convoId of [...state.sessions.keys()]) {
    const f = findConvo(convoId);
    if (f && f.convo.lastAccount === accountId) stopSession(convoId);
  }
  startHost();
  loginAccountId = accountId;
  sendToHost({
    t: 'spawn',
    file: findClaudePath(),
    args: [],
    cwd: acc.configDir, // cwd doesn't matter for /login
    cols: 100, rows: 30,
    env: { CLAUDE_CONFIG_DIR: acc.configDir, FORCE_COLOR: '1' },
  });
  startLoginPoll(accountId);
  return { ok: true };
}
function stopLogin() { sendToHost({ t: 'kill' }); stopLoginPoll(); loginAccountId = null; return { ok: true }; }

// ---- auto-loop (zero-waste Claude usage across all accounts) --------------
//
// Goal: fully utilise every 5-hour usage window on every account, forever,
// without the user needing to be present.
//
// How it works:
//   Round = one pass through all selected accounts.
//   Each account gets its OWN fresh chat per round so context never bloats.
//   After every account in the round has either finished its turn OR hit its
//   limit, we wait for the soonest reset and start a new round.
//   This repeats indefinitely until the user stops it.
//
// State machine per tick:
//   idle   → (start) → pick_account → send → wait_turn
//   wait_turn → (turn done) → pick_account  (next account in round)
//              → (all accounts exhausted) → wait_reset → pick_account (new round)
//
const autoLoop = {
  active: false,
  prompt: '',
  accountIds: [],        // IDs of accounts chosen by user
  // Per-round tracking: which accounts have already run this round
  roundNum: 0,           // how many full rounds completed
  sendCount: 0,          // total sends ever
  usedThisRound: new Set(), // accountIds that have already sent this round
  currentAccountId: '',  // account currently running
  currentConvoId: '',    // convoId currently in use (one per account per round)
  // UI state
  status: 'idle',        // 'idle' | 'sending' | 'waiting_turn' | 'waiting_reset'
  waitReason: '',
  nextAt: 0,             // epoch ms of next wake (for countdown display)
  timer: null,
  // Saved settings (persisted in store so they survive app restarts)
  folder: '',            // project folder for new chats
};

function autoLoopStatus() {
  const allAccounts = store.list();
  const eligible = allAccounts.filter((a) => a.loggedIn && autoLoop.accountIds.includes(a.id));
  const now = Date.now();
  return {
    active: autoLoop.active,
    status: autoLoop.status,
    waitReason: autoLoop.waitReason,
    nextAt: autoLoop.nextAt,
    roundNum: autoLoop.roundNum,
    sendCount: autoLoop.sendCount,
    currentAccountId: autoLoop.currentAccountId,
    prompt: autoLoop.prompt,
    accountIds: autoLoop.accountIds,
    folder: autoLoop.folder,
    // Rich per-account status so the UI can draw a live table
    accounts: eligible.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email || '',
      usedThisRound: autoLoop.usedThisRound.has(a.id),
      isCurrent: a.id === autoLoop.currentAccountId,
      cooldownUntil: a.cooldownUntil || 0,
      available: !a.cooldownUntil || a.cooldownUntil <= now,
    })),
  };
}

function _alBroadcast() { toRenderer('autoloop:status', autoLoopStatus()); }

function autoLoopStop() {
  autoLoop.active = false;
  autoLoop.currentAccountId = '';
  autoLoop.currentConvoId = '';
  if (autoLoop.timer) { clearTimeout(autoLoop.timer); autoLoop.timer = null; }
  autoLoop.status = 'idle';
  autoLoop.waitReason = '';
  autoLoop.nextAt = 0;
  _alBroadcast();
}

function autoLoopStart(prompt, accountIds, folder) {
  if (!prompt || !prompt.trim()) return { ok: false, error: 'Prompt cannot be empty' };
  const allAccounts = store.list().filter((a) => a.loggedIn);
  const chosen = accountIds && accountIds.length
    ? allAccounts.filter((a) => accountIds.includes(a.id))
    : allAccounts;
  if (!chosen.length) return { ok: false, error: 'No signed-in accounts selected. Log in to at least one account first.' };

  // Need a folder for creating fresh chats each round.
  const chatFolder = folder || state.lastFolder || store.get('lastProjectDir') || '';
  if (!chatFolder || !fs.existsSync(chatFolder)) return { ok: false, error: 'Pick a project folder first (New chat → pick folder), then start the loop.' };

  // Stop any existing loop first.
  if (autoLoop.active) autoLoopStop();

  autoLoop.active = true;
  autoLoop.prompt = prompt.trim();
  autoLoop.accountIds = chosen.map((a) => a.id);
  autoLoop.folder = chatFolder;
  autoLoop.roundNum = 0;
  autoLoop.sendCount = 0;
  autoLoop.usedThisRound = new Set();
  autoLoop.currentAccountId = '';
  autoLoop.currentConvoId = '';
  autoLoop.status = 'sending';
  autoLoop.waitReason = '';
  autoLoop.nextAt = 0;

  // Persist settings so they survive if the user navigates away and re-opens.
  store.setSettings({
    _autoLoopPrompt: autoLoop.prompt,
    _autoLoopAccountIds: autoLoop.accountIds,
    _autoLoopFolder: autoLoop.folder,
  });

  _alBroadcast();
  notify('Auto-loop started', `${chosen.length} account${chosen.length > 1 ? 's' : ''} · will run 24/7`);
  _alTick();
  return { ok: true };
}

async function _alTick() {
  if (!autoLoop.active) return;

  const now = Date.now();
  const allAccounts = store.list();
  const eligible = allAccounts.filter((a) => a.loggedIn && autoLoop.accountIds.includes(a.id));

  if (!eligible.length) {
    autoLoopStop();
    notify('Auto-loop stopped', 'No signed-in accounts. Log in and restart.');
    return;
  }

  // ── Pick the next account for this round ───────────────────────────────
  // An account is a candidate if:
  //   (a) it hasn't run this round yet, AND
  //   (b) it isn't on cooldown right now
  const candidates = eligible.filter(
    (a) => !autoLoop.usedThisRound.has(a.id) && (!a.cooldownUntil || a.cooldownUntil <= now)
  );

  if (candidates.length > 0) {
    // Use the account that was used least recently (fair rotation).
    candidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    await _alRunAccount(candidates[0]);
    return;
  }

  // ── No candidate available right now ──────────────────────────────────
  // Check if ALL accounts have been used this round (round is complete).
  const allUsed = eligible.every((a) => autoLoop.usedThisRound.has(a.id));

  if (allUsed) {
    // Round complete — start a new round once ANY account is available.
    autoLoop.roundNum += 1;
    autoLoop.usedThisRound = new Set();
    _alBroadcast();
    notify('Auto-loop round complete', `Round ${autoLoop.roundNum} done · ${autoLoop.sendCount} total sends. Waiting for next reset…`);
  }
  // else: some accounts are not yet used but are cooling — wait for soonest.

  // Find the soonest-to-reset account among those NOT yet used this round.
  const waiting = eligible.filter((a) => !autoLoop.usedThisRound.has(a.id) && a.cooldownUntil && a.cooldownUntil > now);
  const soonest = waiting.sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0))[0];

  if (!soonest) {
    // Should not happen, but retry in 30s as safety net.
    autoLoop.timer = setTimeout(_alTick, 30000);
    return;
  }

  const waitMs = Math.max(10000, soonest.cooldownUntil - now + 8000); // 8s buffer after reset
  autoLoop.status = 'waiting_reset';
  autoLoop.nextAt = soonest.cooldownUntil + 8000;
  const h = Math.floor(waitMs / 3600000);
  const m = Math.floor((waitMs % 3600000) / 60000);
  const s = Math.floor((waitMs % 60000) / 1000);
  const hms = h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m ${s}s` : `${s}s`);
  autoLoop.waitReason = `Waiting for ${soonest.name} to reset — ${hms} remaining`;
  _alBroadcast();

  // Poll every 30s so the countdown stays accurate on screen, and actually
  // wake up right at the reset time using a precise timer.
  autoLoop.timer = setTimeout(_alTick, Math.min(waitMs, 30000));
}

async function _alRunAccount(account) {
  if (!autoLoop.active) return;

  autoLoop.currentAccountId = account.id;
  autoLoop.status = 'sending';
  autoLoop.waitReason = '';
  autoLoop.nextAt = 0;
  _alBroadcast();

  // Create a FRESH chat for every account × round combination.
  // This keeps context small (cheap) and gives Claude a clean slate each time.
  const chatFolder = autoLoop.folder;
  if (!chatFolder || !fs.existsSync(chatFolder)) {
    autoLoopStop();
    notify('Auto-loop stopped', `Folder not found: ${chatFolder}. Pick a valid folder and restart.`);
    toRenderer('chat:event', { convoId: '', type: 'error', text: `🔄 Auto-loop stopped — folder not found: ${chatFolder}` });
    return;
  }

  const c = createConvo(chatFolder);
  autoLoop.currentConvoId = c.id;
  // Make this new chat the visible one so the user can watch it.
  state.currentConvoId = c.id;
  toRenderer('chat:history', { log: [] });
  pushState();

  // Start the session on this account.
  const startRes = startSession(c.id, account.id, '');
  if (!startRes.ok) {
    toRenderer('chat:event', { convoId: c.id, type: 'error', text: `Auto-loop: could not start session on ${account.name} — ${startRes.error}` });
    autoLoop.usedThisRound.add(account.id); // skip this account this round
    autoLoop.currentAccountId = '';
    autoLoop.currentConvoId = '';
    autoLoop.timer = setTimeout(_alTick, 5000);
    return;
  }

  updateConvoById(c.id, { lastAccount: account.id });

  const session = state.sessions.get(c.id);
  if (!session) {
    autoLoop.usedThisRound.add(account.id);
    autoLoop.currentAccountId = '';
    autoLoop.timer = setTimeout(_alTick, 5000);
    return;
  }

  autoLoop.sendCount += 1;
  autoLoop.status = 'waiting_turn';
  autoLoop.waitReason = `Running on ${account.name} (send #${autoLoop.sendCount})`;
  _alBroadcast();

  toRenderer('chat:event', {
    convoId: c.id, type: 'info',
    text: `🔄 Auto-loop · Round ${autoLoop.roundNum + 1} · ${account.name} · Send #${autoLoop.sendCount}`,
  });

  appendUserMessage(c.id, autoLoop.prompt, []);
  session.send(autoLoop.prompt, []);
  state.genConvos.add(c.id);
  pushState();

  // Wait for Claude to finish (turn_end), hit a limit, error, or exit.
  await new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return; resolved = true;
      const idx = autoLoopWaiters.indexOf(waiter);
      if (idx >= 0) autoLoopWaiters.splice(idx, 1);
      if (waiter.safety) { clearTimeout(waiter.safety); waiter.safety = null; }
      resolve();
    };
    const waiter = { convoId: c.id, resolve: cleanup };
    autoLoopWaiters.push(waiter);
    // Hard safety timeout: 45 min — in case the turn never fires an end event.
    waiter.safety = setTimeout(cleanup, 45 * 60 * 1000);
  });

  // Mark this account as used for this round regardless of how the turn ended.
  autoLoop.usedThisRound.add(account.id);
  autoLoop.currentAccountId = '';
  autoLoop.currentConvoId = '';

  if (!autoLoop.active) return;

  autoLoop.status = 'sending'; // will immediately re-evaluate in next tick
  autoLoop.waitReason = '';
  _alBroadcast();

  // Small pause before moving to the next account.
  autoLoop.timer = setTimeout(_alTick, 2000);
}

// Waiters that want to know when a conversation's turn ends.
const autoLoopWaiters = [];
function notifyAutoLoopWaiters(convoId) {
  for (let i = autoLoopWaiters.length - 1; i >= 0; i--) {
    const w = autoLoopWaiters[i];
    if (w.convoId === convoId) {
      if (w.safety) clearTimeout(w.safety);
      w.resolve();
      autoLoopWaiters.splice(i, 1);
    }
  }
}

// ---- IPC ------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:getState', () => statePayload());
  ipcMain.handle('app:recentProjects', () => store.get('recentProjects') || []);
  // Offline speech-to-text model (Vosk). We ship a ~40MB tar.gz in the app and
  // hand its raw bytes to the renderer once, which turns it into a blob: URL for
  // vosk-browser's createModel(). Reading in main avoids file:// fetch/CSP issues
  // and works identically in dev and packaged (asar is disabled).
  ipcMain.handle('voice:model', () => {
    try {
      const p = path.join(__dirname, 'models', 'model-en.tar.gz');
      if (!fs.existsSync(p)) return { ok: false, error: 'Voice model not found in this build' };
      const buf = fs.readFileSync(p);
      // Return an ArrayBuffer-friendly Uint8Array; Electron structured-clones it.
      return { ok: true, bytes: buf, name: 'model-en.tar.gz' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('accounts:add', (_e, name) => { store.add(name); pushState(); return statePayload(); });
  ipcMain.handle('accounts:remove', (_e, id) => {
    // Stop any running chats that were using the account being removed.
    for (const convoId of [...state.sessions.keys()]) {
      const f = findConvo(convoId);
      if (f && f.convo.lastAccount === id) stopSession(convoId);
    }
    store.remove(id); pushState(); return statePayload();
  });
  ipcMain.handle('accounts:rename', (_e, id, name) => { store.rename(id, name); pushState(); return statePayload(); });
  // Undo a cooldown. A limit we misread parks a usable account for hours, so
  // there has to be a way back without waiting it out.
  ipcMain.handle('accounts:clearCooldown', (_e, id) => { store.clearCooldown(id); pushState(); return statePayload(); });

  // Open the OS folder picker and return the chosen path (does not mutate state;
  // the caller decides what to do with it — new chat, or re-folder this chat).
  ipcMain.handle('project:pick', async () => {
    const cur = state.currentConvoId ? findConvo(state.currentConvoId) : null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a working folder',
      properties: ['openDirectory'],
      defaultPath: (cur && cur.folder) || state.lastFolder || store.get('lastProjectDir') || os.homedir(),
    });
    if (res.canceled || !res.filePaths[0]) return '';
    state.lastFolder = res.filePaths[0];
    return res.filePaths[0];
  });
  // Move the CURRENT chat to a different folder (only while it isn't running).
  ipcMain.handle('project:choose', (_e, dir) => {
    const id = state.currentConvoId;
    const f = id && findConvo(id);
    if (!f) return { ok: false, error: 'Open or create a chat first' };
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Folder not found' };
    if (state.sessions.has(id)) return { ok: false, error: 'Stop this chat before changing its folder' };
    if (dir === f.folder) return { ok: true, folder: dir };
    // Re-home the conversation into the new folder's bucket.
    const from = getProjectData(f.folder);
    from.conversations = from.conversations.filter((x) => x.id !== id);
    if (from.currentId === id) from.currentId = from.conversations[0] ? from.conversations[0].id : '';
    saveProjectData(f.folder, from);
    const to = getProjectData(dir);
    const moved = Object.assign({}, f.convo, { sessionId: '', lastAccount: '' }); // fresh session in the new folder
    to.conversations.unshift(moved);
    to.currentId = moved.id;
    saveProjectData(dir, to);
    store.addRecentProject(dir);
    state.lastFolder = dir;
    pushState();
    return { ok: true, folder: dir };
  });

  // ---- saved workspaces (a project folder paired with an account) ----------
  ipcMain.handle('workspaces:list', () => store.listWorkspaces());
  ipcMain.handle('workspaces:add', (_e, name) => {
    const cur = state.currentConvoId ? findConvo(state.currentConvoId) : null;
    const projectDir = (cur && cur.folder) || state.lastFolder || store.get('lastProjectDir') || '';
    const accountId = (cur && cur.convo.lastAccount) || state.lastAccountId || '';
    if (!projectDir) return { ok: false, error: 'Open a chat in a folder first' };
    if (!accountId || !store.byId(accountId)) return { ok: false, error: 'Pick an account for this chat first' };
    try {
      const list = store.addWorkspace({ name: String(name || '').trim() || path.basename(projectDir), projectDir, accountId });
      return { ok: true, workspaces: list };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('workspaces:remove', (_e, id) => ({ ok: true, workspaces: store.removeWorkspace(id) }));
  // Opening a workspace starts a fresh chat in its folder on its account, so a
  // saved combo is one click rather than "pick folder, then pick account".
  ipcMain.handle('workspaces:open', (_e, id) => {
    const ws = store.getWorkspace(id);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    if (!fs.existsSync(ws.projectDir)) return { ok: false, error: 'Folder no longer exists: ' + ws.projectDir };
    const acc = store.byId(ws.accountId);
    if (!acc) return { ok: false, error: 'That account was removed' };
    store.addRecentProject(ws.projectDir);
    state.lastFolder = ws.projectDir;
    const c = createConvo(ws.projectDir);
    state.currentConvoId = c.id;
    toRenderer('chat:history', { log: [] });
    const r = useAccountForChat(ws.accountId);
    pushState();
    return r && r.ok === false ? r : { ok: true, id: c.id, folder: ws.projectDir, accountId: ws.accountId };
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'startOnLogin')) applyLoginItem(s.startOnLogin);
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'hotkeyEnabled') || Object.prototype.hasOwnProperty.call(patch, 'hotkey'))) {
      const r = applyHotkey(s);
      if (!r.ok) toRenderer('app:toast', { text: r.error, kind: 'err' });
    }
    // Permission mode and model apply to live sessions in place. Only effort
    // needs a restart, and a restart costs a full transcript re-ingest on the
    // next turn, so never do one we can avoid.
    const has = (k) => patch && Object.prototype.hasOwnProperty.call(patch, k);
    if (has('permissionMode')) for (const sess of state.sessions.values()) sess.setApprovalMode(s.permissionMode);
    if (has('model')) {
      const f = state.currentConvoId && findConvo(state.currentConvoId);
      if (f && typeof f.convo.model !== 'string') applyModelToCurrent(s.model || ''); // a per-chat override wins
    }
    if (has('autoCompact')) for (const sess of state.sessions.values()) sess.setAutoCompact(s.autoCompact !== false);
    // These are baked into the query at spawn time, so they need a restart.
    if ((has('effort') || has('maxBudgetUsd') || has('maxTurns') || has('disabledTools')) && state.sessions.has(state.currentConvoId)) {
      const f = findConvo(state.currentConvoId);
      if (f && f.convo.lastAccount) useAccountForChat(f.convo.lastAccount);
    }
    pushState();
    return s;
  });

  ipcMain.handle('chat:start', (_e, accountId) => useAccountForChat(accountId));
  ipcMain.handle('chat:getHistory', () => { const id = state.currentConvoId; if (!id || !findConvo(id)) return { log: [] }; return { log: logWithLiveTurn(id), generating: state.genConvos.has(id) }; });
  // The log is now assembled in main from session events; the renderer no longer
  // persists it. Kept as a no-op so an older renderer build can't clobber it.
  ipcMain.handle('chat:saveLog', () => ({ ok: true }));
  ipcMain.handle('chat:new', async (_e, folderArg) => {
    let folder = folderArg;
    if (!folder) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for this chat',
        properties: ['openDirectory'],
        defaultPath: state.lastFolder || store.get('lastProjectDir') || os.homedir(),
      });
      if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
      folder = res.filePaths[0];
    }
    if (!fs.existsSync(folder)) return { ok: false, error: 'Folder not found' };
    store.addRecentProject(folder);
    state.lastFolder = folder;
    const c = createConvo(folder);
    state.currentConvoId = c.id;
    // A new chat starts idle (no session) so it never disturbs running chats;
    // pick an account (or just send) to start it.
    toRenderer('chat:history', { log: [] });
    pushState();
    return { ok: true, id: c.id };
  });
  // Search message CONTENT across every chat; returns { id, snippet } per hit.
  ipcMain.handle('chat:searchAll', (_e, q) => {
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    eachConvo((c) => {
      const log = c.log || [];
      for (const m of log) {
        let text = '';
        if (m.role === 'user') text = m.text || '';
        else if (Array.isArray(m.blocks)) text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ');
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          out.push({ id: c.id, snippet: (start > 0 ? '…' : '') + text.slice(start, idx + q.length + 50).replace(/\s+/g, ' ').trim() + '…' });
          break;
        }
      }
    });
    return out.slice(0, 50);
  });
  // List files in the current chat's folder for @-mentions (bounded, ignore-aware).
  ipcMain.handle('chat:listFiles', () => {
    const id = state.currentConvoId; const f = id && findConvo(id);
    if (!f || !f.folder || !fs.existsSync(f.folder)) return [];
    const skip = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', '.parcel-cache', 'vendor', 'target', 'bin', 'obj']);
    const out = []; const CAP = 4000;
    const walk = (dir, rel, depth) => {
      if (out.length >= CAP || depth > 8) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= CAP) return;
        const rp = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (skip.has(e.name) || e.name.startsWith('.')) continue; walk(path.join(dir, e.name), rp, depth + 1); }
        else if (e.isFile()) out.push(rp);
      }
    };
    walk(f.folder, '', 0);
    return out;
  });
  // ---- conversation (history) management ----
  ipcMain.handle('chat:listConvos', () => conversationList());
  ipcMain.handle('chat:openConvo', (_e, id) => {
    const f = findConvo(id);
    if (!f) return { ok: false, error: 'Conversation not found' };
    state.currentConvoId = id;
    // Keep the folder bucket's own pointer in sync (used by migration/legacy).
    const d = getProjectData(f.folder); d.currentId = id; saveProjectData(f.folder, d);
    toRenderer('chat:history', { log: logWithLiveTurn(id), generating: state.genConvos.has(id) });
    // Replay any permission prompt this chat is waiting on (it was raised while
    // the chat was off-screen and had nowhere to show).
    const pend = state.perms.get(id);
    if (pend) for (const [rid, p] of pend) toRenderer('chat:event', { convoId: id, type: 'permission', requestId: rid, tool: p.tool, input: p.input });
    // Just view it — its session (if any) keeps running; we don't auto-start one.
    pushState();
    return { ok: true, running: state.sessions.has(id) };
  });
  ipcMain.handle('chat:renameConvo', (_e, id, title) => { updateConvoById(id, { title: String(title || '').slice(0, 80) || 'New chat' }); pushState(); return { ok: true }; });
  // Per-chat model / effort override (falls back to the global default).
  function restartCurrentIfRunning() { const id = state.currentConvoId; if (id && state.sessions.has(id)) { const f = findConvo(id); if (f && f.convo.lastAccount) useAccountForChat(f.convo.lastAccount, id); } }
  ipcMain.handle('chat:setModel', (_e, model) => { const id = state.currentConvoId; if (!id) return { ok: false }; updateConvoById(id, { model: String(model || '') }); applyModelToCurrent(String(model || '')); pushState(); return { ok: true }; });
  ipcMain.handle('chat:setEffort', (_e, effort) => { const id = state.currentConvoId; if (!id) return { ok: false }; updateConvoById(id, { effort: String(effort || '') }); restartCurrentIfRunning(); pushState(); return { ok: true }; });
  // Persist a manual drag order (sortIndex) without bumping updatedAt.
  ipcMain.handle('chat:reorder', (_e, orderedIds) => {
    if (!Array.isArray(orderedIds)) return { ok: false };
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    const m = store.get('projectChats') || {};
    for (const folder of Object.keys(m)) {
      const dd = getProjectData(folder); let changed = false;
      for (const c of dd.conversations) if (pos.has(c.id)) { c.sortIndex = pos.get(c.id); changed = true; }
      if (changed) saveProjectData(folder, dd);
    }
    pushState();
    return { ok: true };
  });
  ipcMain.handle('chat:pinConvo', (_e, id) => {
    const f = findConvo(id);
    if (f) { updateConvoById(id, { pinned: !f.convo.pinned }); pushState(); return { ok: true, pinned: !f.convo.pinned }; }
    return { ok: false };
  });
  ipcMain.handle('chat:exportMd', async (_e, id) => {
    const f = (id && findConvo(id)) || (state.currentConvoId && findConvo(state.currentConvoId));
    const c = f && f.convo;
    if (!c || !(c.log && c.log.length)) return { ok: false, error: 'Nothing to export yet' };
    const md = conversationToMarkdown(c);
    const safe = safeFileName(c.title);
    const res = await dialog.showSaveDialog(win, {
      title: 'Export conversation to Markdown',
      defaultPath: path.join(os.homedir(), safe + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    try { fs.writeFileSync(res.filePath, md); return { ok: true, path: res.filePath }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // Same serializer as the export, but straight to the clipboard — pasting a
  // conversation somewhere shouldn't require a round-trip through a file.
  ipcMain.handle('chat:copyMd', (_e, id) => {
    const f = (id && findConvo(id)) || (state.currentConvoId && findConvo(state.currentConvoId));
    const c = f && f.convo;
    if (!c || !(c.log && c.log.length)) return { ok: false, error: 'Nothing to copy yet' };
    const md = conversationToMarkdown(c);
    clipboard.writeText(md);
    return { ok: true, chars: md.length };
  });
  // Write one code block to a file the user picks.
  ipcMain.handle('app:saveText', async (_e, text, suggestedName, ext) => {
    const name = safeFileName(suggestedName || 'snippet') + (ext ? '.' + String(ext).replace(/^\./, '') : '.txt');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save code block',
      defaultPath: path.join(state.lastFolder || os.homedir(), name),
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try { fs.writeFileSync(res.filePath, String(text == null ? '' : text)); return { ok: true, path: res.filePath }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('chat:deleteConvo', (_e, id) => {
    const f = findConvo(id);
    if (!f) return { ok: false };
    stopSession(id); // kill its session if running
    state.pending.delete(id); // stopSession leaves pending alone (resume needs it); a delete does not
    const d = getProjectData(f.folder);
    const idx = d.conversations.findIndex((x) => x.id === id);
    d.conversations = d.conversations.filter((x) => x.id !== id);
    if (d.currentId === id) d.currentId = d.conversations[0] ? d.conversations[0].id : '';
    saveProjectData(f.folder, d);
    // Hold the removed chat in memory so Undo can put it back where it was.
    // Only the most recent delete is recoverable, which is what the toast offers.
    state.lastDeleted = { folder: f.folder, index: Math.max(0, idx), convo: f.convo, wasCurrent: state.currentConvoId === id };
    if (state.currentConvoId === id) {
      // Show the next most-recent chat (across any folder), or an empty state.
      const next = conversationList().conversations[0];
      state.currentConvoId = next ? next.id : '';
      const nf = state.currentConvoId ? findConvo(state.currentConvoId) : null;
      toRenderer('chat:history', { log: (nf && nf.convo.log) || [] });
    }
    pushState();
    return { ok: true, undoable: true, title: f.convo.title || 'Chat' };
  });
  // Put the last deleted chat back. Its session is gone, but the transcript and
  // sessionId survive, so it resumes exactly like any other reopened chat.
  ipcMain.handle('chat:undoDelete', () => {
    const del = state.lastDeleted;
    if (!del) return { ok: false, error: 'Nothing to restore' };
    state.lastDeleted = null;
    const d = getProjectData(del.folder);
    if (d.conversations.some((x) => x.id === del.convo.id)) return { ok: false, error: 'That chat is already back' };
    d.conversations.splice(Math.min(del.index, d.conversations.length), 0, del.convo);
    saveProjectData(del.folder, d);
    if (del.wasCurrent) {
      state.currentConvoId = del.convo.id;
      d.currentId = del.convo.id;
      saveProjectData(del.folder, d);
      toRenderer('chat:history', { log: del.convo.log || [] });
    }
    pushState();
    return { ok: true, id: del.convo.id, title: del.convo.title || 'Chat' };
  });
  ipcMain.handle('chat:send', (_e, text, attachments) => {
    const id = state.currentConvoId;
    const f = id && findConvo(id);
    if (!f) return { ok: false, error: 'Open or create a chat first' };
    // Sanitize inputs (defense-in-depth): bound the prompt length and cap the
    // attachment list to a reasonable number of real, existing files. NOTE: the
    // renderer is trusted (local content only, navigation locked down), so this
    // is not a path-traversal boundary — it just rejects malformed input.
    text = String(text == null ? '' : text).slice(0, 100000);
    attachments = (Array.isArray(attachments) ? attachments : [])
      .filter((p) => typeof p === 'string' && p.length < 4096 && fs.existsSync(p))
      .slice(0, 20);
    let session = state.sessions.get(id);
    if (!session || !session.alive) {
      // Restart (or resume) this chat's session on its own account.
      const accountId = f.convo.lastAccount || state.lastAccountId;
      if (!accountId) return { ok: false, error: 'Choose an account to start this chat' };
      const r = startSession(id, accountId, f.convo.sessionId || '');
      if (!r.ok) return r;
      session = state.sessions.get(id);
    }
    appendUserMessage(id, text, attachments || []);
    if (text.trim()) store.addPrompt(text.trim()); // composer ↑ history
    state.pending.set(id, { text, attachments: attachments || [] }); // for auto-continue on limit
    session.send(text, attachments || []);
    state.genConvos.add(id);
    pushState();
    return { ok: true };
  });
  ipcMain.handle('chat:interrupt', (_e, id) => { const s = state.sessions.get(id || state.currentConvoId); if (s) s.interrupt(); return { ok: true }; });
  // Where this chat's context window is actually going, item by item.
  ipcMain.handle('chat:contextUsage', async (_e, id) => {
    const s = state.sessions.get(id || state.currentConvoId);
    if (!s) return { ok: false, error: 'Start this chat first — there is no live session to measure.' };
    const data = await s.contextUsage();
    if (!data) return { ok: false, error: 'This Claude version does not report a context breakdown.' };
    return { ok: true, data };
  });
  // Summarize the chat so far and drop the intermediate reasoning.
  ipcMain.handle('chat:compact', (_e, id) => {
    const cid = id || state.currentConvoId;
    const s = state.sessions.get(cid);
    if (!s) return { ok: false, error: 'Start this chat first' };
    if (!s.compact()) return { ok: false, error: 'This chat has ended' };
    state.genConvos.add(cid);
    pushState();
    return { ok: true };
  });
  ipcMain.handle('chat:permission', (_e, requestId, allow, message, convoId) => {
    const cid = convoId || state.currentConvoId;
    const s = state.sessions.get(cid);
    if (s) s.respondPermission(requestId, allow, message);
    // Clear ONLY this chat's pending prompt. (Request ids can repeat across
    // parallel chats, so never touch other convos' maps.)
    const m = state.perms.get(cid);
    if (m && m.delete(requestId) && m.size === 0) state.perms.delete(cid);
    return { ok: true };
  });
  ipcMain.handle('chat:switch', (_e, targetId) => switchAccount(targetId));
  // Carry a chat to another account and continue the turn a usage limit cut off.
  ipcMain.handle('chat:continueOn', (_e, convoId, targetId) => {
    state.switchCount += 1;
    const id = convoId || state.currentConvoId;
    // Persist the live session id before teardown so --resume works.
    const live = id && state.sessions.get(id);
    if (live && live.sessionId) updateConvoById(id, { sessionId: live.sessionId });
    return resumeInterrupted(id, targetId);
  });
  ipcMain.handle('chat:stop', (_e, id) => { stopSession(id || state.currentConvoId); pushState(); return { ok: true }; });
  // Composer ↑/↓ history — recently sent prompts, newest first.
  ipcMain.handle('app:promptHistory', () => store.getPromptHistory());
  // Re-run the last user message of the current chat (Regenerate).
  ipcMain.handle('chat:regenerate', () => {
    const id = state.currentConvoId;
    const f = id && findConvo(id);
    if (!f) return { ok: false, error: 'No chat selected' };
    const log = Array.isArray(f.convo.log) ? f.convo.log : [];
    let lastUser = null;
    for (let i = log.length - 1; i >= 0; i--) { if (log[i].role === 'user') { lastUser = log[i]; break; } }
    if (!lastUser) return { ok: false, error: 'Nothing to regenerate yet' };
    let session = state.sessions.get(id);
    if (!session || !session.alive) {
      const accountId = f.convo.lastAccount || state.lastAccountId;
      if (!accountId) return { ok: false, error: 'Choose an account first' };
      const r = startSession(id, accountId, f.convo.sessionId || '');
      if (!r.ok) return r;
      session = state.sessions.get(id);
    }
    const text = 'Please try that again' + (lastUser.text ? ` — my last request was:\n\n${lastUser.text}` : '.');
    state.pending.set(id, { text, attachments: [] });
    session.send(text, []);
    state.genConvos.add(id);
    pushState();
    return { ok: true };
  });
  // Duplicate a chat (fresh session, same folder, copied transcript).
  ipcMain.handle('chat:duplicate', (_e, id) => {
    const f = (id && findConvo(id)) || (state.currentConvoId && findConvo(state.currentConvoId));
    if (!f) return { ok: false };
    const d = getProjectData(f.folder);
    const copy = {
      id: genId(),
      title: (f.convo.title && f.convo.title !== 'New chat' ? f.convo.title + ' (copy)' : 'New chat'),
      sessionId: '', lastAccount: '',
      log: Array.isArray(f.convo.log) ? f.convo.log.map((m) => ({ ...m })) : [],
      pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    };
    d.conversations.unshift(copy);
    d.currentId = copy.id;
    saveProjectData(f.folder, d);
    state.currentConvoId = copy.id;
    toRenderer('chat:history', { log: copy.log });
    pushState();
    return { ok: true, id: copy.id };
  });

  // ---- backup / restore (accounts + settings; no credentials) ----
  ipcMain.handle('app:export', async () => {
    const res = await dialog.showSaveDialog(win, { title: 'Export Claude Multi config', defaultPath: path.join(os.homedir(), 'claude-multi-backup.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { ok: false };
    try { fs.writeFileSync(res.filePath, store.exportData()); return { ok: true, path: res.filePath }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // Export EVERY chat (across all folders) to Markdown files in a chosen folder.
  ipcMain.handle('app:exportAll', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a folder to export all chats to', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const dir = res.filePaths[0]; let count = 0;
    eachConvo((c) => {
      if (!(c.log && c.log.length)) return;
      const safe = safeFileName(c.title);
      let file = path.join(dir, safe + '.md'); let n = 2;
      while (fs.existsSync(file)) file = path.join(dir, safe + ' (' + (n++) + ').md');
      try { fs.writeFileSync(file, conversationToMarkdown(c)); count++; } catch { /* skip */ }
    });
    return { ok: true, count, path: dir };
  });
  ipcMain.handle('app:import', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Import Claude Multi config', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    try { store.importData(fs.readFileSync(res.filePaths[0], 'utf8')); pushState(); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('login:start', (_e, accountId) => startLogin(accountId));
  ipcMain.handle('login:stop', () => stopLogin());
  ipcMain.on('login:input', (_e, data) => sendToHost({ t: 'input', d: Buffer.from(data, 'utf8').toString('base64') }));
  ipcMain.on('login:resize', (_e, cols, rows) => sendToHost({ t: 'resize', cols, rows }));

  ipcMain.handle('app:pickFiles', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach files or images',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return [];
    return res.filePaths || [];
  });
  // Save an image sitting on the clipboard (e.g. a screenshot) to a temp file
  // and return its path so it can be attached like any other file.
  ipcMain.handle('app:pasteImage', () => {
    try {
      const img = clipboard.readImage();
      if (!img || img.isEmpty()) return { ok: false, error: 'No image on the clipboard' };
      const dir = path.join(os.tmpdir(), 'claude-multi-paste');
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, 'paste-' + Date.now() + '.png');
      fs.writeFileSync(p, img.toPNG());
      return { ok: true, path: p };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // Write the raw bytes of a pasted image blob (already decoded by the renderer
  // from the paste event) to a temp file and return its path. This is the
  // reliable image-paste path: the browser hands us the actual pixels, so it
  // works for screenshots, "copy image" from a browser, and image files alike —
  // regardless of which clipboard format the OS used.
  ipcMain.handle('app:savePastedImage', (_e, bytes, ext) => {
    try {
      if (!bytes || !bytes.length) return { ok: false, error: 'Empty image' };
      const safeExt = /^(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : 'png';
      const dir = path.join(os.tmpdir(), 'claude-multi-paste');
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, 'paste-' + Date.now() + '-' + Math.floor(Math.random() * 1e4) + '.' + safeExt);
      fs.writeFileSync(p, Buffer.from(bytes));
      return { ok: true, path: p };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle('app:openConfigDir', (_e, id) => { const a = store.byId(id); if (a) shell.openPath(a.configDir); return true; });
  ipcMain.handle('app:info', () => ({
    version: require('../package.json').version,
    electron: process.versions.electron,
    node: process.versions.node,
    claudePath: findClaudePath(),
  }));
  ipcMain.handle('app:checkUpdate', (_e, force) => checkForUpdate(!!force));
  ipcMain.handle('app:updateInfo', () => state.update);

  // ---- auto-loop (scheduled prompt) ----------------------------------------
  // Lets users fully utilize their 5-hour usage windows automatically.
  // When active, the loop:
  //   1. Sends the saved prompt on the first available account.
  //   2. Waits for the turn to finish.
  //   3. Waits for all accounts to cool down (if any are cooling).
  //   4. Picks the next available account and repeats from step 1.
  // If every account is cooling, it waits for the soonest reset then tries again.
  ipcMain.handle('autoloop:start', (_e, { prompt, accountIds, folder }) => {
    return autoLoopStart(prompt, accountIds, folder);
  });
  ipcMain.handle('autoloop:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the project folder for auto-loop chats',
      properties: ['openDirectory'],
      defaultPath: state.lastFolder || store.get('lastProjectDir') || os.homedir(),
    });
    if (res.canceled || !res.filePaths[0]) return '';
    return res.filePaths[0];
  });
  ipcMain.handle('autoloop:stop', () => { autoLoopStop(); return { ok: true }; });
  ipcMain.handle('autoloop:status', () => autoLoopStatus());
}

// ---- global summon hotkey -------------------------------------------------
// Optional and off by default: a system-wide accelerator that raises the window
// (or hides it when it already has focus). Pairs with minimize-to-tray.
let hotkeyRegistered = '';
function toggleWindowVisibility() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
// Returns { ok } / { ok:false, error } so Settings can report a clash with
// another app instead of silently doing nothing.
function applyHotkey(settings) {
  const s = settings || store.getSettings();
  if (hotkeyRegistered) {
    try { globalShortcut.unregister(hotkeyRegistered); } catch { /* noop */ }
    hotkeyRegistered = '';
  }
  const accel = String(s.hotkey || '').trim();
  if (!s.hotkeyEnabled || !accel) return { ok: true, registered: false };
  try {
    if (!globalShortcut.register(accel, toggleWindowVisibility)) {
      return { ok: false, error: 'Another app already owns ' + accel };
    }
    hotkeyRegistered = accel;
    return { ok: true, registered: true, accelerator: accel };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- system tray + start-on-login ----------------------------------------
let tray = null;
let isQuitting = false;

function applyLoginItem(enabled) {
  try { app.setLoginItemSettings({ openAtLogin: !!enabled }); } catch { /* unsupported */ }
}
function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else { win.show(); win.focus(); }
}
function buildTrayMenu() {
  const accounts = store.list();
  const accountInUse = (id) => [...state.sessions.keys()].some((cid) => { const f = findConvo(cid); return f && f.convo.lastAccount === id; });
  const hasCurrent = !!(state.currentConvoId && findConvo(state.currentConvoId));
  const accItems = accounts.length
    ? accounts.map((a) => ({
      label: (accountInUse(a.id) ? '● ' : '') + a.name + (a.loggedIn ? '' : ' (not signed in)'),
      enabled: a.loggedIn && hasCurrent,
      click: () => { if (win) { win.show(); win.focus(); } if (hasCurrent && a.loggedIn) useAccountForChat(a.id); },
    }))
    : [{ label: 'No accounts yet', enabled: false }];
  const loopItems = autoLoop.active
    ? [
      { label: `🔄 Auto-loop: Round ${autoLoop.roundNum + 1} · ${autoLoop.sendCount} sends`, enabled: false },
      { label: autoLoop.waitReason || autoLoop.status, enabled: false },
      { label: 'Stop auto-loop', click: () => { autoLoopStop(); if (win) { win.show(); win.focus(); } } },
    ]
    : [{ label: '🔄 Auto-loop: off', enabled: false }];
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide window' : 'Show window', click: toggleWindow },
    { type: 'separator' },
    ...loopItems,
    { type: 'separator' },
    { label: 'Use account', submenu: accItems },
    { type: 'separator' },
    { label: 'Quit Claude Multi', click: () => { isQuitting = true; app.quit(); } },
  ]);
}
function updateTray() { if (tray) { try { tray.setContextMenu(buildTrayMenu()); } catch { /* noop */ } } }
function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png'));
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Claude Multi');
    tray.on('click', toggleWindow);
    updateTray();
  } catch (e) { console.error('[tray]', e); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 560,
    backgroundColor: '#f5f4f0',
    title: 'Claude Multi',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Allow the renderer to use the microphone (for voice-to-text dictation).
  // Speech recognition / getUserMedia otherwise get auto-denied in Electron.
  try {
    const ses = win.webContents.session;
    const MEDIA = new Set(['media', 'audioCapture', 'microphone']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(MEDIA.has(permission)));
    if (ses.setPermissionCheckHandler) ses.setPermissionCheckHandler((_wc, permission) => MEDIA.has(permission));
  } catch { /* older Electron — best effort */ }
  // Security lockdown: this is a local-file app, so any attempt to navigate the
  // window away or open a popup is treated as hostile. External http(s) links
  // open in the user's real browser instead of inside the app.
  const isLocal = (u) => { try { return new URL(u).protocol === 'file:'; } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => { if (!isLocal(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!isLocal(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Refuse to attach any preload script we didn't ship, and block webview embeds.
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.CM_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    win.webContents.openDevTools({ mode: 'detach' });
  }
  // Minimize to tray instead of quitting, when enabled.
  win.on('close', (e) => {
    if (!isQuitting && tray && store.getSettings().minimizeToTray) {
      e.preventDefault(); win.hide(); updateTray();
    }
  });
  win.on('focus', () => { try { win.flashFrame(false); } catch { /* noop */ } });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'accounts.json'));
  state.lastFolder = store.get('lastProjectDir') || '';
  // Restore the most-recently-updated chat as the one on screen.
  const convosAtBoot = conversationList().conversations;
  const first = convosAtBoot[0];
  state.currentConvoId = first ? first.id : '';
  // Seed "last used account" from the most-recent chat that has one, so a fresh
  // chat after a restart defaults to the account you last used rather than
  // forcing a pick before you can send.
  const seededAcc = convosAtBoot.find((c) => c.accountId)?.accountId;
  if (seededAcc) state.lastAccountId = seededAcc;
  Menu.setApplicationMenu(null);
  applyLoginItem(store.getSettings().startOnLogin);
  registerIpc();
  createWindow();
  createTray();
  applyHotkey(store.getSettings());
  // Best-effort, and late enough that it never competes with first paint.
  setTimeout(() => { checkForUpdate(false).catch(() => {}); }, 4000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) { win.show(); win.focus(); }
  });
  app.on('before-quit', () => {
    isQuitting = true;
    try { globalShortcut.unregisterAll(); } catch { /* noop */ }
    try { if (store) store.flush(); } catch { /* noop */ }
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray if the user chose minimize-to-tray.
  if (!isQuitting && store && store.getSettings().minimizeToTray && tray) return;
  stopAllSessions();
  sendToHost({ t: 'kill' });
  if (host) { try { host.kill(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
