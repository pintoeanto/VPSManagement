// Per-account lockout on top of the per-IP rate limiter in rateLimit.js.
// In-memory is sufficient here: this is a single-process app, and a restart
// clearing lockout state is an acceptable tradeoff against added complexity.
const attempts = new Map(); // username -> { count, lockedUntil }

const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 30 * 60_000;

function key(username) {
  return username.toLowerCase();
}

export function isLockedOut(username) {
  const entry = attempts.get(key(username));
  if (!entry || !entry.lockedUntil) return false;
  if (Date.now() > entry.lockedUntil) return false;
  return true;
}

export function lockoutRemainingMs(username) {
  const entry = attempts.get(key(username));
  if (!entry || !entry.lockedUntil) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

export function recordFailure(username) {
  const k = key(username);
  const entry = attempts.get(k) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    const excess = entry.count - MAX_ATTEMPTS;
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** excess, MAX_LOCKOUT_MS);
    entry.lockedUntil = Date.now() + lockoutMs;
  }
  attempts.set(k, entry);
}

export function recordSuccess(username) {
  attempts.delete(key(username));
}
