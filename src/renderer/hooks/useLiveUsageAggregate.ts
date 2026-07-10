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
 * `filter` is the Set of session ids to include (project scope), or 'all' for
 * every session (the app-wide dashboard scope; `sessionUsage` is
 * cross-project). Computed inside a selector that returns primitives via
 * useShallow so consumers re-render only when the aggregate values actually
 * change, not on every background usage tick. Extracted from the old
 * status-bar usage strip; the usage dashboard's KPI tiles consume it now.
 */
export function useLiveUsageAggregate(filter: ReadonlySet<string> | 'all'): LiveUsageAggregate {
  return useSessionStore(
    useShallow(
      useCallback((state: SessionStore) => {
        let cost = 0;
        let input = 0;
        let output = 0;
        let count = 0;
        for (const [sessionId, usage] of Object.entries(state.sessionUsage)) {
          if (filter !== 'all' && !filter.has(sessionId)) continue;
          cost += usage.cost.totalCostUsd;
          input += usage.contextWindow.totalInputTokens;
          output += usage.contextWindow.totalOutputTokens;
          count++;
        }
        return { cost, input, output, count };
      }, [filter]),
    ),
  );
}
