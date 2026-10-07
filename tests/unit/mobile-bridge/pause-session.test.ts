/**
 * pause-session pauses a task's live session through the desktop Pause
 * button's own path, pauseTaskSession (session-pause.ts), which the
 * SESSION_SUSPEND handler also calls. The handler, pauseTaskSession, the task
 * lock and the resume-cancel registry all run for real here. What stands in is
 * the layer below: the reconcile, the DB writes, and the session manager.
 *
 * It pins what a phone relies on:
 * - the pause is recorded as the USER's (`'user'`), which keeps an auto-spawn
 *   column from starting the task again by itself;
 * - the verb answers once the pause is accepted, while the PTY shutdown (about
 *   3s, and past the phone's 10s budget at worst) is still running;
 * - a task with no live session is refused, and nothing is written or stopped;
 * - there is no archive gate, matching the desktop: an archived task normally
 *   has no live session and is refused for that reason, and one a failed
 *   Done-move suspend left running is paused;
 * - the task lock is held, and an in-flight resume is cancelled before it.
 *
 * The last block runs the REAL SessionManager and SessionLifecycleBoardFeed,
 * as start-session.test.ts does, to pin that the suspend the verb runs reaches
 * the phone as a task-updated board event before the verb answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReconcileTaskSessionRef = vi.hoisted(() => vi.fn());
const mockApplySuspendDbWrites = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: (...args: unknown[]) => mockReconcileTaskSessionRef(...args),
  applySuspendDbWrites: (...args: unknown[]) => mockApplySuspendDbWrites(...args),
}));

// The real SessionManager for the board block below; the same module mocks
// start-session.test.ts uses to spawn without a PTY.
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));
vi.mock('../../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidate: string) => /^[\\/]{2}[^\\/]/.test(candidate),
}));
vi.mock('../../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import * as pty from 'node-pty';
import { handlePauseSession, PAUSE_SESSION_NOT_LIVE_MESSAGE } from '../../../src/main/mobile-bridge/handlers/pause-session';
import { pauseTaskSession } from '../../../src/main/ipc/handlers/session-pause';
import { withTaskLock } from '../../../src/main/ipc/task-lifecycle-lock';
import { registerResumeController, releaseResumeController } from '../../../src/main/ipc/handlers/session-resume-controllers';
import { CapabilityRouter } from '../../../src/main/mobile-bridge/capability-router';
import { BoardEventBus, type BoardChangedEvent } from '../../../src/main/mobile-bridge/board-event-bus';
import { SessionLifecycleBoardFeed } from '../../../src/main/mobile-bridge/session-lifecycle-feed';
import { SessionManager } from '../../../src/main/pty/session-manager';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

const TASK_ID = 'task-1';
const PROJECT_ID = 'proj-1';
const PAUSE_PAYLOAD = { taskId: TASK_ID, projectId: PROJECT_ID };

const liveTask = { id: TASK_ID, archived_at: null, session_id: 'sess-live' };
const liveSession = { id: 'sess-live', taskId: TASK_ID, status: 'running' };

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'pause-session', payload };
}

function fakeContext(suspend: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve())): IpcContext {
  return {
    currentProjectId: null,
    currentProjectPath: null,
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
    sessionManager: { suspend },
  } as unknown as IpcContext;
}

/** The router the bridge dispatches through, so a refusal is pinned as the ok:false the phone receives. */
function dispatchAsPhone(context: IpcContext, payload: Record<string, unknown> = PAUSE_PAYLOAD) {
  const router = new CapabilityRouter();
  router.register('pause-session', (request) => handlePauseSession(request, context));
  const pairedPhone = { deviceId: 'device-1', capabilities: new Set(['pause-session']) } as unknown as BridgeSession;
  return router.dispatch(fakeRequest(payload), pairedPhone);
}

