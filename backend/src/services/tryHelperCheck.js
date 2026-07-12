// Read-only, best-effort — several independent checks are typically combined
// in a single Promise.all for one "diagnostic panel" result (nginx site
// checks, WireGuard tunnel checks, ...). A hard throw from any one of them
// (spawn-level helper-script failure, etc.) must not blank out every other
// check's result alongside it, so failures are caught and merged into a
// caller-supplied fallback shape instead of propagating.
export async function tryHelperCheck(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    return { ...fallback, error: err.message };
  }
}
