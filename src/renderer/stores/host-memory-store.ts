import { create } from 'zustand';
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import type { HostMemoryAgentPausedEvent, HostMemoryPressureEvent } from '../../shared/types';
import { countStillPaused, notePausedOutcomes, type PausedAgentOutcome } from '../lib/paused-for-memory';
import { useConfigStore } from './config-store';
import { useSessionStore } from './session-store';
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
 *   another. Its Review button opens the list. The toast counts only the
 *   agents still paused (`countStillPaused`), so it counts down in place as
 *   agents come back by any route, or leave (moved to To Do, deleted), and
 *   closes once none is still paused. What became of each agent is noted from
 *   the session store as it happens (`pausedOutcomes`), so one that came back
 *   and later stopped is not counted again. A resumed row stays in the list
 *   and reads Running. The list clears once neither the toast nor Review shows
 *   it (`keepListWhileShown`), so a dialog the user is looking at never
 *   unmounts under them, and the next pause after that starts again at 1.
 *   Recovery leaves the toast alone: an agent outside a workflow stays paused
 *   until the user resumes it, and a running workflow's task that main brings
 *   back once memory recovers (`workflow-memory-resume.ts`) comes back like
 *   any other route, so the count goes down in place and what it says stays true.
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
 *
 * Pattern E applies too: the instance is pinned. The paused toast's Review
 * button closes over `useHostMemoryStore`, and the toast store keeps that
 * closure across a reload. Without the pin a re-evaluated module would build a
 * second store, the dialog would read the new one, and Review would open the
 * old one, so it would do nothing.
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
const initialPausedOutcomes: Record<string, PausedAgentOutcome> = import.meta.hot?.data?.hostMemoryPausedOutcomes ?? {};
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
  /** Every agent low memory paused since the paused toast was raised,
   *  including those that came back (their rows read Running) or left. */
  pausedAgents: HostMemoryAgentPausedEvent[];
  /** What became of each listed agent since its pause, by task id
   *  (`notePausedOutcomes`). Cleared with the list. */
  pausedOutcomes: Readonly<Record<string, PausedAgentOutcome>>;
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

/**
 * The paused toast's title and body for a count, in the session's language. An
 * exact `=1` branch, not `one`: the singular names no number, which would read
 * wrong for the other counts some languages file under `one` (21, 31...).
 */
export function pausedToastCopy(count: number): { title: string; message: string } {
  return {
    title: i18n._(msg`${plural({ count }, { 1: 'Idle agent paused', other: '# idle agents paused' })}`),
    message: i18n._(msg`${plural({ count }, { 1: 'Kangentic paused it to free memory.', other: 'Kangentic paused them to free memory.' })}`),
  };
}

function openBehaviorSettings(): void {
  const configStore = useConfigStore.getState();
  configStore.setLastSettingsTab('behavior');
  configStore.setSettingsOpen(true);
}

/**
 * The list stands while its toast or the Review list shows it, and clears
 * once neither does. The toast leaving and Review closing both end here, so
 * neither has to know the other's half of the rule.
 */
function keepListWhileShown(next: { pausedToastId: string | null; reviewOpen: boolean }): Partial<HostMemoryState> {
  if (next.pausedToastId !== null || next.reviewOpen) return next;
  return { ...next, pausedAgents: [], pausedOutcomes: {} };
}

