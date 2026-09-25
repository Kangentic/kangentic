/**
 * Wiring tests for the startup-failure notice inside the PTY `exit` listener
 * (registerSessionHandlers, src/main/ipc/handlers/sessions.ts).
 *
 * A CLI that ends on its own moments after starting, with its own account of
 * why, used to leave nothing but a dead session row: no toast, no label, a
 * card that went quiet (#682 follow-up; the case is Claude's `--resume` of a
 * conversation whose transcript is gone). The listener now asks the session's
 * adapter to read the CLI's final output (`describeStartupFailure`) and routes
 * a sentence through `notifySpawnBlocked`'s existing "Agent did not start"
 * notice. These pin the gates: only a NON-intentional exit, only a task session
 * (never a Command Terminal), only when the adapter names a failure, and the
 * notice carries the adapter's sentence.
 *
 * Harness modeled on session-exit-git-churn-wiring.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => ({
  describeStartupFailure: vi.fn((): string | null => null),
  notifySpawnBlocked: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: vi.fn(() => undefined), run: vi.fn() })) })),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => null);
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

const mockTaskRepoGetById = vi.fn((): { id: string; title: string } | null => ({ id: 'task-1', title: 'Resume me' }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskRepoGetById;
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(() => true),
  markRecordSuspended: vi.fn(() => true),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => false,
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
}));
vi.mock('../../src/main/agent/shared', () => ({ interpolateTemplate: vi.fn((t: string) => t) }));
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => false) } }));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((name: string) => (name === 'claude'
      ? { describeStartupFailure: (...args: unknown[]) => hoisted.describeStartupFailure(...args) }
      : name === 'bare'
        ? {}
        : undefined)),
    list: vi.fn(() => ['claude', 'bare']),
  },
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: vi.fn(() => null), update: vi.fn() },
    swimlanes: { getById: vi.fn(() => null) },
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { add: vi.fn(), listForTask: vi.fn(() => []) },
  })),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({
    executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
    resumeSuspendedSession: vi.fn(async () => {}),
  })),
  resolveSpawnOverrides: vi.fn(() => ({})),
  notifySpawnBlocked: (...args: unknown[]) => hoisted.notifySpawnBlocked(...args),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => {}),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';

const CLI_OUTPUT = 'No conversation found with session ID: 2451ea6b-0035-47a3-bf0c-d2371074312c\r\n';
const NOTICE = 'Claude Code found no conversation to resume (session 2451ea6b).';

interface ExitFixture {
  session?: { id: string; taskId: string; transient?: boolean };
  agentName?: string;
  intentional?: boolean;
  exitCode?: number;
}

function fireExit(fixture: ExitFixture = {}) {
  const session = fixture.session ?? { id: 'pty-1', taskId: 'task-1' };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getSession: vi.fn(() => session),
      getSessionTaskId: vi.fn(() => session.taskId),
      getSessionProjectId: vi.fn(() => 'proj-test'),
      getSessionAgentName: vi.fn(() => fixture.agentName ?? 'claude'),
      getRawScrollback: vi.fn(() => CLI_OUTPUT),
      getUsageCache: vi.fn(() => ({})),
      getToolCallCount: vi.fn(() => 0),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude', path: '/mock/project' })) },
  };
  registerSessionHandlers(context as never);
  const exitHandler = capturedSessionEventHandlers.get('exit');
  if (!exitHandler) throw new Error('exit handler was not registered');
  exitHandler('pty-1', fixture.exitCode ?? 1, fixture.intentional);
  return context;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSessionEventHandlers.clear();
  hoisted.describeStartupFailure.mockReturnValue(NOTICE);
  mockTaskRepoGetById.mockReturnValue({ id: 'task-1', title: 'Resume me' });
});

describe('PTY exit listener: startup-failure notice', () => {
  it('asks the adapter about the CLI output and raises the "Agent did not start" notice with its sentence', () => {
    fireExit({ exitCode: 1 });

    expect(hoisted.describeStartupFailure).toHaveBeenCalledWith(CLI_OUTPUT, 1);
    expect(hoisted.notifySpawnBlocked).toHaveBeenCalledTimes(1);
    const [, task, step, error, projectId] = hoisted.notifySpawnBlocked.mock.calls[0] as [unknown, { id: string }, string, Error, string];
    expect(task.id).toBe('task-1');
    expect(step).toBe('agent');
    expect(error.message).toBe(NOTICE);
    expect(projectId).toBe('proj-test');
  });

  it('never raises it for an intentional exit (a kill or a suspend carries no failure)', () => {
    fireExit({ intentional: true });

    expect(hoisted.describeStartupFailure).not.toHaveBeenCalled();
    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('raises it from the agent-absence sweep, which is the route a CLI under a surviving shell takes', () => {
    // The CLI normally runs under a shell that outlives it, so its own exit
    // never reaches the PTY; the sweep retires the session through kill(),
    // whose exit is INTENTIONAL and would be skipped above. The sweep
    // therefore announces the absence first, and that is where the notice
    // comes from in practice.
    const context = fireExit({ intentional: true });
    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
    const absentHandler = capturedSessionEventHandlers.get('agent-absent');
    if (!absentHandler) throw new Error('agent-absent handler was not registered');

    absentHandler('pty-1', { id: 'pty-1', taskId: 'task-1', transient: false });

    expect(context.sessionManager.getRawScrollback).toHaveBeenCalledWith('pty-1');
    // The sweep forces exit code 0; the recognizer reads the wording.
    expect(hoisted.describeStartupFailure).toHaveBeenCalledWith(CLI_OUTPUT, 0);
    expect(hoisted.notifySpawnBlocked).toHaveBeenCalledTimes(1);
    const [, task, step, error] = hoisted.notifySpawnBlocked.mock.calls[0] as [unknown, { id: string }, string, Error];
    expect(task.id).toBe('task-1');
    expect(step).toBe('agent');
    expect(error.message).toBe(NOTICE);
  });

  it('the sweep route also skips a Command Terminal', () => {
    fireExit({ intentional: true });
    const absentHandler = capturedSessionEventHandlers.get('agent-absent');
    if (!absentHandler) throw new Error('agent-absent handler was not registered');

    absentHandler('pty-1', { id: 'pty-1', taskId: 'transient-task', transient: true });

    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('never raises it for a Command Terminal, which has no task to notify about', () => {
    fireExit({ session: { id: 'pty-1', taskId: 'transient-task', transient: true } });

    expect(hoisted.describeStartupFailure).not.toHaveBeenCalled();
    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('stays silent when the adapter names no failure (a normal end, or a crash it cannot read)', () => {
    hoisted.describeStartupFailure.mockReturnValue(null);

    fireExit({ exitCode: 0 });

    expect(hoisted.describeStartupFailure).toHaveBeenCalledWith(CLI_OUTPUT, 0);
    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('stays silent for an adapter that does not implement the capability', () => {
    fireExit({ agentName: 'bare' });

    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });

  it('stays silent when the task no longer exists', () => {
    mockTaskRepoGetById.mockReturnValue(null);

    fireExit();

    expect(hoisted.notifySpawnBlocked).not.toHaveBeenCalled();
  });
});
