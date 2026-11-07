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
const settleQueuedRecordMock = vi.fn(() => true);
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: (...args: unknown[]) => markRecordSuspendedMock(...args),
  markRecordExited: (...args: unknown[]) => markRecordExitedMock(...args),
  settleQueuedRecord: (...args: unknown[]) => settleQueuedRecordMock(...args),
}));

// Partial SessionRecord shape: shutdown.ts only reads `id` and `status` on the
// findByAnyId return. If shutdown.ts starts inspecting more fields, this
// mock will naturally fail fast.
//
// The returned record status is driven by the module-level
// `sessionRecordStatusRef` so tests can pick 'running' vs 'queued' per case.
const sessionRecordStatusRef = { current: 'running' as 'running' | 'queued' };
// Where the record's agent ran: null for this computer, or the stored target of an SSH host (#913).
const sessionRecordTargetRef = { current: null as string | null };
const updateMetricsMock = vi.fn();
vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    findByAnyId = vi.fn(() => ({
      id: 'record-1',
      status: sessionRecordStatusRef.current,
      cli_target: sessionRecordTargetRef.current,
    }));
    updateMetrics = (...args: unknown[]) => updateMetricsMock(...args);
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
    killAll: vi.fn(() => [] as number[]),
    dispose: vi.fn(),
    getUsageCache: () => ({}),
    getToolCallCount: () => 4,
    getToolBreakdown: () => [],
    getCompactionCount: () => 0,
  };
  return {
    getSessionManager: () => sessionManager as never,
    getBoardConfigManager: () => ({ detach: vi.fn() }) as never,
    getDiffWatcher: () => ({ closeAll: vi.fn() }) as never,
    getTerminalSubmitScheduler: () => ({ cancelAll: vi.fn() }) as never,
    getCurrentProjectId: () => null,
    deleteProjectFromIndex: vi.fn(),
    stopUpdaterTimers: vi.fn(),
    stopAnnouncementTimers: vi.fn(),
    clearPendingTimers: vi.fn(),
    isEphemeral: false,
    isRestartRequested: () => false,
    allowGrace: false,
  };
}

describe('syncShutdownCleanup: session + task bookkeeping', () => {
  beforeEach(() => {
    markRecordSuspendedMock.mockClear();
    markRecordExitedMock.mockClear();
    settleQueuedRecordMock.mockClear();
    taskRepoUpdateMock.mockClear();
    updateMetricsMock.mockClear();
    sessionRecordStatusRef.current = 'running';
    sessionRecordTargetRef.current = null;
  });

  // A quit leaves an agent on a host running (#913). Its record stays `running` and its task keeps pointing at it,
  // so the next launch can ask the host and take the agent back. Suspended here, that launch would resume a second
  // agent beside the live one.
  it('leaves the record of an agent on a remote host running, and the task still pointing at it', () => {
    sessionRecordTargetRef.current = JSON.stringify({ kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'zsh', roots: [] });

    syncShutdownCleanup(makeDeps());

    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    expect(taskRepoUpdateMock).not.toHaveBeenCalled();
  });

  // What the session measured up to the quit is on this computer only, and the telemetry that held it ends with it.
  it('saves what a remote session measured before leaving it running', () => {
    sessionRecordTargetRef.current = JSON.stringify({ kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'zsh', roots: [] });

    syncShutdownCleanup(makeDeps());

    expect(updateMetricsMock).toHaveBeenCalledTimes(1);
    expect(updateMetricsMock).toHaveBeenCalledWith('record-1', expect.objectContaining({ toolCallCount: 4 }));
  });

  it('still suspends the record of an agent that ran on a distro of this computer', () => {
    sessionRecordTargetRef.current = JSON.stringify({ kind: 'wsl', distro: 'Ubuntu' });

    syncShutdownCleanup(makeDeps());

    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
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

  it("settles a queued session by what it was (session-lifecycle pins the outcome) AND clears task.session_id", () => {
    sessionRecordStatusRef.current = 'queued';

    syncShutdownCleanup(makeDeps({ sessionStatus: 'queued' }));

    expect(settleQueuedRecordMock).toHaveBeenCalledTimes(1);
    expect(settleQueuedRecordMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'record-1' }), undefined, 'system');
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();

    // Still clear the stale pointer so the task row doesn't reference a dead PTY
    expect(taskRepoUpdateMock).toHaveBeenCalledTimes(1);
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({
      id: 'task-A',
      session_id: null,
    });
  });
});
