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
let drafts = {}; // convoId -> unsent composer text (kept per chat)
function swapDraft(prev, next) {
  const inp = $('input');
  // Only save the outgoing draft if that chat still exists (avoid resurrecting a deleted chat's draft).
  if (prev != null && prev !== '' && (state.conversations || []).some((c) => c.id === prev)) drafts[prev] = inp.value;
  inp.value = (next && drafts[next]) || ''; autoGrow(); updateComposer();
}
function pruneDrafts() { const ids = new Set((state.conversations || []).map((c) => c.id)); if (state.currentConvoId) ids.add(state.currentConvoId); for (const k of Object.keys(drafts)) if (!ids.has(k)) delete drafts[k]; }

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
function renderProject() {
  const f = state.projectDir; // main sends the CURRENT chat's folder here
  $('projectName').textContent = f ? baseName(f) : (state.currentConvoId ? 'No folder' : 'New chat to begin');
  $('projectBtn').title = f ? ('This chat’s folder: ' + f + '\nClick to move it to another folder') : 'Start a new chat to pick a folder';
}

let convoFilter = '';
let contentMatches = {}; // convoId -> snippet (from full-text search across chats)
let draggingConvo = false;
function renderConvos() {
  if (draggingConvo) return; // don't rebuild the list mid-drag
  const list = $('convoList');
  list.innerHTML = '';
  if (!state.conversations.length) { $('convoSearch').classList.add('hidden'); const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'No chats yet. Click “New chat” and pick a folder.'; list.appendChild(d); return; }
  $('convoSearch').classList.toggle('hidden', state.conversations.length < 6 && !convoFilter);
  const q = convoFilter.trim().toLowerCase();
  const shown = q ? state.conversations.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.folderName || '').toLowerCase().includes(q) || contentMatches[c.id]) : state.conversations;
  if (!shown.length) { const d = document.createElement('div'); d.className = 'convo-empty-hint'; d.textContent = 'No chats match your search.'; list.appendChild(d); return; }
  for (const c of shown) {
    const row = document.createElement('div');
    row.className = 'convo' + (c.id === state.currentConvoId ? ' active' : '') + (c.pinned ? ' pinned' : '') + (c.generating ? ' working' : '');
    const pin = document.createElement('button'); pin.className = 'convo-pin'; pin.textContent = c.pinned ? '★' : '☆'; pin.title = c.pinned ? 'Unpin' : 'Pin';
    pin.onclick = (e) => { e.stopPropagation(); cc.pinConvo(c.id); };
    const meta = document.createElement('div'); meta.className = 'convo-meta';
    const title = document.createElement('div'); title.className = 'convo-title'; title.textContent = c.title || 'New chat';
    const sub = document.createElement('div'); sub.className = 'convo-folder';
    // Which account this chat uses (small initial badge), then the folder name.
    const acc = c.accountId && state.accounts.find((a) => a.id === c.accountId);
    if (acc) { const b = document.createElement('span'); b.className = 'convo-acc'; b.textContent = (acc.name || '?').trim().charAt(0).toUpperCase(); b.title = 'Account: ' + acc.name; sub.appendChild(b); }
    const fn = document.createElement('span'); fn.className = 'cf-name'; fn.textContent = c.folderName || ''; sub.appendChild(fn);
    sub.title = c.folder || '';
    meta.appendChild(title); meta.appendChild(sub);
    if (convoFilter && contentMatches[c.id]) { const sn = document.createElement('div'); sn.className = 'convo-snippet'; sn.textContent = contentMatches[c.id]; meta.appendChild(sn); }
    // Live status: needs-approval (amber) > working spinner > live dot.
    const status = document.createElement('span');
    status.className = 'convo-status' + (c.awaiting ? ' needs' : (c.generating ? ' spin' : (c.running ? ' live' : '')));
    if (c.awaiting) status.title = 'Waiting for your approval — open this chat'; else if (c.generating) status.title = 'Working…'; else if (c.running) status.title = 'Running';
    const more = document.createElement('button'); more.className = 'convo-more'; more.textContent = '⋯';
    more.onclick = (e) => { e.stopPropagation(); convoMenu(c, e.currentTarget); };
    row.appendChild(pin); row.appendChild(meta); row.appendChild(status); row.appendChild(more);
    row.onclick = () => openConvo(c.id);
    // Drag to reorder (disabled while a search filter is active)
    row.draggable = !convoFilter; row.dataset.id = c.id;
    row.addEventListener('dragstart', (e) => { draggingConvo = true; row.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); } catch { /* noop */ } });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); draggingConvo = false; if (convoFilter) { renderConvos(); return; } const ids = Array.from(list.querySelectorAll('.convo')).map((r) => r.dataset.id).filter(Boolean); cc.reorderConvos(ids); });
    list.appendChild(row);
  }
  setupConvoDnD(list);
}
let convoDnDReady = false;
function setupConvoDnD(list) {
  if (convoDnDReady) return; convoDnDReady = true;
  // Backstop: never let the drag flag wedge the sidebar if dragend is missed.
  window.addEventListener('dragend', () => { if (draggingConvo) { draggingConvo = false; renderConvos(); } });
  list.addEventListener('dragover', (e) => {
    if (!draggingConvo) return;
    e.preventDefault();
    const dragging = list.querySelector('.convo.dragging'); if (!dragging) return;
    const rows = Array.from(list.querySelectorAll('.convo:not(.dragging)'));
    const after = rows.find((r) => e.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
    if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
  });
}
$('convoSearch').addEventListener('input', async (e) => {
  convoFilter = e.target.value; renderConvos();
  const q = convoFilter.trim();
  if (q.length >= 2) { try { const res = await cc.searchAll(q); if (convoFilter.trim() === q) { contentMatches = {}; res.forEach((r) => { contentMatches[r.id] = r.snippet; }); renderConvos(); } } catch { /* noop */ } }
  else if (Object.keys(contentMatches).length) { contentMatches = {}; renderConvos(); }
});
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
    ['Duplicate', async () => { const r = await cc.duplicateConvo(c.id); if (r && r.ok) toast('Chat duplicated', 'ok'); else toast('Could not duplicate', 'err'); }],
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
const MODELS = [
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-haiku-4-5', 'Haiku 4.5'],
  ['', 'Default (account)'],
];
// Legacy aliases → friendly labels, so an older stored setting still reads right.
const MODEL_ALIASES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Max']];
const PERMS = [['ask', 'Ask each time'], ['acceptEdits', 'Accept edits'], ['bypass', 'Bypass permissions']];
function labelFor(list, id, fb) { const f = list.find((x) => x[0] === id); if (f) return f[1]; if (list === MODELS && MODEL_ALIASES[id]) return MODEL_ALIASES[id]; return fb; }
// Short label for the compact chip (drop the "(account)" suffix).
function shortModelLabel(id) { return labelFor(MODELS, id || '', 'Default').replace(' (account)', ''); }
// Effective model/effort = per-chat override if set, else the global default.
function effModel() { return state.chatModel != null ? state.chatModel : ((state.settings && state.settings.model) || ''); }
function effEffort() { return state.chatEffort != null ? state.chatEffort : ((state.settings && state.settings.effort) || 'medium'); }
function renderModelLabel() {
  $('modelChipLabel').textContent = shortModelLabel(effModel());
  $('effortChipLabel').textContent = labelFor(EFFORTS, effEffort(), 'Medium');
  $('modelChip').classList.toggle('per-chat', state.chatModel != null);
  $('effortChip').classList.toggle('per-chat', state.chatEffort != null);
  const pm = (state.settings && state.settings.permissionMode) || 'ask';
  const pc = $('permChip'); if (pc) {
    $('permChipLabel').textContent = labelFor(PERMS, pm, 'Ask each time');
    pc.classList.toggle('bypass', pm === 'bypass');
    pc.classList.toggle('accept', pm === 'acceptEdits');
  }
}
function updateComposer() {
  // Can send if a session is live, or if this chat already has an account we can
  // auto-resume on (main restarts the session on first send).
  const can = state.running || !!state.activeAccountId;
  $('sendBtn').disabled = !can || (!$('input').value.trim() && !attachments.length);
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
    b.onclick = () => { const inp = $('input'); inp.value = s; autoGrow(); updateComposer(); inp.focus(); if (state.running || state.activeAccountId) sendMessage(); else toast('Choose an account, then press send', 'ok'); };
    box.appendChild(b);
  }
}
// Live onboarding checklist in the welcome screen — ticks off as you set up.
function renderWelcome() {
  const w = $('welcome'); const ol = w && w.querySelector('.welcome-steps'); if (!ol) return;
  const hasChat = !!(state.currentConvoId || (state.conversations && state.conversations.length));
  const hasAcct = (state.accounts || []).length > 0;
  const loggedIn = (state.accounts || []).some((a) => a.loggedIn);
  const steps = [
    { done: hasChat, label: 'Create a chat & pick a folder', hint: 'Click “New chat” (top-left)' },
    { done: hasAcct, label: 'Add a Claude account', hint: 'Account switcher (bottom-left) → Add account' },
    { done: loggedIn, label: 'Log in — your login stays on your machine', hint: 'Sign in once per account' },
    { done: !!state.running, label: 'Choose an account & start chatting', hint: '' },
  ];
  let n = 1;
  ol.innerHTML = steps.map((s) => `<li class="ob-step${s.done ? ' done' : ''}"><span class="ob-mark">${s.done ? '✓' : (n++)}</span><span class="ob-txt"><b>${escapeHtml(s.label)}</b>${s.hint ? `<span class="ob-hint">${escapeHtml(s.hint)}</span>` : ''}</span></li>`).join('');
}
// A folder/account context row above the composer (Claude-desktop style).
function renderCtxRow() {
  const row = $('ctxRow'); if (!row) return;
  if (!state.currentConvoId) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden'); row.innerHTML = '';
  const f = state.projectDir;
  const folder = document.createElement('button'); folder.className = 'ctx-pill';
  folder.innerHTML = '<span class="ctx-ico">📁</span>' + escapeHtml(f ? baseName(f) : 'Pick a folder');
  folder.title = f ? ('This chat’s folder: ' + f + '\nClick to change') : 'Click to pick a folder';
  folder.onclick = () => $('projectBtn').click();
  row.appendChild(folder);
  const a = state.accounts.find((x) => x.id === state.activeAccountId);
  if (a) { const ap = document.createElement('span'); ap.className = 'ctx-pill sub'; ap.innerHTML = '<span class="ctx-dot"></span>' + escapeHtml(a.name); row.appendChild(ap); }
}
function renderAll() { renderProject(); renderConvos(); renderAccountRow(); renderTop(); updateComposer(); renderAttachments(); renderStarters(); renderUsage(); renderLimitPill(); renderWelcome(); renderCtxRow(); pruneDrafts(); }

