/* global Terminal, FitAddon, SearchAddon, WebLinksAddon */
(() => {
const cc = window.cc;
const $ = (id) => document.getElementById(id);

// ---- terminal ----
const themes = {
  dark: { background: '#0e0f16', foreground: '#e6e8ef', cursor: '#d97757', selectionBackground: '#33384a' },
  light: { background: '#faf9f7', foreground: '#25262b', cursor: '#c2410c', selectionBackground: '#d6d3cd' },
};

const term = new Terminal({
  fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 10000,
  theme: themes.dark,
});
const fit = new FitAddon.FitAddon();
const search = new SearchAddon.SearchAddon();
term.loadAddon(fit);
term.loadAddon(search);
try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch { /* optional */ }
term.open($('terminal'));

function doFit() {
  try { fit.fit(); cc.resize(term.cols, term.rows); } catch { /* not ready */ }
}
setTimeout(doFit, 50);
window.addEventListener('resize', doFit);

// terminal <-> main
term.onData((d) => cc.sendInput(d));
cc.onData((d) => { term.write(d); });
cc.onExit((code) => {
  term.write(`\r\n\x1b[90m[session ended${code != null ? ' (exit ' + code + ')' : ''}]\x1b[0m\r\n`);
  refreshStatus();
});

// ---- state ----
let state = {
  accounts: [], accountId: null, projectDir: '', projectAccount: '', running: false,
  startedAt: 0, switchCount: 0, recentProjects: [], settings: {}, availableCount: 0,
};
let now = Date.now();

function activeName() {
  const a = state.accounts.find((x) => x.id === state.accountId);
  return a ? (a.email || a.name) : null;
}

// ---- rendering ----
function renderBadge() {
  const badge = $('activeBadge');
  if (state.running && state.accountId) {
    badge.textContent = '● ' + activeName();
    badge.className = 'badge live';
  } else {
    badge.textContent = 'No session';
    badge.className = 'badge idle';
  }
  $('stopBtn').disabled = !state.running;
  $('restartBtn').disabled = !state.running;
  $('switchMenuBtn').disabled = state.accounts.filter((a) => a.loggedIn && a.id !== state.accountId).length === 0;
  $('sendBtn').disabled = !state.running;
  composerInput.placeholder = state.running
    ? 'Send a message to Claude…  (Enter to send · Shift+Enter for a new line)'
    : 'Launch an account below to start chatting…';
}

function renderProject() {
  $('projectPath').textContent = state.projectDir || 'No folder selected';
}

function renderProjectAccount() {
  const row = $('projectAccountRow');
  if (!state.projectDir) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const acc = state.accounts.find((a) => a.id === state.projectAccount);
  const nameEl = $('projectAccountName');
  const btn = $('projectAccountBtn');
  if (acc) { nameEl.textContent = '★ ' + acc.name; btn.classList.add('assigned'); }
  else { nameEl.textContent = 'Choose…'; btn.classList.remove('assigned'); }
}

function fmtCountdown(ms) {
  if (ms == null || ms <= 0) return '0s';
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function fmtAgo(ts) {
  if (!ts) return '';
  const d = now - ts;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
  return Math.floor(d / 86400e3) + 'd ago';
}

let accountFilter = '';

function accStatus(a) {
  if (!a.loggedIn) return { cls: 'off', label: 'not logged in — launch & type /login' };
  if (a.id === state.accountId && state.running) return { cls: 'active', label: 'Active session' };
  if (a.cooldownUntil && a.cooldownUntil > now) return { cls: 'cool', label: 'Cooling down · ' + fmtCountdown(a.cooldownUntil - now) };
  return { cls: 'on', label: a.email + (a.plan ? ' · ' + a.plan : '') };
}

function renderAccounts() {
  const list = $('accountList');
  const prevScroll = list.scrollTop; // preserve scroll across re-render (cooldown ticks rebuild the list)
  list.innerHTML = '';

  // Show a filter box once there are enough accounts to warrant it.
  const showFilter = state.accounts.length > 8;
  $('accountFilter').classList.toggle('hidden', !showFilter);

  if (state.accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No accounts yet. Click + to add your first account.';
    list.appendChild(empty);
    return;
  }

  const q = showFilter ? accountFilter.trim().toLowerCase() : '';
  const shown = q
    ? state.accounts.filter((a) => (a.name + ' ' + (a.email || '')).toLowerCase().includes(q))
    : state.accounts;
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No accounts match "' + accountFilter + '".';
    list.appendChild(empty);
    return;
  }

  for (const a of shown) {
    const st = accStatus(a);
    const card = document.createElement('div');
    card.className = 'account' + (a.id === state.accountId ? ' active' : '');

    const top = document.createElement('div');
    top.className = 'account-top';
    const name = document.createElement('div');
    name.className = 'account-name';
    name.textContent = a.name;
    if (state.projectDir && a.id === state.projectAccount) {
      const star = document.createElement('span');
      star.className = 'proj-star';
      star.textContent = '★';
      star.title = 'Preferred account for this project';
      name.appendChild(star);
    }
    const dot = document.createElement('div');
    dot.className = 'dot ' + st.cls;
    dot.title = st.label;
    top.appendChild(name);
    top.appendChild(dot);

    const email = document.createElement('div');
    email.className = 'account-email';
    email.textContent = st.label;

    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const launch = document.createElement('button');
    launch.className = 'launch';
    const isActive = a.id === state.accountId && state.running;
    launch.textContent = isActive ? 'Active' : 'Launch';
    launch.disabled = isActive;
    launch.onclick = (e) => { e.stopPropagation(); launchAccount(a.id); };
    actions.appendChild(launch);

    if (a.cooldownUntil && a.cooldownUntil > now) {
      const clr = document.createElement('button');
      clr.textContent = 'Clear cooldown';
      clr.onclick = (e) => { e.stopPropagation(); cc.clearCooldown(a.id).then(refreshStatus); };
      actions.appendChild(clr);
    }
    const menu = document.createElement('button');
    menu.textContent = '⋯';
    menu.title = 'More';
    menu.onclick = (e) => { e.stopPropagation(); accountMenu(a, e); };
    actions.appendChild(menu);

    card.appendChild(top);
    card.appendChild(email);
    if (a.sessions) {
      const meta = document.createElement('div');
      meta.className = 'account-meta';
      meta.textContent = a.sessions + (a.sessions === 1 ? ' session' : ' sessions') +
        (a.lastUsedAt ? ' · used ' + fmtAgo(a.lastUsedAt) : '');
      card.appendChild(meta);
    }
    card.appendChild(actions);
    list.appendChild(card);
  }
  list.scrollTop = prevScroll; // restore scroll after rebuild
}

function renderStats() {
  const t = $('timerStat');
  if (state.running && state.startedAt) {
    const s = Math.max(0, Math.floor((now - state.startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const hh = Math.floor(s / 3600);
    t.textContent = '⏱ ' + (hh > 0 ? hh + ':' : '') + mm + ':' + ss;
    t.style.display = '';
  } else {
    t.style.display = 'none';
  }
  const sw = $('switchStat');
  sw.textContent = '⇄ ' + (state.switchCount || 0);
  sw.style.display = state.switchCount ? '' : 'none';

  const pill = $('availCount');
  const n = state.accounts.filter((a) => a.loggedIn && (!a.cooldownUntil || a.cooldownUntil <= now)).length;
  const total = state.accounts.filter((a) => a.loggedIn).length;
  pill.textContent = total ? `${n}/${total} ready` : '';
}

function renderEmpty() {
  const show = !state.running && state.accounts.length === 0;
  $('emptyState').classList.toggle('hidden', !show);
}

function renderAll() { renderBadge(); renderProject(); renderProjectAccount(); renderAccounts(); renderStats(); renderModelLabel(); renderEmpty(); }

async function refreshStatus() {
  const s = await cc.status();
  state = Object.assign(state, s);
  applyTheme(state.settings && state.settings.theme);
  applyFontSize(state.settings && state.settings.fontSize);
  renderAll();
}

// ---- actions ----
async function launchAccount(id) {
  if (!state.projectDir) { flashProjectNeeded(); return; }
  const res = await cc.launch(id);
  if (!res.ok) {
    if (res.error && /project folder/i.test(res.error)) flashProjectNeeded();
    else toast(res.error || 'Launch failed', 'error');
    return;
  }
  term.focus();
  setTimeout(doFit, 80);
}

function flashProjectNeeded() {
  const btn = $('pickProject');
  btn.classList.add('flash-error');
  $('projectPath').textContent = 'Pick a project folder first!';
  setTimeout(() => { btn.classList.remove('flash-error'); renderProject(); }, 1600);
}

async function addAccount() {
  const name = prompt('Name this account (e.g. "Personal", "Work", "Account 2"):');
  if (name == null) return;
  state.accounts = await cc.addAccount(name.trim() || 'Account');
  renderAll();
  toast('Account added — click Launch, then type /login', 'ok');
}

async function removeAccount(a) {
  if (!confirm(`Remove "${a.name}" from the launcher?\n\n(This does NOT delete its login folder on disk.)`)) return;
  state.accounts = await cc.removeAccount(a.id);
  renderAll();
}

async function renameAccount(a) {
  const name = prompt('Rename account:', a.name);
  if (name == null || !name.trim()) return;
  state.accounts = await cc.renameAccount(a.id, name.trim());
  renderAll();
}

// small context menu for an account
function accountMenu(a, ev) {
  closePopups();
  const menu = document.createElement('div');
  menu.className = 'popup ctx';
  const items = [
    ['Rename', () => renameAccount(a)],
    ['Open config folder', () => cc.openConfigDir(a.id)],
    ['Remove', () => removeAccount(a)],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closePopups(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = ev.target.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}

function closePopups() {
  document.querySelectorAll('.popup.ctx').forEach((n) => n.remove());
  $('recentMenu').classList.add('hidden');
  $('switchMenu').classList.add('hidden');
  $('projectAccountMenu').classList.add('hidden');
  $('modelMenu').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popup') && !e.target.closest('#recentBtn') &&
      !e.target.closest('#switchMenuBtn') && !e.target.closest('#projectAccountBtn') &&
      !e.target.closest('#modelBtn') && !e.target.closest('.account-actions')) {
    closePopups();
  }
});

// ---- per-project account selector ----
$('projectAccountBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('projectAccountMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closePopups();
  menu.innerHTML = '';
  if (state.accounts.length === 0) {
    const d = document.createElement('div'); d.className = 'popup-empty';
    d.textContent = 'Add an account first (click +)';
    menu.appendChild(d);
  } else {
    const none = document.createElement('button');
    none.textContent = state.projectAccount ? '✕ Clear assignment' : 'No account assigned';
    none.onclick = async () => { menu.classList.add('hidden'); state.projectAccount = await cc.setProjectAccount(state.projectDir, ''); renderAll(); };
    menu.appendChild(none);
    for (const a of state.accounts) {
      const b = document.createElement('button');
      const mark = a.id === state.projectAccount ? '★ ' : '';
      b.textContent = mark + a.name + (a.loggedIn ? '' : ' — not logged in');
      b.onclick = async () => {
        menu.classList.add('hidden');
        state.projectAccount = await cc.setProjectAccount(state.projectDir, a.id);
        renderAll();
        toast(`"${a.name}" set for this project`, 'ok');
      };
      menu.appendChild(b);
    }
  }
  menu.classList.remove('hidden');
};

// ---- project ----
$('pickProject').onclick = async () => {
  const dir = await cc.pickProject();
  state.projectDir = dir;
  await refreshStatus(); // pick up this project's preferred account
};
$('recentBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('recentMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closePopups();
  menu.innerHTML = '';
  const recents = (state.recentProjects || []).filter((d) => d !== state.projectDir);
  if (!recents.length) {
    const d = document.createElement('div'); d.className = 'popup-empty'; d.textContent = 'No recent folders';
    menu.appendChild(d);
  } else {
    for (const dir of recents) {
      const b = document.createElement('button');
      b.textContent = dir;
      b.title = dir;
      b.onclick = async () => { menu.classList.add('hidden'); state.projectDir = await cc.chooseProject(dir); await refreshStatus(); };
      menu.appendChild(b);
    }
  }
  menu.classList.remove('hidden');
};

// ---- footer / links ----
const REPO_URL = 'https://github.com/Chamanrajragu/claude-multi';
$('ghLink').onclick = (e) => { e.preventDefault(); cc.openExternal(REPO_URL); };
$('ghLink2').onclick = (e) => { e.preventDefault(); cc.openExternal(REPO_URL); };

$('accountFilter').addEventListener('input', (e) => { accountFilter = e.target.value; renderAccounts(); });

// Quick-switch: Ctrl/Cmd + 1..9 launches (or switches to) the Nth account.
function quickAccount(i) {
  const a = state.accounts[i];
  if (!a) return;
  if (state.running && a.id !== state.accountId && a.loggedIn) cc.switchTo(a.id);
  else launchAccount(a.id);
}

// ---- session buttons ----
$('addAccount').onclick = addAccount;
$('stopBtn').onclick = () => cc.stop();
$('restartBtn').onclick = () => { toast('Restarting session…', 'ok'); cc.restart(); };

// ---- manual switch menu ----
$('switchMenuBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('switchMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closePopups();
  menu.innerHTML = '';
  const targets = state.accounts.filter((a) => a.loggedIn && a.id !== state.accountId);
  if (!targets.length) {
    const d = document.createElement('div'); d.className = 'popup-empty'; d.textContent = 'No other logged-in account';
    menu.appendChild(d);
  } else {
    for (const a of targets) {
      const b = document.createElement('button');
      const cool = a.cooldownUntil && a.cooldownUntil > now;
      b.textContent = a.name + (cool ? ' · cooling ' + fmtCountdown(a.cooldownUntil - now) : '');
      b.onclick = async () => {
        menu.classList.add('hidden');
        term.write('\r\n\x1b[33m[launcher] switching account…\x1b[0m\r\n');
        await cc.switchTo(a.id);
      };
      menu.appendChild(b);
    }
  }
  const r = e.target.getBoundingClientRect();
  menu.style.right = (window.innerWidth - r.right) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.classList.remove('hidden');
};

// ---- terminal toolbar ----
$('clearBtn').onclick = () => { term.clear(); term.focus(); };
$('copyBtn').onclick = () => {
  const sel = term.getSelection();
  if (sel) { cc.clipboardWrite(sel); toast('Copied', 'ok'); }
  else toast('Nothing selected', 'error');
};
$('pasteBtn').onclick = () => { const t = cc.clipboardRead(); if (t) cc.sendInput(t); term.focus(); };
$('fontUpBtn').onclick = () => changeFont(1);
$('fontDownBtn').onclick = () => changeFont(-1);

function changeFont(delta) {
  const size = Math.max(8, Math.min(28, (term.options.fontSize || 13) + delta));
  applyFontSize(size);
  cc.setSettings({ fontSize: size });
}
function applyFontSize(size) {
  if (!size) return;
  term.options.fontSize = size;
  setTimeout(doFit, 20);
}

// ---- search ----
$('searchBtn').onclick = openSearch;
$('searchClose').onclick = closeSearch;
$('searchNext').onclick = () => search.findNext($('searchInput').value);
$('searchPrev').onclick = () => search.findPrevious($('searchInput').value);
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.shiftKey ? search.findPrevious(e.target.value) : search.findNext(e.target.value); }
  if (e.key === 'Escape') closeSearch();
});
$('searchInput').addEventListener('input', (e) => { if (e.target.value) search.findNext(e.target.value); });
function openSearch() { $('searchBar').classList.remove('hidden'); $('searchInput').focus(); $('searchInput').select(); }
function closeSearch() { $('searchBar').classList.add('hidden'); try { search.clearDecorations(); } catch {} term.focus(); }

// ---- keyboard shortcuts ----
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'f') { e.preventDefault(); openSearch(); }
  else if (ctrl && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); $('copyBtn').click(); }
  else if (ctrl && e.shiftKey && (e.key === 'V' || e.key === 'v')) { e.preventDefault(); $('pasteBtn').click(); }
  else if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeFont(1); }
  else if (ctrl && e.key === '-') { e.preventDefault(); changeFont(-1); }
  else if (ctrl && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); term.clear(); }
  else if (ctrl && (e.key === ',')) { e.preventDefault(); openSettings(); }
  else if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); quickAccount(parseInt(e.key, 10) - 1); }
});

