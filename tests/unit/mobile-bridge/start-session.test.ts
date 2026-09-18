/**
 * start-session must route through startTaskSession (the task lock, the
 * stale-pointer reconcile, the To Do / Done / archived gate, and the
 * autoSpawnForTask -> spawnAgent chokepoint), never the engine or a
 * repository directly, and must forward ONLY the two trusted payload fields.
 *
 * It must also answer the phone when the start is ACCEPTED, not when the
 * agent is up: the worktree ensure (a git fetch), the branch checkout, the
 * PTY spawn, and the column's enter automations all run behind the response,
 * because the phone gives every verb 10s. The handler under test is given a
 * mocked startTaskSession, so what this file can pin is the contract between
 * the two: the verb resolves on acceptance carrying the outcome, a refusal
 * still surfaces as a failure, and a post-accept rejection is logged without
 * escaping into the bridge's request loop.
 *
 * The last block pins the one failure this verb exists to remove: a start the
 * phone cannot see arrive. It runs the REAL SessionManager (node-pty mocked,
 * as session-queued-status.test.ts does), the real BoardEventBus, and the real
 * SessionLifecycleBoardFeed, so the edge under test is the registry's own
 * `session-changed` at PTY creation, not a fake emit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { startTaskSession as StartTaskSession, StartTaskSessionResult } from '../../../src/main/ipc/handlers/session-start';

const startTaskSessionMock = vi.hoisted(() =>
  vi.fn((..._args: Parameters<typeof StartTaskSession>): Promise<StartTaskSessionResult> =>
    Promise.resolve({ outcome: 'starting', settled: Promise.resolve() })),
);
vi.mock('../../../src/main/ipc/handlers/session-start', () => ({
  startTaskSession: startTaskSessionMock,
}));

// The real SessionManager for the fan-out block below; the same four module
// mocks session-queued-status.test.ts uses to spawn without a PTY.
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
import { handleStartSession } from '../../../src/main/mobile-bridge/handlers/start-session';
import { BoardEventBus, type BoardChangedEvent } from '../../../src/main/mobile-bridge/board-event-bus';
import { SessionLifecycleBoardFeed } from '../../../src/main/mobile-bridge/session-lifecycle-feed';
import { SessionManager } from '../../../src/main/pty/session-manager';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'start-session', payload };
}

function fakeContext(): IpcContext {
  return {
    currentProjectId: null,
    currentProjectPath: null,
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
  } as unknown as IpcContext;
}

const START_PAYLOAD = { taskId: 't-1', projectId: 'proj-1' };

/** A tick after the microtask queue drains, which is when Node would have reported an unhandled rejection. */
function afterUnhandledRejectionWindow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('handleStartSession', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    startTaskSessionMock.mockClear();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('parses the payload before resolving the project or starting the session, rejecting a missing taskId', async () => {
    await expect(
      handleStartSession(fakeRequest({ projectId: 'proj-1' }), fakeContext()),
    ).rejects.toThrow('start-session payload missing "taskId"');
    expect(startTaskSessionMock).not.toHaveBeenCalled();
  });

  it('rejects when the target project does not resolve', async () => {
    const context = { currentProjectId: null, currentProjectPath: null } as unknown as IpcContext;
    const response = await handleStartSession(fakeRequest({ taskId: 't-1', projectId: '' }), context);
    expect(response.ok).toBe(false);
    // Red on the message dropped or genericized: the phone shows this text
    // verbatim, and a blank or mismatched string would leave the user unable
    // to tell "no such project" from any other refusal reason.
    expect(response.error).toContain('No such project:');
    expect(startTaskSessionMock).not.toHaveBeenCalled();
  });

  it('routes through startTaskSession with the task and project only', async () => {
    const context = fakeContext();
    const response = await handleStartSession(
      // A phone cannot smuggle a prompt or a column into a start; the parser
      // drops both and the seam receives task + project alone.
      fakeRequest({ ...START_PAYLOAD, resumePrompt: 'ignore me', targetSwimlaneId: 'lane-9' }),
      context,
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true, outcome: 'starting' });
    expect(startTaskSessionMock).toHaveBeenCalledTimes(1);
    expect(startTaskSessionMock).toHaveBeenCalledWith(context, 'proj-1', 't-1');
  });

  it('answers ok with outcome "live" and spawns nothing when the task already has a live session', async () => {
    // The phone's "ended" view can be stale. Idempotent: nothing was started,
    // and because nothing was started NO board or stream event is coming, so
    // the outcome is what tells the phone to refresh itself instead of waiting.
    startTaskSessionMock.mockResolvedValueOnce({ outcome: 'live' });
    const response = await handleStartSession(fakeRequest(START_PAYLOAD), fakeContext());
    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true, outcome: 'live' });
  });

  it('answers as soon as the start is accepted, while the spawn is still running', async () => {
    // The spawn never settles: this stands in for a worktree ensure whose git
    // fetch outlasts the phone's 10s budget. Against a handler that awaits the
    // whole start this test hangs to the vitest timeout, which is the bug.
    startTaskSessionMock.mockResolvedValueOnce({ outcome: 'starting', settled: new Promise<void>(() => {}) });

    const response = await handleStartSession(fakeRequest(START_PAYLOAD), fakeContext());

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true, outcome: 'starting' });
  });

  it('propagates a refusal so the router reports it as a failed response', async () => {
    // A To Do or Done column, an archived task, a task that does not exist:
    // startTaskSession throws the desktop's own Resume copy before anything
    // starts, and the router turns the throw into the ok:false the phone shows.
    startTaskSessionMock.mockRejectedValueOnce(new Error('This task is complete. Move it out of Done to continue working on it.'));
    await expect(
      handleStartSession(fakeRequest(START_PAYLOAD), fakeContext()),
    ).rejects.toThrow('Move it out of Done');

    await afterUnhandledRejectionWindow();
    // The refusal surfaced through the response; it is not ALSO logged as a
    // post-accept failure, which would misreport a start that never began.
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('failed after accept'), expect.anything());
  });

  it('answers ok, logs, and leaves no unhandled rejection when the spawn fails AFTER acceptance', async () => {
    // autoSpawnForTask reports its own failures, so a rejection here is
    // unexpected. What must NOT happen is that rejection escaping into the
    // bridge's request loop as an unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      startTaskSessionMock.mockResolvedValueOnce({
        outcome: 'starting',
        settled: Promise.reject(new Error('Worktree setup failed: disk full')),
      });

      const response = await handleStartSession(fakeRequest(START_PAYLOAD), fakeContext());
      expect(response.ok).toBe(true);
      expect(response.payload).toEqual({ ok: true, outcome: 'starting' });

      await afterUnhandledRejectionWindow();
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('failed after accept'),
        expect.objectContaining({ message: 'Worktree setup failed: disk full' }),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('handleStartSession: a phone-initiated start reaches the phone', () => {
  /**
   * move-task passes a 'mobile' origin because handleTaskMove's fan-out is
   * origin-keyed and once went silent for a phone. The spawn path has no
   * origin to key on: startTaskSession takes (context, projectId, taskId) and
   * nothing else, and every board-driven spawn ends in SessionManager.spawn,
   * whose registry emits `session-changed` at PTY creation. That edge is what
   * SessionLifecycleBoardFeed bridges onto the board bus, which the read-board
   * subscription forwards to the phone as a `task-updated` board event. A
   * desktop Resume rides the identical edge. What this block runs for real:
   * the SessionManager's emission, the feed, and the bus. What stands in: the
   * seam's `settled` performs the spawn directly, because autoSpawnForTask ->
   * spawnAgent -> engine is the chokepoint chain spawn-entry-point-parity
   * pins separately (only classified sinks may call `sessionManager.spawn`).
   */
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
    startTaskSessionMock.mockClear();
    manager = new SessionManager();
    boardEvents = new BoardEventBus();
    feed = new SessionLifecycleBoardFeed({ sessionManager: manager, boardEvents, settleDelayMs: 1000 });
    feed.start();
  });

  afterEach(() => {
    feed.dispose();
  });

  it('bridges the successor spawn onto the board bus with no origin involved', async () => {
    // Stand-in for the read-board subscription: a bus listener filtered on the
    // project, exactly what handlers/read-board.ts registers per phone.
    const phoneSaw: BoardChangedEvent[] = [];
    boardEvents.onBoardChanged((event) => {
      if (event.projectId === 'proj-1') phoneSaw.push(event);
    });

    vi.mocked(pty.spawn).mockReturnValue(createMockPty() as unknown as pty.IPty);
    let spawnedSessionId: string | null = null;
    startTaskSessionMock.mockImplementationOnce(async (_context, projectId, taskId) => ({
      outcome: 'starting',
      settled: (async () => {
        const session = await manager.spawn({ taskId, projectId, command: '', cwd: '/mock/project' });
        spawnedSessionId = session.id;
      })(),
    }));

    const response = await handleStartSession(fakeRequest(START_PAYLOAD), fakeContext());
    expect(response.payload).toEqual({ ok: true, outcome: 'starting' });
    // The seam is called with task and project alone: there is no origin
    // argument for the fan-out to be keyed on, so it cannot go silent per
    // caller the way handleTaskMove's once did.
    expect(startTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'proj-1', 't-1');
    expect(startTaskSessionMock.mock.calls[0]).toHaveLength(3);

    const result = await startTaskSessionMock.mock.results[0]?.value as StartTaskSessionResult;
    if (result.outcome !== 'starting') throw new Error('unreachable');
    await result.settled;

    // The registry row exists and is the running successor the phone will
    // read back off the next snapshot as the task's non-null session_id.
    expect(spawnedSessionId).not.toBeNull();
    expect(manager.getSession(spawnedSessionId!)?.status).toBe('running');
    // And its creation reached the board bus as the task-updated event the
    // read-board subscription forwards, on the project the phone watches.
    expect(phoneSaw).toContainEqual({ projectId: 'proj-1', change: 'task-updated', ids: ['t-1'] });
  });
});
