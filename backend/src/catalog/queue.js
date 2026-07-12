/**
 * Serializes all mutating apply() calls behind a single promise chain so two
 * config-mutating actions never run concurrently and stomp on each other's
 * backups/writes. Detect/plan (read-only) do not go through the queue.
 */
let tail = Promise.resolve();

export function enqueue(task) {
  const result = tail.then(() => task(), () => task());
  // Swallow rejection in the chain itself so one failed apply doesn't wedge the queue;
  // the caller of enqueue() still sees the real rejection via `result`.
  tail = result.catch(() => {});
  return result;
}
