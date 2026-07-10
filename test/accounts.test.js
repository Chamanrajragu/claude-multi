const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, DEFAULT_SETTINGS, slug } = require('../src/accounts');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
  return {
    dir,
    file: path.join(dir, 'accounts.json'),
    root: path.join(dir, 'roots'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('fresh store has defaults', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    assert.deepStrictEqual(s.list(), []);
    assert.deepStrictEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
    assert.deepStrictEqual(s.get('recentProjects'), []);
  } finally { t.cleanup(); }
});

test('add / rename / remove / byId', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    const a = s.add('Personal');
    assert.strictEqual(a.id, 'personal');
    assert.ok(fs.existsSync(a.configDir), 'config dir created');
    assert.strictEqual(s.byId('personal').name, 'Personal');

    s.rename('personal', 'Main');
    assert.strictEqual(s.byId('personal').name, 'Main');

    s.remove('personal');
    assert.strictEqual(s.byId('personal'), undefined);
    assert.deepStrictEqual(s.list(), []);
  } finally { t.cleanup(); }
});

test('duplicate names get unique ids', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    const a = s.add('Work');
    const b = s.add('Work');
    const c = s.add('Work');
    assert.strictEqual(a.id, 'work');
    assert.strictEqual(b.id, 'work-2');
    assert.strictEqual(c.id, 'work-3');
  } finally { t.cleanup(); }
});

test('settings merge and persist across reload', () => {
  const t = tmp();
  try {
    let s = new Store(t.file, t.root);
    s.setSettings({ autoSwitch: true, fontSize: 16 });
    // reload from disk
    s = new Store(t.file, t.root);
    const cfg = s.getSettings();
    assert.strictEqual(cfg.autoSwitch, true);
    assert.strictEqual(cfg.fontSize, 16);
    // untouched keys keep defaults
    assert.strictEqual(cfg.notify, DEFAULT_SETTINGS.notify);
  } finally { t.cleanup(); }
});

test('recent projects dedup, cap at 8, and set lastProjectDir', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    for (let i = 0; i < 12; i++) s.addRecentProject('/proj/' + i);
    s.addRecentProject('/proj/3'); // move to front / dedup
    const recents = s.get('recentProjects');
    assert.strictEqual(recents.length, 8);
    assert.strictEqual(recents[0], '/proj/3');
    assert.strictEqual(new Set(recents).size, recents.length, 'no dupes');
    assert.strictEqual(s.get('lastProjectDir'), '/proj/3');
  } finally { t.cleanup(); }
});

test('cooldown set/clear persists across reload', () => {
  const t = tmp();
  try {
    let s = new Store(t.file, t.root);
    s.add('acc');
    const until = Date.now() + 60_000;
    s.setCooldown('acc', until, 'resets 3pm');
    s = new Store(t.file, t.root);
    assert.strictEqual(s.byId('acc').cooldownUntil, until);
    assert.strictEqual(s.byId('acc').cooldownHint, 'resets 3pm');
    s.clearCooldown('acc');
    assert.strictEqual(s.byId('acc').cooldownUntil, 0);
  } finally { t.cleanup(); }
});

test('list() enriches with loggedIn=false when no .claude.json', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    s.add('x');
    const [entry] = s.list();
    assert.strictEqual(entry.loggedIn, false);
    assert.strictEqual(entry.email, '');
  } finally { t.cleanup(); }
});

test('list() reads email from a written .claude.json', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    const a = s.add('y');
    fs.writeFileSync(
      path.join(a.configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', subscriptionType: 'max' } }),
    );
    const [entry] = s.list();
    assert.strictEqual(entry.loggedIn, true);
    assert.strictEqual(entry.email, 'me@example.com');
    assert.strictEqual(entry.plan, 'max');
  } finally { t.cleanup(); }
});

test('corrupt store file falls back to defaults (no throw)', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, '{ this is not json');
    let s;
    assert.doesNotThrow(() => { s = new Store(t.file, t.root); });
    assert.deepStrictEqual(s.list(), []);
    assert.deepStrictEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
  } finally { t.cleanup(); }
});

