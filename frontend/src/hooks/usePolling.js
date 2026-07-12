import { useEffect, useRef, useState } from 'react';

/**
 * Polls an async fetcher on an interval, exposing the latest data/error and
 * a manual refresh(). Pauses when the tab is hidden to avoid needless load.
 */
export function usePolling(fetcher, intervalMs = 5000, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  async function run() {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      if (document.visibilityState === 'visible') {
        await run();
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    }
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh: run };
}
