/**
 * Unit tests for src/renderer/stores/session-store.ts's `cancelSync()` /
 * `syncController` contract (Pattern A, layered under the Pattern E instance pin -
 * see .claude/rules/hmr-patterns.md).
 *
 * session-store's module docblock makes a specific, narrow claim about what
 * survives HMR once the store instance itself is pinned: `syncController` (an
 * AbortController) is MODULE state, not STORE state, so it is re-declared on
 * every module evaluation and can only be recovered from the
 * `import.meta.hot.dispose` stash - never from the pinned store instance, which
 * (once pinned) skips re-running the initializer entirely. The docblock calls
 * this out as the ONE value that is still genuinely "live" under the pin:
 *
 *   "its one LIVE consumer is `syncController` ... that is module state, not
 *   store state, so it is re-declared on every module evaluation and read back
 *   at eval time - the stash is its only carrier, on every path. Without it a
 *   re-eval breaks an in-flight project switch."
 *
 * If that recovery broke, an in-flight `syncSessions()` call started just before
 * a Fast Refresh (e.g. saving an unrelated file while a project switch's sync is
 * still in flight) could no longer be cancelled by code that runs after the
 * refresh - the classic "stale closure racing a switch" bug this preservation
 * exists to prevent.
 *
 * `import.meta.hot` is undefined under vitest (no Vite HMR runtime), so the
 * actual dispose-then-restore round trip cannot be triggered directly - the same
 * limitation documented in board-store-hmr.test.ts and toast-store-hmr.test.ts.
 * What CAN be verified directly, with no production code changes, is the
 * mechanism itself: does the exported `cancelSync()` actually abort whatever
 * AbortController `syncSessions()` is currently holding, and does `syncSessions()`
 * then bail without mutating store state? That is exactly the operation the
 * dispose stash exists to keep working ACROSS a re-eval, so proving it holds
 * within one module instance is the closest verifiable proxy available here.
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
