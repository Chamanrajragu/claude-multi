const test = require('node:test');
const assert = require('node:assert');
const { parseVer, compareVersions, isNewer } = require('../src/update');

test('parseVer strips leading v and splits', () => {
  assert.deepStrictEqual(parseVer('v1.2.3'), [1, 2, 3]);
  assert.deepStrictEqual(parseVer('1.0'), [1, 0]);
  assert.deepStrictEqual(parseVer(''), [0]);
});

test('compareVersions orders correctly', () => {
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('v2.0.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1.10.0', '1.9.0'), 1); // numeric, not lexical
});

test('isNewer', () => {
  assert.strictEqual(isNewer('1.1.0', '1.0.0'), true);
  assert.strictEqual(isNewer('1.0.0', '1.0.0'), false);
  assert.strictEqual(isNewer('0.9.0', '1.0.0'), false);
  assert.strictEqual(isNewer('v1.0.1', '1.0.0'), true);
});