// Topbar pill: shows when signed-in accounts are cooling down and when the
// soonest one resets, so "how long until I can use it again" is always visible.
function renderLimitPill() {
  const el = $('limitPill'); if (!el) return;
  const now = Date.now();
  const cooling = (state.accounts || []).filter((a) => a.loggedIn && a.cooldownUntil && a.cooldownUntil > now).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
  if (!cooling.length) { el.classList.add('hidden'); return; }
  const soonest = cooling[0];
  el.classList.remove('hidden');
  el.textContent = `⏳ ${soonest.name} · resets in ${fmtCountdown(soonest.cooldownUntil - now)}`;
  el.title = cooling.length > 1 ? `${cooling.length} accounts cooling down` : 'Usage limit — resets at ' + new Date(soonest.cooldownUntil).toLocaleTimeString();
}

/* ---------------- token / usage meter ---------------- */
// Claude Code runs a 200K-token context window by default (the 1M window is a
// separate opt-in this app doesn't enable), so we measure fill against that.
const CONTEXT_WINDOW = 200000;
let usage = { model: '', ctx: 0, lastOut: 0, lastCache: 0, sessOut: 0, sessCost: 0, turns: 0 };
function resetUsage() { usage = { model: usage.model || '', ctx: 0, lastOut: 0, lastCache: 0, sessOut: 0, sessCost: 0, turns: 0 }; renderUsage(); }
function applyTurnUsage(u, costUsd) {
  if (u) {
    const inp = u.input_tokens || 0;
    const cacheR = u.cache_read_input_tokens || 0;
    const cacheC = u.cache_creation_input_tokens || 0;
    const out = u.output_tokens || 0;
    usage.ctx = inp + cacheR + cacheC + out;      // ≈ tokens carried into the next turn
    usage.lastOut = out;
    usage.lastCache = cacheR + cacheC;
    usage.sessOut += out;
  }
  if (costUsd) usage.sessCost += Number(costUsd) || 0;
  usage.turns += 1;
  renderUsage();
}
function fmtTokens(n) { n = Math.max(0, Math.round(n || 0)); if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K'; return String(n); }
function renderUsage() {
  const pct = Math.max(0, Math.min(100, Math.round((usage.ctx / CONTEXT_WINDOW) * 100)));
  const left = Math.max(0, CONTEXT_WINDOW - usage.ctx);
  // Composer status ring
  const ring = $('usageRingFill');
  if (ring) ring.style.background = `conic-gradient(var(--info) ${pct * 3.6}deg, var(--border) 0deg)`;
  const rb = $('usageRingBtn'); if (rb) rb.classList.toggle('hidden', !state.running && !usage.ctx);
  // Popover — "This chat"
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('usageModel', usage.model ? shortModelLabel(usage.model) : shortModelLabel((state.settings || {}).model || ''));
  set('usageCtxPct', pct + '% used');
  const bar = $('usageBar'); if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('warn', pct >= 85); }
  set('usageCtxSub', fmtTokens(left) + ' tokens left of ~' + fmtTokens(CONTEXT_WINDOW));
  set('usageFootStats', `Session: ${fmtTokens(usage.sessOut)} out · $${(usage.sessCost || 0).toFixed(usage.sessCost >= 1 ? 2 : 4)}`);
  renderUsageAccounts();
}
// Per-account bars (maps our multi-account cooldowns onto Claude-desktop's
// "usage limits" layout): active account shows context fill; cooling accounts
// show time-to-reset; the rest are Ready.
function renderUsageAccounts() {
  const box = $('usageAccounts'); if (!box) return;
  box.innerHTML = '';
  const now = Date.now();
  const FULL = 5 * 3600e3; // ~5h reset window used only to scale the cooldown bar
  const pctCtx = Math.max(0, Math.min(100, Math.round((usage.ctx / CONTEXT_WINDOW) * 100)));
  let shown = 0;
  for (const a of (state.accounts || [])) {
    if (!a.loggedIn) continue;
    shown++;
    let pct = 0, sub = 'Ready', cls = 'info';
    if (a.cooldownUntil && a.cooldownUntil > now) { pct = Math.max(6, Math.min(100, Math.round(((a.cooldownUntil - now) / FULL) * 100))); sub = 'Resets in ' + fmtCountdown(a.cooldownUntil - now); cls = 'warn'; }
    else if (a.id === state.activeAccountId && state.running) { pct = pctCtx; sub = pctCtx + '% context used'; }
    const row = document.createElement('div'); row.className = 'ua-row';
    row.innerHTML = `<div class="ua-top"><span class="ua-name">${escapeHtml(a.name)}${a.id === state.activeAccountId ? ' <span class="ua-active">Active</span>' : ''}</span><span class="ua-sub">${escapeHtml(sub)}</span></div><div class="usage-bar-wrap sm"><div class="usage-bar ${cls}" style="width:${pct}%"></div></div>`;
    box.appendChild(row);
  }
  if (!shown) { const d = document.createElement('div'); d.className = 'ul-sub'; d.textContent = 'No signed-in accounts yet.'; box.appendChild(d); }
}
$('usageRingBtn').onclick = (e) => { e.stopPropagation(); const m = $('usageMenu'); const showing = !m.classList.contains('hidden'); closeMenus(); if (showing) return; renderUsage(); m.classList.remove('hidden'); const r = e.currentTarget.getBoundingClientRect(); const w = 300; m.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px'; m.style.bottom = (window.innerHeight - r.top + 10) + 'px'; m.style.top = 'auto'; };

/* ---------------- transcript ---------------- */
const transcript = $('transcript');
let turn = null; let convo = [];
function clearTranscript() { transcript.innerHTML = ''; turn = null; if (typeof closeFind === 'function') closeFind(); }
function nearBottom() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120; }
function scrollDown(force) { if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight; }
transcript.addEventListener('scroll', () => { $('scrollDownBtn').classList.toggle('hidden', nearBottom()); });
$('scrollDownBtn').onclick = () => { transcript.scrollTop = transcript.scrollHeight; };
function wrap(el) { const w = document.createElement('div'); w.className = 'msg-wrap'; w.appendChild(el); transcript.appendChild(w); return w; }
function hideWelcome() { const w = $('welcome'); if (w) w.classList.add('hidden'); }
// The transcript log is now assembled and persisted in the main process (so
// chats running off-screen save correctly). The renderer only renders.
function persist() { /* no-op: main owns the log */ }
const pending = new Set(); let rafQ = false;
function schedule(el) { pending.add(el); if (!rafQ) { rafQ = true; requestAnimationFrame(flush); } }
function flush() { rafQ = false; for (const el of pending) el.innerHTML = renderMarkdown(el._raw || ''); pending.clear(); scrollDown(); }
function toolSummary(name, i) { if (!i) return ''; return i.command || i.file_path || i.path || i.pattern || i.url || (i.prompt ? String(i.prompt).slice(0, 80) : (JSON.stringify(i) === '{}' ? '' : JSON.stringify(i).slice(0, 80))); }

