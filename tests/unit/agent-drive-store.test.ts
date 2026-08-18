/**
 * Unit tests for src/renderer/stores/agent-drive-store.ts: which sessions
 * currently have an agent driving their Browser pane.
 *
 * This store has no direct unit coverage today; its Pattern E HMR pinning is
 * asserted by tests/unit/hmr-resync.test.ts, and the CONSUMING behavior (the
 * pane's "Agent typing here" badge) is covered end to end by
 * tests/ui/browser-pane-agent-input-focus.spec.ts. Neither exercises the
 * store's own reducer contract directly: that setAgentDriving toggles
 * membership per session id, tracks multiple sessions independently, and -
 * the one non-obvious behavior - is a genuine no-op (no new state, no
 * subscriber notification) when asked to set a session to the state it is
 * already in. That last piece is what keeps `BrowserPane`'s per-drive-call
 * begin/end announcements (see agent-input-burst.test.ts) from re-rendering
 * every consumer on every redundant edge.
 *
 * import.meta.hot is undefined under vitest, so the store's Pattern E
 * instance-pinning collapses to a plain createAgentDriveStore() call - no HMR
 * runtime concerns here (mirrors pop-out-store.test.ts / mobile-store.test.ts).
 * No window.electronAPI stub is needed: this store touches no IPC.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentDriveStore, useIsAgentDrivingSession } from '../../src/renderer/stores/agent-drive-store';

describe('agent-drive-store', () => {
  beforeEach(() => {
    useAgentDriveStore.setState({ drivingSessionIds: [] });
  });

  it('starts with no session being driven', () => {
    expect(useAgentDriveStore.getState().drivingSessionIds).toEqual([]);
  });

  it('setAgentDriving(id, true) adds the session id', () => {
    useAgentDriveStore.getState().setAgentDriving('sess-1', true);
    expect(useAgentDriveStore.getState().drivingSessionIds).toEqual(['sess-1']);
  });

  it('setAgentDriving(id, false) removes a tracked session id', () => {
    useAgentDriveStore.getState().setAgentDriving('sess-1', true);
    useAgentDriveStore.getState().setAgentDriving('sess-1', false);
    expect(useAgentDriveStore.getState().drivingSessionIds).toEqual([]);
  });

  it('tracks multiple sessions independently; removing one leaves the others', () => {
    useAgentDriveStore.getState().setAgentDriving('sess-1', true);
    useAgentDriveStore.getState().setAgentDriving('sess-2', true);
    useAgentDriveStore.getState().setAgentDriving('sess-3', true);

    useAgentDriveStore.getState().setAgentDriving('sess-2', false);

    expect(useAgentDriveStore.getState().drivingSessionIds).toEqual(['sess-1', 'sess-3']);
  });

  it('setAgentDriving(id, false) on an untracked session is a no-op', () => {
    useAgentDriveStore.getState().setAgentDriving('sess-1', true);
    useAgentDriveStore.getState().setAgentDriving('sess-never-tracked', false);
    expect(useAgentDriveStore.getState().drivingSessionIds).toEqual(['sess-1']);
  });

  describe('idempotence: setting a session to its already-current state notifies no subscriber', () => {
    it('does not notify when driving=true is set on an already-tracked session', () => {
      useAgentDriveStore.getState().setAgentDriving('sess-1', true);

      let notifications = 0;
      const unsubscribe = useAgentDriveStore.subscribe(() => { notifications += 1; });
      useAgentDriveStore.getState().setAgentDriving('sess-1', true);
      unsubscribe();

      expect(notifications).toBe(0);
      // And the array itself is untouched, not just equal-by-value: the same
      // reference is what lets a memoized selector skip a re-render.
      const before = useAgentDriveStore.getState().drivingSessionIds;
      useAgentDriveStore.getState().setAgentDriving('sess-1', true);
      expect(useAgentDriveStore.getState().drivingSessionIds).toBe(before);
    });

    it('does not notify when driving=false is set on a session that is not tracked', () => {
      let notifications = 0;
      const unsubscribe = useAgentDriveStore.subscribe(() => { notifications += 1; });
      useAgentDriveStore.getState().setAgentDriving('sess-untracked', false);
      unsubscribe();

      expect(notifications).toBe(0);
    });

    it('DOES notify on a real transition (driving=true on an untracked session)', () => {
      // Control case: proves the subscribe/count harness above would have
      // caught a missing no-op guard, rather than the harness itself being
      // silently broken.
      let notifications = 0;
      const unsubscribe = useAgentDriveStore.subscribe(() => { notifications += 1; });
      useAgentDriveStore.getState().setAgentDriving('sess-1', true);
      unsubscribe();

      expect(notifications).toBe(1);
    });
  });

  // useIsAgentDrivingSession is a thin selector wrapper
  // (`sessionId ? state.drivingSessionIds.includes(sessionId) : false`) around
  // a React hook, so it cannot be invoked outside a component render in this
  // project's vitest setup (no jsdom / @testing-library/react dependency -
  // see panel-error-boundary.test.ts and mobile-store.test.ts for the
  // established precedent). Its only branch (null/undefined sessionId -> false)
  // is exercised behaviorally by tests/ui/browser-pane-agent-input-focus.spec.ts
  // via BrowserPane's real usage. Reference the export so a rename or removal
  // still fails this file at compile time.
  it('exports useIsAgentDrivingSession as a function', () => {
    expect(typeof useIsAgentDrivingSession).toBe('function');
  });
});
