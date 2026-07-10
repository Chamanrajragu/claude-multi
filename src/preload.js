// Secure bridge between the renderer and the main process.
const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  // account management
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', name),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  clearCooldown: (id) => ipcRenderer.invoke('accounts:clearCooldown', id),

  // project folder
  pickProject: () => ipcRenderer.invoke('project:pick'),
  getProject: () => ipcRenderer.invoke('project:get'),
  chooseProject: (dir) => ipcRenderer.invoke('project:choose', dir),
  setProjectAccount: (dir, accountId) => ipcRenderer.invoke('project:setAccount', dir, accountId),

  // session control
  launch: (accountId) => ipcRenderer.invoke('session:launch', accountId),
  switchTo: (targetId) => ipcRenderer.invoke('session:switch', targetId),
  stop: () => ipcRenderer.invoke('session:stop'),
  restart: () => ipcRenderer.invoke('session:restart'),
  status: () => ipcRenderer.invoke('session:status'),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickClaude: () => ipcRenderer.invoke('settings:pickClaude'),

  // misc
  openConfigDir: (id) => ipcRenderer.invoke('app:openConfigDir', id),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  exportConfig: () => ipcRenderer.invoke('app:export'),
  importConfig: () => ipcRenderer.invoke('app:import'),

  // clipboard (Electron native — works in the file:// renderer)
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => clipboard.writeText(text),

  // terminal I/O
  sendInput: (data) => ipcRenderer.send('term:input', data),
  resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  onData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('term:exit', (_e, code) => cb(code)),

  // events
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onLimitReached: (cb) => ipcRenderer.on('limit:reached', (_e, info) => cb(info)),
  onLimitApproaching: (cb) => ipcRenderer.on('limit:approaching', (_e, info) => cb(info)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
});