function fmtTime(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function appendUserDOM(text, ts) {
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text; msg.appendChild(b);
  const foot = document.createElement('div'); foot.className = 'user-foot';
  const edit = document.createElement('button'); edit.className = 'msg-edit'; edit.textContent = '✎ Edit'; edit.title = 'Edit & resend this message';
  edit.onclick = () => { const inp = $('input'); inp.value = String(text).replace(/\n?📎 .*$/gm, '').trim(); autoGrow(); updateComposer(); inp.focus(); };
  foot.appendChild(edit);
  if (ts) { const t = document.createElement('span'); t.className = 'msg-time'; t.textContent = fmtTime(ts); foot.appendChild(t); }
  msg.appendChild(foot);
  wrap(msg);
}
function toolIcon(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'read' || n === 'notebookread') return '📖';
  if (n === 'write') return '📝';
  if (n === 'edit' || n === 'multiedit' || n === 'notebookedit' || n === 'update' || n === 'applypatch') return '✏️';
  if (n === 'bash' || n === 'powershell' || n.includes('shell')) return '⌨️';
  if (n === 'grep' || n === 'glob' || n === 'search' || n.includes('find')) return '🔍';
  if (n === 'webfetch' || n === 'websearch' || n.includes('fetch')) return '🌐';
  if (n === 'task' || n === 'agent') return '🤖';
  if (n === 'todowrite' || n.includes('todo')) return '✅';
  return '⚙';
}
// Mirror of main's diffFromInput so a diff shows live (streaming), not just on reload.
function diffFromToolInput(name, input) {
  const n = String(name || '').toLowerCase();
  if (!input || typeof input !== 'object') return null;
  const cap = (s) => String(s == null ? '' : s).slice(0, 4000);
  const file = input.file_path || input.path || input.notebook_path || '';
  if (n === 'edit' || n === 'update' || n === 'notebookedit') return { file, hunks: [{ old: cap(input.old_string), new: cap(input.new_string) }] };
  if (n === 'multiedit' && Array.isArray(input.edits)) return { file, hunks: input.edits.slice(0, 30).map((e) => ({ old: cap(e && e.old_string), new: cap(e && e.new_string) })) };
  if (n === 'write' && typeof input.content === 'string') return { file, hunks: [{ old: '', new: cap(input.content) }] };
  return null;
}
// Render a red/green diff for a file-editing tool card.
function renderDiff(edit) {
  const el = document.createElement('div'); el.className = 'tool-diff';
  if (edit.file) { const f = document.createElement('div'); f.className = 'diff-file'; f.textContent = edit.file; el.appendChild(f); }
  (edit.hunks || []).forEach((h, i) => {
    if (i > 0) { const s = document.createElement('div'); s.className = 'diff-sep'; s.textContent = '⋯'; el.appendChild(s); }
    const addLine = (cls, prefix, text) => { const d = document.createElement('div'); d.className = 'diff-line ' + cls; d.textContent = prefix + text; el.appendChild(d); };
    if (h.old) h.old.split('\n').forEach((l) => addLine('del', '- ', l));
    if (h.new) h.new.split('\n').forEach((l) => addLine('add', '+ ', l));
  });
  return el;
}
function makeToolCard(block) {
  const card = document.createElement('div'); card.className = 'tool-card';
  const head = document.createElement('div'); head.className = 'tool-head';
  const st = block.state === 'running' ? 'running…' : (block.state === 'err' ? 'error' : 'done');
  const cls = block.state === 'running' ? '' : (block.state === 'err' ? 'err' : 'ok');
  head.innerHTML = `<span class="tool-ico">${toolIcon(block.name)}</span><span class="tool-name">${escapeHtml(block.name)}</span><span class="tool-summary">${escapeHtml(block.summary || '')}</span><span class="tool-state ${cls}">${st}</span>`;
  const body = document.createElement('div'); body.className = 'tool-body hidden';
  // Show the diff for edits; on failure fall back to the error text so the user
  // can read WHY it failed.
  if (block.edit && block.state !== 'err') body.appendChild(renderDiff(block.edit)); else body.textContent = block.output || '';
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
// Lightweight, dependency-free syntax highlighting for code blocks. Tokenises
// comments / strings / numbers / keywords and wraps them in styled spans. Safe:
// every token is HTML-escaped and only our own <span class> markup is emitted.
const HL_KW = new Set(('const let var function return if else for while do switch case break continue new class extends super import export from default async await try catch finally throw typeof instanceof delete yield void this null true false undefined in of static get set public private protected def elif except with lambda pass None True False and or not is print raise global nonlocal func package type struct interface map range chan select defer go fn impl mut pub use match enum trait where mod loop unless then begin end nil echo local fi esac then done').split(' '));
function highlightCode(scope) {
  if (!scope) return;
  scope.querySelectorAll('pre code:not(.hl-done)').forEach((code) => {
    code.classList.add('hl-done');
    const lang = ((code.className.match(/language-([\w-]+)/) || [])[1] || '').toLowerCase();
    const hash = /^(py|python|sh|bash|shell|zsh|yaml|yml|rb|ruby|toml|ini|conf|makefile|dockerfile|r)$/.test(lang);
    const src = code.textContent || '';
    const cmt = hash ? '#[^\\n]*|' : '';
    const re = new RegExp('(' + cmt + '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)|(\\b\\d[\\d_.eExXa-fA-F]*\\b)|(\\b[A-Za-z_$][\\w$]*\\b)', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += escapeHtml(src.slice(last, m.index));
      if (m[1]) out += '<span class="tk-c">' + escapeHtml(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tk-s">' + escapeHtml(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tk-n">' + escapeHtml(m[3]) + '</span>';
      else { const w = m[4]; out += HL_KW.has(w) ? '<span class="tk-k">' + escapeHtml(w) + '</span>' : escapeHtml(w); }
      last = re.lastIndex;
    }
    out += escapeHtml(src.slice(last));
    code.innerHTML = out;
  });
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
  highlightCode(body);
  addCodeCopy(body);
  if (!body.querySelector('.msg-actions')) {
    const bar = document.createElement('div'); bar.className = 'msg-actions';
    const copy = document.createElement('button'); copy.className = 'msg-act'; copy.textContent = 'Copy';
    copy.onclick = () => copyText(assistantPlainText(body), copy);
    const retry = document.createElement('button'); retry.className = 'msg-act'; retry.textContent = '↻ Retry';
    retry.title = 'Regenerate — re-run your last request';
    retry.onclick = () => regenerate();
    bar.appendChild(copy); bar.appendChild(retry);
    if (meta && meta.ts) { const t = document.createElement('span'); t.className = 'msg-act-time'; t.textContent = fmtTime(meta.ts); bar.appendChild(t); }
    body.appendChild(bar);
  }
  if (meta && !body.querySelector('.turn-meta')) {
    const parts = [];
    if (meta.usage) { const t = (meta.usage.input_tokens || 0) + (meta.usage.output_tokens || 0); if (t) parts.push('🔢 ' + t.toLocaleString() + ' tokens'); }
    if (meta.costUsd) parts.push('💲 $' + Number(meta.costUsd).toFixed(4));
    if (parts.length) { const m = document.createElement('div'); m.className = 'turn-meta'; parts.forEach((p) => { const s = document.createElement('span'); s.textContent = p; m.appendChild(s); }); body.insertBefore(m, body.querySelector('.msg-actions')); }
  }
}

function appendAssistantDOM(blocks, meta) {
  hideWelcome();
  const msg = document.createElement('div'); msg.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'assistant-avatar'; av.textContent = '✳';
  const body = document.createElement('div'); body.className = 'assistant-body';
  for (const blk of blocks || []) {
    if (blk.type === 'text') { const d = document.createElement('div'); d.className = 'md'; d.innerHTML = renderMarkdown(blk.text || ''); body.appendChild(d); }
    else if (blk.type === 'tool') body.appendChild(makeToolCard(blk).card);
  }
  msg.appendChild(av); msg.appendChild(body); wrap(msg);
  decorateAssistant(msg, meta);
}
function renderHistory(log) {
  clearTranscript();
  convo = Array.isArray(log) ? log.map((m) => ({ ...m })) : [];
  resetUsage();
  if (!convo.length) { const w = $('welcome'); if (w) w.classList.remove('hidden'); return; }
  for (const m of convo) {
    if (m.role === 'user') appendUserDOM(m.text, m.ts);
    else { appendAssistantDOM(m.blocks, { usage: m.usage, costUsd: m.costUsd, ts: m.ts }); if (m.usage || m.costUsd) applyTurnUsage(m.usage, m.costUsd); }
  }
  scrollDown(true);
}
function addUserMessage(text) { convo.push({ role: 'user', text }); appendUserDOM(text, Date.now()); persist(); scrollDown(true); }
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
function onAssistantText(text) { const t = ensureTurn(); if (!t.curText) newTextBlock(); const el = t.curText; el._raw = text; el.innerHTML = renderMarkdown(text); pending.delete(el); t.curBlock.text = text; t.curText = null; t.curRaw = ''; t.curBlock = null; scrollDown(); }
function onThinking(text) {
  const t = ensureTurn();
  if (!t.thinkEl) { const d = document.createElement('details'); d.className = 'think'; const s = document.createElement('summary'); s.textContent = 'Thinking'; const b = document.createElement('div'); b.className = 'think-body'; d.appendChild(s); d.appendChild(b); t.body.appendChild(d); t.thinkEl = b; t.thinkRaw = ''; }
  t.thinkRaw += text; t.thinkEl.textContent = t.thinkRaw; scrollDown();
}
function onToolUse(id, name, input) {
  const t = ensureTurn(); t.curText = null; t.curBlock = null;
  const block = { type: 'tool', name, summary: toolSummary(name, input), state: 'running', output: typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input) };
  const ed = diffFromToolInput(name, input); if (ed) block.edit = ed; // live red/green diff
  t.blocks.push(block); const { card, head, body } = makeToolCard(block); t.body.appendChild(card); t.tools.set(id, { block, head, body }); scrollDown();
}
function onToolResult(id, isError, text) {
  const t = turn; if (!t) return; const e = t.tools.get(id); if (!e) return;
  e.block.state = isError ? 'err' : 'ok';
  const s = e.head.querySelector('.tool-state'); s.textContent = isError ? 'error' : 'done'; s.className = 'tool-state ' + (isError ? 'err' : 'ok');
  if (text) {
    e.block.output = (typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 8000);
    // Keep the diff for a successful edit; show the result/error text otherwise.
    if (isError || !e.block.edit) e.body.textContent = e.block.output;
  }
  scrollDown();
}
function onErrorLine(text) { hideWelcome(); const el = document.createElement('div'); el.className = 'err-line'; el.textContent = '⚠ ' + text; if (turn && turn.body) turn.body.appendChild(el); else wrap(el); scrollDown(true); }
function onInfoLine(text) { hideWelcome(); const el = document.createElement('div'); el.className = 'info-line'; el.textContent = text; wrap(el); scrollDown(true); }
function endTurn(meta) { if (turn && turn.blocks.length) { const m = Object.assign({ ts: Date.now() }, meta); convo.push({ role: 'assistant', blocks: turn.blocks, usage: m.usage, costUsd: m.costUsd }); persist(); if (turn.msg) decorateAssistant(turn.msg, m); } turn = null; }

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
  // Only draw events for the chat currently on screen. Other chats keep running
  // in the background; their progress shows as a spinner in the sidebar and
  // their results are saved by the main process.
  if (ev.convoId && state.currentConvoId && ev.convoId !== state.currentConvoId) return;
  switch (ev.type) {
    case 'ready': if (ev.model) { usage.model = ev.model; renderUsage(); } break;
    case 'assistant_delta': onAssistantDelta(ev.text); break;
    case 'assistant_text': onAssistantText(ev.text); break;
    case 'thinking': onThinking(ev.text); break;
    case 'tool_use': onToolUse(ev.id, ev.name, ev.input); break;
    case 'tool_result': onToolResult(ev.id, ev.isError, ev.text); break;
    case 'permission': onPermission(ev.requestId, ev.tool, ev.input); break;
    case 'info': onInfoLine(ev.text); break;
    case 'turn_end': applyTurnUsage(ev.usage, ev.costUsd); endTurn({ usage: ev.usage, costUsd: ev.costUsd }); break;
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
  if (!state.currentConvoId) { const r = await cc.newChat(); if (!r || !r.ok) return; }
  const res = await cc.startChat(id);
  if (!res.ok) { if (res.error === 'not_logged_in') { const a = state.accounts.find((x) => x.id === id); openLogin(a); } else toast(res.error || 'Could not start', 'err'); }
  else if (res.carried) toast('Conversation carried to this account', 'ok');
}
function flashProject() { const b = $('projectBtn'); b.style.color = 'var(--err)'; setTimeout(() => { b.style.color = ''; }, 1200); }
async function sendMessage() {
  const inp = $('input'); const text = inp.value.trim();
  if (!text && !attachments.length) return;
  if (!state.running && !state.activeAccountId) { toast('Choose an account to start this chat', 'err'); return; }
  addUserMessage(text + (attachments.length ? '\n' + attachments.map((p) => '📎 ' + baseName(p)).join('\n') : ''));
  const atts = attachments.slice(); attachments = []; renderAttachments();
  inp.value = ''; if (state.currentConvoId) delete drafts[state.currentConvoId]; autoGrow(); updateComposer();
  const res = await cc.sendMessage(text, atts);
  if (res && !res.ok) onErrorLine(res.error || 'Could not send');
}
async function regenerate() {
  if (!state.running && !state.activeAccountId) { toast('Choose an account first', 'err'); return; }
  const res = await cc.regenerate();
  if (res && !res.ok) { toast(res.error || 'Could not regenerate', 'err'); return; }
  scrollDown(true);
}
function autoGrow() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(200, i.scrollHeight) + 'px'; }
function renderAttachments() {
  const row = $('attachRow'); row.innerHTML = ''; row.classList.toggle('hidden', !attachments.length);
  attachments.forEach((p, i) => { const c = document.createElement('div'); c.className = 'attach-chip'; c.innerHTML = `📎 ${escapeHtml(baseName(p))} <span class="rm">✕</span>`; c.querySelector('.rm').onclick = () => { attachments.splice(i, 1); renderAttachments(); }; row.appendChild(c); });
}

