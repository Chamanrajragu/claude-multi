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

// Pull the fields we care about out of a GitHub "releases/latest" payload.
// Returns null for anything unusable (draft, missing tag, wrong shape) so the
// caller can treat "no answer" and "malformed answer" the same way.
function parseRelease(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.draft) return null;
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
  if (!tag) return null;
  if (!parseVer(tag).some((n) => n > 0)) return null;
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    name: typeof json.name === 'string' && json.name.trim() ? json.name.trim() : tag,
    url: typeof json.html_url === 'string' ? json.html_url : '',
    prerelease: !!json.prerelease,
  };
}

// Decide whether to bother the user. Prereleases are never offered, and a check
// is skipped entirely if one ran within `everyMs`.
function shouldCheck(lastCheckedAt, now, everyMs) {
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  if (lastCheckedAt > now) return true; // clock moved backwards; don't wedge
  return now - lastCheckedAt >= everyMs;
}

function updateAvailable(release, currentVersion) {
  if (!release || release.prerelease) return false;
  return isNewer(release.version, currentVersion);
}

module.exports = { parseVer, compareVersions, isNewer, parseRelease, shouldCheck, updateAvailable };
