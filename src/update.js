// Tiny semver-ish comparison for the update checker. Pure + testable.

function parseVer(v) {
  return String(v || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

// 1 if a > b, -1 if a < b, 0 if equal (compares major.minor.patch).
function compareVersions(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

module.exports = { parseVer, compareVersions, isNewer };
