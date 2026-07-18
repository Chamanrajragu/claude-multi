// Electron main process (chat rebuild).
// Responsibilities:
//   - account store + settings + project folder
//   - CHAT: drive Claude via the Agent SDK (src/chat.js), one session per
//     active account, with in-chat permission prompts, usage-limit detection,
//     and account switching that carries the conversation across accounts.
//   - LOGIN: a small interactive terminal (pty-host) used only to run /login
//     once per account (OAuth can't run in headless chat mode).
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { Store, readAccountInfo } = require('./accounts');
const cooldown = require('./cooldown');
const { ChatSession, extractResetAt } = require('./chat');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_COOLDOWN_MS = 5 * 3600e3;
let win = null;
let store = null;

// ---- runtime state --------------------------------------------------------
const state = {
  activeAccountId: null,
  projectDir: '',
  session: null,      // ChatSession
  running: false,     // a chat session process is alive
  generating: false,  // a turn is in progress
  switchCount: 0,
  pendingSend: null,  // message queued while a session is (re)starting
};

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
  store.set('projectChats', m);
}
function currentConvo(project) {
  const d = getProjectData(project);
  let c = d.conversations.find((x) => x.id === d.currentId);
  if (!c && d.conversations.length) { c = d.conversations[0]; d.currentId = c.id; saveProjectData(project, d); }
  return c || null;
}
function createConvo(project) {
  const d = getProjectData(project);
  const c = { id: genId(), title: 'New chat', sessionId: '', lastAccount: '', log: [], createdAt: Date.now(), updatedAt: Date.now() };
  d.conversations.unshift(c);
  d.currentId = c.id;
  saveProjectData(project, d);
  return c;
}
function ensureConvo(project) { return currentConvo(project) || createConvo(project); }
function updateConvo(project, id, patch) {
  const d = getProjectData(project);
  const c = d.conversations.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch, { updatedAt: Date.now() });
  saveProjectData(project, d);
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

function conversationList(project) {
  const d = getProjectData(project);
  const items = d.conversations.map((c) => ({ id: c.id, title: c.title || 'New chat', updatedAt: c.updatedAt || 0, pinned: !!c.pinned, empty: !(c.log && c.log.length) }));
  // Pinned conversations float to the top (stable within each group).
  items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return { conversations: items, currentConvoId: d.currentId };
}
function statePayload() {
  const conv = conversationList(state.projectDir);
  return {
    accounts: store.list(),
    activeAccountId: state.activeAccountId,
    projectDir: state.projectDir,
    running: state.running,
    generating: state.generating,
    switchCount: state.switchCount,
    settings: store.getSettings(),
    availableCount: cooldown.availableCount(store.list()),
    conversations: conv.conversations,
    currentConvoId: conv.currentConvoId,
  };
}
function pushState() { toRenderer('app:state', statePayload()); updateTray(); }

// ---- chat engine ----------------------------------------------------------
function stopSession() {
  if (state.session) { try { state.session.stop(); } catch { /* noop */ } state.session = null; }
  state.running = false;
  state.generating = false;
}

function startSession(accountId, resumeId) {
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  if (!state.projectDir || !fs.existsSync(state.projectDir)) return { ok: false, error: 'Pick a project folder first' };
  const info = readAccountInfo(acc.configDir);
  if (!info.loggedIn) return { ok: false, error: 'not_logged_in' };

  stopSession();
  state.activeAccountId = accountId;
  const s = store.getSettings();
  const session = new ChatSession({
    configDir: acc.configDir,
    cwd: state.projectDir,
    model: s.model || '',
    effort: s.effort || '',
    resumeId: resumeId || '',
    permissionMode: 'default', // "ask each time" via canUseTool
    onEvent: (ev) => onChatEvent(accountId, ev),
  });
  state.session = session;
  state.running = true;
  store.recordLaunch(accountId);
  store.setProjectAccount(state.projectDir, accountId);
  session.start();
  pushState();
  return { ok: true };
}