// ---- composer (Claude Code–style chat input) ----
const composerInput = $('composerInput');
const MODELS = [
  { id: '', label: 'Default model' },
  { id: 'opus', label: 'Opus 4.8' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 4.5' },
];

function autoGrow() {
  composerInput.style.height = 'auto';
  composerInput.style.height = Math.min(160, composerInput.scrollHeight) + 'px';
}
composerInput.addEventListener('input', autoGrow);

function sendPrompt(text) {
  if (!text) return;
  if (!state.running) { toast('Launch an account first', 'error'); return; }
  // Wrap multi-line text in a bracketed paste so Claude Code inserts it
  // literally instead of submitting each line.
  const payload = text.includes('\n') ? ('\x1b[200~' + text + '\x1b[201~') : text;
  cc.sendInput(payload + '\r');
}

function submitComposer() {
  const text = composerInput.value.trim();
  if (!text) return;
  sendPrompt(text);
  composerInput.value = '';
  autoGrow();
  composerInput.focus();
}

composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); }
});
$('sendBtn').onclick = submitComposer;

document.querySelectorAll('.chip.preset').forEach((btn) => {
  btn.onclick = () => {
    if (btn.dataset.insert != null) {
      composerInput.value = btn.dataset.insert + composerInput.value;
      autoGrow(); composerInput.focus();
    } else if (btn.dataset.send != null) {
      if (!state.running) { toast('Launch an account first', 'error'); return; }
      cc.sendInput(btn.dataset.send + '\r'); term.focus();
    } else if (btn.dataset.key === 'esc') {
      if (state.running) cc.sendInput('\x1b');
    }
  };
});

