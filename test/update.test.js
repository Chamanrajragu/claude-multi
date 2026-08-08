const test = require('node:test');
const assert = require('node:assert');
const { parseVer, compareVersions, isNewer, parseRelease, shouldCheck, updateAvailable } = require('../src/update');

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

test('parseRelease keeps the fields the banner needs', () => {
  const r = parseRelease({ tag_name: 'v1.28.0', name: 'v1.28.0', html_url: 'https://x/y', draft: false, prerelease: false });
  assert.deepStrictEqual(r, { version: '1.28.0', tag: 'v1.28.0', name: 'v1.28.0', url: 'https://x/y', prerelease: false });
});

test('parseRelease falls back to the tag when a release has no name', () => {
  assert.strictEqual(parseRelease({ tag_name: 'v2.0.0' }).name, 'v2.0.0');
});

test('parseRelease rejects anything unusable rather than throwing', () => {
  assert.strictEqual(parseRelease(null), null);
  assert.strictEqual(parseRelease('nope'), null);
  assert.strictEqual(parseRelease({}), null);
  assert.strictEqual(parseRelease({ tag_name: '' }), null);
  assert.strictEqual(parseRelease({ tag_name: 'nightly' }), null);   // no version digits
  assert.strictEqual(parseRelease({ tag_name: 'v1.0.0', draft: true }), null);
});

test('a rate-limited or offline check does not advertise an update', () => {
  assert.strictEqual(updateAvailable(null, '1.0.0'), false);
});

test('prereleases are never offered', () => {
  const pre = parseRelease({ tag_name: 'v2.0.0', prerelease: true });
  assert.strictEqual(pre.prerelease, true);
  assert.strictEqual(updateAvailable(pre, '1.0.0'), false);
});

test('updateAvailable only fires for a strictly newer version', () => {
  const rel = parseRelease({ tag_name: 'v1.28.0' });
  assert.strictEqual(updateAvailable(rel, '1.27.0'), true);
  assert.strictEqual(updateAvailable(rel, '1.28.0'), false);
  assert.strictEqual(updateAvailable(rel, '1.29.0'), false);
});

test('shouldCheck throttles to one check per interval', () => {
  const hour = 3600e3;
  assert.strictEqual(shouldCheck(0, 1000, 6 * hour), true);          // never checked
  assert.strictEqual(shouldCheck(1000, 1000 + hour, 6 * hour), false); // too soon
  assert.strictEqual(shouldCheck(1000, 1000 + 6 * hour, 6 * hour), true);
});

test('a clock that jumped backwards does not wedge the checker forever', () => {
  assert.strictEqual(shouldCheck(Date.now() + 9e9, Date.now(), 6 * 3600e3), true);
});
