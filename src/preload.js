// Secure bridge between the renderer and the main process (chat rebuild).
const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  // ---- state / accounts / project / settings ----
  getState: () => ipcRenderer.invoke('app:getState'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', name),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  chooseProject: (dir) => ipcRenderer.invoke('project:choose', dir),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ---- chat ----
  startChat: (accountId) => ipcRenderer.invoke('chat:start', accountId),
  getHistory: () => ipcRenderer.invoke('chat:getHistory'),
  saveLog: (log) => ipcRenderer.invoke('chat:saveLog', log),
  newChat: () => ipcRenderer.invoke('chat:new'),
  sendMessage: (text, attachments) => ipcRenderer.invoke('chat:send', text, attachments),
  interrupt: () => ipcRenderer.invoke('chat:interrupt'),
  respondPermission: (requestId, allow, message) => ipcRenderer.invoke('chat:permission', requestId, allow, message),
  switchAccount: (targetId) => ipcRenderer.invoke('chat:switch', targetId),
  stopChat: () => ipcRenderer.invoke('chat:stop'),

  // ---- conversations (history) ----
  listConvos: () => ipcRenderer.invoke('chat:listConvos'),
  openConvo: (id) => ipcRenderer.invoke('chat:openConvo', id),
  renameConvo: (id, title) => ipcRenderer.invoke('chat:renameConvo', id, title),
  deleteConvo: (id) => ipcRenderer.invoke('chat:deleteConvo', id),
  pinConvo: (id) => ipcRenderer.invoke('chat:pinConvo', id),
  exportMd: (id) => ipcRenderer.invoke('chat:exportMd', id),

  // ---- login (interactive terminal, one-time per account) ----
  loginStart: (accountId) => ipcRenderer.invoke('login:start', accountId),
  loginInput: (data) => ipcRenderer.send('login:input', data),
  loginResize: (cols, rows) => ipcRenderer.send('login:resize', cols, rows),
  loginStop: () => ipcRenderer.invoke('login:stop'),

  // ---- misc ----
  pickFiles: () => ipcRenderer.invoke('app:pickFiles'),
  pasteImage: () => ipcRenderer.invoke('app:pasteImage'),
  exportConfig: () => ipcRenderer.invoke('app:export'),
  importConfig: () => ipcRenderer.invoke('app:import'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openConfigDir: (id) => ipcRenderer.invoke('app:openConfigDir', id),
  appInfo: () => ipcRenderer.invoke('app:info'),
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => clipboard.writeText(text),

  // ---- events (main -> renderer) ----
  onChat: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
  onHistory: (cb) => ipcRenderer.on('chat:history', (_e, info) => cb(info)),
  onState: (cb) => ipcRenderer.on('app:state', (_e, s) => cb(s)),
  onLimit: (cb) => ipcRenderer.on('chat:limit', (_e, info) => cb(info)),
  onLoginData: (cb) => ipcRenderer.on('login:data', (_e, d) => cb(d)),
  onLoginExit: (cb) => ipcRenderer.on('login:exit', (_e, code) => cb(code)),
  onLoginSuccess: (cb) => ipcRenderer.on('login:success', (_e, info) => cb(info)),
});
