// Secure bridge between the renderer and the main process (chat rebuild).
const { contextBridge, ipcRenderer, clipboard, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  // ---- state / accounts / project / settings ----
  getState: () => ipcRenderer.invoke('app:getState'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', name),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  clearCooldown: (id) => ipcRenderer.invoke('accounts:clearCooldown', id),
  contextUsage: (id) => ipcRenderer.invoke('chat:contextUsage', id),
  compact: (id) => ipcRenderer.invoke('chat:compact', id),
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
  undoDeleteConvo: () => ipcRenderer.invoke('chat:undoDelete'),
  pinConvo: (id) => ipcRenderer.invoke('chat:pinConvo', id),
  exportMd: (id) => ipcRenderer.invoke('chat:exportMd', id),
  copyMd: (id) => ipcRenderer.invoke('chat:copyMd', id),
  saveText: (text, name, ext) => ipcRenderer.invoke('app:saveText', text, name, ext),

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
  checkUpdate: (force) => ipcRenderer.invoke('app:checkUpdate', force),
  updateInfo: () => ipcRenderer.invoke('app:updateInfo'),
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => clipboard.writeText(text),
  // UI zoom (whole window). delta 0 resets. Returns the new zoom level.
  zoom: (delta) => { const z = delta === 0 ? 0 : Math.max(-3, Math.min(5, webFrame.getZoomLevel() + delta)); webFrame.setZoomLevel(z); return z; },
  setZoom: (z) => { try { webFrame.setZoomLevel(Math.max(-3, Math.min(5, z || 0))); } catch { /* noop */ } },
  searchAll: (q) => ipcRenderer.invoke('chat:searchAll', q),
  listFiles: () => ipcRenderer.invoke('chat:listFiles'),
  recentProjects: () => ipcRenderer.invoke('app:recentProjects'),

  // ---- saved workspaces (project folder + account) ----
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: (name) => ipcRenderer.invoke('workspaces:add', name),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  openWorkspace: (id) => ipcRenderer.invoke('workspaces:open', id),

  // ---- events (main -> renderer) ----
  onChat: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
  onHistory: (cb) => ipcRenderer.on('chat:history', (_e, info) => cb(info)),
  onState: (cb) => ipcRenderer.on('app:state', (_e, s) => cb(s)),
  onLimit: (cb) => ipcRenderer.on('chat:limit', (_e, info) => cb(info)),
  onLoginData: (cb) => ipcRenderer.on('login:data', (_e, d) => cb(d)),
  onLoginExit: (cb) => ipcRenderer.on('login:exit', (_e, code) => cb(code)),
  onLoginSuccess: (cb) => ipcRenderer.on('login:success', (_e, info) => cb(info)),

  // ---- auto-loop (scheduled prompt) ----
  autoLoopStart: (opts) => ipcRenderer.invoke('autoloop:start', opts),
  autoLoopStop: () => ipcRenderer.invoke('autoloop:stop'),
  autoLoopStatus: () => ipcRenderer.invoke('autoloop:status'),
  autoLoopPickFolder: () => ipcRenderer.invoke('autoloop:pickFolder'),
  onAutoLoopStatus: (cb) => ipcRenderer.on('autoloop:status', (_e, s) => cb(s)),
  onToast: (cb) => ipcRenderer.on('app:toast', (_e, t) => cb(t)),
  onUpdate: (cb) => ipcRenderer.on('app:update', (_e, u) => cb(u)),
});
