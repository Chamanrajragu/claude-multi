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

test('recordUsage on an unknown account is a no-op', () => {
  const s = tmpStore();
  assert.doesNotThrow(() => s.recordUsage('nope', { tokens: 5 }));
});
