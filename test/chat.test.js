const test = require('node:test');
const assert = require('node:assert');
const { classifyError, extractResetAt, classifyTerminalReason } = require('../src/chat');

test('only blocking_limit means the account is out of quota', () => {
  assert.strictEqual(classifyTerminalReason('blocking_limit'), 'limit');
  for (const r of ['prompt_too_long', 'max_turns', 'budget_exhausted', 'api_error',
    'model_error', 'rapid_refill_breaker', 'aborted_tools', 'hook_stopped']) {
    assert.strictEqual(classifyTerminalReason(r), 'error', r);
  }
  // No reason reported (older CLI) or a clean finish → fall back / nothing.
  assert.strictEqual(classifyTerminalReason(undefined), null);
  assert.strictEqual(classifyTerminalReason('completed'), null);
});

test('real plan-limit messages are classified as a usage limit', () => {
  const positives = [
    'Claude AI usage limit reached|1769812345',
    'Claude usage limit reached. Your limit will reset at 3pm.',
    "You've hit your session limit · resets 2:10am (Asia/Calcutta)",
    "You've reached your weekly limit",
    'reached your 5-hour limit',
  ];
  for (const p of positives) assert.strictEqual(classifyError(p), 'limit', p);
});

test('errors that merely contain "limit" are NOT a usage limit', () => {
  const negatives = [
    'prompt is too long: 250000 tokens > 200000 maximum',
    'input length and max_tokens exceed context limit',
    "Claude's response exceeded the output token limit",
    'API Error: 429 rate_limit_error — please retry',
    'Overloaded: too many concurrent requests, limit is 5',
    'tool result exceeds maximum length limit',
    'Request timed out — gateway limit',
    'error: cannot find module foo',
    'the rate limit for this model is high',
  ];
  for (const n of negatives) assert.strictEqual(classifyError(n), 'error', n);
});

test('auth failures win over everything', () => {
  assert.strictEqual(classifyError('Not logged in. Please run /login'), 'auth');
  assert.strictEqual(classifyError('authentication_failed: usage limit reached'), 'auth');
});

test('extractResetAt reads the epoch Claude Code emits', () => {
  const now = 1_769_800_000_000;
  const at = extractResetAt('Claude AI usage limit reached|1769812345', now);
  assert.strictEqual(at, 1_769_812_345_000);
});

test('extractResetAt falls back to clock and relative forms, else 0', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0, 0).getTime();
  assert.strictEqual(new Date(extractResetAt('resets at 3pm', now)).getHours(), 15);
  assert.strictEqual(extractResetAt('resets in 45 minutes', now), now + 45 * 60e3);
  assert.strictEqual(extractResetAt('no time here', now), 0);
});
