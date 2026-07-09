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
  accounts: [], accountId: null, projectDir: '', running: false,
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
}

function renderProject() {
  $('projectPath').textContent = state.projectDir || 'No folder selected';
}

function fmtCountdown(ms) {
  if (ms == null || ms <= 0) return '0s';
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function accStatus(a) {
  if (!a.loggedIn) return { cls: 'off', label: 'not logged in — launch & type /login' };
  if (a.id === state.accountId && state.running) return { cls: 'active', label: 'Active session' };
  if (a.cooldownUntil && a.cooldownUntil > now) return { cls: 'cool', label: 'Cooling down · ' + fmtCountdown(a.cooldownUntil - now) };
  return { cls: 'on', label: a.email };
}

function renderAccounts() {
  const list = $('accountList');
  list.innerHTML = '';
  if (state.accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No accounts yet. Click + to add your first account.';
    list.appendChild(empty);
    return;
  }
  for (const a of state.accounts) {
    const st = accStatus(a);
    const card = document.createElement('div');
    card.className = 'account' + (a.id === state.accountId ? ' active' : '');

    const top = document.createElement('div');
    top.className = 'account-top';
    const name = document.createElement('div');
    name.className = 'account-name';
    name.textContent = a.name;
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
    card.appendChild(actions);
    list.appendChild(card);
  }
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

function renderAll() { renderBadge(); renderProject(); renderAccounts(); renderStats(); renderEmpty(); }

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
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popup') && !e.target.closest('#recentBtn') &&
      !e.target.closest('#switchMenuBtn') && !e.target.closest('.account-actions')) {
    closePopups();
  }
});

// ---- project ----
$('pickProject').onclick = async () => {
  const dir = await cc.pickProject();
  state.projectDir = dir;
  renderProject();
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
      b.onclick = async () => { menu.classList.add('hidden'); state.projectDir = await cc.chooseProject(dir); renderProject(); };
      menu.appendChild(b);
    }
  }
  menu.classList.remove('hidden');
};

// ---- footer / links ----
const REPO_URL = 'https://github.com/Chamanrajragu/claude-multi';
$('ghLink').onclick = (e) => { e.preventDefault(); cc.openExternal(REPO_URL); };
$('ghLink2').onclick = (e) => { e.preventDefault(); cc.openExternal(REPO_URL); };

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
});

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