$('modeBtn').onclick = () => {
  if (!state.running) { toast('Launch an account first', 'error'); return; }
  cc.sendInput('\x1b[Z'); // Shift+Tab cycles Claude Code's permission mode
  toast('Cycled permission mode (Shift+Tab)', 'ok');
};

function renderModelLabel() {
  const cur = (state.settings && state.settings.model) || '';
  const m = MODELS.find((x) => x.id === cur) || MODELS[0];
  $('modelLabel').textContent = m.label;
  $('modelBtn').classList.toggle('set', !!cur);
}
$('modelBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('modelMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  closePopups();
  menu.innerHTML = '';
  const cur = (state.settings && state.settings.model) || '';
  for (const m of MODELS) {
    const b = document.createElement('button');
    b.textContent = (m.id === cur ? '✓ ' : '') + m.label;
    b.onclick = async () => {
      menu.classList.add('hidden');
      state.settings = await cc.setSettings({ model: m.id });
      renderModelLabel();
      if (state.running && m.id) cc.sendInput('/model ' + m.id + '\r');
      toast(m.id ? `Model: ${m.label}${state.running ? '' : ' (applies on launch)'}` : 'Using account default model', 'ok');
    };
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
};

// ---- microphone / dictation ----
let recog = null;
let recording = false;
function stopRecog() {
  recording = false;
  $('micBtn').classList.remove('recording');
  if (recog) { try { recog.onend = null; recog.stop(); } catch {} recog = null; }
}
$('micBtn').onclick = () => {
  if (recording) { stopRecog(); toast('Stopped listening', 'ok'); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  composerInput.focus();
  if (!SR) {
    toast('Tip: press Win+H for Windows Voice Typing — offline & no time limit.', 'error');
    return;
  }
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-US';
  let base = composerInput.value;
  recording = true;
  $('micBtn').classList.add('recording');
  recog.onresult = (ev) => {
    let interim = '', final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += t; else interim += t;
    }
    if (final) base = (base ? base + ' ' : '') + final.trim();
    composerInput.value = (base + (interim ? ' ' + interim : '')).trim();
    autoGrow();
  };
  recog.onerror = (ev) => {
    const err = ev.error;
    stopRecog();
    if (err === 'network') toast('Browser voice needs internet. Offline: press Win+H (Windows Voice Typing) with the box focused.', 'error');
    else if (err === 'not-allowed' || err === 'service-not-allowed') toast('Microphone blocked. Allow mic access, or use Win+H.', 'error');
    else if (err !== 'aborted' && err !== 'no-speech') toast('Voice error: ' + err, 'error');
  };
  // Auto-restart on end so recognition never cuts off after ~1 minute.
  recog.onend = () => { if (recording) { try { recog.start(); } catch {} } };
  try { recog.start(); toast('Listening… click the mic again to stop.', 'ok'); }
  catch { stopRecog(); }
};

// ---- limit handling ----
let pendingSwitch = null;
let countdownTimer = null;

cc.onLimitReached((info) => {
  clearInterval(countdownTimer);
  const overlay = $('overlay');
  const body = $('dlgBody');
  const cur = state.accounts.find((x) => x.id === info.accountId);
  const curLabel = cur ? (cur.email || cur.name) : 'This account';
  const reset = info.resetHint ? ` It resets around <b>${escapeHtml(info.resetHint)}</b>.` : '';

  if (info.next) {
    pendingSwitch = info.next.id;
    body.innerHTML =
      `<b>${escapeHtml(curLabel)}</b> hit its usage limit.${reset}<br><br>` +
      `Switch to <b>${escapeHtml(info.next.email || info.next.name)}</b> and continue this conversation?`;
    $('dlgSwitch').classList.remove('hidden');

    if (info.autoSwitch) {
      let left = Math.max(0, info.autoSwitchDelay || 6);
      const btn = $('dlgSwitch');
      const tick = () => {
        btn.textContent = left > 0 ? `Switching in ${left}…` : 'Switching…';
        if (left <= 0) { clearInterval(countdownTimer); doSwitch(); }
        left -= 1;
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    } else {
      $('dlgSwitch').textContent = 'Switch account';
    }
  } else {
    pendingSwitch = null;
    body.innerHTML =
      `<b>${escapeHtml(curLabel)}</b> hit its usage limit.${reset}<br><br>` +
      `No other logged-in account is available. Add or log into another account, then switch.`;
    $('dlgSwitch').classList.add('hidden');
  }
  overlay.classList.remove('hidden');
  refreshStatus();
});

cc.onLimitApproaching((info) => {
  const b = $('approachBanner');
  b.textContent = 'Approaching usage limit' + (info.resetHint ? ` · resets ~${info.resetHint}` : '');
  b.classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), 12000);
});

