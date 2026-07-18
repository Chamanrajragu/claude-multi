/* global marked, DOMPurify, Terminal, FitAddon */
(() => {
const cc = window.cc;
const $ = (id) => document.getElementById(id);
marked.setOptions({ gfm: true, breaks: true });
function renderMarkdown(t) { try { return DOMPurify.sanitize(marked.parse(t || '')); } catch { return escapeHtml(t || ''); } }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

let state = { accounts: [], activeAccountId: null, projectDir: '', running: false, generating: false, settings: {}, conversations: [], currentConvoId: '' };
let attachments = [];

function activeAccount() { return state.accounts.find((a) => a.id === state.activeAccountId); }
function fmtCountdown(ms) { const t = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); return h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m` : `${t}s`); }
function accView(a) {
  const now = Date.now();
  if (!a.loggedIn) return { dot: 'off', label: 'Not signed in', needLogin: true };
  if (a.id === state.activeAccountId && state.running) return { dot: 'active', label: 'Active' };
  if (a.cooldownUntil && a.cooldownUntil > now) return { dot: 'cool', label: 'Cooling · ' + fmtCountdown(a.cooldownUntil - now) };
  return { dot: 'ready', label: a.email || 'Ready' };
}

/* ---------------- sidebar ---------------- */
function renderProject() { $('projectName').textContent = state.projectDir ? baseName(state.projectDir) : 'Choose a folder…'; $('projectBtn').title = state.projectDir || 'Choose a project folder'; }

let convoFilter = '';
function renderConvos() {
  const list = $('convoList');
  list.innerHTML = '';
  if (!state.projectDir) { $('convoSearch').classList.add('hidden'); const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'Pick a project folder to start chatting.'; list.appendChild(d); return; }
  if (!state.conversations.length) { $('convoSearch').classList.add('hidden'); const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'No chats yet. Click “New chat”.'; list.appendChild(d); return; }
  $('convoSearch').classList.toggle('hidden', state.conversations.length < 6 && !convoFilter);
  const q = convoFilter.trim().toLowerCase();
  const shown = q ? state.conversations.filter((c) => (c.title || '').toLowerCase().includes(q)) : state.conversations;
  if (!shown.length) { const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'No chats match your search.'; list.appendChild(d); return; }
  for (const c of shown) {
    const row = document.createElement('div');
    row.className = 'convo' + (c.id === state.currentConvoId ? ' active' : '') + (c.pinned ? ' pinned' : '');
    const pin = document.createElement('button'); pin.className = 'convo-pin'; pin.textContent = c.pinned ? '★' : '☆'; pin.title = c.pinned ? 'Unpin' : 'Pin';
    pin.onclick = (e) => { e.stopPropagation(); cc.pinConvo(c.id); };
    const title = document.createElement('div'); title.className = 'convo-title'; title.textContent = c.title || 'New chat';
    const more = document.createElement('button'); more.className = 'convo-more'; more.textContent = '⋯';
    more.onclick = (e) => { e.stopPropagation(); convoMenu(c, e.currentTarget); };
    row.appendChild(pin); row.appendChild(title); row.appendChild(more);
    row.onclick = () => openConvo(c.id);
    list.appendChild(row);
  }
}
$('convoSearch').addEventListener('input', (e) => { convoFilter = e.target.value; renderConvos(); });
async function openConvo(id) {
  if (id === state.currentConvoId && state.running) return;
  const r = await cc.openConvo(id);
  if (r && !r.ok) toast(r.error || 'Could not open chat', 'err');
}
function convoMenu(c, anchor) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu ctx';
  const items = [
    [c.pinned ? 'Unpin' : 'Pin', async () => { await cc.pinConvo(c.id); }],
    ['Rename', async () => { const t = await uiPrompt('Rename chat:', c.title, 'Rename'); if (t && t.trim()) { await cc.renameConvo(c.id, t.trim()); } }],
    ['Export as Markdown…', async () => { const r = await cc.exportMd(c.id); if (r && r.ok) toast('Exported to ' + r.path, 'ok'); else if (r && r.error) toast(r.error, 'err'); }],
    ['Delete', async () => { if (confirm(`Delete "${c.title}"?`)) await cc.deleteConvo(c.id); }],
  ];
  for (const [label, fn] of items) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { closeMenus(); fn(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 210) + 'px'; m.style.top = (r.bottom + 4) + 'px';
}

function renderAccountRow() {
  const a = activeAccount();
  const av = $('acAvatar'); const nm = $('acName'); const sub = $('acSub'); const dot = $('acDot');
  if (a) {
    av.textContent = (a.name || a.email || '?').trim().charAt(0).toUpperCase();
    nm.textContent = a.name;
    const v = accView(a); sub.textContent = a.email || v.label; dot.className = 'dot ' + v.dot;
  } else {
    av.textContent = '–'; nm.textContent = 'No account'; sub.textContent = 'Choose an account'; dot.className = 'dot off';
  }
  // top pill
  $('switchName').textContent = a ? a.name : 'No account';
  $('switchDot').className = 'dot ' + (a ? accView(a).dot : 'off');
}

let accFilter = '';
function openAccountMenu(anchor) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu ctx'; m.style.minWidth = '260px';
  if (state.accounts.length > 6) {
    const s = document.createElement('input'); s.className = 'm-search'; s.placeholder = 'Search accounts…'; s.value = accFilter;
    s.oninput = () => { accFilter = s.value; rebuild(); };
    m.appendChild(s); setTimeout(() => s.focus(), 30);
  }
  const body = document.createElement('div');
  m.appendChild(body);
  function rebuild() {
    body.innerHTML = '';
    const lbl = document.createElement('div'); lbl.className = 'm-label'; lbl.textContent = 'Accounts'; body.appendChild(lbl);
    const q = accFilter.trim().toLowerCase();
    const shown = q ? state.accounts.filter((a) => (a.name + ' ' + (a.email || '')).toLowerCase().includes(q)) : state.accounts;
    if (!shown.length) { const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'No accounts.'; body.appendChild(d); }
    shown.forEach((a, i) => {
      const v = accView(a);
      const b = document.createElement('button'); b.className = 'menu-acc';
      const idx = state.accounts.indexOf(a);
      b.innerHTML = `<span class="ac-avatar">${escapeHtml((a.name || '?').charAt(0).toUpperCase())}</span>` +
        `<span class="ma-meta"><span class="ma-name">${escapeHtml(a.name)}${a.id === state.activeAccountId && state.running ? ' ·  active' : ''}</span>` +
        `<span class="ma-sub">${escapeHtml(v.needLogin ? 'Not signed in — click to log in' : v.label)}</span></span>` +
        `<span class="dot ${v.dot}"></span>${idx < 9 ? `<span class="ma-sub">⌘${idx + 1}</span>` : ''}`;
      b.onclick = () => { closeMenus(); if (v.needLogin) openLogin(a); else useAccount(a.id); };
      body.appendChild(b);
    });
    const sep = document.createElement('div'); sep.className = 'm-sep'; body.appendChild(sep);
    const add = document.createElement('button'); add.textContent = '＋  Add account'; add.onclick = () => { closeMenus(); addAccount(); }; body.appendChild(add);
    const set = document.createElement('button'); set.textContent = '⚙  Settings'; set.onclick = () => { closeMenus(); openSettings(); }; body.appendChild(set);
  }
  rebuild();
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const w = 262;
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  if (r.top > window.innerHeight / 2) m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  else m.style.top = (r.bottom + 6) + 'px';
}

/* ---------------- top / render all ---------------- */
function renderTop() {
  const c = state.conversations.find((x) => x.id === state.currentConvoId);
  $('topTitle').textContent = c ? (c.title || 'New chat') : (state.running ? 'Chat' : 'New chat');
  renderModelLabel();
}
const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultrathink']];
function labelFor(list, id, fb) { const f = list.find((x) => x[0] === id); return f ? f[1] : fb; }
function renderModelLabel() {
  $('modelChipLabel').textContent = labelFor(MODELS, (state.settings && state.settings.model) || '', 'Default');
  $('effortChipLabel').textContent = labelFor(EFFORTS, (state.settings && state.settings.effort) || 'medium', 'Medium');
}
function updateComposer() {
  const can = state.running;
  $('sendBtn').disabled = !can || !$('input').value.trim();
  $('input').placeholder = can ? 'Reply to Claude…' : (state.accounts.some((a) => a.loggedIn) ? 'Choose an account to start…' : 'Add & log in an account to start…');
  $('genBar').classList.toggle('hidden', !state.generating);
}
const STARTERS = [
  'Explain what this project does',
  'Find and fix a bug',
  'Write tests for the current file',
  'Review my recent changes',
  'Refactor this code to be simpler',
];
let startersBuilt = false;
function renderStarters() {
  const box = $('starterChips'); if (!box || startersBuilt) return;
  startersBuilt = true;
  for (const s of STARTERS) {
    const b = document.createElement('button'); b.className = 'starter-chip'; b.textContent = s;
    b.onclick = () => { const inp = $('input'); inp.value = s; autoGrow(); updateComposer(); inp.focus(); if (state.running) sendMessage(); else toast('Choose an account, then press send', 'ok'); };
    box.appendChild(b);
  }
}
function renderAll() { renderProject(); renderConvos(); renderAccountRow(); renderTop(); updateComposer(); renderAttachments(); renderStarters(); }

/* ---------------- transcript ---------------- */
const transcript = $('transcript');
let turn = null; let convo = [];
function clearTranscript() { transcript.innerHTML = ''; turn = null; }
function nearBottom() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120; }
function scrollDown(force) { if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight; }
transcript.addEventListener('scroll', () => { $('scrollDownBtn').classList.toggle('hidden', nearBottom()); });
$('scrollDownBtn').onclick = () => { transcript.scrollTop = transcript.scrollHeight; };
function wrap(el) { const w = document.createElement('div'); w.className = 'msg-wrap'; w.appendChild(el); transcript.appendChild(w); return w; }
function hideWelcome() { const w = $('welcome'); if (w) w.classList.add('hidden'); }
function persist() { try { cc.saveLog(convo); } catch { /* noop */ } }
const pending = new Set(); let rafQ = false;
function schedule(el) { pending.add(el); if (!rafQ) { rafQ = true; requestAnimationFrame(flush); } }
function flush() { rafQ = false; for (const el of pending) el.innerHTML = renderMarkdown(el._raw || ''); pending.clear(); scrollDown(); }
function toolSummary(name, i) { if (!i) return ''; return i.command || i.file_path || i.path || i.pattern || i.url || (i.prompt ? String(i.prompt).slice(0, 80) : (JSON.stringify(i) === '{}' ? '' : JSON.stringify(i).slice(0, 80))); }

function appendUserDOM(text) { hideWelcome(); const msg = document.createElement('div'); msg.className = 'msg user'; const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text; msg.appendChild(b); wrap(msg); }
function makeToolCard(block) {
  const card = document.createElement('div'); card.className = 'tool-card';
  const head = document.createElement('div'); head.className = 'tool-head';
  const st = block.state === 'running' ? 'running…' : (block.state === 'err' ? 'error' : 'done');
  const cls = block.state === 'running' ? '' : (block.state === 'err' ? 'err' : 'ok');
  head.innerHTML = `<span class="tool-ico">⚙</span><span class="tool-name">${escapeHtml(block.name)}</span><span class="tool-summary">${escapeHtml(block.summary || '')}</span><span class="tool-state ${cls}">${st}</span>`;
  const body = document.createElement('div'); body.className = 'tool-body hidden'; body.textContent = block.output || '';
  head.onclick = () => body.classList.toggle('hidden');
  card.appendChild(head); card.appendChild(body);
  return { card, head, body };
}
// Copy helper with a brief visual confirmation on the clicked button.
function copyText(text, btn, okLabel) {
  try { cc.clipboardWrite(text); } catch { return; }
  if (btn) { const old = btn.textContent; btn.textContent = okLabel || '✓ Copied'; setTimeout(() => { btn.textContent = old; }, 1300); }
  else toast('Copied', 'ok');
}
// Add a copy button to every code block inside a scope (idempotent).
function addCodeCopy(scope) {
  scope.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const b = document.createElement('button'); b.className = 'code-copy'; b.textContent = 'Copy';
    b.onclick = (e) => { e.stopPropagation(); const code = pre.querySelector('code'); copyText((code || pre).innerText, b); };
    pre.appendChild(b);
  });
}
// Reconstruct the plain-text of an assistant message from its rendered blocks.
function assistantPlainText(bodyEl) {
  return Array.from(bodyEl.querySelectorAll('.md')).map((m) => m.innerText).join('\n\n').trim();
}
// Add the hover action bar (Copy) + optional usage footer to a finished turn.
function decorateAssistant(msgEl, meta) {
  const body = msgEl.querySelector('.assistant-body'); if (!body) return;
  addCodeCopy(body);
  if (!body.querySelector('.msg-actions')) {
    const bar = document.createElement('div'); bar.className = 'msg-actions';
    const copy = document.createElement('button'); copy.className = 'msg-act'; copy.textContent = 'Copy';
    copy.onclick = () => copyText(assistantPlainText(body), copy);
    bar.appendChild(copy);
    body.appendChild(bar);
  }
  if (meta && !body.querySelector('.turn-meta')) {
    const parts = [];
    if (meta.usage) { const t = (meta.usage.input_tokens || 0) + (meta.usage.output_tokens || 0); if (t) parts.push('🔢 ' + t.toLocaleString() + ' tokens'); }
    if (meta.costUsd) parts.push('💲 $' + Number(meta.costUsd).toFixed(4));
    if (parts.length) { const m = document.createElement('div'); m.className = 'turn-meta'; parts.forEach((p) => { const s = document.createElement('span'); s.textContent = p; m.appendChild(s); }); body.insertBefore(m, body.querySelector('.msg-actions')); }
  }
}

function appendAssistantDOM(blocks) {
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'assistant-avatar'; av.textContent = '✳';
  const body = document.createElement('div'); body.className = 'assistant-body';
  for (const blk of blocks || []) {
    if (blk.type === 'text') { const d = document.createElement('div'); d.className = 'md'; d.innerHTML = renderMarkdown(blk.text || ''); body.appendChild(d); }
    else if (blk.type === 'tool') body.appendChild(makeToolCard(blk).card);
  }
  msg.appendChild(av); msg.appendChild(body); wrap(msg);
  decorateAssistant(msg);
}
function renderHistory(log) {
  clearTranscript();
  convo = Array.isArray(log) ? log.map((m) => ({ ...m })) : [];
  if (!convo.length) { const w = $('welcome'); if (w) w.classList.remove('hidden'); return; }
  for (const m of convo) { if (m.role === 'user') appendUserDOM(m.text); else appendAssistantDOM(m.blocks); }
  scrollDown(true);
}
function addUserMessage(text) { convo.push({ role: 'user', text }); appendUserDOM(text); persist(); scrollDown(true); }
function ensureTurn() {
  if (turn) return turn;
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'assistant-avatar'; av.textContent = '✳';
  const body = document.createElement('div'); body.className = 'assistant-body';
  msg.appendChild(av); msg.appendChild(body); wrap(msg);
  turn = { msg, body, curText: null, curRaw: '', curBlock: null, tools: new Map(), thinkEl: null, thinkRaw: '', blocks: [] };
  return turn;
}
function newTextBlock() { const t = ensureTurn(); const el = document.createElement('div'); el.className = 'md'; t.body.appendChild(el); t.curText = el; t.curRaw = ''; t.curBlock = { type: 'text', text: '' }; t.blocks.push(t.curBlock); return el; }
function onAssistantDelta(text) { const t = ensureTurn(); if (!t.curText) newTextBlock(); t.curRaw += text; t.curText._raw = t.curRaw; t.curBlock.text = t.curRaw; schedule(t.curText); }
function onAssistantText(text) { const t = ensureTurn(); if (!t.curText) newTextBlock(); t.curText._raw = text; t.curText.innerHTML = renderMarkdown(text); t.curBlock.text = text; t.curText = null; t.curRaw = ''; t.curBlock = null; scrollDown(); }
function onThinking(text) {
  const t = ensureTurn();
  if (!t.thinkEl) { const d = document.createElement('details'); d.className = 'think'; const s = document.createElement('summary'); s.textContent = 'Thinking'; const b = document.createElement('div'); b.className = 'think-body'; d.appendChild(s); d.appendChild(b); t.body.appendChild(d); t.thinkEl = b; t.thinkRaw = ''; }
  t.thinkRaw += text; t.thinkEl.textContent = t.thinkRaw; scrollDown();
}
function onToolUse(id, name, input) {
  const t = ensureTurn(); t.curText = null; t.curBlock = null;
  const block = { type: 'tool', name, summary: toolSummary(name, input), state: 'running', output: typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input) };
  t.blocks.push(block); const { card, head, body } = makeToolCard(block); t.body.appendChild(card); t.tools.set(id, { block, head, body }); scrollDown();
}
function onToolResult(id, isError, text) {
  const t = turn; if (!t) return; const e = t.tools.get(id); if (!e) return;
  e.block.state = isError ? 'err' : 'ok';
  const s = e.head.querySelector('.tool-state'); s.textContent = isError ? 'error' : 'done'; s.className = 'tool-state ' + (isError ? 'err' : 'ok');
  if (text) { e.block.output = (typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 8000); e.body.textContent = e.block.output; }
  scrollDown();
}
function onErrorLine(text) { hideWelcome(); const el = document.createElement('div'); el.className = 'err-line'; el.textContent = '⚠ ' + text; if (turn && turn.body) turn.body.appendChild(el); else wrap(el); scrollDown(true); }
function endTurn(meta) { if (turn && turn.blocks.length) { convo.push({ role: 'assistant', blocks: turn.blocks }); persist(); if (turn.msg) decorateAssistant(turn.msg, meta); } turn = null; }

/* ---------------- permission cards ---------------- */
function onPermission(requestId, tool, input) {
  const t = ensureTurn(); t.curText = null; t.curBlock = null;
  const card = document.createElement('div'); card.className = 'perm-card';
  const title = document.createElement('div'); title.className = 'perm-title'; title.innerHTML = `Claude wants to use <span class="ptool">${escapeHtml(tool)}</span>`;
  const detail = document.createElement('div'); detail.className = 'perm-detail'; detail.textContent = summarizePerm(tool, input);
  const actions = document.createElement('div'); actions.className = 'perm-actions';
  const allow = document.createElement('button'); allow.className = 'perm-allow'; allow.textContent = 'Allow';
  const deny = document.createElement('button'); deny.className = 'perm-deny'; deny.textContent = 'Deny';
  const done = (ok) => { cc.respondPermission(requestId, ok); actions.remove(); const r = document.createElement('div'); r.className = 'perm-resolved ' + (ok ? 'allow' : 'deny'); r.textContent = ok ? '✓ Allowed' : '✕ Denied'; card.appendChild(r); };
  allow.onclick = () => done(true); deny.onclick = () => done(false);
  actions.appendChild(allow); actions.appendChild(deny);
  card.appendChild(title); card.appendChild(detail); card.appendChild(actions); t.body.appendChild(card); scrollDown(true);
}
function summarizePerm(tool, i) { if (!i) return ''; if (i.command) return '$ ' + i.command; if (i.file_path) return i.file_path + (i.content ? '\n\n' + String(i.content).slice(0, 600) : ''); return JSON.stringify(i, null, 2).slice(0, 800); }

/* ---------------- chat events ---------------- */
cc.onChat((ev) => {
  switch (ev.type) {
    case 'assistant_delta': onAssistantDelta(ev.text); break;
    case 'assistant_text': onAssistantText(ev.text); break;
    case 'thinking': onThinking(ev.text); break;
    case 'tool_use': onToolUse(ev.id, ev.name, ev.input); break;
    case 'tool_result': onToolResult(ev.id, ev.isError, ev.text); break;
    case 'permission': onPermission(ev.requestId, ev.tool, ev.input); break;
    case 'turn_end': endTurn({ usage: ev.usage, costUsd: ev.costUsd }); break;
    case 'auth_failed': endTurn(); onErrorLine('This account is not signed in. Open the account switcher and Log in.'); break;
    case 'error': endTurn(); onErrorLine(ev.text || 'Something went wrong.'); break;
    case 'limit': endTurn(); break;
    case 'exit': endTurn(); break;
    default: break;
  }
});
cc.onHistory((info) => renderHistory(info && info.log));

/* ---------------- actions ---------------- */
async function useAccount(id) {
  if (!state.projectDir) { toast('Pick a project folder first', 'err'); flashProject(); return; }
  const res = await cc.startChat(id);
  if (!res.ok) { if (res.error === 'not_logged_in') { const a = state.accounts.find((x) => x.id === id); openLogin(a); } else toast(res.error || 'Could not start', 'err'); }
  else if (res.carried) toast('Conversation carried to this account', 'ok');
}
function flashProject() { const b = $('projectBtn'); b.style.color = 'var(--err)'; setTimeout(() => { b.style.color = ''; }, 1200); }
async function sendMessage() {
  const inp = $('input'); const text = inp.value.trim();
  if (!text && !attachments.length) return;
  if (!state.running) { toast('Choose an account to start chatting', 'err'); return; }
  addUserMessage(text + (attachments.length ? '\n' + attachments.map((p) => '📎 ' + baseName(p)).join('\n') : ''));
  const atts = attachments.slice(); attachments = []; renderAttachments();
  inp.value = ''; autoGrow(); updateComposer();
  const res = await cc.sendMessage(text, atts);
  if (res && !res.ok) onErrorLine(res.error || 'Could not send');
}
function autoGrow() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(200, i.scrollHeight) + 'px'; }
function renderAttachments() {
  const row = $('attachRow'); row.innerHTML = ''; row.classList.toggle('hidden', !attachments.length);
  attachments.forEach((p, i) => { const c = document.createElement('div'); c.className = 'attach-chip'; c.innerHTML = `📎 ${escapeHtml(baseName(p))} <span class="rm">✕</span>`; c.querySelector('.rm').onclick = () => { attachments.splice(i, 1); renderAttachments(); }; row.appendChild(c); });
}

$('sendBtn').onclick = sendMessage;
$('input').addEventListener('input', () => { autoGrow(); updateComposer(); });
$('input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const enterSends = (state.settings || {}).enterSends !== false;
  const wantSend = enterSends ? (!e.shiftKey) : (e.ctrlKey || e.metaKey);
  if (wantSend) { e.preventDefault(); sendMessage(); }
});
$('stopBtn').onclick = () => cc.interrupt();
$('attachBtn').onclick = async () => { const files = await cc.pickFiles(); if (files && files.length) { attachments = attachments.concat(files); renderAttachments(); } };
$('newChatBtn').onclick = async () => { if (!state.projectDir) { toast('Pick a project folder first', 'err'); flashProject(); return; } const r = await cc.newChat(); if (r && !r.ok) toast(r.error || 'Could not start', 'err'); };
$('projectBtn').onclick = async () => { state.projectDir = await cc.pickProject(); renderAll(); };
$('accountBtn').onclick = (e) => { e.stopPropagation(); openAccountMenu(e.currentTarget); };
$('switchPill').onclick = (e) => { e.stopPropagation(); openAccountMenu(e.currentTarget); };
$('topTitle').onclick = async () => { const c = state.conversations.find((x) => x.id === state.currentConvoId); if (!c) return; const t = await uiPrompt('Rename chat:', c.title, 'Rename'); if (t && t.trim()) cc.renameConvo(c.id, t.trim()); };

async function addAccount() {
  const name = await uiPrompt('Name this account (e.g. "Personal", "Work"):', '', 'Add account');
  if (name == null) return;
  await cc.addAccount(name.trim() || 'Account');
  toast('Account added — open the switcher and Log in', 'ok');
}

/* ---------------- menus ---------------- */
function closeMenus() { document.querySelectorAll('.menu.ctx').forEach((n) => n.remove()); $('modelMenu').classList.add('hidden'); $('effortMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('#accountBtn') && !e.target.closest('#switchPill') && !e.target.closest('#modelChip') && !e.target.closest('#effortChip') && !e.target.closest('.convo-more')) closeMenus(); });
function openChipMenu(menuId, list, key, onPick) {
  const menu = $(menuId);
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closeMenus(); menu.innerHTML = '';
  const cur = (state.settings && state.settings[key]) || (key === 'effort' ? 'medium' : '');
  for (const [id, label] of list) { const b = document.createElement('button'); b.textContent = (id === cur ? '✓ ' : '') + label; b.onclick = async () => { menu.classList.add('hidden'); state.settings = await cc.setSettings({ [key]: id }); renderModelLabel(); onPick && onPick(label); }; menu.appendChild(b); }
  menu.classList.remove('hidden');
}
$('modelChip').onclick = (e) => { e.stopPropagation(); openChipMenu('modelMenu', MODELS, 'model', (l) => toast('Model: ' + l, 'ok')); const r = e.currentTarget.getBoundingClientRect(); const m = $('modelMenu'); m.style.left = r.left + 'px'; m.style.bottom = (window.innerHeight - r.top + 6) + 'px'; };
$('effortChip').onclick = (e) => { e.stopPropagation(); openChipMenu('effortMenu', EFFORTS, 'effort', (l) => toast('Effort: ' + l, 'ok')); const r = e.currentTarget.getBoundingClientRect(); const m = $('effortMenu'); m.style.left = r.left + 'px'; m.style.bottom = (window.innerHeight - r.top + 6) + 'px'; };

/* ---------------- quick-switch Ctrl+1..9 ---------------- */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key) && !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) {
    e.preventDefault(); const a = state.accounts[parseInt(e.key, 10) - 1]; if (a) { if (!a.loggedIn) openLogin(a); else useAccount(a.id); }
  }
  // paste into login terminal (native Ctrl+V disabled without app menu)
  if (!$('loginModal').classList.contains('hidden')) {
    if (ctrl && !e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); const t = cc.clipboardRead(); if (t) cc.loginInput(t); }
    else if (e.key === 'Escape') closeLogin();
  }
}, true);

/* ---------------- login modal ---------------- */
let loginTerm = null, loginFit = null;
function openLogin(a) {
  if (!a) return;
  $('loginTitle').textContent = 'Sign in — ' + a.name; $('loginStatus').textContent = ''; $('loginModal').classList.remove('hidden');
  if (!loginTerm) {
    loginTerm = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#12100e', foreground: '#e6e2da', cursor: '#d9795a' } });
    loginFit = new FitAddon.FitAddon(); loginTerm.loadAddon(loginFit); loginTerm.open($('loginTerm')); loginTerm.onData((d) => cc.loginInput(d));
  } else loginTerm.clear();
  setTimeout(() => { try { loginFit.fit(); cc.loginResize(loginTerm.cols, loginTerm.rows); loginTerm.focus(); } catch {} }, 60);
  cc.loginStart(a.id);
}
function closeLogin() { cc.loginStop(); $('loginModal').classList.add('hidden'); }
$('loginClose').onclick = closeLogin;
$('loginTerm').addEventListener('contextmenu', (e) => { e.preventDefault(); const t = cc.clipboardRead(); if (t) cc.loginInput(t); });
cc.onLoginData((d) => { if (loginTerm) loginTerm.write(d); });
cc.onLoginExit(() => { if (loginTerm) loginTerm.write('\r\n[session ended]\r\n'); });
cc.onLoginSuccess((info) => { $('loginStatus').textContent = '✓ Signed in as ' + (info.email || 'your account') + '. You can close this and start chatting.'; toast('Signed in: ' + (info.email || ''), 'ok'); setTimeout(() => { if (!$('loginModal').classList.contains('hidden')) closeLogin(); }, 2000); });

/* ---------------- limit / switch ---------------- */
let pendingSwitch = null;
cc.onLimit((info) => {
  const cur = state.accounts.find((x) => x.id === info.accountId); const curName = cur ? cur.name : 'This account';
  if (info.autoSwitch && info.next) { doSwitch(info.next.id); return; }
  if (info.next) { pendingSwitch = info.next.id; $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.<br><br>Switch to <b>${escapeHtml(info.next.name)}</b> and continue this conversation?`; $('switchGo').classList.remove('hidden'); }
  else { pendingSwitch = null; $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.<br><br>No other signed-in account is available.`; $('switchGo').classList.add('hidden'); }
  $('switchModal').classList.remove('hidden');
});
$('switchCancel').onclick = () => $('switchModal').classList.add('hidden');
$('switchGo').onclick = () => { $('switchModal').classList.add('hidden'); if (pendingSwitch) doSwitch(pendingSwitch); };
async function doSwitch(id) { onErrorLine('Switching account…'); const r = await cc.switchAccount(id); if (r && !r.ok) toast(r.error === 'not_logged_in' ? 'That account is not signed in' : (r.error || 'Switch failed'), 'err'); else toast('Switched account' + (r && r.carried ? ' · conversation carried over' : ''), 'ok'); }

/* ---------------- settings ---------------- */
function openSettings() {
  const s = state.settings || {};
  $('setTheme').value = ['light', 'system'].includes(s.theme) ? s.theme : 'dark';
  $('setWidth').value = s.width === 'wide' ? 'wide' : 'comfortable';
  $('setFontScale').value = ['small', 'large'].includes(s.fontScale) ? s.fontScale : 'normal';
  $('setEnterSends').checked = s.enterSends !== false;
  $('setModel').value = s.model || '';
  $('setEffort').value = s.effort || 'medium';
  $('setAutoSwitch').checked = !!s.autoSwitch;
  $('setNotify').checked = s.notify !== false;
  $('setTray').checked = !!s.minimizeToTray;
  $('setStartup').checked = !!s.startOnLogin;
  cc.appInfo().then((i) => { $('aboutLine').textContent = `Claude Multi v${i.version} · Electron ${i.electron} · Node ${i.node}`; }).catch(() => {});
  $('settingsModal').classList.remove('hidden');
}
$('settingsTop').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
document.querySelectorAll('.snav').forEach((b) => { b.onclick = () => {
  document.querySelectorAll('.snav').forEach((x) => x.classList.remove('active')); b.classList.add('active');
  const p = b.dataset.pane; document.querySelectorAll('.spane').forEach((x) => x.classList.toggle('hidden', x.dataset.pane !== p));
}; });
$('setTheme').onchange = async (e) => { applyTheme(e.target.value); state.settings = await cc.setSettings({ theme: e.target.value }); };
$('setModel').onchange = async (e) => { state.settings = await cc.setSettings({ model: e.target.value }); renderModelLabel(); };
$('setEffort').onchange = async (e) => { state.settings = await cc.setSettings({ effort: e.target.value }); renderModelLabel(); };
$('setAutoSwitch').onchange = async (e) => { state.settings = await cc.setSettings({ autoSwitch: e.target.checked }); };
$('setNotify').onchange = async (e) => { state.settings = await cc.setSettings({ notify: e.target.checked }); };
$('setTray').onchange = async (e) => { state.settings = await cc.setSettings({ minimizeToTray: e.target.checked }); };
$('setStartup').onchange = async (e) => { state.settings = await cc.setSettings({ startOnLogin: e.target.checked }); };
$('exportBtn').onclick = async () => { const r = await cc.exportConfig(); if (r && r.ok) toast('Exported to ' + r.path, 'ok'); else if (r && r.error) toast(r.error, 'err'); };
$('importBtn').onclick = async () => { const r = await cc.importConfig(); if (r && r.ok) toast('Imported — accounts restored', 'ok'); else if (r && r.error) toast(r.error, 'err'); };
$('ghBtn').onclick = () => cc.openExternal('https://github.com/Chamanrajragu/claude-multi');
$('setWidth').onchange = async (e) => { applyAppearance({ width: e.target.value }); state.settings = await cc.setSettings({ width: e.target.value }); };
$('setFontScale').onchange = async (e) => { applyAppearance({ fontScale: e.target.value }); state.settings = await cc.setSettings({ fontScale: e.target.value }); };
$('setEnterSends').onchange = async (e) => { state.settings = await cc.setSettings({ enterSends: e.target.checked }); };

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function applyTheme(t) {
  const eff = t === 'system' ? (mq && mq.matches ? 'light' : 'dark') : (t === 'light' ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', eff);
}
function applyAppearance(s) {
  s = s || (state.settings || {});
  if (s.theme !== undefined) applyTheme(s.theme);
  document.documentElement.setAttribute('data-width', s.width === 'wide' ? 'wide' : 'comfortable');
  document.documentElement.setAttribute('data-fontscale', ['small', 'large'].includes(s.fontScale) ? s.fontScale : 'normal');
}
if (mq) mq.addEventListener('change', () => { if ((state.settings || {}).theme === 'system') applyTheme('system'); });

/* ---------------- prompt modal ---------------- */
function uiPrompt(label, def, okLabel) {
  return new Promise((resolve) => {
    $('promptLabel').textContent = label; const inp = $('promptInput'); inp.value = def || ''; $('promptOk').textContent = okLabel || 'OK'; $('promptModal').classList.remove('hidden');
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (v) => { $('promptModal').classList.add('hidden'); cleanup(); resolve(v); };
    const onOk = () => done(inp.value); const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    function cleanup() { $('promptOk').onclick = null; $('promptCancel').onclick = null; inp.removeEventListener('keydown', onKey); }
    $('promptOk').onclick = onOk; $('promptCancel').onclick = onCancel; inp.addEventListener('keydown', onKey);
  });
}

/* ---------------- command palette ---------------- */
let cmdkItems = [], cmdkIdx = 0;
function buildCommands() {
  const cmds = [];
  cmds.push({ icon: '＋', label: 'New chat', hint: 'Ctrl+N', run: () => $('newChatBtn').click() });
  cmds.push({ icon: '🔍', label: 'Search chats', hint: 'Ctrl+F', run: () => { $('convoSearch').classList.remove('hidden'); $('convoSearch').focus(); } });
  cmds.push({ icon: '📤', label: 'Export this chat as Markdown', run: async () => { const r = await cc.exportMd(); if (r && r.ok) toast('Exported to ' + r.path, 'ok'); else if (r && r.error) toast(r.error, 'err'); } });
  cmds.push({ icon: '🎨', label: 'Toggle light / dark theme', run: async () => { const cur = (state.settings || {}).theme; const next = cur === 'light' ? 'dark' : 'light'; applyTheme(next); state.settings = await cc.setSettings({ theme: next }); } });
  cmds.push({ icon: '⚙', label: 'Open settings', run: () => openSettings() });
  cmds.push({ icon: '⌨', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => $('shortcutsModal').classList.remove('hidden') });
  cmds.push({ icon: '🐙', label: 'Open project on GitHub', run: () => cc.openExternal('https://github.com/Chamanrajragu/claude-multi') });
  for (const a of state.accounts) {
    const v = accView(a);
    cmds.push({ icon: '👤', label: 'Account: ' + a.name, hint: v.needLogin ? 'log in' : v.label, run: () => { if (v.needLogin) openLogin(a); else useAccount(a.id); } });
  }
  for (const c of state.conversations) cmds.push({ icon: '💬', label: 'Chat: ' + (c.title || 'New chat'), run: () => openConvo(c.id) });
  return cmds;
}
function renderCmdk(filter) {
  const q = (filter || '').trim().toLowerCase();
  const all = buildCommands();
  cmdkItems = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  cmdkIdx = 0;
  const list = $('cmdkList'); list.innerHTML = '';
  if (!cmdkItems.length) { const d = document.createElement('div'); d.className = 'cmdk-empty'; d.textContent = 'No matching commands'; list.appendChild(d); return; }
  cmdkItems.forEach((c, i) => {
    const el = document.createElement('div'); el.className = 'cmdk-item' + (i === cmdkIdx ? ' active' : '');
    el.innerHTML = `<span class="cmdk-ico">${escapeHtml(c.icon)}</span><span class="cmdk-lbl"></span>${c.hint ? `<span class="cmdk-hint">${escapeHtml(c.hint)}</span>` : ''}`;
    el.querySelector('.cmdk-lbl').textContent = c.label;
    el.onmouseenter = () => { cmdkIdx = i; highlightCmdk(); };
    el.onclick = () => runCmdk(i);
    list.appendChild(el);
  });
}
function highlightCmdk() { document.querySelectorAll('#cmdkList .cmdk-item').forEach((el, i) => el.classList.toggle('active', i === cmdkIdx)); }
function runCmdk(i) { const c = cmdkItems[i]; closeCmdk(); if (c) try { c.run(); } catch (e) { toast('Command failed', 'err'); } }
function openCmdk() { closeMenus(); $('cmdkModal').classList.remove('hidden'); const inp = $('cmdkInput'); inp.value = ''; renderCmdk(''); setTimeout(() => inp.focus(), 20); }
function closeCmdk() { $('cmdkModal').classList.add('hidden'); }
$('cmdkInput').addEventListener('input', (e) => renderCmdk(e.target.value));
$('cmdkInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIdx = Math.min(cmdkIdx + 1, cmdkItems.length - 1); highlightCmdk(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIdx = Math.max(cmdkIdx - 1, 0); highlightCmdk(); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkIdx); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
});
$('cmdkModal').addEventListener('click', (e) => { if (e.target === $('cmdkModal')) closeCmdk(); });
$('cmdkBtn').onclick = openCmdk;
$('shortcutsClose').onclick = () => $('shortcutsModal').classList.add('hidden');
$('shortcutsModal').addEventListener('click', (e) => { if (e.target === $('shortcutsModal')) $('shortcutsModal').classList.add('hidden'); });

/* ---------------- global shortcuts (Ctrl+K/N/F, Ctrl+/) ---------------- */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'k' || e.key === 'K') { e.preventDefault(); if ($('cmdkModal').classList.contains('hidden')) openCmdk(); else closeCmdk(); }
  else if (e.key === '/') { e.preventDefault(); $('shortcutsModal').classList.toggle('hidden'); }
  else if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) { e.preventDefault(); $('newChatBtn').click(); }
  else if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) { e.preventDefault(); if (state.projectDir) { $('convoSearch').classList.remove('hidden'); $('convoSearch').focus(); } }
});

/* ---------------- drag & drop attachments ---------------- */
(() => {
  const drop = $('main');
  ['dragover', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }));
  drop.addEventListener('drop', (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => f.path).filter(Boolean);
    if (files.length) { attachments = attachments.concat(files); renderAttachments(); toast(files.length + ' file' + (files.length > 1 ? 's' : '') + ' attached', 'ok'); }
  });
})();

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, kind) { const el = $('toast'); el.textContent = msg; el.className = 'toast' + (kind === 'err' ? ' err' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2600); }

/* ---------------- boot ---------------- */
cc.onState((s) => { state = Object.assign(state, s); if (s.settings) applyAppearance(s.settings); renderAll(); });
(async () => {
  state = await cc.getState();
  applyAppearance(state.settings || {});
  renderAll();
  if (state.projectDir) { try { const h = await cc.getHistory(); if (h && h.log && h.log.length) renderHistory(h.log); } catch {} }
  setInterval(() => { if (state.accounts.some((a) => a.cooldownUntil && a.cooldownUntil > Date.now())) renderAccountRow(); }, 30000);
})();
})();
