// Account store: persists the list of accounts and app settings to a JSON file.
// Each account maps to its own CLAUDE_CONFIG_DIR, which is what makes the
// logins fully independent (verified: a fresh config dir => "Not logged in").
const fs = require('fs');
const path = require('path');
const os = require('os');

const ACCOUNTS_ROOT = path.join(os.homedir(), '.claude-accounts');

const DEFAULT_SETTINGS = {
  autoSwitch: false,        // switch automatically (with a short countdown) vs. ask
  autoSwitchDelay: 6,       // seconds to count down before an auto-switch
  notify: true,            // OS notifications on limit / switch
  theme: 'dark',           // 'dark' | 'light'
  fontSize: 13,            // terminal font size
  extraArgs: '',           // extra flags passed to `claude` on launch
  confirmClose: true,      // warn before quitting during a live session
  model: '',               // default model alias passed via --model (''=account default)
};

function slug(name) {
  return String(name || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'account';
}

class Store {
  constructor(filePath, accountsRoot = ACCOUNTS_ROOT) {
    this.filePath = filePath;
    this.accountsRoot = accountsRoot;
    this.state = {
      accounts: [],
      lastProjectDir: '',
      recentProjects: [],
      projectAccounts: {},   // { [projectDir]: accountId } — preferred account per project
      claudePath: '',
      settings: { ...DEFAULT_SETTINGS },
    };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = Object.assign(this.state, parsed);
      if (!Array.isArray(this.state.accounts)) this.state.accounts = [];
      if (!Array.isArray(this.state.recentProjects)) this.state.recentProjects = [];
      if (!this.state.projectAccounts || typeof this.state.projectAccounts !== 'object') this.state.projectAccounts = {};
      this.state.settings = { ...DEFAULT_SETTINGS, ...(this.state.settings || {}) };
    } catch {
      // first run: no file yet
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  get(key) { return this.state[key]; }
  set(key, value) { this.state[key] = value; this.save(); }

  // ---- settings ----
  getSettings() { return { ...DEFAULT_SETTINGS, ...(this.state.settings || {}) }; }
  setSettings(patch) {
    this.state.settings = { ...this.getSettings(), ...(patch || {}) };
    this.save();
    return this.getSettings();
  }

  // ---- per-project account mapping ----
  // Returns the preferred accountId for a project dir, but only if that
  // account still exists (stale mappings are ignored).
  getProjectAccount(dir) {
    const id = this.state.projectAccounts[dir];
    if (id && this.state.accounts.some((a) => a.id === id)) return id;
    return '';
  }
  setProjectAccount(dir, accountId) {
    if (!dir) return;
    if (accountId) this.state.projectAccounts[dir] = accountId;
    else delete this.state.projectAccounts[dir];
    this.save();
  }

  // ---- recent projects ----
  addRecentProject(dir) {
    if (!dir) return;
    const list = this.state.recentProjects.filter((d) => d !== dir);
    list.unshift(dir);
    this.state.recentProjects = list.slice(0, 8);
    this.state.lastProjectDir = dir;
    this.save();
  }

  // ---- accounts ----
  list() {
    // Enrich each account with live login info read from its config dir.
    return this.state.accounts.map((a) => ({
      ...a,
      ...readAccountInfo(a.configDir),
    }));
  }

  add(name) {
    const base = slug(name);
    let id = base;
    let n = 2;
    const taken = new Set(this.state.accounts.map((a) => a.id));
    while (taken.has(id)) id = `${base}-${n++}`;
    const configDir = path.join(this.accountsRoot, id);
    fs.mkdirSync(configDir, { recursive: true });
    const account = { id, name: name || id, configDir, cooldownUntil: 0, lastLimitAt: 0 };
    this.state.accounts.push(account);
    this.save();
    return account;
  }

  remove(id) {
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    // Drop any project mappings that pointed at the removed account.
    for (const dir of Object.keys(this.state.projectAccounts)) {
      if (this.state.projectAccounts[dir] === id) delete this.state.projectAccounts[dir];
    }
    this.save();
  }

  rename(id, name) {
    const a = this.state.accounts.find((x) => x.id === id);
    if (a) { a.name = name; this.save(); }
  }

  setCooldown(id, until, hint) {
    const a = this.state.accounts.find((x) => x.id === id);
    if (a) {
      a.cooldownUntil = until || 0;
      a.cooldownHint = hint || '';
      a.lastLimitAt = Date.now();
      this.save();
    }
  }

  clearCooldown(id) {
    const a = this.state.accounts.find((x) => x.id === id);
    if (a) { a.cooldownUntil = 0; a.cooldownHint = ''; this.save(); }
  }

  byId(id) { return this.state.accounts.find((a) => a.id === id); }
}

// Reads <configDir>/.claude.json and extracts login status + email.
// After a successful /login, Claude Code writes oauthAccount.emailAddress here.
function readAccountInfo(configDir) {
  try {
    const p = path.join(configDir, '.claude.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const oa = j.oauthAccount || {};
    const email = oa.emailAddress || '';
    const plan = oa.subscriptionType || oa.planType || '';
    return { loggedIn: !!email, email, plan };
  } catch {
    return { loggedIn: false, email: '', plan: '' };
  }
}

module.exports = { Store, ACCOUNTS_ROOT, readAccountInfo, slug, DEFAULT_SETTINGS };
