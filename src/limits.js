// Usage-limit detection. Claude Code prints a message to the terminal when a
// plan's usage limit is hit. We strip ANSI escapes from the pty stream and
// look for the tell-tale phrases.
//
// We split into two classes:
//   - "reached":     hard stop -> trigger the switch flow
//   - "approaching": soft warning -> show a non-blocking banner
//
// Because the real action (switching accounts) is gated behind a user
// confirmation (or an explicit auto-switch setting), an occasional false
// positive is harmless.

// Matches CSI/OSC/other escape sequences. \x1b is ESC, \x9b is the 8-bit CSI.
// eslint-disable-next-line no-control-regex
const ANSI = /[\x1b\x9b][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]|[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*(?:\x07|\x1b\\))/g;

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

const REACHED = [
  // "You've hit your session limit", "reached your usage/weekly/5-hour limit", etc.
  /(?:hit|reached)\s+your\s+(?:\w+[\s-]+){0,3}limit/i,
  /(?:usage|session|weekly|daily|5[\s-]?hour)\s+limit\s+reached/i,
  /usage limit reached/i,
  /claude usage limit reached/i,
  /limit reached[^\n]*\breset/i,
];

const APPROACHING = [
  /approaching (?:your )?(?:usage|session|weekly) limit/i,
  /nearing your (?:usage|session) limit/i,
  /running low on (?:usage|tokens)/i,
];

// Pull a human-readable reset phrase out of the message, e.g. "resets at 3pm"
// or "resets 2:10am (Asia/Calcutta)".
function extractResetHint(text) {
  const m = text.match(/reset[s]?(?:\s+at)?\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?:\s*\([^)]+\))?)/i);
  if (m) return m[1].trim();
  const rel = text.match(/reset[s]?\s+in\s+([0-9]+\s*(?:hours?|hrs?|h|minutes?|mins?|m))/i);
  return rel ? 'in ' + rel[1].trim() : '';
}

// Parse a clock string ("2:10am", "15:00", "3 pm") into {h, m} 24-hour, or null.
function parseClock(str) {
  const m = String(str).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, m: min };
}

// Turn the reset text into an absolute timestamp (ms). Handles both relative
// ("in 2 hours") and clock ("at 3pm") forms. Returns null if it can't tell.
function parseResetTime(text, now = Date.now()) {
  const clean = stripAnsi(text);

  // Relative: "reset in 2 hours", "resets in 45 minutes"
  const rel = clean.match(/reset[s]?\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = /^h/.test(unit) ? n * 3600e3 : n * 60e3;
    return now + ms;
  }

  // Clock: "reset at 3pm", "resets 2:10am"
  const abs = clean.match(/reset[s]?(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (abs) {
    const c = parseClock(abs[1]);
    if (c) {
      const target = new Date(now);
      target.setHours(c.h, c.m, 0, 0);
      if (target.getTime() <= now) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
  }
  return null;
}

// Returns { kind: 'reached'|'approaching'|null, resetHint, resetAt }
function classify(text, now = Date.now()) {
  const clean = stripAnsi(text);
  for (const re of REACHED) {
    if (re.test(clean)) {
      return { kind: 'reached', resetHint: extractResetHint(clean), resetAt: parseResetTime(clean, now) };
    }
  }
  for (const re of APPROACHING) {
    if (re.test(clean)) {
      return { kind: 'approaching', resetHint: extractResetHint(clean), resetAt: parseResetTime(clean, now) };
    }
  }
  return { kind: null, resetHint: '', resetAt: null };
}

module.exports = { stripAnsi, classify, parseResetTime, parseClock, extractResetHint, REACHED, APPROACHING };
