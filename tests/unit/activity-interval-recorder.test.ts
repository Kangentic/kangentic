/**
 * Unit tests for src/main/activity-engine/activity-interval-recorder.ts
 *
 * Covered: seed suppression (an initSession emit writes no row), opening on
 * a fresh flip into either disposition, closing-then-opening on the
 * OPPOSITE flip (symmetric: active<->idle, not idle-only), closing on
 * session exit, transient (Command Terminal) sessions skipped entirely, and
 * a thinking -> permission -> idle run producing exactly one 'idle'
 * interval that keeps the original park's started_ms (a permission<->idle
 * crossing shares one disposition, so nothing closes/reopens for it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ActivityIntervalRecorder, type ActivityIntervalRecorderOptions } from '../../src/main/activity-engine/activity-interval-recorder';
import type { ActivityIntervalStore } from '../../src/main/activity-engine/activity-interval-store';
import type { ActivityReason, ActivityState } from '../../src/shared/types';

interface FakeTransitionRecord {
  ts: number;
  from: ActivityState;
  to: ActivityState;
  reasonKind: string;
  trigger: string;
}

class FakeSessionManager extends EventEmitter {
  session: { transient?: boolean } | undefined = { transient: false };
  projectId: string | undefined = 'project-1';
  taskId: string | undefined = 'task-1';
  recentTransitions: FakeTransitionRecord[] = [];

  getSession = vi.fn((_sessionId: string) => this.session);
  getSessionProjectId = vi.fn((_sessionId: string) => this.projectId);
  getSessionTaskId = vi.fn((_sessionId: string) => this.taskId);
  getActivityStatsSnapshot = vi.fn((_sessionId: string) => ({
    recentTransitions: this.recentTransitions,
  }));
}

function fakeStore(): { store: ActivityIntervalStore; openInterval: ReturnType<typeof vi.fn>; closeOpenInterval: ReturnType<typeof vi.fn> } {
  const openInterval = vi.fn();
  const closeOpenInterval = vi.fn();
  const store = { openInterval, closeOpenInterval, getForTask: vi.fn(), getForSession: vi.fn() } as unknown as ActivityIntervalStore;
  return { store, openInterval, closeOpenInterval };
}

describe('ActivityIntervalRecorder', () => {
  let sessionManager: FakeSessionManager;
  let storeHandle: ReturnType<typeof fakeStore>;
  let getStore: ReturnType<typeof vi.fn>;
  let recorder: ActivityIntervalRecorder;

  function buildRecorder(overrides: Partial<ActivityIntervalRecorderOptions> = {}): void {
    recorder = new ActivityIntervalRecorder({
      sessionManager: sessionManager as unknown as ActivityIntervalRecorderOptions['sessionManager'],
      getStore,
      now: () => '2026-07-22T00:00:00.000Z',
      ...overrides,
    });
    recorder.start();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:09.000Z'));
    sessionManager = new FakeSessionManager();
    storeHandle = fakeStore();
    getStore = vi.fn(() => storeHandle.store);
  });

  afterEach(() => {
    recorder.dispose();
    vi.useRealTimers();
  });

  describe('session-removed closes the interval a direct remove() used to strand', () => {
    const removedRow = {
      id: 'sess-1',
      taskId: 'task-1',
      projectId: 'project-1',
      status: 'running',
      transient: false,
    };

    it('closes the open interval, resolving the project from the removal payload', () => {
      buildRecorder();

      sessionManager.emit('session-removed', 'sess-1', removedRow);

      expect(getStore).toHaveBeenCalledWith('project-1');
      expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
      expect(storeHandle.closeOpenInterval).toHaveBeenCalledWith(
        'sess-1',
        Date.parse('2026-07-22T00:00:09.000Z'),
        'session-removed',
      );
    });

    it('a direct remove(): the row is gone by the time the exit lands, and the removal is what closed the interval', () => {
      // The documented gap: remove() deletes the registry row synchronously
      // while the PTY dies asynchronously, so the later 'exit' resolves no
      // session and used to leave the interval open forever.
      buildRecorder();
      sessionManager.session = undefined;

      sessionManager.emit('session-removed', 'sess-1', removedRow);
      sessionManager.emit('exit', 'sess-1', -1, true);

      expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
      expect(storeHandle.closeOpenInterval).toHaveBeenCalledWith('sess-1', expect.any(Number), 'session-removed');
    });

    it('skips a transient (Command Terminal) session removal', () => {
      buildRecorder();

      sessionManager.emit('session-removed', 'sess-cmd', { ...removedRow, id: 'sess-cmd', transient: true });

      expect(storeHandle.closeOpenInterval).not.toHaveBeenCalled();
    });

    it('skips a removal payload with no resolvable project id, the other half of the guard', () => {
      // The removal payload carries the row's own last snapshot rather than a
      // live registry lookup, so a caller that constructs it from partial
      // data (or a stale/never-assigned row) can hand this listener a
      // projectId of undefined. Without the `!session.projectId` half of the
      // guard this would call getStore(undefined), which the real production
      // getStore (getProjectDb-backed) would throw or resolve against the
      // wrong project for.
      buildRecorder();

      sessionManager.emit('session-removed', 'sess-1', { ...removedRow, projectId: undefined });

      expect(getStore).not.toHaveBeenCalled();
      expect(storeHandle.closeOpenInterval).not.toHaveBeenCalled();
    });

    it('dispose detaches the removal listener with the other two', () => {
      buildRecorder();
      expect(sessionManager.listenerCount('session-removed')).toBe(1);

      recorder.dispose();

      expect(sessionManager.listenerCount('session-removed')).toBe(0);
      expect(sessionManager.listenerCount('exit')).toBe(0);
      expect(sessionManager.listenerCount('activity')).toBe(0);
    });
  });

  it('ignores an initSession seed emit (empty recentTransitions)', () => {
    buildRecorder();
    sessionManager.recentTransitions = [];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 1000 } satisfies ActivityReason);

    expect(storeHandle.openInterval).not.toHaveBeenCalled();
    expect(storeHandle.closeOpenInterval).not.toHaveBeenCalled();
  });

  it('ignores an emission whose transition-ring tail does not match the reported state (stale/seed)', () => {
    buildRecorder();
    // The ring's last entry reports 'permission', but the callback claims 'idle' -
    // a mismatch that only a seed emission (which never appends to the ring) produces.
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'permission', reasonKind: 'permission', trigger: 'event:idle:permission' },
    ];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);

    expect(storeHandle.openInterval).not.toHaveBeenCalled();
  });

  it('a fresh park (thinking -> idle) closes nothing (nothing was open yet) and opens an "idle" interval', () => {
    buildRecorder();
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'idle', reasonKind: 'idle', trigger: 'event:idle' },
    ];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);

    // First real transition of the session's life: closeOpenInterval still
    // fires (unconditional close-then-open), but it is a no-op at the store
    // layer since nothing was open - the recorder itself does not special-case it.
    expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
    expect(storeHandle.closeOpenInterval).toHaveBeenCalledWith('sess-1', 5000, 'event:idle');
    expect(storeHandle.openInterval).toHaveBeenCalledTimes(1);
    expect(storeHandle.openInterval).toHaveBeenCalledWith(
      {
        sessionId: 'sess-1',
        taskId: 'task-1',
        disposition: 'idle',
        state: 'idle',
        previousState: 'thinking',
        enterTrigger: 'event:idle',
        startedMs: 5000,
      },
      '2026-07-22T00:00:00.000Z',
    );
  });

  it('leaving a park (idle -> thinking) closes the "idle" interval and opens an "active" one', () => {
    buildRecorder();
    sessionManager.recentTransitions = [
      { ts: 8000, from: 'idle', to: 'thinking', reasonKind: 'turn-active', trigger: 'event:prompt' },
    ];

    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' } satisfies ActivityReason);

    expect(storeHandle.closeOpenInterval).toHaveBeenCalledWith('sess-1', 8000, 'event:prompt');
    expect(storeHandle.openInterval).toHaveBeenCalledWith(
      {
        sessionId: 'sess-1',
        taskId: 'task-1',
        disposition: 'active',
        state: 'thinking',
        previousState: 'idle',
        enterTrigger: 'event:prompt',
        startedMs: 8000,
      },
      '2026-07-22T00:00:00.000Z',
    );
  });

  it('a permission park (thinking -> permission) opens an "idle"-disposition interval too', () => {
    buildRecorder();
    sessionManager.recentTransitions = [
      { ts: 2000, from: 'thinking', to: 'permission', reasonKind: 'permission', trigger: 'event:idle:permission' },
    ];

    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 2000 } satisfies ActivityReason);

    expect(storeHandle.openInterval).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'idle', state: 'permission', previousState: 'thinking' }),
      expect.any(String),
    );
  });

  it('a thinking -> permission -> idle run opens exactly one "idle" interval - the crossing shares one disposition', () => {
    buildRecorder();

    // Turn 1: thinking -> permission. A real disposition flip: closes
    // nothing (first transition of the session's life, a store-level no-op)
    // and opens the one 'idle' interval.
    sessionManager.recentTransitions = [
      { ts: 1000, from: 'thinking', to: 'permission', reasonKind: 'permission', trigger: 'event:idle:permission' },
    ];
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 1000 } satisfies ActivityReason);
    expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
    expect(storeHandle.openInterval).toHaveBeenCalledTimes(1);

    // Turn 2: permission -> idle. Both map to the 'idle' disposition, so
    // NEITHER close nor open fires again - the interval opened in turn 1
    // stays open, uncounted.
    sessionManager.recentTransitions = [
      ...sessionManager.recentTransitions,
      { ts: 3000, from: 'permission', to: 'idle', reasonKind: 'idle', trigger: 'interrupted' },
    ];
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 1000 } satisfies ActivityReason);

    expect(storeHandle.openInterval).toHaveBeenCalledTimes(1);
    expect(storeHandle.openInterval).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'idle', state: 'permission', previousState: 'thinking', startedMs: 1000 }),
      expect.any(String),
    );
    // Still just the one call from turn 1 - turn 2 must not close/reopen.
    expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
  });

  it('closes the open interval on session exit, regardless of whether one is open', () => {
    buildRecorder();

    sessionManager.emit('exit', 'sess-1', 0, true);

    expect(storeHandle.closeOpenInterval).toHaveBeenCalledTimes(1);
    expect(storeHandle.closeOpenInterval).toHaveBeenCalledWith('sess-1', Date.now(), 'session-exit');
  });

  it('skips a transient (Command Terminal) session entirely, for both activity and exit', () => {
    sessionManager.session = { transient: true };
    buildRecorder();
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'idle', reasonKind: 'idle', trigger: 'event:idle' },
    ];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);
    sessionManager.emit('exit', 'sess-1', 0, true);

    expect(getStore).not.toHaveBeenCalled();
    expect(storeHandle.openInterval).not.toHaveBeenCalled();
    expect(storeHandle.closeOpenInterval).not.toHaveBeenCalled();
  });

  it('skips a session with no resolvable project id', () => {
    sessionManager.projectId = undefined;
    buildRecorder();
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'idle', reasonKind: 'idle', trigger: 'event:idle' },
    ];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);

    expect(getStore).not.toHaveBeenCalled();
  });

  it('does nothing after dispose()', () => {
    buildRecorder();
    recorder.dispose();
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'idle', reasonKind: 'idle', trigger: 'event:idle' },
    ];

    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);
    sessionManager.emit('exit', 'sess-1', 0, true);

    expect(storeHandle.openInterval).not.toHaveBeenCalled();
    expect(storeHandle.closeOpenInterval).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Listener isolation. SessionManager is a plain EventEmitter, and emit()
  // does not isolate listener exceptions: a throw aborts every listener
  // registered AFTER this one on the same synchronous emit (in production
  // that is registerSessionHandlers' session-lifecycle DB write and the
  // SESSION_ACTIVITY board broadcast), and unwinds back into
  // ActivityEngine.commitTransition before it can call scheduleTimer(),
  // leaving the stale-thinking watchdog unarmed. The recorder does
  // synchronous better-sqlite3 I/O inline, so it must swallow its own
  // failures - same guard DesktopNotifier documents on this event.
  // -------------------------------------------------------------------------

  it('a store write failure on activity never escapes into the emit stack, and later listeners still run', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    buildRecorder();
    storeHandle.openInterval.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    sessionManager.recentTransitions = [
      { ts: 5000, from: 'thinking', to: 'idle', reasonKind: 'idle', trigger: 'event:idle' },
    ];
    // Stands in for registerSessionHandlers' 'activity' listener, which
    // register-all.ts attaches AFTER the recorder.
    const laterListener = vi.fn();
    sessionManager.on('activity', laterListener);

    expect(() => {
      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle', since: 5000 } satisfies ActivityReason);
    }).not.toThrow();

    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a store write failure on exit never escapes into the emit stack, and later listeners still run', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    buildRecorder();
    storeHandle.closeOpenInterval.mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const laterListener = vi.fn();
    sessionManager.on('exit', laterListener);

    expect(() => {
      sessionManager.emit('exit', 'sess-1', 0, true);
    }).not.toThrow();

    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a store write failure on removal never escapes into the emit stack, and later listeners still run', () => {
    // SessionManager.remove() emits 'session-removed' synchronously to five
    // listeners (see session-replica-contract.md); a throw in this one's
    // store write must not abort the others or the SESSION_REMOVED broadcast
    // that rides the same emit. Mirrors the activity/exit isolation tests
    // above for the third listener onRemoved wraps.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    buildRecorder();
    storeHandle.closeOpenInterval.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const laterListener = vi.fn();
    sessionManager.on('session-removed', laterListener);

    expect(() => {
      sessionManager.emit('session-removed', 'sess-1', {
        id: 'sess-1',
        taskId: 'task-1',
        projectId: 'project-1',
        status: 'running',
        transient: false,
      });
    }).not.toThrow();

    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
