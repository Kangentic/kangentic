/**
 * Unit tests for src/renderer/stores/session-store.ts's `cancelSync()` /
 * `syncController` contract (module state shared under the Pattern E pin and
 * refresh - see .claude/rules/hmr-patterns.md).
 *
 * `syncController` (an AbortController) is MODULE state, not STORE state. It
 * lives in `sessionModuleState`, one object every evaluation of the module reads
 * through `import.meta.hot.data`, so a sync an old evaluation started can still
 * be cancelled by the refreshed actions and `cancelSync()` of the new one.
 *
 * If that broke, an in-flight `syncSessions()` call started just before a Fast
 * Refresh (e.g. saving an unrelated file while a project switch's sync is still
 * in flight) could no longer be cancelled by code that runs after the refresh -
 * the classic "stale closure racing a switch" bug.
 *
 * `import.meta.hot` is undefined under vitest (no Vite HMR runtime), so the
 * actual re-eval cannot be triggered directly - the same limitation documented
 * in board-store-hmr.test.ts and toast-store-hmr.test.ts. What CAN be verified
 * directly is the mechanism itself: does the exported `cancelSync()` actually
 * abort whatever AbortController `syncSessions()` is currently holding, and does
 * `syncSessions()` then bail without mutating store state?
 *
 * This was previously untested: no test in the suite (including
 * session-store-cache-reconcile.test.ts, which otherwise covers syncSessions()
 * exhaustively) exercised cancelSync() or the abort-signal short-circuit at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: { list: async () => [] },
    sessions: {
      list: async (): Promise<Session[]> => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

// Imported after the stub, mirroring session-store-cache-reconcile.test.ts.
const { useSessionStore, cancelSync } = await import('../../src/renderer/stores/session-store');

interface StubbedSessionsApi {
  list: () => Promise<Session[]>;
}

describe('session-store cancelSync() / syncController contract', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessionActivity: {}, sessions: [] });
  });

  it('aborts an in-flight syncSessions() call, which then bails without mutating state', async () => {
    // Seed store state that a successful sync would overwrite, so a bail can be
    // distinguished from a completion that merely happened to leave it alone.
    useSessionStore.setState({ sessionActivity: { 'sess-a': 'thinking' } });

    let resolveList!: (sessions: Session[]) => void;
    const sessionsApi = (window as Record<string, unknown> & { electronAPI: { sessions: StubbedSessionsApi } })
      .electronAPI.sessions;
    const originalList = sessionsApi.list;
    // Hold the foundational sessions.list() fetch open so there is a window in
    // which to cancel before syncSessions() reaches its post-fetch abort check.
    sessionsApi.list = () => new Promise<Session[]>((resolve) => { resolveList = resolve; });

    try {
      const syncPromise = useSessionStore.getState().syncSessions();

      // Cancel while list() is still pending - the exact shape of a project
      // switch (or a Fast Refresh restoring the stash) racing an in-flight sync.
      cancelSync();
      resolveList([]);

      const result = await syncPromise;

      expect(result, 'cancelSync() did not abort the in-flight sync').toBe(false);
      expect(
        useSessionStore.getState().sessionActivity['sess-a'],
        'an aborted sync must bail out before calling set(), leaving prior state untouched',
      ).toBe('thinking');
    } finally {
      sessionsApi.list = originalList;
    }
  });

  it('is a safe no-op when no sync is in flight', () => {
    expect(() => cancelSync()).not.toThrow();
  });
});
