import { useEffect } from 'react';
import { useLeftoverProcessesStore } from '../stores/leftover-processes-store';
import { useToastStore } from '../stores/toast-store';
import { recheckDelayMs, reportHasSettled, rowsToRecheck } from '../lib/leftover-processes';

/**
 * Keeps the leftover-process toast and list true after the report. A process
 * the reap left running can exit on its own (a quitting tool, a shell whose
 * child just ended), and a row that still says "running" then holds a toast
 * open that has nothing left to say. While a report with a row that claims a
 * live process is on screen, through its toast or its open list, this asks
 * main which of those processes have ended (by pid and start key, never a
 * scan): every few seconds while the report is new, slower after that, and at
 * once when a list opens. A row whose process ended reads Ended, and a toast
 * whose report no longer names anything running closes, whether a recheck or
 * the user's own Stop settled it.
 *
 * Runs from store subscriptions inside one effect, so a toast or a recheck
 * never re-renders its host. Mounted once, with the list
 * (`LeftoverProcessesDialog`). Nothing is asked while no leftover toast or
 * list is up.
 */
export function useLeftoverRecheck(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerDueAt = 0;
    let checksInFlight = 0;
    let disposed = false;
    let lastOpenReportId = useLeftoverProcessesStore.getState().openReportId;

    const watched = () => {
      const leftover = useLeftoverProcessesStore.getState();
      return rowsToRecheck({
        reports: leftover.reports,
        reportToasts: leftover.reportToasts,
        openReportId: leftover.openReportId,
        stopStates: leftover.stopStates,
        visibleToastIds: new Set(useToastStore.getState().toasts.map((toast) => toast.id)),
      });
    };

    const scheduleNext = (): void => {
      if (disposed || checksInFlight > 0) return;
      const { processIds, youngestReportedAt } = watched();
      if (processIds.length === 0 || youngestReportedAt === null) return;
      const now = Date.now();
      const dueAt = now + recheckDelayMs(youngestReportedAt, now);
      // An armed timer is never pushed back by a later change, only brought
      // forward: a new report needs the fast pace an older one's timer lacks.
      if (timer !== null && timerDueAt <= dueAt) return;
      if (timer !== null) clearTimeout(timer);
      timerDueAt = dueAt;
      timer = setTimeout(() => {
        timer = null;
        void checkNow();
      }, dueAt - now);
    };

    const checkNow = async (): Promise<void> => {
      const { processIds } = watched();
      if (processIds.length === 0) return;
      checksInFlight += 1;
      try {
        await useLeftoverProcessesStore.getState().recheck(processIds);
      } finally {
        checksInFlight -= 1;
      }
      scheduleNext();
    };

    const closeSettledToasts = (): void => {
      const leftover = useLeftoverProcessesStore.getState();
      for (const [reportId, toastId] of Object.entries(leftover.reportToasts)) {
        const report = leftover.reports[reportId];
        if (!report || !reportHasSettled(report, leftover.stopStates)) continue;
        useToastStore.getState().dismissToast(toastId);
        leftover.releaseToast(reportId);
      }
    };

    const unsubscribeLeftover = useLeftoverProcessesStore.subscribe((state) => {
      closeSettledToasts();
      const openedNow = state.openReportId !== null && state.openReportId !== lastOpenReportId;
      lastOpenReportId = state.openReportId;
      if (openedNow) {
        // The list a user just opened reads current at once, not on the next tick.
        if (timer !== null) clearTimeout(timer);
        timer = null;
        void checkNow();
        return;
      }
      scheduleNext();
    });
    const unsubscribeToasts = useToastStore.subscribe(scheduleNext);
    scheduleNext();

    return () => {
      disposed = true;
      unsubscribeLeftover();
      unsubscribeToasts();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