// The single entry point for "use account X for the current project chat".
// Carries the existing conversation onto X (transcript copy + resume) so the
// chat continues seamlessly across accounts, then tells the UI to render the
// stored history.
function useAccountForChat(accountId) {
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  if (!state.projectDir) return { ok: false, error: 'Pick a project folder first' };
  if (!readAccountInfo(acc.configDir).loggedIn) return { ok: false, error: 'not_logged_in' };

  const project = state.projectDir;
  const chat = ensureConvo(project);
  let resumeId = '';
  let carried = false;
  if (chat.sessionId) {
    if (chat.lastAccount && chat.lastAccount !== accountId) {
      const fromAcc = store.byId(chat.lastAccount);
      if (fromAcc && carryTranscripts(fromAcc.configDir, acc.configDir, project)) {
        resumeId = chat.sessionId;
        carried = true;
      }
    } else {
      resumeId = chat.sessionId; // same account — resume its own conversation
    }
  }
  const res = startSession(accountId, resumeId);
  if (!res.ok) return res;
  updateConvo(project, chat.id, { lastAccount: accountId });
  toRenderer('chat:history', { log: chat.log || [] });
  return { ok: true, carried };
}

function onChatEvent(accountId, ev) {
  // Ignore late events from a session we've already switched away from.
  if (accountId !== state.activeAccountId) return;
  const convo = currentConvo(state.projectDir);
  switch (ev.type) {
    case 'ready':
      if (ev.sessionId && convo) updateConvo(state.projectDir, convo.id, { sessionId: ev.sessionId, lastAccount: accountId });
      break;
    case 'turn_end':
      state.generating = false;
      if (ev.sessionId && convo) updateConvo(state.projectDir, convo.id, { sessionId: ev.sessionId, lastAccount: accountId });
      pushState();
      break;
    case 'limit':
      state.generating = false;
      handleLimit(accountId, ev);
      break;
    case 'error':
    case 'auth_failed':
      state.generating = false;
      pushState();
      break;
    case 'exit':
      state.generating = false;
      if (state.session && !state.session.alive) state.running = false;
      pushState();
      break;
    default:
      break;
  }
  // Forward every event to the chat UI.
  toRenderer('chat:event', ev);
}

function handleLimit(accountId, ev) {
  const until = ev.resetAt || (Date.now() + DEFAULT_COOLDOWN_MS);
  store.setCooldown(accountId, until, ev.text || '');
  const next = cooldown.pickNext(store.list(), accountId);
  const cur = store.byId(accountId);
  notify('Usage limit reached',
    (cur ? cur.name : 'Account') + ' hit its limit.' + (next ? ` Switching to ${next.name}.` : ' No other account available.'));
  toRenderer('chat:limit', {
    accountId,
    resetAt: until,
    text: ev.text || '',
    autoSwitch: store.getSettings().autoSwitch,
    next: next ? { id: next.id, name: next.name, email: next.email } : null,
  });
  pushState();
}

// Copy the active project's transcripts from one account to another so the
// switched-to account can resume the same conversation.
function carryTranscripts(fromDir, toDir, projectDir) {
  try {
    const enc = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    const src = path.join(fromDir, 'projects', enc);
    const dst = path.join(toDir, 'projects', enc);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      return true;
    }
  } catch (e) { console.error('[carryTranscripts]', e); }
  return false;
}

