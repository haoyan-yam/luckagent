import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll a fetcher on an interval. Pauses while the tab is hidden; tracks
 * consecutive failures so the caller can surface a "连接中断" banner.
 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      setFailCount(0);
    } catch (err: any) {
      setError(err?.message || '请求失败');
      setFailCount((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void tick();
    const timer = setInterval(() => {
      if (!document.hidden) void tick();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, error, failCount, refresh: tick };
}