$('sendBtn').onclick = sendMessage;
$('input').addEventListener('input', () => { autoGrow(); updateComposer(); histIdx = -1; if (state.currentConvoId) drafts[state.currentConvoId] = $('input').value; });
// Composer prompt history: ↑ recalls previous prompts (when caret is at the
// start / already navigating), ↓ moves back toward your draft. Newest first.
let histItems = [], histIdx = -1;
async function loadHist() { try { histItems = (await cc.promptHistory()) || []; } catch { histItems = []; } }
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const inp = $('input');
  if (e.key === 'ArrowUp' && !e.altKey && histItems.length && (histIdx >= 0 || inp.selectionStart === 0)) {
    if (histIdx < histItems.length - 1) { histIdx++; inp.value = histItems[histIdx]; autoGrow(); updateComposer(); }
    e.preventDefault(); return;
  }
  if (e.key === 'ArrowDown' && !e.altKey && histIdx >= 0) {
    histIdx--; inp.value = histIdx >= 0 ? histItems[histIdx] : ''; autoGrow(); updateComposer();
    e.preventDefault(); return;
  }
  if (e.key !== 'Enter' || e.isComposing) return;
  const enterSends = (state.settings || {}).enterSends !== false;
  const wantSend = enterSends ? (!e.shiftKey) : (e.ctrlKey || e.metaKey);
  if (wantSend) { e.preventDefault(); histIdx = -1; sendMessage().then(loadHist); }
});
// Paste images (screenshots / copied images) or files straight into the chat.
// Electron 32+ removed File.path, so we resolve real files via getPathForFile
// and handle image blobs by reading their bytes directly — that works even when
// the OS clipboard holds the image in a format clipboard.readImage can't decode.
$('input').addEventListener('paste', async (e) => {
  const dt = e.clipboardData; if (!dt) return;
  // 1) Real on-disk files (copied in Explorer/Finder, dragged from another app).
  const filePaths = Array.from(dt.files || []).map((f) => cc.getPathForFile(f)).filter(Boolean);
  if (filePaths.length) {
    e.preventDefault();
    attachments = attachments.concat(filePaths); renderAttachments();
    toast(filePaths.length + ' file' + (filePaths.length > 1 ? 's' : '') + ' attached', 'ok');
    return;
  }
  // 2) Image blobs with no filesystem path (screenshots, "copy image", etc.).
  const imageItems = Array.from(dt.items || []).filter((it) => it.kind === 'file' && it.type && it.type.startsWith('image/'));
  if (imageItems.length) {
    e.preventDefault();
    let added = 0;
    for (const it of imageItems) {
      const file = it.getAsFile(); if (!file) continue;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const ext = ((file.type.split('/')[1] || 'png').toLowerCase()).replace('jpeg', 'jpg');
        const r = await cc.savePastedImage(bytes, ext);
        if (r && r.ok) { attachments.push(r.path); added++; }
      } catch { /* skip this blob */ }
    }
    if (added) { renderAttachments(); toast('Image pasted', 'ok'); }
    else {
      // 3) Last resort: pull whatever bitmap the OS clipboard has.
      const r = await cc.pasteImage();
      if (r && r.ok) { attachments.push(r.path); renderAttachments(); toast('Image pasted', 'ok'); }
      else toast((r && r.error) || 'Could not paste image', 'err');
    }
    return;
  }
  // 4) Nothing usable in the paste event — try the OS clipboard bitmap directly.
  if (!dt.getData || !dt.getData('text')) {
    const r = await cc.pasteImage();
    if (r && r.ok) { e.preventDefault(); attachments.push(r.path); renderAttachments(); toast('Image pasted', 'ok'); }
  }
});
$('stopBtn').onclick = () => cc.interrupt();
$('attachBtn').onclick = async () => { const files = await cc.pickFiles(); if (files && files.length) { attachments = attachments.concat(files); renderAttachments(); } };

