/**
 * Tests for the `branch-pushed` listener in registerSessionHandlers.
 *
 * When an agent's own `git push` finishes, SessionManager emits `branch-pushed`
 * with the destination branch its command named. The listener records it on
 * the session's task through `recordPushedBranchForSession`: the per-task PR
 * anchor for a task with no worktree. It must NOT resolve the PR from here
 * (the push precedes the PR, and a non-force resolve would burn the 60s
 * per-task throttle the `pr-candidate` seconds later needs), and it must skip
 * transient (Command Terminal) sessions, which have no task row.
 *
 * Mock strategy mirrors session-idle-pr-link.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { linkPR, autoLinkPRForTask, recordPushedBranchForSession } from '../../src/main/pr/pr-linking';

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false }) as { transient: boolean } | undefined),
      getSessionTaskId: vi.fn(() => 'task-1' as string | null | undefined),
      getSessionProjectId: vi.fn(() => 'proj-1' as string | null | undefined),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

function fireBranchPushed(sessionId: string, branch: string): void {
  const handler = capturedSessionEventHandlers.get('branch-pushed');
  if (!handler) throw new Error('branch-pushed handler was not registered');
  handler(sessionId, branch);
}

describe('branch-pushed records the pushed branch on the task', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  it('records through recordPushedBranchForSession for a real, non-transient session', async () => {
    fireBranchPushed('sess-1', 'feature/x');
    await Promise.resolve();

    expect(recordPushedBranchForSession).toHaveBeenCalledTimes(1);
    expect(recordPushedBranchForSession).toHaveBeenCalledWith(context, 'sess-1', 'feature/x');
  });

  it('never resolves the PR from the push itself', async () => {
    fireBranchPushed('sess-1', 'feature/x');
    await Promise.resolve();

    expect(linkPR).not.toHaveBeenCalled();
    expect(autoLinkPRForTask).not.toHaveBeenCalled();
  });

  it('skips a transient (Command Terminal) session', async () => {
    context.sessionManager.getSession.mockReturnValue({ transient: true });

    fireBranchPushed('sess-transient', 'feature/x');
    await Promise.resolve();

    expect(recordPushedBranchForSession).not.toHaveBeenCalled();
  });

  it('skips a session the manager no longer knows', async () => {
    context.sessionManager.getSession.mockReturnValue(undefined);

    fireBranchPushed('sess-gone', 'feature/x');
    await Promise.resolve();

    expect(recordPushedBranchForSession).not.toHaveBeenCalled();
  });

  it('the pr-candidate listener resolves with the throttle bypassed, but never forced', () => {
    // The strongest link signal there is, and it routinely lands inside the
    // 60s window an idle resolve stamped after the push. `force` would also
    // skip the terminal-state guard, which a `gh pr view` on a merged PR must
    // not do.
    const handler = capturedSessionEventHandlers.get('pr-candidate');
    if (!handler) throw new Error('pr-candidate handler was not registered');

    handler('sess-1', 'scrollback bytes');

    expect(linkPR).toHaveBeenCalledTimes(1);
    expect(linkPR).toHaveBeenCalledWith(context, expect.objectContaining({
      sessionId: 'sess-1', scrollback: 'scrollback bytes', bypassThrottle: true,
    }));
    expect(linkPR).toHaveBeenCalledWith(context, expect.not.objectContaining({ force: true }));
  });

  it('a rejected record never throws out of the listener', async () => {
    vi.mocked(recordPushedBranchForSession).mockRejectedValueOnce(new Error('db closed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => fireBranchPushed('sess-1', 'feature/x')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
