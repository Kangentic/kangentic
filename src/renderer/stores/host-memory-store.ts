import { create } from 'zustand';
import type { HostMemoryAgentPausedEvent, HostMemoryPressureEvent } from '../../shared/types';
import { useConfigStore } from './config-store';
import { useToastStore } from './toast-store';

/**
 * Renderer side of the host memory pushes. Main owns the sampling and both
 * decisions (`src/main/diagnostics/host-memory.ts`, `idle-agent-pause.ts`);
 * this store turns what arrives into toasts and the Review list:
 *
 * - The low-memory WARNING (Windows only, Sentry DESKTOP-16): a persistent
 *   toast, dismissed when main reports recovery.
 * - The PAUSED list: each agent low memory paused, one push per agent. The
 *   first raises a persistent toast ("Idle agent paused"); each later one
 *   updates that toast in place ("3 idle agents paused") rather than stacking
 *   another. Its Review button opens the list. Dismissing the toast clears the
 *   list, so the next pause after that starts again at 1. A resumed row stays
 *   in the list and reads Running. Recovery leaves the toast alone: the agents
 *   stay paused until the user resumes them, so what it says stays true.
 *
 * There is no `load*`/`sync*` here (the truth is a push, not something to
 * re-fetch on HMR), so it needs no `vite:afterUpdate` registration.
 *
 * Pattern A DOES apply, for the same reason `toast-store.ts` applies it to its
 * own `toasts` array: this file is not a Fast Refresh boundary, so an edit here
 * re-runs `create()` and resets the store. `toast-store.ts` preserves visible
 * toasts across that cycle, so a persistent toast survives the reload while an
 * unprotected id would come back null, leaving a toast on screen with no id
 * left to dismiss or update it. The ids, and what they describe, are preserved
 * together.
 */

/** @see the Pattern A note above. Production has no `import.meta.hot`, so
 *  all of these are a no-op there. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialLastEvent: HostMemoryPressureEvent | null = import.meta.hot?.data?.hostMemoryLastEvent ?? null;
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialPressureToastId: string | null = import.meta.hot?.data?.hostMemoryPressureToastId ?? null;
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialPausedAgents: HostMemoryAgentPausedEvent[] = import.meta.hot?.data?.hostMemoryPausedAgents ?? [];
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialPausedToastId: string | null = import.meta.hot?.data?.hostMemoryPausedToastId ?? null;
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialReviewOpen: boolean = import.meta.hot?.data?.hostMemoryReviewOpen ?? false;

interface HostMemoryState {
  /** The most recently arrived pressure event. Cleared on recovery: it is the
   *  pressure reading, and a stale reading outliving the condition is the bug
   *  the recovery push exists to fix. */
  lastEvent: HostMemoryPressureEvent | null;
  /** The id of the toast raised for the current (still-latched) warning, if
   *  any. Nulled on recovery whether or not the dismiss found a live toast:
   *  it can already be gone (dismissed by hand, evicted by `maxCount`, or the
   *  renderer reloaded). */
  pressureToastId: string | null;
  /** Every agent low memory paused since the paused toast was raised. */
  pausedAgents: HostMemoryAgentPausedEvent[];
  /** The paused toast, updated in place as more agents are paused. */
  pausedToastId: string | null;
  /** Whether the Review list is open. */
  reviewOpen: boolean;
  receivePressureEvent: (event: HostMemoryPressureEvent) => void;
  receiveRecovery: () => void;
  receiveAgentPaused: (event: HostMemoryAgentPausedEvent) => void;
  openReview: () => void;
  closeReview: () => void;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The paused toast's title and body for a count. */
export function pausedToastCopy(count: number): { title: string; message: string } {
  return count === 1
    ? { title: 'Idle agent paused', message: 'Kangentic paused it to free memory.' }
    : { title: `${count} idle agents paused`, message: 'Kangentic paused them to free memory.' };
}

function openBehaviorSettings(): void {
  const configStore = useConfigStore.getState();
  configStore.setLastSettingsTab('behavior');
  configStore.setSettingsOpen(true);
}

