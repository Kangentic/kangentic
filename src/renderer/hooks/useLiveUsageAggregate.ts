import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../stores/session-store';
import type { SessionStore } from '../stores/session-store/types';

export interface LiveUsageAggregate {
  cost: number;
  input: number;
  output: number;
  count: number;
}

/**
 * Aggregate in-memory live-session usage (the push-fed `sessionUsage` cache).
 * Computed inside a selector that returns primitives via useShallow so
 * consumers re-render only when the aggregate values actually change, not on
 * every background usage tick. Extracted from the old status-bar usage strip;
 * the usage dashboard's KPI tiles consume it now.
 *
 * This is the ONLY source of instant (zero-IPC-round-trip) reactivity for the
 * Cost/Tokens tiles: a pushed `session:usage` event mutates `sessionUsage`
 * directly, and this selector recomputes within the same render.
 *
 * `sessionIds` IS THE WHOLE POLICY, and it must contain only sessions that are
 * still LIVE. There used to be an 'all' sentinel meaning "every entry in
 * `sessionUsage`", which read as "every running session" but is not: the cache
 * is reconciled against main's usage cache (`reconcileLiveCache` in
 * session-store.ts), which retains a session until it leaves the registry, so
 * suspended and exited sessions sit in it carrying their full cumulative cost.
 * Layering those on top of a ledger that already has them is what floated the
 * Cost tile above the breakdowns. The sentinel is gone so the mistake cannot
 * be made by omission; callers pass an explicit set built with
 * `isLiveSessionStatus`.
 *
 * Note the values here are the agent's CUMULATIVE readings for the session, so
 * the caller must also subtract what the ledger already holds for these same
 * ids (`UsageDashboardStats.liveLedgerBaseline`) rather than adding this
 * straight onto a ledger total.
 */
export function useLiveUsageAggregate(sessionIds: ReadonlySet<string>): LiveUsageAggregate {
  return useSessionStore(
    useShallow(
      useCallback((state: SessionStore) => {
        let cost = 0;
        let input = 0;
        let output = 0;
        let count = 0;
        for (const [sessionId, usage] of Object.entries(state.sessionUsage)) {
          if (!sessionIds.has(sessionId)) continue;
          cost += usage.cost.totalCostUsd;
          input += usage.contextWindow.totalInputTokens;
          output += usage.contextWindow.totalOutputTokens;
          count++;
        }
        return { cost, input, output, count };
      }, [sessionIds]),
    ),
  );
}
