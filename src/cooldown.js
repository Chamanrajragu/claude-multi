// Account availability + "which account do we switch to?" logic.
//
// When an account hits its usage limit we stamp `cooldownUntil` (an absolute
// ms timestamp, best-effort parsed from the reset message). While cooling
// down, the account is skipped when choosing the next one. If EVERY logged-in
// account is cooling down, we still pick the one that frees up soonest so the
// user waits the least.
//
// Pure functions only — no Electron, no fs — so this is trivially testable.

// Is this account usable right now?
function isAvailable(acc, now = Date.now()) {
  if (!acc || !acc.loggedIn) return false;
  if (acc.cooldownUntil && acc.cooldownUntil > now) return false;
  return true;
}

// Human status for an account card.
function describe(acc, now = Date.now(), activeId = null) {
  if (!acc.loggedIn) return { state: 'logged-out', label: 'Not logged in' };
  if (acc.id === activeId) return { state: 'active', label: 'Active' };
  if (acc.cooldownUntil && acc.cooldownUntil > now) {
    return { state: 'cooldown', label: 'Cooling down · ' + formatCountdown(acc.cooldownUntil - now) };
  }
  return { state: 'ready', label: 'Ready' };
}

// Choose the next account after `currentId`, preferring ones available now,
// rotating round-robin, and falling back to the soonest-to-reset otherwise.
function pickNext(accounts, currentId, now = Date.now()) {
  const loggedIn = (accounts || []).filter((a) => a.loggedIn);
  const others = loggedIn.filter((a) => a.id !== currentId);
  if (!others.length) return null;

  // Order `others` starting right after the current account (round-robin).
  let order = others;
  const curIdx = loggedIn.findIndex((a) => a.id === currentId);
  if (curIdx !== -1) {
    order = [];
    for (let i = 1; i <= loggedIn.length; i++) {
      const a = loggedIn[(curIdx + i) % loggedIn.length];
      if (a.id !== currentId) order.push(a);
    }
  }

  const available = order.filter((a) => isAvailable(a, now));
  if (available.length) return available[0];

  // All cooling down: pick the one that resets soonest.
  return order
    .slice()
    .sort((a, b) => (a.cooldownUntil || Infinity) - (b.cooldownUntil || Infinity))[0] || null;
}

// Count of accounts usable right now.
function availableCount(accounts, now = Date.now()) {
  return (accounts || []).filter((a) => isAvailable(a, now)).length;
}

// "2h 05m", "45m 03s", "38s"
function formatCountdown(ms) {
  if (ms == null || ms <= 0) return '0s';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

module.exports = { isAvailable, describe, pickNext, availableCount, formatCountdown };
