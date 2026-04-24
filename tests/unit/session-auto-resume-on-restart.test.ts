/**
 * Tests for syncShutdownCleanup's session + task bookkeeping.
 *
 * At shutdown we always mark running sessions as `suspended_by = 'system'`
 * and clear the task's `session_id`. The 'user' marker is reserved for
 * explicit pause-button presses; conflating shutdown with user pause would
 * cause task-move's spawnAgent path to refuse to resume the session on a
 * subsequent column drag (see spawnAgent's user-pause guard).
 *
 * Preventing auto-resume on the next launch when the user has
 * `autoResumeSessionsOnRestart = false` is handled entirely in
 * resumeSuspendedSessions (see session-auto-resume-orphan-upgrade.test.ts),
 * so shutdown no longer reads the config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks: must appear before the import of syncShutdownCleanup.

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({}) as never),
  closeAll: vi.fn(),
}));

const markRecordSuspendedMock = vi.fn(() => true);
const markRecordExitedMock = vi.fn(() => true);
vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordSuspended: (...args: unknown[]) => markRecordSuspendedMock(...args),
  markRecordExited: (...args: unknown[]) => markRecordExitedMock(...args),
}));

// Partial SessionRecord shape: shutdown.ts only reads `id` and `status` on the
// getLatestForTask return. If shutdown.ts starts inspecting more fields, this
// mock will naturally fail fast.
//
// The returned record status is driven by the module-level
// `sessionRecordStatusRef` so tests can pick 'running' vs 'queued' per case.
const sessionRecordStatusRef = { current: 'running' as 'running' | 'queued' };
vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    getLatestForTask = vi.fn(() => ({
      id: 'record-1',
      status: sessionRecordStatusRef.current,
    }));
  }
  return { SessionRepository: FakeSessionRepository };
});

const taskRepoUpdateMock = vi.fn();
vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
  }
  return { TaskRepository: FakeTaskRepository };
});

import { syncShutdownCleanup } from '../../src/main/shutdown';

function makeDeps(options: { sessionStatus?: 'running' | 'queued' } = {}) {
  const sessionStatus = options.sessionStatus ?? 'running';
  const sessionManager = {
    listSessions: vi.fn(() => [
      { taskId: 'task-A', projectId: 'proj-1', status: sessionStatus },
    ]),
    killAll: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    getSessionManager: () => sessionManager as never,
    getBoardConfigManager: () => ({ detach: vi.fn() }) as never,
    getCommandInjector: () => ({ cancelAll: vi.fn() }) as never,
    getCurrentProjectId: () => null,
    deleteProjectFromIndex: vi.fn(),
    stopUpdaterTimers: vi.fn(),
    clearPendingTimers: vi.fn(),
    isEphemeral: false,
  };
}

describe('syncShutdownCleanup: session + task bookkeeping', () => {
  beforeEach(() => {
    markRecordSuspendedMock.mockClear();
    markRecordExitedMock.mockClear();
    taskRepoUpdateMock.mockClear();
    sessionRecordStatusRef.current = 'running';
  });

  it("always marks running sessions as 'system' (reserves 'user' for explicit pause)", () => {
    syncShutdownCleanup(makeDeps());

    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
    const [, , suspendedBy] = markRecordSuspendedMock.mock.calls[0];
    expect(suspendedBy).toBe('system');
  });

  it("clears task.session_id when suspending a running session so SESSION_RESUME's precondition passes on next launch", () => {
    syncShutdownCleanup(makeDeps());

    expect(taskRepoUpdateMock).toHaveBeenCalledTimes(1);
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({
      id: 'task-A',
      session_id: null,
    });
  });

  it("marks queued sessions as exited (no resumable transcript) AND clears task.session_id", () => {
    sessionRecordStatusRef.current = 'queued';

    syncShutdownCleanup(makeDeps({ sessionStatus: 'queued' }));

    // Queued sessions never reached Claude CLI - exited, not suspended
    expect(markRecordExitedMock).toHaveBeenCalledTimes(1);
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();

    // Still clear the stale pointer so the task row doesn't reference a dead PTY
    expect(taskRepoUpdateMock).toHaveBeenCalledTimes(1);
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({
      id: 'task-A',
      session_id: null,
    });
  });
});