/** A tick after the microtask queue drains, which is when Node would have reported an unhandled rejection. */
function afterUnhandledRejectionWindow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('handlePauseSession', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockReconcileTaskSessionRef.mockReset().mockReturnValue({ task: liveTask, liveSession });
    mockApplySuspendDbWrites.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('pauses the live session as the user, DB first, and answers while the PTY shutdown is still running', async () => {
    const shutdown = Promise.withResolvers<void>();
    let shutdownFinished = false;
    void shutdown.promise.then(() => { shutdownFinished = true; });
    const suspend = vi.fn(() => shutdown.promise);
    const context = fakeContext(suspend);

    const response = await handlePauseSession(fakeRequest(PAUSE_PAYLOAD), context);

    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: true, payload: { ok: true } });
    expect(shutdownFinished).toBe(false);
    expect(mockReconcileTaskSessionRef).toHaveBeenCalledWith(context, PROJECT_ID, TASK_ID);
    expect(mockApplySuspendDbWrites).toHaveBeenCalledWith(context, PROJECT_ID, TASK_ID, 'user');
    expect(suspend).toHaveBeenCalledWith('sess-live');
    expect(mockApplySuspendDbWrites.mock.invocationCallOrder[0]).toBeLessThan(suspend.mock.invocationCallOrder[0]);

    shutdown.resolve();
    await afterUnhandledRejectionWindow();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('refuses a task with no live session, and writes and stops nothing', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: { ...liveTask, session_id: null }, liveSession: null });
    const suspend = vi.fn(() => Promise.resolve());

    const response = await dispatchAsPhone(fakeContext(suspend));

    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: PAUSE_SESSION_NOT_LIVE_MESSAGE });
    expect(mockApplySuspendDbWrites).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('refuses an archived task whose Done move already suspended its session', async () => {
    mockReconcileTaskSessionRef.mockReturnValue({
      task: { id: TASK_ID, archived_at: '2026-10-01T00:00:00.000Z', session_id: null },
      liveSession: null,
    });
    const suspend = vi.fn(() => Promise.resolve());

    const response = await dispatchAsPhone(fakeContext(suspend));

    expect(response.ok).toBe(false);
    expect(response.error).toBe(PAUSE_SESSION_NOT_LIVE_MESSAGE);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('pauses an archived task that still has a live session, as the desktop Pause does', async () => {
    // A Done move archives first and suspends after. When that suspend fails,
    // the agent keeps running on a card that left the board, and the task
    // view's Pause, never gated on the archive, is the only stop for it.
    mockReconcileTaskSessionRef.mockReturnValue({
      task: { id: TASK_ID, archived_at: '2026-10-01T00:00:00.000Z', session_id: 'sess-stuck' },
      liveSession: { id: 'sess-stuck', taskId: TASK_ID, status: 'running' },
    });
    const suspend = vi.fn(() => Promise.resolve());
    const context = fakeContext(suspend);

    const response = await dispatchAsPhone(context);

    expect(response.ok).toBe(true);
    expect(mockApplySuspendDbWrites).toHaveBeenCalledWith(context, PROJECT_ID, TASK_ID, 'user');
    expect(suspend).toHaveBeenCalledWith('sess-stuck');
  });

  it('waits for the task lock: a holder delays the reconcile and the suspend until it releases', async () => {
    const holder = Promise.withResolvers<void>();
    const held = withTaskLock(TASK_ID, () => holder.promise);
    const suspend = vi.fn(() => Promise.resolve());

    const pending = handlePauseSession(fakeRequest(PAUSE_PAYLOAD), fakeContext(suspend));
    await afterUnhandledRejectionWindow();
    expect(mockReconcileTaskSessionRef).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();

    holder.resolve();
    await held;
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(suspend).toHaveBeenCalledWith('sess-live');
  });

  it('cancels a resume in flight for the task before queueing on the lock, as the desktop Pause does', async () => {
    // Holding the lock keeps the pause queued, so the abort it saw can only
    // have come from outside the lock.
    const holder = Promise.withResolvers<void>();
    const held = withTaskLock(TASK_ID, () => holder.promise);
    const resumeController = new AbortController();
    registerResumeController(TASK_ID, resumeController);
    try {
      const pending = handlePauseSession(fakeRequest(PAUSE_PAYLOAD), fakeContext());
      expect(resumeController.signal.aborted).toBe(true);
      expect(mockReconcileTaskSessionRef).not.toHaveBeenCalled();

      holder.resolve();
      await held;
      expect((await pending).ok).toBe(true);
    } finally {
      releaseResumeController(TASK_ID, resumeController);
    }
  });

  it('logs a PTY shutdown failure after accept and lets no rejection escape', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const suspend = vi.fn(async () => {
        await afterUnhandledRejectionWindow();
        throw new Error('host gone');
      });

      const response = await handlePauseSession(fakeRequest(PAUSE_PAYLOAD), fakeContext(suspend));
      expect(response.ok).toBe(true);

      await afterUnhandledRejectionWindow();
      await afterUnhandledRejectionWindow();
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('failed after accept'),
        expect.objectContaining({ message: 'host gone' }),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('turns a failure before acceptance into the verb\'s own refusal, not a log line', async () => {
    mockReconcileTaskSessionRef.mockImplementation(() => {
      throw new Error(`Task ${TASK_ID} not found`);
    });
    const suspend = vi.fn(() => Promise.resolve());

    const response = await dispatchAsPhone(fakeContext(suspend));

    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: `Task ${TASK_ID} not found` });
    expect(suspend).not.toHaveBeenCalled();
    await afterUnhandledRejectionWindow();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('refuses when neither the payload nor the desktop names a project, before taking the lock', async () => {
    const response = await handlePauseSession(fakeRequest({ taskId: TASK_ID, projectId: '' }), fakeContext());

    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'No such project: ' });
    expect(mockReconcileTaskSessionRef).not.toHaveBeenCalled();
  });

  it('refuses a project id the desktop does not know, before taking the lock or opening a repository', async () => {
    // The reconcile opens the project database by id, and an unknown id would
    // create and migrate one named after it (a deleted project, or a path
    // segment outside the projects directory).
    const context = fakeContext();
    vi.mocked(context.projectRepo.getById).mockReturnValue(undefined);

    const response = await handlePauseSession(fakeRequest({ taskId: TASK_ID, projectId: '../index' }), context);

    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'No such project: ../index' });
    expect(mockReconcileTaskSessionRef).not.toHaveBeenCalled();
  });

  it('parses the payload before anything else, rejecting a missing taskId', async () => {
    await expect(handlePauseSession(fakeRequest({ projectId: PROJECT_ID }), fakeContext())).rejects.toThrow(
      'pause-session payload missing "taskId"',
    );
    expect(mockReconcileTaskSessionRef).not.toHaveBeenCalled();
  });
});

