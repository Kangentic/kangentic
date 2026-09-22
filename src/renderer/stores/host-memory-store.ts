import { create } from 'zustand';
import type { HostMemoryPressureEvent } from '../../shared/types';
import { useToastStore } from './toast-store';

/**
 * Renderer side of the host memory pressure push (Sentry DESKTOP-16). Main
 * owns the sampling and the edge-triggered decision (see
 * `src/main/diagnostics/host-memory.ts`); this store only turns an arrived
 * event into a persistent toast, and dismisses that toast when main reports
 * recovery. There is no `load*`/`sync*` here (the truth is a push, not
 * something to re-fetch on HMR), so unlike the IPC-backed stores this needs
 * no `vite:afterUpdate` registration - same shape as `updater-store.ts`'s
 * `receiveUpdate`.
 *
 * Pattern A DOES apply, for the same reason `toast-store.ts` applies it to
 * its own `toasts` array: this file is not a Fast Refresh boundary, so an
 * edit here re-runs `create()` and resets the store. `toast-store.ts`
 * deliberately preserves visible toasts across that cycle, so a `duration: 0`
 * pressure toast survives the reload while an unprotected `pressureToastId`
 * would come back null - leaving a persistent toast on screen with no id left
 * to dismiss it. That is the exact bug the recovery push exists to close, so
 * the id and the event that produced it are preserved as a pair.
 *
 * Not Pattern-E instance-pinned (unlike `updater-store.ts`): nothing
 * subscribes to this store reactively. Every read is a one-shot `getState()`
 * from an IPC handler, so there is no stale-subscriber hazard.
 */

/** @see the Pattern A note above. Production has no `import.meta.hot`, so
 *  both of these are a no-op there. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialLastEvent: HostMemoryPressureEvent | null = import.meta.hot?.data?.hostMemoryLastEvent ?? null;
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialPressureToastId: string | null = import.meta.hot?.data?.hostMemoryPressureToastId ?? null;

interface HostMemoryState {
  /** The most recently arrived pressure event, kept for anything that wants
   *  to show the raw numbers (currently nothing does; the toast is enough).
   *  Cleared on recovery - it is the pressure reading, and a stale reading
   *  outliving the condition is the bug the recovery push exists to fix. */
  lastEvent: HostMemoryPressureEvent | null;
  /** The id of the toast raised for the current (still-latched) warning, if
   *  any. Nulled on recovery regardless of whether the dismiss actually
   *  found a live toast: the toast can already be gone three ways (the user
   *  dismissed it by hand, `maxCount` evicted it, or the renderer reloaded),
   *  and leaving this non-null would let the store's own invariant drift
   *  from what is actually on screen. */
  pressureToastId: string | null;
  receivePressureEvent: (event: HostMemoryPressureEvent) => void;
  receiveRecovery: () => void;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const useHostMemoryStore = create<HostMemoryState>((set, get) => ({
  lastEvent: initialLastEvent,
  pressureToastId: initialPressureToastId,

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

    const { sample, activeAgentCount } = event;
    const headroom = sample.commitRemainingBytes !== null
      ? formatGigabytes(sample.commitRemainingBytes)
      : 'unknown';
    const agentClause = activeAgentCount === 1
      ? '1 agent is'
      : `${activeAgentCount} agents are`;

    // Persistent (duration: 0): this is a standing condition, not a transient
    // event, and a toast that vanishes on its own about a machine running out
    // of memory is worse than one that stays until dismissed. It clears
    // instead when receiveRecovery() fires.
    const toastId = useToastStore.getState().addToast({
      message: `This computer is low on memory (${headroom} free) while ${agentClause} running. Kangentic may recover automatically if it runs out.`,
      variant: 'warning',
      duration: 0,
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
}));

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    const { lastEvent, pressureToastId } = useHostMemoryStore.getState();
    data.hostMemoryLastEvent = lastEvent;
    data.hostMemoryPressureToastId = pressureToastId;
  });
}