const createHostMemoryStore = () => create<HostMemoryState>((set, get) => ({
  lastEvent: initialLastEvent,
  pressureToastId: initialPressureToastId,
  pausedAgents: initialPausedAgents,
  pausedOutcomes: initialPausedOutcomes,
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
    const remaining = sample.commitRemainingBytes !== null ? formatGigabytes(sample.commitRemainingBytes) : null;
    const message = remaining !== null
      ? i18n._(msg`${{ remaining }} of memory reservations left.`)
      : i18n._(msg`Almost no memory reservations left.`);

    // Persistent: a standing condition, not a transient event. It clears
    // when receiveRecovery() fires.
    //
    // "Memory reservations", not "memory": the sample is Windows commit
    // headroom (RAM plus page file, charged for every reservation whether or
    // not it is touched), so RAM can read half free while this fires. A user
    // has two levers: the page file that sets the limit, and how many agents
    // run at once. The button opens the tab holding the second; the page-file
    // steps are in docs/user-guide/troubleshooting.md (Low memory warning).
    //
    // `since` is the sample's time, so a toast left up reads its age instead
    // of quoting a dip that may be long past.
    const toastId = useToastStore.getState().addToast({
      title: i18n._(msg`Low on memory`),
      message,
      variant: 'warning',
      persistent: true,
      since: sample.ts,
      action: { label: i18n._(msg`Settings`), icon: 'settings', onClick: openBehaviorSettings },
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
    // A task paused again is paused, whatever became of its last pause.
    const { [event.taskId]: _previousOutcome, ...pausedOutcomes } = get().pausedOutcomes;
    // The list can hold agents already back, so count what is still paused.
    // That includes this one: no resume of its task can start before main
    // sends its push.
    const copy = pausedToastCopy(countStillPaused(pausedAgents, useSessionStore.getState().sessions, pausedOutcomes));
    const toastStore = useToastStore.getState();
    const existingToastId = get().pausedToastId;
    if (existingToastId !== null && toastStore.toasts.some((toast) => toast.id === existingToastId)) {
      toastStore.updateToast(existingToastId, { ...copy, since: event.pausedAt });
      set({ pausedAgents, pausedOutcomes });
      return;
    }
    const toastId = toastStore.addToast({
      ...copy,
      variant: 'info',
      persistent: true,
      since: event.pausedAt,
      action: { label: i18n._(msg`Review`), icon: 'review', onClick: () => useHostMemoryStore.getState().openReview() },
    });
    set({ pausedAgents, pausedOutcomes, pausedToastId: toastId });
  },

  openReview: () => set({ reviewOpen: true }),
  closeReview: () => set(keepListWhileShown({ pausedToastId: get().pausedToastId, reviewOpen: false })),
}));

/** @see the Pattern E note above. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedHostMemoryStore: ReturnType<typeof createHostMemoryStore> | undefined = import.meta.hot?.data?.hostMemoryStore;

export const useHostMemoryStore = preservedHostMemoryStore ?? createHostMemoryStore();

/**
 * The paused toast leaving, whether the user closed it or the session watch
 * below took it down, clears the list it stands for unless Review still shows
 * it (`keepListWhileShown`). The toast store has no dismiss callback, so this
 * watches for the toast leaving the stack.
 */
const unsubscribeToastWatch = useToastStore.subscribe((state) => {
  const { pausedToastId, reviewOpen } = useHostMemoryStore.getState();
  if (pausedToastId === null) return;
  if (state.toasts.some((toast) => toast.id === pausedToastId)) return;
  useHostMemoryStore.setState(keepListWhileShown({ pausedToastId: null, reviewOpen }));
});

/**
 * Agents come back by many routes (the Review row, a card, a task window, a
 * move), in any project, and every one lands in the session store, which is
 * unscoped. So the outcomes are noted there, and the toast recounts: in place
 * while some are still paused, and gone once none are.
 */
const unsubscribeSessionWatch = useSessionStore.subscribe((state, previousState) => {
  // Usage and activity ticks change the store without touching `sessions`.
  if (state.sessions === previousState.sessions) return;
  const { pausedAgents, pausedOutcomes, pausedToastId } = useHostMemoryStore.getState();
  if (pausedAgents.length === 0) return;
  // Noted with the toast gone too: an open Review list still reads them.
  const outcomes = notePausedOutcomes(pausedAgents, pausedOutcomes, state.sessions, previousState.sessions);
  if (outcomes !== pausedOutcomes) useHostMemoryStore.setState({ pausedOutcomes: outcomes });
  if (pausedToastId === null) return;
  const toastStore = useToastStore.getState();
  const toast = toastStore.toasts.find((candidate) => candidate.id === pausedToastId);
  if (!toast) return;
  const remaining = countStillPaused(pausedAgents, state.sessions, outcomes);
  if (remaining === 0) {
    toastStore.dismissToast(pausedToastId);
    return;
  }
  const copy = pausedToastCopy(remaining);
  if (toast.title !== copy.title) toastStore.updateToast(pausedToastId, copy);
});

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    unsubscribeToastWatch();
    unsubscribeSessionWatch();
    const { lastEvent, pressureToastId, pausedAgents, pausedOutcomes, pausedToastId, reviewOpen } = useHostMemoryStore.getState();
    data.hostMemoryLastEvent = lastEvent;
    data.hostMemoryPressureToastId = pressureToastId;
    data.hostMemoryPausedAgents = pausedAgents;
    data.hostMemoryPausedOutcomes = pausedOutcomes;
    data.hostMemoryPausedToastId = pausedToastId;
    data.hostMemoryReviewOpen = reviewOpen;
  });
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.hostMemoryStore = useHostMemoryStore;
  // An edit to this module's own code would leave the pinned instance running
  // stale closures, so it hands the update on instead.
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
