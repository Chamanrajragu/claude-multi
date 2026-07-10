// Electron main process (chat rebuild).
// Responsibilities:
//   - account store + settings + project folder
//   - CHAT: drive Claude via the Agent SDK (src/chat.js), one session per
//     active account, with in-chat permission prompts, usage-limit detection,
//     and account switching that carries the conversation across accounts.
//   - LOGIN: a small interactive terminal (pty-host) used only to run /login
//     once per account (OAuth can't run in headless chat mode).
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu } = require('electron');
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

// A conversation is scoped to a PROJECT, not an account. We persist, per
// project: the Claude session id (so any account can --resume it), which
// account last ran it (so we know where to copy the transcript FROM when
// switching), and the display log (so the UI shows full history on any account
// and after a restart).
function getProjectChat(project) {
  const m = store.get('projectChats') || {};
  return m[project] || { sessionId: '', lastAccount: '', log: [] };
}
function saveProjectChat(project, patch) {
  if (!project) return;
  const m = store.get('projectChats') || {};
  m[project] = Object.assign({ sessionId: '', lastAccount: '', log: [] }, m[project] || {}, patch);
  store.set('projectChats', m);
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

function statePayload() {
  return {
    accounts: store.list(),
    activeAccountId: state.activeAccountId,
    projectDir: state.projectDir,
    running: state.running,
    generating: state.generating,
    switchCount: state.switchCount,
    settings: store.getSettings(),
    availableCount: cooldown.availableCount(store.list()),
  };
}
function pushState() { toRenderer('app:state', statePayload()); }

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
  const chat = getProjectChat(project);
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
  saveProjectChat(project, { lastAccount: accountId });
  toRenderer('chat:history', { log: getProjectChat(project).log || [] });
  return { ok: true, carried };
}

function onChatEvent(accountId, ev) {
  // Ignore late events from a session we've already switched away from.
  if (accountId !== state.activeAccountId) return;
  switch (ev.type) {
    case 'ready':
      if (ev.sessionId) saveProjectChat(state.projectDir, { sessionId: ev.sessionId, lastAccount: accountId });
      break;
    case 'turn_end':
      state.generating = false;
      if (ev.sessionId) saveProjectChat(state.projectDir, { sessionId: ev.sessionId, lastAccount: accountId });
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
  if (state.session && state.session.sessionId) {
    saveProjectChat(state.projectDir, { sessionId: state.session.sessionId, lastAccount: state.activeAccountId });
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
      toRenderer('chat:history', { log: getProjectChat(dir).log || [] });
    }
    return state.projectDir;
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch);
    // Model / effort changes take effect by restarting the live session (which
    // resumes the same conversation).
    const touchesEngine = patch && (Object.prototype.hasOwnProperty.call(patch, 'model') || Object.prototype.hasOwnProperty.call(patch, 'effort'));
    if (touchesEngine && state.running && state.activeAccountId) useAccountForChat(state.activeAccountId);
    pushState();
    return s;
  });

  ipcMain.handle('chat:start', (_e, accountId) => useAccountForChat(accountId));
  ipcMain.handle('chat:getHistory', () => ({ log: getProjectChat(state.projectDir).log || [] }));
  ipcMain.handle('chat:saveLog', (_e, log) => { saveProjectChat(state.projectDir, { log: Array.isArray(log) ? log : [] }); return { ok: true }; });
  ipcMain.handle('chat:new', () => {
    if (!state.activeAccountId) return { ok: false, error: 'No active account' };
    saveProjectChat(state.projectDir, { sessionId: '', log: [] });
    const r = startSession(state.activeAccountId, '');
    toRenderer('chat:history', { log: [] });
    return r;
  });
  ipcMain.handle('chat:send', (_e, text) => {
    if (!state.activeAccountId) return { ok: false, error: 'No active account' };
    // Restart a dead session (e.g. after a recoverable error). send() queues the
    // message even while the SDK is still loading, so no ready-gating is needed.
    if (!state.session || !state.session.alive) {
      const chat = getProjectChat(state.projectDir);
      const r = startSession(state.activeAccountId, chat.sessionId || '');
      if (!r.ok) return r;
    }
    state.session.send(text);
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

  ipcMain.handle('login:start', (_e, accountId) => startLogin(accountId));
  ipcMain.handle('login:stop', () => stopLogin());
  ipcMain.on('login:input', (_e, data) => sendToHost({ t: 'input', d: Buffer.from(data, 'utf8').toString('base64') }));
  ipcMain.on('login:resize', (_e, cols, rows) => sendToHost({ t: 'resize', cols, rows }));

  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle('app:openConfigDir', (_e, id) => { const a = store.byId(id); if (a) shell.openPath(a.configDir); return true; });
  ipcMain.handle('app:info', () => ({
    version: require('../package.json').version,
    electron: process.versions.electron,
    node: process.versions.node,
    claudePath: findClaudePath(),
  }));
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
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'accounts.json'));
  state.projectDir = store.get('lastProjectDir') || '';
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) { win.show(); win.focus(); }
  });
});

app.on('window-all-closed', () => {
  stopSession();
  sendToHost({ t: 'kill' });
  if (host) { try { host.kill(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