export const useHostMemoryStore = create<HostMemoryState>((set, get) => ({
  lastEvent: initialLastEvent,
  pressureToastId: initialPressureToastId,
  pausedAgents: initialPausedAgents,
  pausedToastId: initialPausedToastId,
  reviewOpen: initialReviewOpen,

  receivePressureEvent: (event) => {
    // Replace, don't stack: dismiss any still-showing warning BEFORE raising
    // the new one. `addToast` trims to `notifications.toasts.maxCount`
    // (user-configurable down to a small number), so an add-then-dismiss
    // ordering can evict the new toast and then dismiss the stale one,
    // leaving nothing on screen.
    const previousToastId = get().pressureToastId;
    if (previousToastId !== null) {
      useToastStore.getState().dismissToast(previousToastId);
    }

    const { sample } = event;
    const message = sample.commitRemainingBytes !== null
      ? `${formatGigabytes(sample.commitRemainingBytes)} of memory reservations left.`
      : 'Almost no memory reservations left.';

    // Persistent: a standing condition, not a transient event. It clears
    // when receiveRecovery() fires.
    //
    // "Memory reservations", not "memory": the sample is Windows commit
    // headroom (RAM plus page file, charged for every reservation whether or
    // not it is touched), so RAM can read half free while this fires. A user
    // has two levers: the page file that sets the limit, and how many agents
    // run at once. The button opens the tab holding the second; the page-file
    // steps are in docs/user-guide.md (Low memory warning).
    //
    // `since` is the sample's time, so a toast left up reads its age instead
    // of quoting a dip that may be long past.
    const toastId = useToastStore.getState().addToast({
      title: 'Low on memory',
      message,
      variant: 'warning',
      persistent: true,
      since: sample.ts,
      action: { label: 'Settings', icon: 'settings', onClick: openBehaviorSettings },
    });

    set({ lastEvent: event, pressureToastId: toastId });
  },

  receiveRecovery: () => {
    const toastId = get().pressureToastId;
    if (toastId !== null) {
      useToastStore.getState().dismissToast(toastId);
    }
    set({ lastEvent: null, pressureToastId: null });
  },

  receiveAgentPaused: (event) => {
    // One row per task: a task paused again (resumed, then paused once more)
    // moves its row rather than adding a second.
    const pausedAgents = [...get().pausedAgents.filter((entry) => entry.taskId !== event.taskId), event];
    const copy = pausedToastCopy(pausedAgents.length);
    const toastStore = useToastStore.getState();
    const existingToastId = get().pausedToastId;
    const toastIsUp = existingToastId !== null && toastStore.toasts.some((toast) => toast.id === existingToastId);
    if (toastIsUp && existingToastId !== null) {
      toastStore.updateToast(existingToastId, { ...copy, since: event.pausedAt });
      set({ pausedAgents });
      return;
    }
    const toastId = toastStore.addToast({
      ...copy,
      variant: 'info',
      persistent: true,
      since: event.pausedAt,
      action: { label: 'Review', icon: 'review', onClick: () => useHostMemoryStore.getState().openReview() },
    });
    set({ pausedAgents, pausedToastId: toastId });
  },

  openReview: () => set({ reviewOpen: true }),
  closeReview: () => set({ reviewOpen: false }),
}));

/**
 * Dismissing the paused toast clears the list it stands for. The toast store
 * has no dismiss callback, so this watches for the toast leaving the stack.
 */
const unsubscribeToastWatch = useToastStore.subscribe((state) => {
  const { pausedToastId } = useHostMemoryStore.getState();
  if (pausedToastId === null) return;
  if (state.toasts.some((toast) => toast.id === pausedToastId)) return;
  useHostMemoryStore.setState({ pausedAgents: [], pausedToastId: null, reviewOpen: false });
});

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    unsubscribeToastWatch();
    const { lastEvent, pressureToastId, pausedAgents, pausedToastId, reviewOpen } = useHostMemoryStore.getState();
    data.hostMemoryLastEvent = lastEvent;
    data.hostMemoryPressureToastId = pressureToastId;
    data.hostMemoryPausedAgents = pausedAgents;
    data.hostMemoryPausedToastId = pausedToastId;
    data.hostMemoryReviewOpen = reviewOpen;
  });
}