function switchAccount(targetId) {
  // Persist the live session id before we tear it down, so the carry works even
  // if no turn has completed yet.
  const convo = currentConvo(state.projectDir);
  if (state.session && state.session.sessionId && convo) {
    updateConvo(state.projectDir, convo.id, { sessionId: state.session.sessionId, lastAccount: state.activeAccountId });
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

function startHost() {
  if (host) return;
  host = spawn('node', [path.join(__dirname, 'pty-host.js')], {
    cwd: APP_ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', onHostData);
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (d) => console.error('[pty-host]', d));
  host.on('exit', () => { host = null; });
}
function sendToHost(obj) { if (host && host.stdin.writable) host.stdin.write(JSON.stringify(obj) + '\n'); }
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
  stopSession(); // don't run chat + login at once
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

// ---- IPC ------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:getState', () => statePayload());
  ipcMain.handle('accounts:add', (_e, name) => { store.add(name); pushState(); return statePayload(); });
  ipcMain.handle('accounts:remove', (_e, id) => {
    if (state.activeAccountId === id) stopSession();
    store.remove(id); pushState(); return statePayload();
  });
  ipcMain.handle('accounts:rename', (_e, id, name) => { store.rename(id, name); pushState(); return statePayload(); });

  ipcMain.handle('project:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose your project / working folder',
      properties: ['openDirectory'],
      defaultPath: state.projectDir || store.get('lastProjectDir') || os.homedir(),
    });
    if (res.canceled || !res.filePaths[0]) return state.projectDir;
    state.projectDir = res.filePaths[0];
    store.addRecentProject(state.projectDir);
    pushState();
    return state.projectDir;
  });
  ipcMain.handle('project:choose', (_e, dir) => {
    if (dir && fs.existsSync(dir) && dir !== state.projectDir) {
      stopSession();
      state.projectDir = dir; state.activeAccountId = null;
      store.addRecentProject(dir); pushState();
      const c = currentConvo(dir);
      toRenderer('chat:history', { log: (c && c.log) || [] });
    }
    return state.projectDir;
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'startOnLogin')) applyLoginItem(s.startOnLogin);
    // Model / effort changes take effect by restarting the live session (which
    // resumes the same conversation).
    const touchesEngine = patch && (Object.prototype.hasOwnProperty.call(patch, 'model') || Object.prototype.hasOwnProperty.call(patch, 'effort'));
    if (touchesEngine && state.running && state.activeAccountId) useAccountForChat(state.activeAccountId);
    pushState();
    return s;
  });

  ipcMain.handle('chat:start', (_e, accountId) => useAccountForChat(accountId));
  ipcMain.handle('chat:getHistory', () => { const c = currentConvo(state.projectDir); return { log: (c && c.log) || [] }; });
  ipcMain.handle('chat:saveLog', (_e, log) => {
    const c = currentConvo(state.projectDir);
    if (c) {
      const patch = { log: Array.isArray(log) ? log : [] };
      if ((!c.title || c.title === 'New chat') && patch.log.length) patch.title = titleFromLog(patch.log);
      updateConvo(state.projectDir, c.id, patch);
      pushState(); // refresh sidebar titles
    }
    return { ok: true };
  });
  ipcMain.handle('chat:new', () => {
    if (!state.projectDir) return { ok: false, error: 'Pick a project folder first' };
    createConvo(state.projectDir);
    toRenderer('chat:history', { log: [] });
    if (state.activeAccountId && readAccountInfo((store.byId(state.activeAccountId) || {}).configDir || '').loggedIn) {
      startSession(state.activeAccountId, ''); // fresh session for the new convo
    } else {
      stopSession();
    }
    pushState();
    return { ok: true };
  });
  // ---- conversation (history) management ----
  ipcMain.handle('chat:listConvos', () => conversationList(state.projectDir));
  ipcMain.handle('chat:openConvo', (_e, id) => {
    const d = getProjectData(state.projectDir);
    const c = d.conversations.find((x) => x.id === id);
    if (!c) return { ok: false, error: 'Conversation not found' };
    d.currentId = id; saveProjectData(state.projectDir, d);
    toRenderer('chat:history', { log: c.log || [] });
    // Continue it on the active (or its last) account if we can.
    const acctId = state.activeAccountId || c.lastAccount;
    if (acctId && readAccountInfo((store.byId(acctId) || {}).configDir || '').loggedIn) useAccountForChat(acctId);
    else { stopSession(); pushState(); }
    return { ok: true };
  });
  ipcMain.handle('chat:renameConvo', (_e, id, title) => { updateConvo(state.projectDir, id, { title: String(title || '').slice(0, 80) || 'New chat' }); pushState(); return { ok: true }; });
  ipcMain.handle('chat:pinConvo', (_e, id) => {
    const d = getProjectData(state.projectDir);
    const c = d.conversations.find((x) => x.id === id);
    if (c) { updateConvo(state.projectDir, id, { pinned: !c.pinned }); pushState(); return { ok: true, pinned: !c.pinned }; }
    return { ok: false };
  });
  ipcMain.handle('chat:exportMd', async (_e, id) => {
    const d = getProjectData(state.projectDir);
    const c = d.conversations.find((x) => x.id === (id || d.currentId)) || currentConvo(state.projectDir);
    if (!c || !(c.log && c.log.length)) return { ok: false, error: 'Nothing to export yet' };
    const md = conversationToMarkdown(c);
    const safe = String(c.title || 'chat').replace(/[^a-z0-9\-_ ]+/gi, '').trim().slice(0, 40) || 'chat';
    const res = await dialog.showSaveDialog(win, {
      title: 'Export conversation to Markdown',
      defaultPath: path.join(os.homedir(), safe + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    try { fs.writeFileSync(res.filePath, md); return { ok: true, path: res.filePath }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('chat:deleteConvo', (_e, id) => {
    const d = getProjectData(state.projectDir);
    d.conversations = d.conversations.filter((x) => x.id !== id);
    if (d.currentId === id) { d.currentId = d.conversations[0] ? d.conversations[0].id : ''; if (!d.currentId) stopSession(); }
    saveProjectData(state.projectDir, d);
    const c = currentConvo(state.projectDir);
    toRenderer('chat:history', { log: (c && c.log) || [] });
    pushState();
    return { ok: true };
  });
  ipcMain.handle('chat:send', (_e, text, attachments) => {
    if (!state.activeAccountId) return { ok: false, error: 'No active account' };
    ensureConvo(state.projectDir);
    if (!state.session || !state.session.alive) {
      const c = currentConvo(state.projectDir);
      const r = startSession(state.activeAccountId, (c && c.sessionId) || '');
      if (!r.ok) return r;
    }
    state.session.send(text, attachments || []);
    state.generating = true;
    pushState();
    return { ok: true };
  });
  ipcMain.handle('chat:interrupt', () => { if (state.session) state.session.interrupt(); return { ok: true }; });
  ipcMain.handle('chat:permission', (_e, requestId, allow, message) => {
    if (state.session) state.session.respondPermission(requestId, allow, message);
    return { ok: true };
  });
  ipcMain.handle('chat:switch', (_e, targetId) => switchAccount(targetId));
  ipcMain.handle('chat:stop', () => { stopSession(); pushState(); return { ok: true }; });

  // ---- backup / restore (accounts + settings; no credentials) ----
  ipcMain.handle('app:export', async () => {
    const res = await dialog.showSaveDialog(win, { title: 'Export Claude Multi config', defaultPath: path.join(os.homedir(), 'claude-multi-backup.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { ok: false };
    try { fs.writeFileSync(res.filePath, store.exportData()); return { ok: true, path: res.filePath }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
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
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle('app:openConfigDir', (_e, id) => { const a = store.byId(id); if (a) shell.openPath(a.configDir); return true; });
  ipcMain.handle('app:info', () => ({
    version: require('../package.json').version,
    electron: process.versions.electron,
    node: process.versions.node,
    claudePath: findClaudePath(),
  }));
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
  const accItems = accounts.length
    ? accounts.map((a) => ({
      label: (a.id === state.activeAccountId && state.running ? '● ' : '') + a.name + (a.loggedIn ? '' : ' (not signed in)'),
      enabled: a.loggedIn && !!state.projectDir,
      click: () => { if (win) { win.show(); win.focus(); } if (state.projectDir && a.loggedIn) useAccountForChat(a.id); },
    }))
    : [{ label: 'No accounts yet', enabled: false }];
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide window' : 'Show window', click: toggleWindow },
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
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'accounts.json'));
  state.projectDir = store.get('lastProjectDir') || '';
  Menu.setApplicationMenu(null);
  applyLoginItem(store.getSettings().startOnLogin);
  registerIpc();
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) { win.show(); win.focus(); }
  });
  app.on('before-quit', () => { isQuitting = true; });
});

app.on('window-all-closed', () => {
  // Keep running in the tray if the user chose minimize-to-tray.
  if (!isQuitting && store && store.getSettings().minimizeToTray && tray) return;
  stopSession();
  sendToHost({ t: 'kill' });
  if (host) { try { host.kill(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
