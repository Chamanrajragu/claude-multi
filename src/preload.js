// Secure bridge between the renderer and the main process (chat rebuild).
const { contextBridge, ipcRenderer, clipboard, webUtils, webFrame } = require('electron');

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
  newChat: (folder) => ipcRenderer.invoke('chat:new', folder),
  sendMessage: (text, attachments) => ipcRenderer.invoke('chat:send', text, attachments),
  interrupt: (convoId) => ipcRenderer.invoke('chat:interrupt', convoId),
  respondPermission: (requestId, allow, message, convoId) => ipcRenderer.invoke('chat:permission', requestId, allow, message, convoId),
  switchAccount: (targetId) => ipcRenderer.invoke('chat:switch', targetId),
  continueOn: (convoId, targetId) => ipcRenderer.invoke('chat:continueOn', convoId, targetId),
  stopChat: (convoId) => ipcRenderer.invoke('chat:stop', convoId),
  regenerate: () => ipcRenderer.invoke('chat:regenerate'),
  duplicateConvo: (id) => ipcRenderer.invoke('chat:duplicate', id),
  reorderConvos: (ids) => ipcRenderer.invoke('chat:reorder', ids),
  setChatModel: (model) => ipcRenderer.invoke('chat:setModel', model),
  setChatEffort: (effort) => ipcRenderer.invoke('chat:setEffort', effort),
  promptHistory: () => ipcRenderer.invoke('app:promptHistory'),

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
  // Electron 32+ removed the non-standard File.path property; webUtils is the
  // supported way to get the real on-disk path of a dropped / pasted File.
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  // Persist raw bytes (a pasted screenshot / copied image blob) to a temp file
  // and get back a path we can attach like any other file. This works even when
  // the OS clipboard holds the image in a format Electron's clipboard.readImage
  // can't decode (e.g. an image file copied from Explorer).
  savePastedImage: (bytes, ext) => ipcRenderer.invoke('app:savePastedImage', bytes, ext),
  exportConfig: () => ipcRenderer.invoke('app:export'),
  exportAllChats: () => ipcRenderer.invoke('app:exportAll'),
  importConfig: () => ipcRenderer.invoke('app:import'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openConfigDir: (id) => ipcRenderer.invoke('app:openConfigDir', id),
  appInfo: () => ipcRenderer.invoke('app:info'),
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => clipboard.writeText(text),
  // UI zoom (whole window). delta 0 resets. Returns the new zoom level.
  zoom: (delta) => { const z = delta === 0 ? 0 : Math.max(-3, Math.min(5, webFrame.getZoomLevel() + delta)); webFrame.setZoomLevel(z); return z; },
  setZoom: (z) => { try { webFrame.setZoomLevel(Math.max(-3, Math.min(5, z || 0))); } catch { /* noop */ } },
  searchAll: (q) => ipcRenderer.invoke('chat:searchAll', q),

  // ---- events (main -> renderer) ----
  onChat: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
  onHistory: (cb) => ipcRenderer.on('chat:history', (_e, info) => cb(info)),
  onState: (cb) => ipcRenderer.on('app:state', (_e, s) => cb(s)),
  onLimit: (cb) => ipcRenderer.on('chat:limit', (_e, info) => cb(info)),
  onLoginData: (cb) => ipcRenderer.on('login:data', (_e, d) => cb(d)),
  onLoginExit: (cb) => ipcRenderer.on('login:exit', (_e, code) => cb(code)),
  onLoginSuccess: (cb) => ipcRenderer.on('login:success', (_e, info) => cb(info)),
});
