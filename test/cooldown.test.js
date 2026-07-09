const test = require('node:test');
const assert = require('node:assert');
const { isAvailable, pickNext, availableCount, formatCountdown, describe } = require('../src/cooldown');

const NOW = 1_000_000_000_000;
const acc = (id, loggedIn, cooldownUntil = 0) => ({ id, name: id, loggedIn, cooldownUntil });

test('isAvailable', () => {
  assert.strictEqual(isAvailable(acc('a', true, 0), NOW), true);
  assert.strictEqual(isAvailable(acc('a', false, 0), NOW), false);
  assert.strictEqual(isAvailable(acc('a', true, NOW + 1000), NOW), false);
  assert.strictEqual(isAvailable(acc('a', true, NOW - 1000), NOW), true);
  assert.strictEqual(isAvailable(null, NOW), false);
});

test('pickNext: round-robin among available', () => {
  const list = [acc('a', true), acc('b', true), acc('c', true)];
  assert.strictEqual(pickNext(list, 'a', NOW).id, 'b');
  assert.strictEqual(pickNext(list, 'b', NOW).id, 'c');
  assert.strictEqual(pickNext(list, 'c', NOW).id, 'a');
});

test('pickNext: skips cooling-down accounts', () => {
  const list = [acc('a', true), acc('b', true, NOW + 60_000), acc('c', true)];
  assert.strictEqual(pickNext(list, 'a', NOW).id, 'c', 'should skip b (cooling)');
});

test('pickNext: skips not-logged-in accounts', () => {
  const list = [acc('a', true), acc('b', false), acc('c', true)];
  assert.strictEqual(pickNext(list, 'a', NOW).id, 'c');
});

test('pickNext: all cooling -> soonest to reset', () => {
  const list = [
    acc('a', true, NOW + 10_000),
    acc('b', true, NOW + 3_000),
    acc('c', true, NOW + 99_000),
  ];
  const n = pickNext(list, 'a', NOW);
  assert.strictEqual(n.id, 'b', 'should pick soonest reset');
});

test('pickNext: single logged-in account -> null (nothing to switch to)', () => {
  assert.strictEqual(pickNext([acc('a', true)], 'a', NOW), null);
  assert.strictEqual(pickNext([acc('a', true), acc('b', false)], 'a', NOW), null);
});

test('pickNext: no current id picks first available', () => {
  const list = [acc('a', true), acc('b', true)];
  assert.strictEqual(pickNext(list, null, NOW).id, 'a');
});

test('availableCount', () => {
  const list = [acc('a', true), acc('b', true, NOW + 1000), acc('c', false)];
  assert.strictEqual(availableCount(list, NOW), 1);
});

test('formatCountdown', () => {
  assert.strictEqual(formatCountdown(0), '0s');
  assert.strictEqual(formatCountdown(-5), '0s');
  assert.strictEqual(formatCountdown(45_000), '45s');
  assert.strictEqual(formatCountdown(90_000), '1m 30s');
  assert.strictEqual(formatCountdown(3_600_000), '1h 00m');
  assert.strictEqual(formatCountdown(2 * 3600e3 + 5 * 60e3), '2h 05m');
});

test('describe reflects state', () => {
  assert.strictEqual(describe(acc('a', false), NOW).state, 'logged-out');
  assert.strictEqual(describe(acc('a', true), NOW, 'a').state, 'active');
  assert.strictEqual(describe(acc('a', true, NOW + 1000), NOW).state, 'cooldown');
  assert.strictEqual(describe(acc('a', true), NOW).state, 'ready');
});

test('scales to 20 accounts: round-robin visits every logged-in account exactly once', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(acc('acc' + i, true));
  // Walk the rotation starting from acc0 and confirm we cycle through all 20.
  const visited = new Set();
  let cur = 'acc0';
  visited.add(cur);
  for (let step = 0; step < 19; step++) {
    const n = pickNext(list, cur, NOW);
    assert.ok(n, 'should always find a next account');
    assert.ok(!visited.has(n.id), 'round-robin should not repeat until all visited: ' + n.id);
    visited.add(n.id);
    cur = n.id;
  }
  assert.strictEqual(visited.size, 20, 'should visit all 20 accounts');
});

test('scales to 20 accounts: one available among 19 cooling is always chosen', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(acc('acc' + i, true, i === 13 ? 0 : NOW + 60_000));
  const n = pickNext(list, 'acc0', NOW);
  assert.strictEqual(n.id, 'acc13', 'must pick the only available account');
});

test('scales to 20 accounts: pickNext is fast (100k calls)', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(acc('acc' + i, true, i % 2 ? NOW + 1000 : 0));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100_000; i++) pickNext(list, 'acc' + (i % 20), NOW);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `100k pickNext calls over 20 accounts took ${ms.toFixed(0)}ms`);
});

test('fuzz: 10000 random rosters obey the invariants', () => {
  for (let iter = 0; iter < 10000; iter++) {
    const count = 1 + Math.floor(Math.random() * 20);
    const list = [];
    for (let i = 0; i < count; i++) {
      const loggedIn = Math.random() < 0.75;
      const cooling = loggedIn && Math.random() < 0.5;
      list.push(acc('id' + i, loggedIn, cooling ? NOW + Math.floor(Math.random() * 100000) + 1 : 0));
    }
    const current = Math.random() < 0.85 ? 'id' + Math.floor(Math.random() * count) : null;
    const n = pickNext(list, current, NOW);

    if (n === null) continue;
    // Invariant 1: never returns the current account
    assert.notStrictEqual(n.id, current, 'returned current account');
    // Invariant 2: only ever returns a logged-in account
    assert.ok(n.loggedIn, 'returned a logged-out account');
    // Invariant 3: if any OTHER account is available now, the pick must be available now
    const othersAvailable = list.some((a) => a.id !== current && isAvailable(a, NOW));
    if (othersAvailable) assert.ok(isAvailable(n, NOW), 'picked a cooling account while an available one existed');
    // Invariant 4: returned account is actually in the list
    assert.ok(list.some((a) => a.id === n.id));
  }
});
