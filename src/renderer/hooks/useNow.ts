import { useEffect, useState } from 'react';

/**
 * The current time in ms, re-read every `intervalMs`, so a label such as
 * "37 minutes ago" keeps up while it stays on screen. The timer runs only
 * while the component is mounted and `enabled` is true; while disabled the
 * value holds, and the first tick after enabling brings it up to date.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
