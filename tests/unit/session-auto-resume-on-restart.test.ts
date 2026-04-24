/**
 * Tests for the `agent.autoResumeSessionsOnRestart` shutdown behavior.
 *
 * Default is `true` (sessions auto-resume on next launch). When turned off,
 * `syncShutdownCleanup` marks running sessions as `suspended_by = 'user'` so
 * the existing user-paused-skip in `resumeSuspendedSessions` leaves them as
 * placeholders on the next launch instead of auto-resuming (this is the opt-in
 * fix for the "startup stampede" from issue #21).
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
vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    getLatestForTask = vi.fn(() => ({
      id: 'record-1',
      status: 'running',
    }));
  }
  return { SessionRepository: FakeSessionRepository };
});

import { syncShutdownCleanup } from '../../src/main/shutdown';

function makeDeps(autoResumeOnRestart: boolean, options: { configThrows?: boolean } = {}) {
  const sessionManager = {
    listSessions: vi.fn(() => [
      { taskId: 'task-A', projectId: 'proj-1', status: 'running' },
    ]),
    killAll: vi.fn(),
    dispose: vi.fn(),
  };
  const configManager = {
    load: vi.fn(() => {
      if (options.configThrows) throw new Error('disk error');
      return { agent: { autoResumeSessionsOnRestart: autoResumeOnRestart } };
    }),
  };
  return {
    getSessionManager: () => sessionManager as never,
    getBoardConfigManager: () => ({ detach: vi.fn() }) as never,
    getCommandInjector: () => ({ cancelAll: vi.fn() }) as never,
    getConfigManager: () => configManager as never,
    getCurrentProjectId: () => null,
    deleteProjectFromIndex: vi.fn(),
    stopUpdaterTimers: vi.fn(),
    clearPendingTimers: vi.fn(),
    isEphemeral: false,
  };
}

describe('syncShutdownCleanup: autoResumeSessionsOnRestart setting', () => {
  beforeEach(() => {
    markRecordSuspendedMock.mockClear();
    markRecordExitedMock.mockClear();
  });

  it("marks running sessions as 'system' when auto-resume is on (default)", () => {
    syncShutdownCleanup(makeDeps(true));

    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
    const [, , suspendedBy] = markRecordSuspendedMock.mock.calls[0];
    expect(suspendedBy).toBe('system');
  });

  it("marks running sessions as 'user' when auto-resume is off", () => {
    syncShutdownCleanup(makeDeps(false));

    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
    const [, , suspendedBy] = markRecordSuspendedMock.mock.calls[0];
    expect(suspendedBy).toBe('user');
  });

  it("falls back to 'system' (safe default) if configManager.load throws", () => {
    syncShutdownCleanup(makeDeps(true, { configThrows: true }));

    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
    const [, , suspendedBy] = markRecordSuspendedMock.mock.calls[0];
    expect(suspendedBy).toBe('system');
  });
});