function closeDialog() { clearInterval(countdownTimer); $('overlay').classList.add('hidden'); $('dlgSwitch').textContent = 'Switch account'; }
async function doSwitch() {
  closeDialog();
  if (!pendingSwitch) return;
  term.write('\r\n\x1b[33m[launcher] switching account…\x1b[0m\r\n');
  await cc.switchTo(pendingSwitch);
}
$('dlgCancel').onclick = closeDialog;
$('dlgSwitch').onclick = doSwitch;

// ---- settings ----
function openSettings() {
  const s = state.settings || {};
  $('setAutoSwitch').checked = !!s.autoSwitch;
  $('setDelay').value = s.autoSwitchDelay ?? 6;
  $('setNotify').checked = s.notify !== false;
  $('setConfirmClose').checked = s.confirmClose !== false;
  $('setMinimizeToTray').checked = !!s.minimizeToTray;
  $('setStartOnLogin').checked = !!s.startOnLogin;
  $('setCheckUpdates').checked = s.checkUpdates !== false;
  $('setTheme').value = s.theme || 'dark';
  $('setExtraArgs').value = s.extraArgs || '';
  cc.appInfo().then((info) => {
    $('claudePathLabel').textContent = info.claudePath || 'not found';
    $('aboutLine').textContent = `Claude Multi v${info.version} · Electron ${info.electron} · Node ${info.node}`;
  });
  $('settingsOverlay').classList.remove('hidden');
}
async function saveSettings() {
  const patch = {
    autoSwitch: $('setAutoSwitch').checked,
    autoSwitchDelay: Math.max(0, Math.min(60, parseInt($('setDelay').value, 10) || 0)),
    notify: $('setNotify').checked,
    confirmClose: $('setConfirmClose').checked,
    minimizeToTray: $('setMinimizeToTray').checked,
    startOnLogin: $('setStartOnLogin').checked,
    checkUpdates: $('setCheckUpdates').checked,
    theme: $('setTheme').value,
    extraArgs: $('setExtraArgs').value.trim(),
  };
  state.settings = await cc.setSettings(patch);
  applyTheme(patch.theme);
}
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => { saveSettings(); $('settingsOverlay').classList.add('hidden'); };
$('setTheme').onchange = (e) => applyTheme(e.target.value);
$('pickClaudeBtn').onclick = async () => {
  const p = await cc.pickClaude();
  $('claudePathLabel').textContent = p || 'not found';
};
$('exportBtn').onclick = async () => {
  const r = await cc.exportConfig();
  if (r && r.ok) toast('Exported to ' + r.path, 'ok');
  else if (r && r.error) toast('Export failed: ' + r.error, 'error');
};
$('importBtn').onclick = async () => {
  if (!confirm('Import a backup? This merges accounts & settings from the file.')) return;
  const r = await cc.importConfig();
  if (r && r.ok) { await refreshStatus(); toast('Config imported', 'ok'); }
  else if (r && r.error) toast('Import failed: ' + r.error, 'error');
};

// ---- update banner ----
cc.onUpdateAvailable((info) => {
  if (!info || !info.isNewer) return;
  const b = $('updateBanner');
  b.textContent = `⬆ Update available: v${info.latest}`;
  b.classList.remove('hidden');
  b.onclick = (e) => { e.preventDefault(); cc.openExternal(info.url); };
  toast(`A newer version (v${info.latest}) is available — click the banner to download.`, 'ok');
});

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  term.options.theme = themes[t];
}

// ---- toasts ----
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- ticking clock (timers/cooldowns) ----
setInterval(() => { now = Date.now(); renderStats(); if (hasVisibleCooldown()) renderAccounts(); }, 1000);
function hasVisibleCooldown() {
  return state.accounts.some((a) => a.cooldownUntil && a.cooldownUntil > now - 2000);
}

// ---- boot ----
cc.onStatus((s) => { state = Object.assign(state, s); applyTheme(state.settings && state.settings.theme); renderAll(); });
(async () => {
  state.projectDir = await cc.getProject();
  await refreshStatus();
  renderAll();
})();

window.__cmReady = true;
})();
