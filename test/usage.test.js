const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
const { Store } = require('../src/accounts');

function tmpStore() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'accounts.json');
  return new Store(p, path.join(path.dirname(p), 'accts'));
}

test('recordUsage accumulates per-account totals', () => {
  const s = tmpStore();
  const a = s.add('one');
  s.recordUsage(a.id, { tokens: 1000, costUsd: 0.5 });
  s.recordUsage(a.id, { tokens: 500, costUsd: 0.25 });
  const got = s.byId(a.id);
  assert.strictEqual(got.usage.tokens, 1500);
  assert.strictEqual(got.usage.turns, 2);
  assert.strictEqual(got.lifetime.tokens, 1500);
  assert.ok(Math.abs(got.lifetime.costUsd - 0.75) < 1e-9);
});

test('since-reset totals restart after a limit, lifetime does not', () => {
  const s = tmpStore();
  const a = s.add('one');
  s.recordUsage(a.id, { tokens: 1000, costUsd: 1 });
  s.setCooldown(a.id, Date.now() + 3600e3, 'limit');   // stamps lastLimitAt
  s.recordUsage(a.id, { tokens: 200, costUsd: 0.1 });
  const got = s.byId(a.id);
  assert.strictEqual(got.usage.tokens, 200, 'since-reset window resets');
  assert.strictEqual(got.lifetime.tokens, 1200, 'lifetime keeps accumulating');
});

// Regression: the window used to be decided by `since < lastLimitAt`, which
// silently skipped the reset whenever a turn and a limit shared a millisecond.
test('window resets even when the turn and the limit share a millisecond', () => {
  const s = tmpStore();
  const a = s.add('one');
  const t = Date.now();
  const acc = s.byId(a.id);
  s.recordUsage(a.id, { tokens: 1000 });
  acc.usage.since = t;          // force the exact-collision case
  acc.lastLimitAt = t;
  acc.usage.resetFor = 0;       // a limit this window has not been reset for
  s.recordUsage(a.id, { tokens: 200 });
  assert.strictEqual(s.byId(a.id).usage.tokens, 200);
});

test('the window resets once per limit, not on every later turn', () => {
  const s = tmpStore();
  const a = s.add('one');
  s.recordUsage(a.id, { tokens: 1000 });
  s.setCooldown(a.id, Date.now() + 3600e3, 'limit');
  s.recordUsage(a.id, { tokens: 200 });
  s.recordUsage(a.id, { tokens: 300 });
  assert.strictEqual(s.byId(a.id).usage.tokens, 500, 'both post-limit turns count');
  assert.strictEqual(s.byId(a.id).lifetime.tokens, 1500);
});

test('recordUsage on an unknown account is a no-op', () => {
  const s = tmpStore();
  assert.doesNotThrow(() => s.recordUsage('nope', { tokens: 5 }));
});

/* ---- persistence: atomic + coalesced writes ---- */

test('writes are atomic — no .tmp is left behind after save', () => {
  const s = tmpStore();
  s.add('one');
  s.save();
  assert.ok(fs.existsSync(s.filePath), 'store file exists');
  assert.ok(!fs.existsSync(s.filePath + '.tmp'), 'temp file cleaned up');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(s.filePath, 'utf8')), 'file is valid JSON');
});

test('a leftover .tmp from a crash is discarded, not loaded', () => {
  const { Store } = require('../src/accounts');
  const s = tmpStore();
  s.add('keeper');
  s.save();
  fs.writeFileSync(s.filePath + '.tmp', '{"accounts":[{"id":"gar');   // truncated write
  const reopened = new Store(s.filePath, s.accountsRoot);
  assert.strictEqual(reopened.list().length, 1, 'good file still loads');
  assert.strictEqual(reopened.list()[0].id, 'keeper');
  assert.ok(!fs.existsSync(s.filePath + '.tmp'), 'partial file removed on load');
});

test('saveSoon coalesces, and flush forces it to disk', async () => {
  const { Store } = require('../src/accounts');
  const s = tmpStore();
  s.add('one');
  s.save();
  s.state.marker = 'pending';
  s.saveSoon();
  s.saveSoon();
  s.saveSoon();
  // Not on disk yet — that is the point of coalescing.
  assert.strictEqual(JSON.parse(fs.readFileSync(s.filePath, 'utf8')).marker, undefined);
  s.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(s.filePath, 'utf8')).marker, 'pending');
  assert.ok(!fs.existsSync(s.filePath + '.tmp'));
  // flush with nothing pending must not throw
  assert.doesNotThrow(() => new Store(s.filePath, s.accountsRoot).flush());
});
