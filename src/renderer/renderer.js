/* global marked, DOMPurify, Terminal, FitAddon */
(() => {
const cc = window.cc;
const $ = (id) => document.getElementById(id);

marked.setOptions({ gfm: true, breaks: true });
function renderMarkdown(text) {
  try { return DOMPurify.sanitize(marked.parse(text || '')); }
  catch { return escapeHtml(text || ''); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- state ----
let state = { accounts: [], activeAccountId: null, projectDir: '', running: false, generating: false, settings: {} };

function activeAccount() { return state.accounts.find((a) => a.id === state.activeAccountId); }
function fmtCountdown(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${t}s`;
}
function accView(a) {
  const now = Date.now();
  if (!a.loggedIn) return { dot: 'off', cls: 'out', label: 'Not signed in', canUse: false, needLogin: true };
  if (a.id === state.activeAccountId && state.running) return { dot: 'active', cls: 'ready', label: 'Active', canUse: true };
  if (a.cooldownUntil && a.cooldownUntil > now) return { dot: 'cool', cls: 'cool', label: 'Cooling · resets ' + fmtCountdown(a.cooldownUntil - now), canUse: true };
  return { dot: 'ready', cls: 'ready', label: a.email || 'Ready', canUse: true };
}

// ---- rendering: sidebar ----
function renderProject() {
  $('projectName').textContent = state.projectDir ? baseName(state.projectDir) : 'Choose a folder…';
  $('projectBtn').title = state.projectDir || 'Choose the folder Claude works in';
}
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

function renderAccounts() {
  const list = $('accountList');
  list.innerHTML = '';
  if (!state.accounts.length) {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:12.5px;color:var(--muted);padding:8px 4px;line-height:1.5;';
    e.textContent = 'No accounts yet. Click ＋ to add your first one.';
    list.appendChild(e);
    return;
  }
  for (const a of state.accounts) {
    const v = accView(a);
    const card = document.createElement('div');
    card.className = 'account-card' + (a.id === state.activeAccountId ? ' active' : '');

    const top = document.createElement('div'); top.className = 'ac-top';
    const av = document.createElement('div'); av.className = 'ac-avatar';
    av.textContent = (a.name || a.email || '?').trim().charAt(0).toUpperCase();
    const info = document.createElement('div'); info.className = 'ac-info';
    const nm = document.createElement('div'); nm.className = 'ac-name'; nm.textContent = a.name;
    const st = document.createElement('div'); st.className = 'ac-status ' + v.cls; st.textContent = v.label;
    info.appendChild(nm); info.appendChild(st);
    const dot = document.createElement('div'); dot.className = 'dot ' + v.dot;
    top.appendChild(av); top.appendChild(info); top.appendChild(dot);

    const actions = document.createElement('div'); actions.className = 'ac-actions';
    if (v.needLogin) {
      const login = document.createElement('button'); login.className = 'btn-login'; login.textContent = 'Log in';
      login.onclick = (e) => { e.stopPropagation(); openLogin(a); };
      actions.appendChild(login);
    } else {
      const use = document.createElement('button');
      const isActive = a.id === state.activeAccountId && state.running;
      use.textContent = isActive ? 'In use' : 'Use';
      use.disabled = isActive;
      use.onclick = (e) => { e.stopPropagation(); useAccount(a.id); };
      actions.appendChild(use);
    }
    const more = document.createElement('button'); more.className = 'btn-more'; more.textContent = '⋯';
    more.onclick = (e) => { e.stopPropagation(); accountMenu(a, e.currentTarget); };
    actions.appendChild(more);

    if (v.canUse && !(a.id === state.activeAccountId && state.running)) {
      card.onclick = () => useAccount(a.id);
    }
    card.appendChild(top); card.appendChild(actions);
    list.appendChild(card);
  }
}

function renderTop() {
  const a = activeAccount();
  const dot = $('activeDot');
  if (a && state.running) {
    $('activeName').textContent = a.name;
    $('activeMeta').textContent = (a.email || '') + (state.projectDir ? '  ·  ' + baseName(state.projectDir) : '');
    dot.className = 'status-dot ' + (state.generating ? 'busy' : 'live');
  } else {
    $('activeName').textContent = a ? a.name : 'No account selected';
    $('activeMeta').textContent = state.projectDir ? baseName(state.projectDir) : '';
    dot.className = 'status-dot off';
  }
  renderModelLabel();
}
const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultrathink']];
function labelFor(list, id, fallback) { const f = list.find((x) => x[0] === id); return f ? f[1] : fallback; }
function renderModelLabel() {
  const m = (state.settings && state.settings.model) || '';
  const eff = (state.settings && state.settings.effort) || 'medium';
  const ml = $('modelChipLabel'); if (ml) ml.textContent = labelFor(MODELS, m, 'Default');
  const el = $('effortChipLabel'); if (el) el.textContent = labelFor(EFFORTS, eff, 'Medium');
}
function renderAll() { renderProject(); renderAccounts(); renderTop(); updateComposer(); }

function updateComposer() {
  const canChat = state.running;
  $('sendBtn').disabled = !canChat || !$('input').value.trim();
  $('input').placeholder = canChat ? 'Message Claude…  (Enter to send · Shift+Enter for a new line)'
    : (state.accounts.some((a) => a.loggedIn) ? 'Click an account to start chatting…' : 'Add and log in an account to start…');
  $('genBar').classList.toggle('hidden', !state.generating);
}

// ---- transcript ----
// `convo` is the serialisable conversation log for the current project. It is
// the source of truth for display, persisted to main on every turn, and
// re-rendered whenever we switch accounts / reopen a project — so the history
// is always shown no matter which account is active.
const transcript = $('transcript');
let turn = null;
let convo = [];

function clearTranscript() { transcript.innerHTML = ''; turn = null; }
function nearBottom() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120; }
function scrollDown(force) { if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight; }
function wrap(el) { const w = document.createElement('div'); w.className = 'msg-wrap'; w.appendChild(el); transcript.appendChild(w); return w; }
function hideWelcome() { const w = $('welcome'); if (w) w.classList.add('hidden'); }
function persist() { try { cc.saveLog(convo); } catch { /* noop */ } }

// throttled markdown flush
const pending = new Set(); let rafQ = false;
function schedule(el) { pending.add(el); if (!rafQ) { rafQ = true; requestAnimationFrame(flush); } }
function flush() {
  rafQ = false;
  for (const el of pending) el.innerHTML = renderMarkdown(el._raw || '');
  pending.clear();
  scrollDown();
}

function toolSummary(name, input) {
  if (!input) return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.prompt) return String(input.prompt).slice(0, 80);
  const s = JSON.stringify(input); return s === '{}' ? '' : s.slice(0, 80);
}

// ---- DOM builders (used for both live streaming and history replay) ----
function appendUserDOM(text) {
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  msg.appendChild(b); wrap(msg);
}
function makeToolCard(block) {
  const card = document.createElement('div'); card.className = 'tool-card';
  const head = document.createElement('div'); head.className = 'tool-head';
  const stateTxt = block.state === 'running' ? 'running…' : (block.state === 'err' ? 'error' : 'done');
  const stateCls = block.state === 'running' ? '' : (block.state === 'err' ? 'err' : 'ok');
  head.innerHTML = `<span class="tool-ico">⚙</span><span class="tool-name">${escapeHtml(block.name)}</span>` +
    `<span class="tool-summary">${escapeHtml(block.summary || '')}</span>` +
    `<span class="tool-state ${stateCls}">${stateTxt}</span>`;
  const body = document.createElement('div'); body.className = 'tool-body hidden';
  body.textContent = block.output || '';
  head.onclick = () => body.classList.toggle('hidden');
  card.appendChild(head); card.appendChild(body);
  return { card, head, body };
}
function appendAssistantDOM(blocks) {
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'assistant-avatar'; av.textContent = '✦';
  const body = document.createElement('div'); body.className = 'assistant-body';
  for (const blk of blocks || []) {
    if (blk.type === 'text') { const d = document.createElement('div'); d.className = 'md'; d.innerHTML = renderMarkdown(blk.text || ''); body.appendChild(d); }
    else if (blk.type === 'tool') { body.appendChild(makeToolCard(blk).card); }
  }
  msg.appendChild(av); msg.appendChild(body); wrap(msg);
}

// Re-render the entire conversation from a stored log.
function renderHistory(log) {
  clearTranscript();
  convo = Array.isArray(log) ? log.map((m) => ({ ...m })) : [];
  if (!convo.length) { const w = $('welcome'); if (w) w.classList.remove('hidden'); return; }
  for (const m of convo) {
    if (m.role === 'user') appendUserDOM(m.text);
    else appendAssistantDOM(m.blocks);
  }
  scrollDown(true);
}

// ---- live streaming ----
function addUserMessage(text) {
  convo.push({ role: 'user', text });
  appendUserDOM(text);
  persist();
  scrollDown(true);
}
function ensureTurn() {
  if (turn) return turn;
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'assistant-avatar'; av.textContent = '✦';
  const body = document.createElement('div'); body.className = 'assistant-body';
  msg.appendChild(av); msg.appendChild(body); wrap(msg);
  turn = { body, curText: null, curRaw: '', curBlock: null, tools: new Map(), thinkEl: null, blocks: [] };
  return turn;
}
function newTextBlock() {
  const t = ensureTurn();
  const el = document.createElement('div'); el.className = 'md';
  t.body.appendChild(el); t.curText = el; t.curRaw = '';
  t.curBlock = { type: 'text', text: '' }; t.blocks.push(t.curBlock);
  return el;
}
function onAssistantDelta(text) {
  const t = ensureTurn();
  if (!t.curText) newTextBlock();
  t.curRaw += text; t.curText._raw = t.curRaw; t.curBlock.text = t.curRaw; schedule(t.curText);
}
function onAssistantText(text) {
  const t = ensureTurn();
  if (!t.curText) newTextBlock();
  t.curText._raw = text; t.curText.innerHTML = renderMarkdown(text);
  t.curBlock.text = text;
  t.curText = null; t.curRaw = ''; t.curBlock = null;
  scrollDown();
}
function onThinking(text) {
  const t = ensureTurn();
  if (!t.thinkEl) {
    const d = document.createElement('details'); d.className = 'think';
    const s = document.createElement('summary'); s.textContent = 'Thinking';
    const body = document.createElement('div'); body.className = 'think-body';
    d.appendChild(s); d.appendChild(body); t.body.appendChild(d);
    t.thinkEl = body; t.thinkRaw = '';
  }
  t.thinkRaw = (t.thinkRaw || '') + text; t.thinkEl.textContent = t.thinkRaw; scrollDown();
}
function onToolUse(id, name, input) {
  const t = ensureTurn();
  t.curText = null; t.curBlock = null;
  const block = { type: 'tool', name, summary: toolSummary(name, input), state: 'running', output: typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input) };
  t.blocks.push(block);
  const { card, head, body } = makeToolCard(block);
  t.body.appendChild(card);
  t.tools.set(id, { block, head, body });
  scrollDown();
}
function onToolResult(id, isError, text) {
  const t = turn; if (!t) return;
  const entry = t.tools.get(id); if (!entry) return;
  entry.block.state = isError ? 'err' : 'ok';
  const stateEl = entry.head.querySelector('.tool-state');
  stateEl.textContent = isError ? 'error' : 'done';
  stateEl.className = 'tool-state ' + (isError ? 'err' : 'ok');
  if (text) { entry.block.output = (typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 8000); entry.body.textContent = entry.block.output; }
  scrollDown();
}
function onErrorLine(text) {
  hideWelcome();
  const el = document.createElement('div'); el.className = 'err-line'; el.textContent = '⚠ ' + text;
  if (turn && turn.body) turn.body.appendChild(el);
  else wrap(el);
  scrollDown(true);
}
function endTurn() {
  if (turn && turn.blocks.length) {
    convo.push({ role: 'assistant', blocks: turn.blocks });
    persist();
  }
  turn = null;
}

// ---- permission cards ----
function onPermission(requestId, tool, input) {
  const t = ensureTurn();
  t.curText = null;
  const card = document.createElement('div'); card.className = 'perm-card';
  const title = document.createElement('div'); title.className = 'perm-title';
  title.innerHTML = `Claude wants to use <span class="ptool">${escapeHtml(tool)}</span>`;
  const detail = document.createElement('div'); detail.className = 'perm-detail';
  detail.textContent = summarizePerm(tool, input);
  const actions = document.createElement('div'); actions.className = 'perm-actions';
  const allow = document.createElement('button'); allow.className = 'perm-allow'; allow.textContent = 'Allow';
  const deny = document.createElement('button'); deny.className = 'perm-deny'; deny.textContent = 'Deny';
  const resolve = (ok) => {
    cc.respondPermission(requestId, ok);
    actions.remove();
    const r = document.createElement('div'); r.className = 'perm-resolved ' + (ok ? 'allow' : 'deny');
    r.textContent = ok ? '✓ Allowed' : '✕ Denied';
    card.appendChild(r);
  };
  allow.onclick = () => resolve(true);
  deny.onclick = () => resolve(false);
  actions.appendChild(allow); actions.appendChild(deny);
  card.appendChild(title); card.appendChild(detail); card.appendChild(actions);
  t.body.appendChild(card);
  scrollDown(true);
}
function summarizePerm(tool, input) {
  if (!input) return '';
  if (input.command) return '$ ' + input.command;
  if (input.file_path) return input.file_path + (input.content ? '\n\n' + String(input.content).slice(0, 600) : '');
  return JSON.stringify(input, null, 2).slice(0, 800);
}

// ---- chat events from main ----
cc.onChat((ev) => {
  switch (ev.type) {
    case 'assistant_delta': onAssistantDelta(ev.text); break;
    case 'assistant_text': onAssistantText(ev.text); break;
    case 'thinking': onThinking(ev.text); break;
    case 'tool_use': onToolUse(ev.id, ev.name, ev.input); break;
    case 'tool_result': onToolResult(ev.id, ev.isError, ev.text); break;
    case 'permission': onPermission(ev.requestId, ev.tool, ev.input); break;
    case 'turn_end': endTurn(); break;
    case 'auth_failed': endTurn(); onErrorLine('This account is not signed in. Click “Log in” on the account.'); toast('Account not signed in', 'err'); break;
    case 'error': endTurn(); onErrorLine(ev.text || 'Something went wrong.'); break;
    case 'limit': endTurn(); break; // switch dialog handled via onLimit
    case 'exit': endTurn(); break;
    default: break;
  }
});
cc.onHistory((info) => renderHistory(info && info.log));

// ---- actions ----
async function useAccount(id) {
  if (!state.projectDir) { toast('Pick a project folder first', 'err'); flashProject(); return; }
  // Do NOT clear the transcript — main sends the stored history via 'chat:history'
  // and the conversation is carried onto this account.
  const res = await cc.startChat(id);
  if (!res.ok) {
    if (res.error === 'not_logged_in') { const a = state.accounts.find((x) => x.id === id); openLogin(a); }
    else toast(res.error || 'Could not start', 'err');
  } else if (res.carried) {
    toast('Conversation carried to this account', 'ok');
  }
}
function flashProject() { const b = $('projectBtn'); b.style.borderColor = 'var(--err)'; setTimeout(() => { b.style.borderColor = ''; }, 1400); }

async function sendMessage() {
  const inp = $('input');
  const text = inp.value.trim();
  if (!text) return;
  if (!state.running) { toast('Click an account to start chatting', 'err'); return; }
  addUserMessage(text);
  inp.value = ''; autoGrow(); updateComposer();
  const res = await cc.sendMessage(text);
  if (res && !res.ok) onErrorLine(res.error || 'Could not send');
}

$('sendBtn').onclick = sendMessage;
$('input').addEventListener('input', () => { autoGrow(); updateComposer(); });
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
function autoGrow() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(180, i.scrollHeight) + 'px'; }
$('stopBtn').onclick = () => cc.interrupt();
$('newChatBtn').onclick = async () => {
  if (!state.running) { toast('Start a chat first', 'err'); return; }
  const r = await cc.newChat(); // main clears the log and sends empty history
  if (r && !r.ok) toast(r.error || 'Could not start new chat', 'err');
  else toast('New chat started', 'ok');
};

$('projectBtn').onclick = async () => { state.projectDir = await cc.pickProject(); renderAll(); };
$('addAccountBtn').onclick = async () => {
  const name = await uiPrompt('Name this account (e.g. "Personal", "Work"):', '', 'Add account');
  if (name == null) return;
  await cc.addAccount(name.trim() || 'Account');
  toast('Account added — click “Log in”', 'ok');
};

function accountMenu(a, anchor) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu ctx';
  const items = [
    ['Rename', async () => { const n = await uiPrompt('Rename account:', a.name, 'Rename'); if (n && n.trim()) await cc.renameAccount(a.id, n.trim()); }],
    ['Open config folder', () => cc.openConfigDir(a.id)],
    ['Sign in again', () => openLogin(a)],
    ['Remove', async () => { if (confirm(`Remove "${a.name}"? (Its login folder on disk is kept.)`)) await cc.removeAccount(a.id); }],
  ];
  for (const [label, fn] of items) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { closeMenus(); fn(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
}
function closeMenus() {
  document.querySelectorAll('.menu.ctx').forEach((n) => n.remove());
  $('modelMenu').classList.add('hidden');
  $('effortMenu').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('#modelChip') && !e.target.closest('#effortChip') && !e.target.closest('.btn-more')) closeMenus();
});

// ---- model + effort chips (above the composer, like Claude) ----
function openChipMenu(menuId, list, settingKey, onPick) {
  const menu = $(menuId);
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closeMenus(); menu.innerHTML = '';
  const cur = (state.settings && state.settings[settingKey]) || '';
  for (const [id, label] of list) {
    const b = document.createElement('button');
    b.textContent = (id === cur ? '✓ ' : '') + label;
    b.onclick = async () => { menu.classList.add('hidden'); state.settings = await cc.setSettings({ [settingKey]: id }); renderModelLabel(); onPick && onPick(label); };
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
}
$('modelChip').onclick = (e) => {
  e.stopPropagation();
  openChipMenu('modelMenu', MODELS, 'model', (l) => toast('Model: ' + l, 'ok'));
  const r = e.currentTarget.getBoundingClientRect();
  const m = $('modelMenu'); m.style.left = r.left + 'px'; m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
};
$('effortChip').onclick = (e) => {
  e.stopPropagation();
  openChipMenu('effortMenu', EFFORTS, 'effort', (l) => toast('Effort: ' + l, 'ok'));
  const r = e.currentTarget.getBoundingClientRect();
  const m = $('effortMenu'); m.style.left = r.left + 'px'; m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
};
const newChatTop = $('newChatTop'); if (newChatTop) newChatTop.onclick = () => $('newChatBtn').click();

// ---- login modal (interactive terminal) ----
let loginTerm = null, loginFit = null, loginAcc = null;
function openLogin(a) {
  if (!a) return;
  loginAcc = a;
  $('loginTitle').textContent = 'Sign in — ' + a.name;
  $('loginStatus').textContent = '';
  $('loginModal').classList.remove('hidden');
  if (!loginTerm) {
    loginTerm = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#12100e', foreground: '#e6e2da', cursor: '#d9795a' } });
    loginFit = new FitAddon.FitAddon(); loginTerm.loadAddon(loginFit);
    loginTerm.open($('loginTerm'));
    loginTerm.onData((d) => cc.loginInput(d));
  } else {
    loginTerm.clear();
  }
  setTimeout(() => { try { loginFit.fit(); cc.loginResize(loginTerm.cols, loginTerm.rows); loginTerm.focus(); } catch {} }, 60);
  cc.loginStart(a.id);
}
function closeLogin() { cc.loginStop(); $('loginModal').classList.add('hidden'); }
$('loginClose').onclick = closeLogin;
cc.onLoginData((d) => { if (loginTerm) loginTerm.write(d); });
cc.onLoginExit(() => { if (loginTerm) loginTerm.write('\r\n[session ended]\r\n'); });
cc.onLoginSuccess((info) => {
  $('loginStatus').textContent = '✓ Signed in as ' + (info.email || 'your account') + '. You can close this and start chatting.';
  toast('Signed in: ' + (info.email || ''), 'ok');
  setTimeout(() => { if (!$('loginModal').classList.contains('hidden')) closeLogin(); }, 2200);
});
// paste into the login terminal (native Ctrl+V is disabled without an app menu)
$('loginTerm').addEventListener('contextmenu', (e) => { e.preventDefault(); const t = cc.clipboardRead(); if (t) cc.loginInput(t); });
window.addEventListener('keydown', (e) => {
  if ($('loginModal').classList.contains('hidden')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); const t = cc.clipboardRead(); if (t) cc.loginInput(t); }
  else if (e.key === 'Escape') closeLogin();
}, true);

// ---- switch (limit) dialog ----
let pendingSwitch = null;
cc.onLimit((info) => {
  const cur = state.accounts.find((x) => x.id === info.accountId);
  const curName = cur ? cur.name : 'This account';
  if (info.autoSwitch && info.next) { doSwitch(info.next.id); return; }
  if (info.next) {
    pendingSwitch = info.next.id;
    $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.<br><br>Switch to <b>${escapeHtml(info.next.name)}</b> and continue this conversation?`;
    $('switchGo').classList.remove('hidden');
  } else {
    pendingSwitch = null;
    $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.<br><br>No other signed-in account is available. Add or log into another account.`;
    $('switchGo').classList.add('hidden');
  }
  $('switchModal').classList.remove('hidden');
});
$('switchCancel').onclick = () => $('switchModal').classList.add('hidden');
$('switchGo').onclick = () => { $('switchModal').classList.add('hidden'); if (pendingSwitch) doSwitch(pendingSwitch); };
async function doSwitch(id) {
  onErrorLine('Switching account…');
  const r = await cc.switchAccount(id);
  if (r && !r.ok) toast(r.error === 'not_logged_in' ? 'That account is not signed in' : (r.error || 'Switch failed'), 'err');
  else toast('Switched account' + (r && r.carried ? ' · conversation carried over' : ''), 'ok');
}

// ---- settings ----
$('settingsBtn').onclick = () => {
  const s = state.settings || {};
  $('setTheme').value = s.theme || 'light';
  $('setModel').value = s.model || '';
  $('setAutoSwitch').checked = !!s.autoSwitch;
  $('setNotify').checked = s.notify !== false;
  cc.appInfo().then((i) => { $('aboutLine').textContent = `Claude Multi v${i.version} · Electron ${i.electron}`; }).catch(() => {});
  $('settingsModal').classList.remove('hidden');
};
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
$('setTheme').onchange = async (e) => { applyTheme(e.target.value); state.settings = await cc.setSettings({ theme: e.target.value }); };
$('setModel').onchange = async (e) => { state.settings = await cc.setSettings({ model: e.target.value }); renderModelLabel(); };
$('setAutoSwitch').onchange = async (e) => { state.settings = await cc.setSettings({ autoSwitch: e.target.checked }); };
$('setNotify').onchange = async (e) => { state.settings = await cc.setSettings({ notify: e.target.checked }); };

function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light'); }

// ---- prompt modal (Electron has no window.prompt) ----
function uiPrompt(label, def, okLabel) {
  return new Promise((resolve) => {
    $('promptLabel').textContent = label;
    const inp = $('promptInput'); inp.value = def || '';
    $('promptOk').textContent = okLabel || 'OK';
    $('promptModal').classList.remove('hidden');
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (val) => { $('promptModal').classList.add('hidden'); cleanup(); resolve(val); };
    const onOk = () => done(inp.value);
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    function cleanup() { $('promptOk').onclick = null; $('promptCancel').onclick = null; inp.removeEventListener('keydown', onKey); }
    $('promptOk').onclick = onOk; $('promptCancel').onclick = onCancel; inp.addEventListener('keydown', onKey);
  });
}

// ---- toast ----
let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast'); el.textContent = msg; el.className = 'toast' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---- boot ----
cc.onState((s) => { state = Object.assign(state, s); if (s.settings) applyTheme(s.settings.theme); renderAll(); });
(async () => {
  state = await cc.getState();
  applyTheme(state.settings && state.settings.theme);
  renderAll();
  // Show the last conversation for this project (if any) even before a session starts.
  if (state.projectDir) { try { const h = await cc.getHistory(); if (h && h.log && h.log.length) renderHistory(h.log); } catch { /* noop */ } }
  setInterval(() => { if (state.accounts.some((a) => a.cooldownUntil && a.cooldownUntil > Date.now())) renderAccounts(); }, 30000);
})();
})();
