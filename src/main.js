// Electron main process: owns the window, the account store, and the pty-host
// child. It relays terminal I/O between the renderer and the pty host, scans
// the output for usage limits, tracks per-account cooldowns, and performs
// account switches (carrying the current conversation transcript to the new
// account so `claude --continue` can resume it).
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { Store } = require('./accounts');
const { classify } = require('./limits');
const cooldown = require('./cooldown');
const pkg = require('../package.json');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_COOLDOWN_MS = 5 * 3600e3; // Claude session limits reset ~5h later
let win = null;
let store = null;

// ---- pty host management -------------------------------------------------
let host = null;          // child_process handle
let hostBuf = '';         // line buffer for host stdout

// Current session state
const session = {
  accountId: null,
  projectDir: '',
  running: false,
  cols: 80,
  rows: 24,
  scanBuf: '',            // rolling stripped-output buffer for limit detection
  limitHit: false,        // guard against re-firing within one session
  startedAt: 0,           // ms timestamp of current session start
  switchCount: 0,         // how many auto/manual switches this run
};

let loginSnapshot = '';   // to detect login changes while polling

function findClaudePath() {
  const override = store.getSettings().claudePath || store.get('claudePath');
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const out = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not found */ }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

// Split a user-provided extra-args string into argv, honouring simple quotes.
function parseArgs(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function startHost() {
  if (host) return;
  // Run under system Node so the prebuilt pty binary (Node ABI) loads cleanly.
  host = spawn('node', [path.join(__dirname, 'pty-host.js')], {
    cwd: APP_ROOT,
    shell: true, // resolve `node` from PATH on Windows
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', onHostData);
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (d) => console.error('[pty-host]', d));
  host.on('exit', () => {
    host = null;
    if (session.running) {
      session.running = false;
      if (win) win.webContents.send('term:data', '\r\n\x1b[31m[launcher] terminal host stopped unexpectedly\x1b[0m\r\n');
      sendStatus();
    }
  });
}

function sendToHost(obj) {
  if (host && host.stdin.writable) host.stdin.write(JSON.stringify(obj) + '\n');
}

function onHostData(chunk) {
  hostBuf += chunk;
  let idx;
  while ((idx = hostBuf.indexOf('\n')) >= 0) {
    const line = hostBuf.slice(0, idx);
    hostBuf = hostBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleHostMessage(msg);
  }
}

function handleHostMessage(msg) {
  switch (msg.t) {
    case 'ready':
      session.running = true;
      session.startedAt = Date.now();
      updateTitle();
      sendStatus();
      break;
    case 'data': {
      const text = Buffer.from(msg.d, 'base64').toString('utf8');
      if (win) win.webContents.send('term:data', text);
      scanForLimit(text);
      break;
    }
    case 'exit':
      session.running = false;
      updateTitle();
      if (win) win.webContents.send('term:exit', msg.code);
      sendStatus();
      break;
    case 'error':
      if (win) win.webContents.send('term:data', `\r\n\x1b[31m[launcher] ${msg.message}\x1b[0m\r\n`);
      break;
    default:
      break;
  }
}

function notify(title, body) {
  try {
    if (!store.getSettings().notify) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  } catch { /* noop */ }
}

function scanForLimit(text) {
  if (session.limitHit) return;
  session.scanBuf = (session.scanBuf + text).slice(-6000);
  const { kind, resetHint, resetAt } = classify(session.scanBuf);
  if (kind === 'reached') {
    session.limitHit = true;
    const until = resetAt || Date.now() + DEFAULT_COOLDOWN_MS;
    store.setCooldown(session.accountId, until, resetHint);
    const next = cooldown.pickNext(store.list(), session.accountId);
    const cur = store.byId(session.accountId);
    const settings = store.getSettings();
    notify(
      'Usage limit reached',
      (cur ? (cur.name) : 'Account') + ' hit its limit.' +
      (next ? ` Switching to ${next.name}.` : ' No other account available.'),
    );
    if (win) {
      win.webContents.send('limit:reached', {
        accountId: session.accountId,
        resetHint,
        resetAt: until,
        autoSwitch: settings.autoSwitch,
        autoSwitchDelay: settings.autoSwitchDelay,
        next: next ? { id: next.id, name: next.name, email: next.email } : null,
      });
    }
    sendStatus();
  } else if (kind === 'approaching') {
    if (win) win.webContents.send('limit:approaching', { resetHint });
  }
}

// ---- launching / switching ------------------------------------------------
function launchAccount(accountId, { continueConv = false } = {}) {
  const acc = store.byId(accountId);
  if (!acc) return { ok: false, error: 'Account not found' };
  const projectDir = session.projectDir || store.get('lastProjectDir');
  if (!projectDir || !fs.existsSync(projectDir)) {
    return { ok: false, error: 'Pick a project folder first' };
  }
  const claudePath = findClaudePath();
  startHost();
  const args = [];
  if (continueConv) args.push('--continue');
  args.push(...parseArgs(store.getSettings().extraArgs));
  session.accountId = accountId;
  session.projectDir = projectDir;
  session.scanBuf = '';
  session.limitHit = false;
  store.addRecentProject(projectDir);
  sendToHost({
    t: 'spawn',
    file: claudePath,
    args,
    cwd: projectDir,
    cols: session.cols,
    rows: session.rows,
    env: { CLAUDE_CONFIG_DIR: acc.configDir, FORCE_COLOR: '1' },
  });
  return { ok: true };
}

// Copy the active project's conversation transcripts from one account's config
// dir to another, so `claude --continue` on the new account resumes the chat.
// Claude Code stores them at <configDir>/projects/<encoded-cwd>/*.jsonl, where
// the cwd is encoded by replacing every non-alphanumeric char with '-'.
function syncTranscripts(fromDir, toDir, projectDir) {
  try {
    const enc = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    const src = path.join(fromDir, 'projects', enc);
    const dst = path.join(toDir, 'projects', enc);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      return true;
    }
  } catch (e) {
    console.error('[syncTranscripts]', e);
  }
  return false;
}

function switchAccount(targetId) {
  const fromAcc = store.byId(session.accountId);
  const toAcc = store.byId(targetId);
  if (!toAcc) return { ok: false, error: 'Target account not found' };

  // Kill current session and give it a moment to release the transcript file.
  sendToHost({ t: 'kill' });
  session.running = false;

  const projectDir = session.projectDir;
  let carried = false;
  if (fromAcc && toAcc && fromAcc.id !== toAcc.id) {
    carried = syncTranscripts(fromAcc.configDir, toAcc.configDir, projectDir);
  }

  session.switchCount += 1;
  notify('Switched account', `Now running as ${toAcc.name}` + (carried ? ' · conversation carried over' : ''));

  setTimeout(() => {
    launchAccount(targetId, { continueConv: carried });
  }, 500);

  return { ok: true, carried };
}

function updateTitle() {
  if (!win) return;
  const acc = store.byId(session.accountId);
  const base = 'Claude Multi';
  win.setTitle(session.running && acc ? `${base} — ${acc.name}` : base);
}

function statusPayload() {
  return {
    accountId: session.accountId,
    projectDir: session.projectDir,
    running: session.running,
    startedAt: session.startedAt,
    switchCount: session.switchCount,
    accounts: store.list(),
    recentProjects: store.get('recentProjects') || [],
    settings: store.getSettings(),
    availableCount: cooldown.availableCount(store.list()),
  };
}

function sendStatus() {
  if (win) win.webContents.send('status', statusPayload());
}

// Poll account login state so the UI reflects a fresh /login without a restart.
function startLoginPolling() {
  setInterval(() => {
    if (!win) return;
    const snap = JSON.stringify(store.list().map((a) => [a.id, a.loggedIn, a.email, a.cooldownUntil]));
    if (snap !== loginSnapshot) {
      loginSnapshot = snap;
      sendStatus();
    }
  }, 3000);
}

// ---- IPC ------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('accounts:list', () => store.list());
  ipcMain.handle('accounts:add', (_e, name) => { store.add(name); return store.list(); });
  ipcMain.handle('accounts:remove', (_e, id) => { store.remove(id); return store.list(); });
  ipcMain.handle('accounts:rename', (_e, id, name) => { store.rename(id, name); return store.list(); });
  ipcMain.handle('accounts:clearCooldown', (_e, id) => { store.clearCooldown(id); sendStatus(); return store.list(); });

  ipcMain.handle('project:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose your project / working folder',
      properties: ['openDirectory'],
      defaultPath: store.get('lastProjectDir') || os.homedir(),
    });
    if (res.canceled || !res.filePaths[0]) return session.projectDir || store.get('lastProjectDir') || '';
    const dir = res.filePaths[0];
    store.addRecentProject(dir);
    session.projectDir = dir;
    sendStatus();
    return dir;
  });
  ipcMain.handle('project:get', () => session.projectDir || store.get('lastProjectDir') || '');
  ipcMain.handle('project:choose', (_e, dir) => {
    if (dir && fs.existsSync(dir)) { session.projectDir = dir; store.addRecentProject(dir); sendStatus(); }
    return session.projectDir;
  });

  ipcMain.handle('session:launch', (_e, accountId) => launchAccount(accountId, { continueConv: false }));
  ipcMain.handle('session:switch', (_e, targetId) => switchAccount(targetId));
  ipcMain.handle('session:stop', () => { sendToHost({ t: 'kill' }); return { ok: true }; });
  ipcMain.handle('session:restart', () => {
    if (!session.accountId) return { ok: false, error: 'No active account' };
    sendToHost({ t: 'kill' });
    setTimeout(() => launchAccount(session.accountId, { continueConv: true }), 400);
    return { ok: true };
  });
  ipcMain.handle('session:status', () => statusPayload());

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch);
    sendStatus();
    return s;
  });
  ipcMain.handle('settings:pickClaude', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Locate the claude executable',
      properties: ['openFile'],
      defaultPath: path.join(os.homedir(), '.local', 'bin'),
    });
    if (res.canceled || !res.filePaths[0]) return store.getSettings().claudePath || '';
    store.setSettings({ claudePath: res.filePaths[0] });
    return res.filePaths[0];
  });
  ipcMain.handle('app:openConfigDir', (_e, id) => {
    const acc = store.byId(id);
    if (acc) shell.openPath(acc.configDir);
    return true;
  });
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });
  ipcMain.handle('app:info', () => ({
    version: pkg.version,
    electron: process.versions.electron,
    node: process.versions.node,
    claudePath: findClaudePath(),
    platform: process.platform,
  }));

  ipcMain.on('term:input', (_e, data) => {
    sendToHost({ t: 'input', d: Buffer.from(data, 'utf8').toString('base64') });
  });
  ipcMain.on('term:resize', (_e, cols, rows) => {
    session.cols = cols; session.rows = rows;
    sendToHost({ t: 'resize', cols, rows });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 880,
    minHeight: 540,
    backgroundColor: '#12131a',
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

  // Opt-in debugging: `CM_DEBUG=1 npm start` surfaces renderer console output
  // in the terminal and opens devtools.
  if (process.env.CM_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Warn before quitting during a live session.
  win.on('close', (e) => {
    if (session.running && store.getSettings().confirmClose) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Quit Claude Multi?',
        message: 'A Claude Code session is still running.',
        detail: 'Quitting will end the current session.',
      });
      if (choice === 1) { e.preventDefault(); return; }
    }
    sendToHost({ t: 'kill' });
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'accounts.json'));
  // Restore the last project folder so status/badge reflect it on boot
  // (otherwise session:status returns '' and clobbers the renderer's value).
  session.projectDir = store.get('lastProjectDir') || '';
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  startLoginPolling();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sendToHost({ t: 'kill' });
  if (host) { try { host.kill(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