/* ---------------- prompt templates ---------------- */
const DEFAULT_TEMPLATES = [
  { name: 'Explain this codebase', text: 'Give me a high-level overview of this codebase: the main modules, how they fit together, and where the entry points are.' },
  { name: 'Find & fix a bug', text: 'Find a bug in the most recently changed files, explain the root cause, then fix it.' },
  { name: 'Write tests', text: 'Write thorough tests for the current file, covering the main paths and edge cases.' },
  { name: 'Review my changes', text: 'Review my most recent changes for correctness, edge cases and simplifications. Be specific with file:line references.' },
  { name: 'Refactor for clarity', text: 'Refactor this code to be simpler and clearer without changing behavior. Explain each change briefly.' },
];
function templates() { const t = (state.settings || {}).templates; return (Array.isArray(t) && t.length) ? t : DEFAULT_TEMPLATES; }
function insertTemplate(text) { const inp = $('input'); inp.value = (inp.value ? inp.value + '\n' : '') + text; autoGrow(); updateComposer(); inp.focus(); if (state.currentConvoId) drafts[state.currentConvoId] = inp.value; }
function openTemplateMenu(anchor) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu ctx tpl-menu';
  const lbl = document.createElement('div'); lbl.className = 'm-label'; lbl.textContent = 'Prompt templates'; m.appendChild(lbl);
  const custom = Array.isArray((state.settings || {}).templates);
  templates().forEach((t, i) => {
    const b = document.createElement('button'); b.className = 'tpl-item';
    const nm = document.createElement('span'); nm.className = 'tpl-name'; nm.textContent = t.name; b.appendChild(nm);
    if (custom) { const x = document.createElement('span'); x.className = 'tpl-del'; x.textContent = '✕'; x.title = 'Delete template'; x.onclick = async (e) => { e.stopPropagation(); const arr = templates().filter((_, j) => j !== i); state.settings = await cc.setSettings({ templates: arr }); openTemplateMenu(anchor); }; b.appendChild(x); }
    b.onclick = () => { closeMenus(); insertTemplate(t.text); };
    m.appendChild(b);
  });
  const sep = document.createElement('div'); sep.className = 'm-sep'; m.appendChild(sep);
  const save = document.createElement('button'); save.textContent = '＋ Save current text as template';
  save.onclick = async () => {
    closeMenus(); const cur = $('input').value.trim();
    if (!cur) { toast('Type a prompt first, then save it', 'err'); return; }
    const name = await uiPrompt('Template name:', '', 'Save');
    if (name && name.trim()) { const base = custom ? state.settings.templates.slice() : DEFAULT_TEMPLATES.slice(); base.push({ name: name.trim().slice(0, 40), text: cur }); state.settings = await cc.setSettings({ templates: base }); toast('Template saved', 'ok'); }
  };
  m.appendChild(save);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(); const w = m.offsetWidth || 260;
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  m.style.bottom = (window.innerHeight - r.top + 8) + 'px'; m.style.top = 'auto';
}
$('tplBtn').onclick = (e) => { e.stopPropagation(); openTemplateMenu(e.currentTarget); };

