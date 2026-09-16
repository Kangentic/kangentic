import { create } from 'zustand';
import type { HostMemoryPressureEvent } from '../../shared/types';
import { useToastStore } from './toast-store';

/**
 * Renderer side of the host memory pressure push (Sentry DESKTOP-16). Main
 * owns the sampling and the edge-triggered decision (see
 * `src/main/diagnostics/host-memory.ts`); this store only turns an arrived
 * event into a persistent toast. There is no `load*`/`sync*` here (the truth
 * is a push, not something to re-fetch on HMR), so unlike the IPC-backed
 * stores this needs no `vite:afterUpdate` registration - same shape as
 * `updater-store.ts`'s `receiveUpdate`.
 *
 * Not Pattern-E instance-pinned (unlike `updater-store.ts`): `lastEvent` is
 * transient display state with no modal or long-lived subscriber depending
 * on cross-HMR identity, the same reasoning `toast-store.ts` already applies
 * to its own toast queue.
 */

interface HostMemoryState {
  /** The most recently arrived pressure event, kept for anything that wants
   *  to show the raw numbers (currently nothing does; the toast is enough). */
  lastEvent: HostMemoryPressureEvent | null;
  receivePressureEvent: (event: HostMemoryPressureEvent) => void;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const useHostMemoryStore = create<HostMemoryState>((set) => ({
  lastEvent: null,

  receivePressureEvent: (event) => {
    set({ lastEvent: event });

    const { sample, activeAgentCount } = event;
    const headroom = sample.commitRemainingBytes !== null
      ? formatGigabytes(sample.commitRemainingBytes)
      : 'unknown';
    const agentClause = activeAgentCount === 1
      ? '1 agent is'
      : `${activeAgentCount} agents are`;

    // Persistent (duration: 0): this is a standing condition, not a transient
    // event, and a toast that vanishes on its own about a machine running out
    // of memory is worse than one that stays until dismissed.
    useToastStore.getState().addToast({
      message: `This computer is low on memory (${headroom} free) while ${agentClause} running. Kangentic may recover automatically if it runs out.`,
      variant: 'warning',
      duration: 0,
    });
  },
}));
