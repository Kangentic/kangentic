import { useEffect } from 'react';
import { useMonitorStore } from '../../stores/monitor-store';

/**
 * Subscribe this renderer to the live output-peek stream for as long as a monitor
 * is on screen, naming the sessions whose cards actually draw a peek.
 *
 * Peeks are the only monitor push that is subscribe-gated. The others
 * (MONITOR_CHANGED, SESSION_ACTIVITY) are broadcast regardless because they cost
 * nothing extra when unread; the peek makes main attach a PTY output listener and
 * run a sampling timer, so it is paid for only while someone is looking, and only
 * for the sessions someone is looking AT. The card's slot follows the Card
 * Preview setting, so most cards draw the agent's message trail and never the
 * peek; naming the rest lets main drop every other session's output at the tap,
 * and an empty set switches the listener and the timer off while the monitor
 * stays open.
 *
 * `wantedKey` is the wanted session ids joined by newlines, sorted by the
 * caller, so an unchanged set never re-invokes main and a changed one re-states
 * the set (main seeds only the sessions that are new to it).
 *
 * Mount this where the monitor's ROWS live, so the subscription's lifetime is the
 * surface's lifetime. Both hosts (the in-app overlay and the detached pop-out
 * window) mount it independently and main ref-counts them, which is why
 * unsubscribing here cannot cut off the other window.
 */
export function useMonitorPeekSubscription(wantedKey: string): void {
  const applyPeeks = useMonitorStore((state) => state.applyPeeks);

  // Listener FIRST, then subscribe (the effect below runs after this one on
  // mount). Subscribing triggers main's seed pass, which pushes a peek for every
  // wanted session immediately; registering afterwards would let that seed
  // arrive with nothing listening, and an idle session (which emits no output,
  // so produces no further sample) would then show a blank card until it
  // happened to speak.
  useEffect(() => {
    const monitorApi = window.electronAPI?.monitor;
    if (!monitorApi?.onPeek || !monitorApi.setPeekSubscribed) return;
    const unsubscribePush = monitorApi.onPeek(applyPeeks);
    return () => {
      unsubscribePush();
      void monitorApi.setPeekSubscribed(false);
    };
  }, [applyPeeks]);

  useEffect(() => {
    const monitorApi = window.electronAPI?.monitor;
    if (!monitorApi?.onPeek || !monitorApi.setPeekSubscribed) return;
    void monitorApi.setPeekSubscribed(true, wantedKey === '' ? [] : wantedKey.split('\n'));
  }, [wantedKey]);
}