/* ---------------- voice to text (dictation) ---------------- */
(() => {
  const btn = $('micBtn');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!btn) return;
  if (!SR) { btn.disabled = true; btn.title = 'Voice input is not available in this build'; return; }
  let rec = null, listening = false, baseText = '', stopping = false;
  const inp = $('input');
  function setListening(on) {
    listening = on;
    btn.classList.toggle('listening', on);
    btn.title = on ? 'Stop dictation' : 'Dictate (voice to text)';
  }
  function start() {
    try {
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      baseText = inp.value;
      stopping = false;
      rec.onresult = (e) => {
        let finalTxt = '', interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTxt += t; else interim += t;
        }
        if (finalTxt) baseText = (baseText ? baseText.replace(/\s*$/, '') + ' ' : '') + finalTxt.trim();
        const joiner = baseText && interim ? ' ' : '';
        inp.value = baseText + joiner + interim;
        autoGrow(); updateComposer();
      };
      rec.onerror = (e) => {
        stopping = true;
        const msg = e && e.error;
        if (msg === 'not-allowed' || msg === 'service-not-allowed') toast('Microphone access was blocked', 'err');
        else if (msg === 'no-speech') toast('Didn’t catch that — try again', 'err');
        else if (msg === 'network') toast('Voice service unavailable (no network / not supported in this build)', 'err');
        else if (msg !== 'aborted') toast('Voice input error', 'err');
        setListening(false);
      };
      rec.onend = () => {
        // Chromium ends the session periodically; keep going until the user stops.
        if (listening && !stopping) { try { rec.start(); return; } catch { /* fall through */ } }
        setListening(false);
        inp.focus();
      };
      rec.start();
      setListening(true);
    } catch (err) {
      toast('Could not start voice input', 'err');
      setListening(false);
    }
  }
  function stop() { stopping = true; setListening(false); if (rec) { try { rec.stop(); } catch { /* noop */ } } }
  btn.onclick = () => { if (listening) stop(); else start(); };
})();
async function newChat(chooseFolder) {
  // Reuse the current chat's folder by default (no dialog); pass chooseFolder
  // to explicitly pick a different one.
  const folder = chooseFolder ? '' : (state.projectDir || '');
  const r = await cc.newChat(folder);
  if (r && r.canceled) return;
  if (r && !r.ok) toast(r.error || 'Could not start', 'err');
}
$('newChatBtn').onclick = (e) => newChat(e && (e.altKey || e.shiftKey)); // Alt/Shift+click = pick a folder
async function toggleSidebar() { const v = !(state.settings || {}).sidebarCollapsed; state.settings = await cc.setSettings({ sidebarCollapsed: v }); applyAppearance(state.settings); }
$('sidebarToggle').onclick = toggleSidebar;
$('projectBtn').onclick = async () => {
  if (!state.currentConvoId) { const r = await cc.newChat(); if (r && !r.ok && !r.canceled) toast(r.error || 'Could not start', 'err'); return; }
  const dir = await cc.pickProject();
  if (!dir) return;
  const r = await cc.chooseProject(dir);
  if (r && r.ok === false) toast(r.error || 'Could not change folder', 'err');
};
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
function closeMenus() { document.querySelectorAll('.menu.ctx').forEach((n) => n.remove()); $('modelMenu').classList.add('hidden'); $('effortMenu').classList.add('hidden'); $('permMenu').classList.add('hidden'); $('usageMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('#accountBtn') && !e.target.closest('#switchPill') && !e.target.closest('#modelChip') && !e.target.closest('#effortChip') && !e.target.closest('#permChip') && !e.target.closest('#usageRingBtn') && !e.target.closest('.convo-more')) closeMenus(); });
// Position a composer popover just above its anchor chip.
function anchorAbove(menu, anchor) {
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth || 240;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  menu.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  menu.style.top = 'auto';
}
// Model picker — Claude-desktop style: "Models" header, numbered rows, checkmark.
function openModelMenu(anchor) {
  const menu = $('modelMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closeMenus(); menu.innerHTML = '';
  const cur = effModel();
  const perChat = !!state.currentConvoId;
  const lbl = document.createElement('div'); lbl.className = 'm-label'; lbl.textContent = perChat ? 'Model — this chat' : 'Default model'; menu.appendChild(lbl);
  MODELS.forEach(([id, label], i) => {
    const b = document.createElement('button'); b.className = 'model-row';
    const num = id ? String(i + 1) : '';
    b.innerHTML = `<span class="mr-check">${id === cur ? '✓' : ''}</span><span class="mr-name">${escapeHtml(label)}</span><span class="mr-num">${num}</span>`;
    b.onclick = async () => { closeMenus(); if (perChat) { state.chatModel = id; await cc.setChatModel(id); } else { state.settings = await cc.setSettings({ model: id }); } renderModelLabel(); renderUsage(); toast('Model: ' + shortModelLabel(id), 'ok'); };
    menu.appendChild(b);
  });
  anchorAbove(menu, anchor);
}
// Effort picker — Faster ↔ Smarter slider.
function openEffortMenu(anchor) {
  const menu = $('effortMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closeMenus(); menu.innerHTML = '';
  const cur = effEffort();
  const perChat = !!state.currentConvoId;
  const head = document.createElement('div'); head.className = 'effort-head'; head.innerHTML = `Effort${perChat ? ' (this chat)' : ''} <b>${escapeHtml(labelFor(EFFORTS, cur, 'Medium'))}</b>`; menu.appendChild(head);
  const ends = document.createElement('div'); ends.className = 'effort-ends'; ends.innerHTML = '<span>Faster</span><span>Smarter</span>'; menu.appendChild(ends);
  const track = document.createElement('div'); track.className = 'effort-track';
  const curIdx = EFFORTS.findIndex((x) => x[0] === cur);
  EFFORTS.forEach(([id, label], i) => {
    const stop = document.createElement('button'); stop.className = 'effort-stop' + (i <= curIdx ? ' on' : '') + (id === cur ? ' active' : '');
    stop.title = label;
    stop.onclick = async () => { closeMenus(); if (perChat) { state.chatEffort = id; await cc.setChatEffort(id); } else { state.settings = await cc.setSettings({ effort: id }); } renderModelLabel(); toast('Effort: ' + label, 'ok'); };
    track.appendChild(stop);
  });
  menu.appendChild(track);
  anchorAbove(menu, anchor);
}
// Permission-mode picker.
function openPermMenu(anchor) {
  const menu = $('permMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closeMenus(); menu.innerHTML = '';
  const cur = (state.settings && state.settings.permissionMode) || 'ask';
  const subs = { ask: 'Approve each tool before it runs', acceptEdits: 'Auto-approve file edits, ask for the rest', bypass: 'Run every tool without asking' };
  const lbl = document.createElement('div'); lbl.className = 'm-label'; lbl.textContent = 'Permissions'; menu.appendChild(lbl);
  PERMS.forEach(([id, label]) => {
    const b = document.createElement('button'); b.className = 'perm-row' + (id === 'bypass' ? ' bypass' : '');
    b.innerHTML = `<span class="pr-check">${id === cur ? '✓' : ''}</span><span class="pr-meta"><span class="pr-name">${escapeHtml(label)}</span><span class="pr-sub">${escapeHtml(subs[id])}</span></span>`;
    b.onclick = async () => { closeMenus(); state.settings = await cc.setSettings({ permissionMode: id }); renderModelLabel(); toast(label, 'ok'); };
    menu.appendChild(b);
  });
  anchorAbove(menu, anchor);
}
$('modelChip').onclick = (e) => { e.stopPropagation(); openModelMenu(e.currentTarget); };
$('effortChip').onclick = (e) => { e.stopPropagation(); openEffortMenu(e.currentTarget); };
$('permChip').onclick = (e) => { e.stopPropagation(); openPermMenu(e.currentTarget); };

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
let pendingSwitch = null; let pendingLimitConvo = null;
cc.onLimit((info) => {
  const cur = state.accounts.find((x) => x.id === info.accountId); const curName = cur ? cur.name : 'This account';
  const resetTxt = info.resetAt ? ` Resets in ${fmtCountdown(info.resetAt - Date.now())}.` : '';
  renderLimitPill();
  // Main already carried the chat to a free account and resumed the work.
  if (info.handled) { toast(`${curName} hit its limit — continued on ${info.next ? info.next.name : 'another account'}`, 'ok'); return; }
  // If the limit is on a background chat (not the one on screen), don't hijack
  // the visible chat with a modal — just nudge the user to open that chat.
  if (info.convoId && state.currentConvoId && info.convoId !== state.currentConvoId) {
    const c = state.conversations.find((x) => x.id === info.convoId);
    toast(`${curName} hit its limit${c ? ` on “${c.title}”` : ''} — open that chat to switch accounts`, 'err');
    return;
  }
  pendingLimitConvo = info.convoId || state.currentConvoId;
  if (info.next && info.nextAvailable) {
    // A free account exists — offer to switch and continue.
    pendingSwitch = info.next.id;
    $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.${escapeHtml(resetTxt)}<br><br>Switch to <b>${escapeHtml(info.next.name)}</b> and ${info.canContinue ? '<b>continue where Claude left off</b>' : 'continue this conversation'}?`;
    $('switchGo').classList.remove('hidden');
  } else {
    // Nothing free right now — inform, don't offer a switch that would re-limit.
    pendingSwitch = null;
    const soon = info.next && info.next.resetAt ? ` Soonest to free up: <b>${escapeHtml(info.next.name)}</b> in ${escapeHtml(fmtCountdown(info.next.resetAt - Date.now()))}.` : '';
    $('switchBody').innerHTML = `<b>${escapeHtml(curName)}</b> hit its usage limit.${escapeHtml(resetTxt)}<br><br>No account is free right now — the work will need to wait.${soon}`;
    $('switchGo').classList.add('hidden');
  }
  $('switchModal').classList.remove('hidden');
});
$('switchCancel').onclick = () => $('switchModal').classList.add('hidden');
$('switchGo').onclick = () => { $('switchModal').classList.add('hidden'); if (pendingSwitch) doSwitch(pendingSwitch); };
async function doSwitch(id) {
  // Only write the inline note if the limited chat is the one on screen.
  if (!pendingLimitConvo || pendingLimitConvo === state.currentConvoId) onErrorLine('Switching account…');
  const r = await cc.continueOn(pendingLimitConvo, id);
  if (r && !r.ok) toast(r.error === 'not_logged_in' ? 'That account is not signed in' : (r.error || 'Switch failed'), 'err');
  else toast('Switched account' + (r && r.continued ? ' · continuing the task' : (r && r.carried ? ' · conversation carried over' : '')), 'ok');
}

/* ---------------- settings ---------------- */
const ACCENTS = [
  { v: '', c: '#d97757', name: 'Coral (default)' },
  { v: '#4d90d6', c: '#4d90d6', name: 'Blue' },
  { v: '#4ec98a', c: '#4ec98a', name: 'Green' },
  { v: '#a07cf0', c: '#a07cf0', name: 'Purple' },
  { v: '#e0a458', c: '#e0a458', name: 'Amber' },
  { v: '#e06ba8', c: '#e06ba8', name: 'Pink' },
  { v: '#3bb3a1', c: '#3bb3a1', name: 'Teal' },
];
function renderAccentRow() {
  const row = $('accentRow'); if (!row) return; row.innerHTML = '';
  const cur = (state.settings || {}).accent || '';
  ACCENTS.forEach((a) => {
    const b = document.createElement('button'); b.className = 'accent-sw' + (a.v === cur ? ' on' : ''); b.style.background = a.c; b.title = a.name;
    b.onclick = async () => { state.settings = await cc.setSettings({ accent: a.v }); applyAppearance(state.settings); renderAccentRow(); };
    row.appendChild(b);
  });
}
function openSettings() {
  const s = state.settings || {};
  renderAccentRow();
  $('setTheme').value = ['light', 'system'].includes(s.theme) ? s.theme : 'dark';
  $('setWidth').value = s.width === 'wide' ? 'wide' : 'comfortable';
  $('setFontScale').value = ['small', 'large'].includes(s.fontScale) ? s.fontScale : 'normal';
  $('setEnterSends').checked = s.enterSends !== false;
  $('setPermission').value = ['acceptEdits', 'bypass'].includes(s.permissionMode) ? s.permissionMode : 'ask';
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

/* ---------------- activity & usage dashboard ---------------- */
function renderDashboard() {
  const el = $('dashBody'); if (!el) return;
  const now = Date.now();
  const convs = state.conversations || [];
  const loggedIn = (state.accounts || []).filter((a) => a.loggedIn);
  const accHtml = loggedIn.map((a) => {
    const using = convs.filter((c) => c.accountId === a.id).length;
    const run = convs.filter((c) => c.accountId === a.id && c.running).length;
    let status = 'Ready', cls = 'ready';
    if (a.cooldownUntil && a.cooldownUntil > now) { status = 'Cooling · ' + fmtCountdown(a.cooldownUntil - now); cls = 'cool'; }
    else if (a.id === state.activeAccountId && state.running) { status = 'Active'; cls = 'active'; }
    return `<div class="dash-acc"><span class="dash-acc-av">${escapeHtml((a.name || '?').charAt(0).toUpperCase())}</span>`
      + `<span class="dash-acc-meta"><span class="dash-acc-name">${escapeHtml(a.name)}</span><span class="dash-acc-sub">${escapeHtml(a.email || 'not signed in')}</span></span>`
      + `<span class="dash-acc-stat ${cls}">${escapeHtml(status)}</span>`
      + `<span class="dash-acc-num">${using} chat${using === 1 ? '' : 's'}${run ? ' · ' + run + ' running' : ''}</span></div>`;
  }).join('') || '<div class="dash-empty">No signed-in accounts yet.</div>';
  const pct = Math.max(0, Math.min(100, Math.round((usage.ctx / CONTEXT_WINDOW) * 100)));
  const left = Math.max(0, CONTEXT_WINDOW - usage.ctx);
  const stat = (n, l) => `<div class="dash-stat"><div class="dash-n">${n}</div><div class="dash-l">${l}</div></div>`;
  el.innerHTML = `<div class="dash-stats">${stat(convs.length, 'chats')}${stat(convs.filter((c) => c.running).length, 'running')}${stat(convs.filter((c) => c.generating).length, 'working now')}${stat(loggedIn.length, 'accounts')}</div>`
    + `<div class="dash-sec-label">Accounts</div><div class="dash-accs">${accHtml}</div>`
    + `<div class="dash-sec-label">This chat</div><div class="dash-chat">`
    + `<div class="dash-row"><span>Model</span><b>${escapeHtml(shortModelLabel(usage.model || effModel()))}</b></div>`
    + `<div class="dash-row"><span>Context used</span><b>${pct}% · ${fmtTokens(left)} left</b></div>`
    + `<div class="dash-row"><span>Session output</span><b>${fmtTokens(usage.sessOut)} tokens</b></div>`
    + `<div class="dash-row"><span>Session cost</span><b>$${(usage.sessCost || 0).toFixed(usage.sessCost >= 1 ? 2 : 4)}</b></div></div>`;
}
function openDashboard() { renderDashboard(); $('dashModal').classList.remove('hidden'); }
$('dashBtn').onclick = openDashboard;
$('dashClose').onclick = () => $('dashModal').classList.add('hidden');
$('dashModal').addEventListener('click', (e) => { if (e.target === $('dashModal')) $('dashModal').classList.add('hidden'); });
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
document.querySelectorAll('.snav').forEach((b) => { b.onclick = () => {
  document.querySelectorAll('.snav').forEach((x) => x.classList.remove('active')); b.classList.add('active');
  const p = b.dataset.pane; document.querySelectorAll('.spane').forEach((x) => x.classList.toggle('hidden', x.dataset.pane !== p));
}; });
$('setTheme').onchange = async (e) => { applyTheme(e.target.value); state.settings = await cc.setSettings({ theme: e.target.value }); };
$('setPermission').onchange = async (e) => { state.settings = await cc.setSettings({ permissionMode: e.target.value }); renderModelLabel(); toast(e.target.value === 'bypass' ? 'Allowing all tools — no more prompts' : (e.target.value === 'acceptEdits' ? 'Auto-accepting file edits' : 'Will ask before each tool'), 'ok'); };
$('setModel').onchange = async (e) => { state.settings = await cc.setSettings({ model: e.target.value }); renderModelLabel(); };
$('setEffort').onchange = async (e) => { state.settings = await cc.setSettings({ effort: e.target.value }); renderModelLabel(); };
$('setAutoSwitch').onchange = async (e) => { state.settings = await cc.setSettings({ autoSwitch: e.target.checked }); };
$('setNotify').onchange = async (e) => { state.settings = await cc.setSettings({ notify: e.target.checked }); };
$('setTray').onchange = async (e) => { state.settings = await cc.setSettings({ minimizeToTray: e.target.checked }); };
$('setStartup').onchange = async (e) => { state.settings = await cc.setSettings({ startOnLogin: e.target.checked }); };
$('exportBtn').onclick = async () => { const r = await cc.exportConfig(); if (r && r.ok) toast('Exported to ' + r.path, 'ok'); else if (r && r.error) toast(r.error, 'err'); };
$('exportAllBtn').onclick = async () => { const r = await cc.exportAllChats(); if (r && r.ok) toast(`Exported ${r.count} chat${r.count === 1 ? '' : 's'} to ${r.path}`, 'ok'); else if (r && r.error) toast(r.error, 'err'); };
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
function shade(hex, f) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex; const n = parseInt(m[1], 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.max(0, Math.min(255, Math.round(x * f))).toString(16).padStart(2, '0')); return '#' + c.join(''); }
function applyAppearance(s) {
  s = s || (state.settings || {});
  if (s.theme !== undefined) applyTheme(s.theme);
  document.documentElement.setAttribute('data-width', s.width === 'wide' ? 'wide' : 'comfortable');
  document.documentElement.setAttribute('data-fontscale', ['small', 'large'].includes(s.fontScale) ? s.fontScale : 'normal');
  const rs = document.documentElement.style;
  if (s.accent) { rs.setProperty('--accent', s.accent); rs.setProperty('--accent-2', shade(s.accent, 0.82)); }
  else { rs.removeProperty('--accent'); rs.removeProperty('--accent-2'); }
  document.documentElement.setAttribute('data-sidebar', s.sidebarCollapsed ? 'collapsed' : 'open');
  if (typeof s.zoom === 'number' && cc.setZoom) cc.setZoom(s.zoom);
  if (s.sidebarWidth) { const sb = $('sidebar'); if (sb) { const w = Math.max(220, Math.min(480, s.sidebarWidth)); sb.style.width = w + 'px'; sb.style.minWidth = w + 'px'; } }
}
// Drag-to-resize the sidebar; width persists in settings.
(function sidebarResize() {
  const sb = $('sidebar'); if (!sb) return;
  sb.style.position = 'relative';
  const h = document.createElement('div'); h.className = 'side-resize'; sb.appendChild(h);
  const clamp = (w) => Math.max(220, Math.min(480, w));
  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = sb.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    const mm = (ev) => { const w = clamp(startW + (ev.clientX - startX)); sb.style.width = w + 'px'; sb.style.minWidth = w + 'px'; };
    const mu = () => {
      document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      cc.setSettings({ sidebarWidth: Math.round(sb.getBoundingClientRect().width) });
    };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  });
})();
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
  cmds.push({ icon: '＋', label: 'New chat (same folder)', hint: 'Ctrl+N', run: () => newChat(false) });
  cmds.push({ icon: '📁', label: 'New chat in another folder…', run: () => newChat(true) });
  if (state.currentConvoId) cmds.push({ icon: '⎘', label: 'Duplicate this chat', run: async () => { const r = await cc.duplicateConvo(state.currentConvoId); if (r && r.ok) toast('Chat duplicated', 'ok'); } });
  if (state.running) cmds.push({ icon: '↻', label: 'Regenerate last response', run: () => regenerate() });
  cmds.push({ icon: '🔍', label: 'Search chats', hint: 'Ctrl+F', run: () => { $('convoSearch').classList.remove('hidden'); $('convoSearch').focus(); } });
  cmds.push({ icon: '🔎', label: 'Find in this chat', hint: 'Ctrl+Shift+F', run: () => openFind() });
  cmds.push({ icon: '📤', label: 'Export this chat as Markdown', run: async () => { const r = await cc.exportMd(); if (r && r.ok) toast('Exported to ' + r.path, 'ok'); else if (r && r.error) toast(r.error, 'err'); } });
  cmds.push({ icon: '🗂', label: 'Export ALL chats to Markdown…', run: async () => { const r = await cc.exportAllChats(); if (r && r.ok) toast(`Exported ${r.count} chats to ${r.path}`, 'ok'); else if (r && r.error) toast(r.error, 'err'); } });
  cmds.push({ icon: '🎨', label: 'Toggle light / dark theme', run: async () => { const cur = (state.settings || {}).theme; const next = cur === 'light' ? 'dark' : 'light'; applyTheme(next); state.settings = await cc.setSettings({ theme: next }); } });
  cmds.push({ icon: '⬅', label: (state.settings || {}).sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar', hint: 'Ctrl+B', run: () => toggleSidebar() });
  cmds.push({ icon: '📊', label: 'Activity & usage dashboard', run: () => openDashboard() });
  cmds.push({ icon: '⚙', label: 'Open settings', run: () => openSettings() });
  cmds.push({ icon: '⌨', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => $('shortcutsModal').classList.remove('hidden') });
  // Quick model switch
  for (const [id, label] of MODELS) {
    cmds.push({ icon: '◇', label: 'Model: ' + label, hint: (state.settings || {}).model === id ? 'current' : '', run: async () => { state.settings = await cc.setSettings({ model: id }); renderModelLabel(); toast('Model: ' + label, 'ok'); } });
  }
  // Quick effort switch
  for (const [id, label] of EFFORTS) {
    cmds.push({ icon: '⚡', label: 'Effort: ' + label, hint: ((state.settings || {}).effort || 'medium') === id ? 'current' : '', run: async () => { state.settings = await cc.setSettings({ effort: id }); renderModelLabel(); toast('Effort: ' + label, 'ok'); } });
  }
  cmds.push({ icon: '📊', label: 'Show token usage for this chat', run: () => { const b = $('usageRingBtn'); if (b && !b.classList.contains('hidden')) b.click(); else toast('Usage appears once a chat is running', 'ok'); } });
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

/* ---------------- find in chat (Ctrl+Shift+F) ---------------- */
let findEls = [], findIdx = -1;
function ensureFindBar() {
  let bar = $('findBar'); if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'findBar'; bar.className = 'find-bar hidden';
  bar.innerHTML = '<input id="findInput" class="find-input" placeholder="Find in chat…" /><span id="findCount" class="find-count"></span>'
    + '<button id="findPrev" class="find-btn" title="Previous (Shift+Enter)">↑</button><button id="findNext" class="find-btn" title="Next (Enter)">↓</button><button id="findClose" class="find-btn" title="Close (Esc)">✕</button>';
  $('main').appendChild(bar);
  $('findInput').addEventListener('input', () => runFind($('findInput').value));
  $('findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } });
  $('findPrev').onclick = () => stepFind(-1); $('findNext').onclick = () => stepFind(1); $('findClose').onclick = closeFind;
  return bar;
}
function openFind() { ensureFindBar().classList.remove('hidden'); const i = $('findInput'); setTimeout(() => { i.focus(); i.select(); }, 10); if (i.value) runFind(i.value); }
function closeFind() { const b = $('findBar'); if (b) b.classList.add('hidden'); findEls.forEach((el) => el.classList.remove('find-current', 'find-match')); findEls = []; findIdx = -1; }
function runFind(q) {
  findEls.forEach((el) => el.classList.remove('find-current', 'find-match')); findEls = []; findIdx = -1;
  q = (q || '').trim().toLowerCase(); const cnt = $('findCount');
  if (!q) { if (cnt) cnt.textContent = ''; return; }
  transcript.querySelectorAll('.md, .msg.user .bubble, .tool-summary, .tool-body').forEach((el) => { if ((el.textContent || '').toLowerCase().includes(q)) { findEls.push(el); el.classList.add('find-match'); } });
  if (cnt) cnt.textContent = findEls.length ? ('1/' + findEls.length) : 'No results';
  if (findEls.length) stepFind(1, true);
}
function stepFind(dir, first) {
  if (!findEls.length) return;
  if (findIdx >= 0 && findEls[findIdx]) findEls[findIdx].classList.remove('find-current');
  findIdx = first ? 0 : ((findIdx + dir) % findEls.length + findEls.length) % findEls.length;
  const el = findEls[findIdx]; el.classList.add('find-current'); el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const cnt = $('findCount'); if (cnt) cnt.textContent = (findIdx + 1) + '/' + findEls.length;
}

/* ---------------- global shortcuts (Ctrl+K/N/F, Ctrl+/) ---------------- */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'k' || e.key === 'K') { e.preventDefault(); if ($('cmdkModal').classList.contains('hidden')) openCmdk(); else closeCmdk(); }
  else if (e.key === '/') { e.preventDefault(); $('shortcutsModal').classList.toggle('hidden'); }
  else if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) { e.preventDefault(); $('newChatBtn').click(); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleSidebar(); }
  else if ((e.key === 'f' || e.key === 'F') && e.shiftKey) { e.preventDefault(); openFind(); }
  else if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) { e.preventDefault(); if (state.conversations.length) { $('convoSearch').classList.remove('hidden'); $('convoSearch').focus(); } }
});
// Esc stops the current generation (when nothing modal is open).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.overlay:not(.hidden)') || document.querySelector('.menu.ctx')) return;
  if (state.generating) { e.preventDefault(); cc.interrupt(); }
});
// Alt+↑/↓ switch chats · Ctrl/Cmd +/-/0 zoom the whole UI.
function cycleChat(dir) { const list = state.conversations || []; if (!list.length) return; let i = list.findIndex((c) => c.id === state.currentConvoId); if (i < 0) i = 0; const n = ((i + dir) % list.length + list.length) % list.length; openConvo(list[n].id); }
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !typing) { e.preventDefault(); cycleChat(e.key === 'ArrowUp' ? -1 : 1); return; }
  const ctrl = e.ctrlKey || e.metaKey; if (!ctrl) return;
  const setZoom = (z) => { if (state.settings) state.settings.zoom = z; cc.setSettings({ zoom: z }); };
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(cc.zoom(0.5)); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(cc.zoom(-0.5)); }
  else if (e.key === '0') { e.preventDefault(); cc.zoom(0); setZoom(0); }
});

/* ---------------- drag & drop attachments ---------------- */
(() => {
  const drop = $('main');
  ['dragover', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }));
  drop.addEventListener('drop', async (e) => {
    const list = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const files = list.map((f) => cc.getPathForFile(f)).filter(Boolean);
    if (files.length) { attachments = attachments.concat(files); renderAttachments(); toast(files.length + ' file' + (files.length > 1 ? 's' : '') + ' attached', 'ok'); return; }
    // Dropped an image with no path (e.g. dragged out of a browser) — save its bytes.
    let added = 0;
    for (const f of list) {
      if (!f.type || !f.type.startsWith('image/')) continue;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const ext = ((f.type.split('/')[1] || 'png').toLowerCase()).replace('jpeg', 'jpg');
        const r = await cc.savePastedImage(bytes, ext);
        if (r && r.ok) { attachments.push(r.path); added++; }
      } catch { /* skip */ }
    }
    if (added) { renderAttachments(); toast(added + ' image' + (added > 1 ? 's' : '') + ' attached', 'ok'); }
  });
})();

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, kind) { const el = $('toast'); el.textContent = msg; el.className = 'toast' + (kind === 'err' ? ' err' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2600); }

/* ---------------- boot ---------------- */
cc.onState((s) => { const prev = state.currentConvoId; state = Object.assign(state, s); if (s.settings) applyAppearance(s.settings); renderAll(); if (state.currentConvoId !== prev) swapDraft(prev, state.currentConvoId); });
(async () => {
  state = await cc.getState();
  applyAppearance(state.settings || {});
  renderAll();
  loadHist();
  if (state.currentConvoId) { try { const h = await cc.getHistory(); if (h && h.log && h.log.length) renderHistory(h.log); } catch {} }
  setInterval(() => { if (state.accounts.some((a) => a.cooldownUntil && a.cooldownUntil > Date.now())) { renderAccountRow(); renderLimitPill(); renderUsageAccounts(); } }, 15000);
})();
})();
