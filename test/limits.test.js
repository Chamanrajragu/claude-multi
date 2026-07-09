const test = require('node:test');
const assert = require('node:assert');
const { classify, parseResetTime, parseClock, stripAnsi } = require('../src/limits');

// Wrap text in realistic ANSI/box-drawing noise like the pty stream produces.
function noisy(s) {
  return `\x1b[2m\x1b[38;5;242m│\x1b[0m \x1b[1m${s}\x1b[0m \x1b[90m│\x1b[0m\r\n`;
}

test('detects the real "hit your session limit" message', () => {
  const r = classify("You've hit your session limit · resets 2:10am (Asia/Calcutta)");
  assert.strictEqual(r.kind, 'reached');
});

test('reached: a spread of real-world phrasings', () => {
  const positives = [
    'Claude usage limit reached. Your limit will reset at 3pm.',
    "You've reached your usage limit",
    "You've hit your weekly limit",
    'Session limit reached',
    'reached your 5-hour limit',
    'reached your 5 hour limit',
    'Daily limit reached — reset at midnight',
    'usage limit reached',
    "you've hit your usage limit for now",
  ];
  for (const p of positives) {
    assert.strictEqual(classify(p).kind, 'reached', `expected reached: ${p}`);
    assert.strictEqual(classify(noisy(p)).kind, 'reached', `expected reached (noisy): ${p}`);
  }
});

test('approaching phrases', () => {
  for (const p of ['Approaching your usage limit', 'nearing your usage limit', 'running low on tokens']) {
    assert.strictEqual(classify(p).kind, 'approaching', p);
  }
});

test('benign text must not be flagged (curated negatives)', () => {
  const negatives = [
    'the rate limit for this model is high',
    'reset the file to its original state',
    'set a limit on the number of retries',
    'your credit limit was approved',
    'I reached the end of the file',
    'the session started successfully',
    'npm install completed with 0 vulnerabilities',
    'Compiling... done in 4.2s',
    'error: cannot find module foo',
    'git push origin main',
    'the weekly report is ready',
    '',
    'limit',
    'reset',
  ];
  for (const n of negatives) {
    assert.strictEqual(classify(n).kind, null, `should be null: ${n}`);
  }
});

test('fuzz: 8000 random benign lines never crash and never false-positive', () => {
  const words = ('the quick brown fox compiles code npm install build test run push commit ' +
    'reset limit session weekly usage rate window token file module error done ok start stop ' +
    'your my a an of to in on at is was set reached hit approaching low high number retries').split(' ');
  let flagged = 0;
  for (let i = 0; i < 8000; i++) {
    const len = 3 + Math.floor(Math.random() * 12);
    const parts = [];
    for (let j = 0; j < len; j++) parts.push(words[Math.floor(Math.random() * words.length)]);
    const line = parts.join(' ');
    let r;
    assert.doesNotThrow(() => { r = classify(line); });
    // If it flagged, it must be because a genuine trigger phrase emerged.
    if (r.kind === 'reached') {
      assert.match(line, /(hit|reached)\s+your\s+(\w+[\s-]+){0,3}limit|limit\s+reached|usage limit reached/i, line);
      flagged++;
    }
  }
  // Sanity: random noise should rarely form a full trigger phrase.
  assert.ok(flagged < 400, `too many random false positives: ${flagged}`);
});

test('stripAnsi removes escape sequences', () => {
  assert.strictEqual(stripAnsi('\x1b[31mhi\x1b[0m'), 'hi');
  assert.strictEqual(stripAnsi('\x1b[1;38;5;196mX\x1b[0m'), 'X');
});

test('parseClock handles am/pm and 24h', () => {
  assert.deepStrictEqual(parseClock('2:10am'), { h: 2, m: 10 });
  assert.deepStrictEqual(parseClock('12am'), { h: 0, m: 0 });
  assert.deepStrictEqual(parseClock('12pm'), { h: 12, m: 0 });
  assert.deepStrictEqual(parseClock('3pm'), { h: 15, m: 0 });
  assert.deepStrictEqual(parseClock('15:30'), { h: 15, m: 30 });
  assert.strictEqual(parseClock('99:99'), null);
});

test('parseResetTime: clock time resolves to next occurrence', () => {
  // now = 2026-01-01 10:00 local
  const now = new Date(2026, 0, 1, 10, 0, 0, 0).getTime();
  const at3pm = parseResetTime('resets at 3pm', now);
  const d = new Date(at3pm);
  assert.strictEqual(d.getHours(), 15);
  assert.ok(at3pm > now && at3pm - now <= 5 * 3600e3 + 1000);

  // a clock time earlier than now rolls to tomorrow
  const at9am = parseResetTime('resets 9am', now);
  assert.ok(at9am > now, 'earlier clock time should roll to next day');
  assert.ok(at9am - now > 22 * 3600e3);
});

test('parseResetTime: relative durations', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(parseResetTime('reset in 2 hours', now), now + 2 * 3600e3);
  assert.strictEqual(parseResetTime('resets in 45 minutes', now), now + 45 * 60e3);
  assert.strictEqual(parseResetTime('resets in 30 min', now), now + 30 * 60e3);
  assert.strictEqual(parseResetTime('no time here', now), null);
});

test('classify carries resetAt when a time is present', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0, 0).getTime();
  const r = classify('Usage limit reached. Resets at 3pm.', now);
  assert.strictEqual(r.kind, 'reached');
  assert.ok(typeof r.resetAt === 'number' && r.resetAt > now);
  assert.ok(/3pm/i.test(r.resetHint));
});
