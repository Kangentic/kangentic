/**
 * The park-or-drop DECISION itself: `shouldParkTaskDetailWindowOnClose`.
 *
 * `window-parking-close-paths.test.ts` pins that every board close path routes
 * through this policy (a static scan of call sites) and that its source text
 * mentions the right store fields. Neither checks what the function actually
 * RETURNS for a given store state. The UI spec
 * (`tests/ui/browser-pane-park-on-close.spec.ts`) drives the real thing end to
 * end, but every one of its scenarios closes a window while the task's session
 * is `running` at the moment of the close - none of them exercise the case a
 * park exists specifically to exclude: a task whose Browser pane is still
 * mounted (open or held) but whose agent is NOT live. Drop the status check and
 * every existing test still passes, while a task with a stopped agent starts
 * parking its window on every close - an invisible `<webview>` that nothing
 * will ever reap, since the reaper's own liveness check is this same function
 * and would agree.
 *
 * On `queued` this pins the CURRENT renderer behavior (only `running` parks)
 * rather than asserting it is the only defensible one. Main's
 * `SessionRegistry.hasLiveSessionForTask`, added on the same branch, counts
 * `queued` as live for the hand-off lane, so the two liveness checks genuinely
 * differ. That is survivable here because a queued task's close is exactly the
 * case the hand-off lane exists to catch: the pane unmounts with
 * `renderer-unmount`, which IS in `HANDOFF_REASONS`, so main carries the page
 * anyway. If someone later aligns the two, this case failing is the intended
 * prompt to make that a deliberate decision, not a reason to widen it blindly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldParkTaskDetailWindowOnClose } from '../../src/renderer/window-manager/bridge/window-parking';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import type { ManagedWindow } from '../../src/renderer/window-manager/store/types';
import type { Session, SessionStatus } from '../../src/shared/types';

function makeWindow(overrides: Partial<ManagedWindow> = {}): ManagedWindow {
  return {
    id: 'window-task-a',
    kind: 'task-detail',
    anchor: 'task-a',
    sessionId: null,
    geometry: { x: 0, y: 0, w: 0.5, h: 1 },
    state: 'floating',
    zIndex: 1,
    leafId: null,
    sessionStatus: 'closed',
    restoreGeometry: null,
    title: 'task-a',
    ...overrides,
  };
}

function makeSession(taskId: string, status: SessionStatus): Session {
  return {
    id: `sess-${taskId}`,
    taskId,
    projectId: 'proj-1',
    pid: 1000,
    status,
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    agentSessionId: null,
  };
}

/** Set only the fields the policy reads, leaving the rest of the store alone. */
function setSessionState(options: {
  session?: Session;
  browserOpenTasks?: Set<string>;
  browserHeldTasks?: Set<string>;
  /** Tasks with a registered `<webview>` guest. Defaults to none. */
  guestTasks?: readonly string[];
}): void {
  const _sessionByTaskId = new Map<string, Session>();
  if (options.session) _sessionByTaskId.set(options.session.taskId, options.session);
  const browserGuestTasks = new Map<string, number>();
  for (const [index, taskId] of (options.guestTasks ?? []).entries()) {
    browserGuestTasks.set(taskId, 5000 + index);
  }
  useSessionStore.setState({
    sessions: options.session ? [options.session] : [],
    _sessionByTaskId,
    browserOpenTasks: options.browserOpenTasks ?? new Set(),
    browserHeldTasks: options.browserHeldTasks ?? new Set(),
    browserGuestTasks,
  });
}

describe('shouldParkTaskDetailWindowOnClose', () => {
  beforeEach(() => {
    setSessionState({});
  });

  it('is false for a window kind other than task-detail, even with a mounted pane and a live session', () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserOpenTasks: new Set(['task-a']),
      guestTasks: ['task-a'],
    });
    const commandWindow = makeWindow({ kind: 'command-terminal' });
    expect(shouldParkTaskDetailWindowOnClose(commandWindow)).toBe(false);
  });

  // Parking exists to preserve a live `<webview>` guest. A pane with no URL
  // renders the empty state and never attaches one, so the open flag alone must
  // not park: doing so hid a window indefinitely with nothing inside it to
  // save. `browserGuestTasks` is the renderer's "a page is really here" fact.
  it('is false when the pane is open on a running session but no guest ever registered', () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserOpenTasks: new Set(['task-a']),
    });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
  });

  it('is false when the pane is held on a running session but no guest ever registered', () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserHeldTasks: new Set(['task-a']),
    });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
  });

  it("is false when another task's guest is the only one registered", () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserOpenTasks: new Set(['task-a']),
      guestTasks: ['task-b'],
    });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
  });

  // Each case below differs from the passing case by exactly ONE condition, so
  // it pins that condition rather than passing for an incidental second reason.
  it('is false when the pane is neither open nor held, even with a running session', () => {
    setSessionState({ session: makeSession('task-a', 'running'), guestTasks: ['task-a'] });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
  });

  it('is false when the pane is open but the task has no session at all', () => {
    setSessionState({ browserOpenTasks: new Set(['task-a']), guestTasks: ['task-a'] });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
  });

  // The gap this file exists to close: a mounted pane alone is not enough.
  for (const status of ['exited', 'suspended', 'queued'] as const) {
    it(`is false when the pane is open but the session status is '${status}' (only 'running' is live)`, () => {
      setSessionState({
        session: makeSession('task-a', status),
        browserOpenTasks: new Set(['task-a']),
        guestTasks: ['task-a'],
      });
      expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
    });

    it(`is false when the pane is held but the session status is '${status}'`, () => {
      setSessionState({
        session: makeSession('task-a', status),
        browserHeldTasks: new Set(['task-a']),
        guestTasks: ['task-a'],
      });
      expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(false);
    });
  }

  it('is true when the pane is open with a live guest and the session is running', () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserOpenTasks: new Set(['task-a']),
      guestTasks: ['task-a'],
    });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(true);
  });

  it('is true when the pane is only held (not open) with a live guest and the session is running', () => {
    setSessionState({
      session: makeSession('task-a', 'running'),
      browserHeldTasks: new Set(['task-a']),
      guestTasks: ['task-a'],
    });
    expect(shouldParkTaskDetailWindowOnClose(makeWindow())).toBe(true);
  });

  it("reads the CLOSING window's own anchor, not some other task's state", () => {
    setSessionState({
      session: makeSession('task-b', 'running'),
      browserOpenTasks: new Set(['task-b']),
      guestTasks: ['task-b'],
    });
    // task-a's window closing while task-b (a different task) has the live,
    // pane-open agent must not park task-a's window.
    expect(shouldParkTaskDetailWindowOnClose(makeWindow({ anchor: 'task-a' }))).toBe(false);
    expect(shouldParkTaskDetailWindowOnClose(makeWindow({ id: 'window-task-b', anchor: 'task-b' }))).toBe(true);
  });
});
