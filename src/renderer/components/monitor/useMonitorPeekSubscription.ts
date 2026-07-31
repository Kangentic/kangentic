import { useEffect } from 'react';
import { useMonitorStore } from '../../stores/monitor-store';

/**
 * Subscribe this renderer to the live output-peek stream for as long as a monitor
 * is on screen.
 *
 * Peeks are the only monitor push that is subscribe-gated. The others
 * (MONITOR_CHANGED, SESSION_ACTIVITY) are broadcast regardless because they cost
 * nothing extra when unread; the peek makes main attach a PTY output listener and
 * run a sampling timer, so it is paid for only while someone is looking.
 *
 * Mount this where the monitor's ROWS live, so the subscription's lifetime is the
 * surface's lifetime. Both hosts (the in-app overlay and the detached pop-out
 * window) mount it independently and main ref-counts them, which is why
 * unsubscribing here cannot cut off the other window.
 */
export function useMonitorPeekSubscription(): void {
  const applyPeeks = useMonitorStore((state) => state.applyPeeks);

  useEffect(() => {
    const monitorApi = window.electronAPI?.monitor;
    if (!monitorApi?.onPeek || !monitorApi.setPeekSubscribed) return;

    // Listener FIRST, then subscribe. Subscribing triggers main's seed pass, which
    // pushes a peek for every live session immediately; registering afterwards
    // would let that seed arrive with nothing listening, and an idle session
    // (which emits no output, so produces no further sample) would then show a
    // blank card until it happened to speak.
    const unsubscribePush = monitorApi.onPeek(applyPeeks);
    void monitorApi.setPeekSubscribed(true);

    return () => {
      unsubscribePush();
      void monitorApi.setPeekSubscribed(false);
    };
  }, [applyPeeks]);
}