describe('pauseTaskSession (the SESSION_SUSPEND body)', () => {
  beforeEach(() => {
    mockReconcileTaskSessionRef.mockReset().mockReturnValue({ task: liveTask, liveSession });
    mockApplySuspendDbWrites.mockReset();
  });

  it("reports 'not-live' without accepting, so the desktop's Pause stays a silent no-op", async () => {
    mockReconcileTaskSessionRef.mockReturnValue({ task: liveTask, liveSession: null });
    const onAccepted = vi.fn();

    await expect(pauseTaskSession(fakeContext(), TASK_ID, { projectId: PROJECT_ID, onAccepted })).resolves.toBe('not-live');
    expect(onAccepted).not.toHaveBeenCalled();
    expect(mockApplySuspendDbWrites).not.toHaveBeenCalled();
  });

  it('accepts once, after the DB writes and before the suspend, and resolves when the suspend has finished', async () => {
    const suspend = vi.fn(() => Promise.resolve());
    const onAccepted = vi.fn();

    await expect(pauseTaskSession(fakeContext(suspend), TASK_ID, { projectId: PROJECT_ID, onAccepted })).resolves.toBe('paused');
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(mockApplySuspendDbWrites.mock.invocationCallOrder[0]).toBeLessThan(onAccepted.mock.invocationCallOrder[0]);
    expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(suspend.mock.invocationCallOrder[0]);
  });

  it('still suspends the PTY when the accept hook throws, so the record never says paused over a running agent', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const suspend = vi.fn(() => Promise.resolve());
      const onAccepted = vi.fn(() => {
        throw new Error('hook broke');
      });

      await expect(pauseTaskSession(fakeContext(suspend), TASK_ID, { projectId: PROJECT_ID, onAccepted })).resolves.toBe('paused');
      expect(suspend).toHaveBeenCalledWith('sess-live');
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('falls back to the current project when the caller names none (the desktop handler\'s internal callers)', async () => {
    const context = { ...fakeContext(), currentProjectId: 'proj-current' } as unknown as IpcContext;

    await pauseTaskSession(context, TASK_ID);
    expect(mockReconcileTaskSessionRef).toHaveBeenCalledWith(context, 'proj-current', TASK_ID);
  });
});

describe('pause-session: a phone pause reaches the phone', () => {
  function createMockPty() {
    return {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }

  let manager: SessionManager;
  let boardEvents: BoardEventBus;
  let feed: SessionLifecycleBoardFeed;

  beforeEach(() => {
    mockReconcileTaskSessionRef.mockReset();
    mockApplySuspendDbWrites.mockReset();
    manager = new SessionManager();
    boardEvents = new BoardEventBus();
    feed = new SessionLifecycleBoardFeed({ sessionManager: manager, boardEvents, settleDelayMs: 1000 });
    feed.start();
  });

  afterEach(() => {
    feed.dispose();
  });

  it('the suspend the verb runs reaches the board bus as task-updated before the verb answers', async () => {
    const mockPty = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mockPty as unknown as pty.IPty);
    const live = await manager.spawn({ taskId: TASK_ID, projectId: PROJECT_ID, command: '', cwd: '/mock/project' });
    expect(manager.getSession(live.id)?.status).toBe('running');

    // Stand-in for the read-board subscription, registered after the spawn so
    // only the pause's own events are counted.
    const phoneSaw: BoardChangedEvent[] = [];
    boardEvents.onBoardChanged((event) => {
      if (event.projectId === PROJECT_ID) phoneSaw.push(event);
    });
    mockReconcileTaskSessionRef.mockReturnValue({ task: liveTask, liveSession: live });
    const suspendSpy = vi.spyOn(manager, 'suspend');
    const context = {
      currentProjectId: null,
      currentProjectPath: null,
      projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
      sessionManager: manager,
    } as unknown as IpcContext;

    const response = await handlePauseSession(fakeRequest(PAUSE_PAYLOAD), context);

    expect(response.ok).toBe(true);
    expect(manager.getSession(live.id)?.status).toBe('suspended');
    expect(phoneSaw).toContainEqual({ projectId: PROJECT_ID, change: 'task-updated', ids: [TASK_ID] });

    // End the PTY so the shutdown the verb left running finishes inside the test.
    const exitListener = mockPty.onExit.mock.calls[0]?.[0] as ((event: { exitCode: number; signal?: number }) => void) | undefined;
    exitListener?.({ exitCode: 0, signal: 0 });
    await suspendSpy.mock.results[0]?.value;
  });
});