test('per-project account: set, get, clear, persist', () => {
  const t = tmp();
  try {
    let s = new Store(t.file, t.root);
    s.add('alpha'); s.add('beta');
    assert.strictEqual(s.getProjectAccount('D:/proj-a'), '');
    s.setProjectAccount('D:/proj-a', 'alpha');
    s.setProjectAccount('D:/proj-b', 'beta');
    // reload
    s = new Store(t.file, t.root);
    assert.strictEqual(s.getProjectAccount('D:/proj-a'), 'alpha');
    assert.strictEqual(s.getProjectAccount('D:/proj-b'), 'beta');
    s.setProjectAccount('D:/proj-a', ''); // clear
    assert.strictEqual(s.getProjectAccount('D:/proj-a'), '');
  } finally { t.cleanup(); }
});

test('per-project account: stale mapping to a removed account is ignored & cleaned', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    s.add('gamma');
    s.setProjectAccount('D:/proj', 'gamma');
    assert.strictEqual(s.getProjectAccount('D:/proj'), 'gamma');
    s.remove('gamma');
    // getter ignores stale mapping
    assert.strictEqual(s.getProjectAccount('D:/proj'), '');
    // and remove() cleaned it from disk
    const raw = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.ok(!raw.projectAccounts || raw.projectAccounts['D:/proj'] === undefined);
  } finally { t.cleanup(); }
});

test('per-project account: 20 projects each mapped independently', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(s.add('acct' + i).id);
    for (let i = 0; i < 20; i++) s.setProjectAccount('D:/p' + i, ids[i]);
    for (let i = 0; i < 20; i++) assert.strictEqual(s.getProjectAccount('D:/p' + i), ids[i]);
  } finally { t.cleanup(); }
});

test('recordLaunch bumps sessions and lastUsedAt', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    s.add('a');
    assert.strictEqual(s.byId('a').sessions, 0);
    s.recordLaunch('a');
    s.recordLaunch('a');
    assert.strictEqual(s.byId('a').sessions, 2);
    assert.ok(s.byId('a').lastUsedAt > 0);
  } finally { t.cleanup(); }
});

test('export then import round-trips accounts, settings and mappings', () => {
  const a = tmp();
  const b = tmp();
  try {
    const s1 = new Store(a.file, a.root);
    s1.add('Work'); s1.add('Personal');
    s1.setSettings({ autoSwitch: true, model: 'sonnet' });
    s1.setProjectAccount('D:/proj', 'work');
    s1.recordLaunch('work');
    const blob = s1.exportData();
    assert.ok(!/oauth|token|emailAddress/i.test(blob), 'export must not contain credentials');

    // Import into a fresh store on a different root
    const s2 = new Store(b.file, b.root);
    s2.importData(blob);
    assert.deepStrictEqual(s2.list().map((x) => x.id).sort(), ['personal', 'work']);
    assert.strictEqual(s2.getSettings().autoSwitch, true);
    assert.strictEqual(s2.getSettings().model, 'sonnet');
    assert.strictEqual(s2.getProjectAccount('D:/proj'), 'work');
    // configDir is re-based to the importing machine's root
    assert.ok(s2.byId('work').configDir.startsWith(b.root));
  } finally { a.cleanup(); b.cleanup(); }
});

test('import merges without clobbering existing accounts', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    s.add('existing');
    s.importData(JSON.stringify({ accounts: [{ id: 'imported', name: 'Imported' }] }));
    assert.deepStrictEqual(s.list().map((x) => x.id).sort(), ['existing', 'imported']);
  } finally { t.cleanup(); }
});

test('import rejects invalid data', () => {
  const t = tmp();
  try {
    const s = new Store(t.file, t.root);
    assert.throws(() => s.importData('{"nope":true}'), /Invalid backup/);
  } finally { t.cleanup(); }
});

test('slug helper', () => {
  assert.strictEqual(slug('Hello World!'), 'hello-world');
  assert.strictEqual(slug('   '), 'account');
  assert.strictEqual(slug('A'.repeat(50)).length, 24);
});
