import { useEffect, useState } from 'react';

/**
 * The current time in ms, re-read every `intervalMs`, so a label such as
 * "37 minutes ago" keeps up while it stays on screen. The timer runs only
 * while the component is mounted.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
