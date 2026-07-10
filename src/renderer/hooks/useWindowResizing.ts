import { useEffect, useState } from 'react';

/** True while the OS window is actively being resized (and for a short settle
 *  window after the last resize event). Consumers suspend expensive motion -
 *  e.g. chart data animations - so layout tracks the drag crisply instead of
 *  re-triggering a tween on every resize tick, which reads as stutter. */
export function useWindowResizing(settleMs = 200): boolean {
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    function handleResize() {
      setResizing(true);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setResizing(false), settleMs);
    }
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [settleMs]);

  return resizing;
}
