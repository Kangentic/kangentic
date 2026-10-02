/**
 * Startup auto-spawn scoped to the tasks a pty host loss took down.
 *
 * When the host dies mid-run, the recovery resumes every lost session it can
 * and then calls `autoSpawnTasks` with `onlyTaskIds` for the rest, the way a
 * startup runs resume and then auto-spawn. Two things make the scoped pass
 * different from a startup one. It must not touch a task outside the set: an
 * unscoped pass would also restart a task whose agent exited earlier this run.
 * And the lost row is still in the registry, exited, so `hasSessionForTask`
 * would report every lost task as covered and nothing would ever restart.
 *
 * Red-green: drop the `onlyTaskIds.has` filter and the first test fails; use
 * `hasSessionForTask` in scoped mode and the second fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrepareAgentSpawn = vi.fn(async () => ({ ok: false as const, reason: 'cli-not-found' as const }));
const mockTaskList = vi.fn();
/** The task row as the database holds it now; unset, the row discovery listed. */
const mockTaskGetById = vi.fn((_id: string): unknown => undefined);
const mockSwimlaneList = vi.fn();

vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    // The spawn pass re-reads its task under the task lock: answer with what the
    // discovery pass was handed.
    listed = new Map<string, unknown>();
    list = (...args: unknown[]) => {
      const rows = (mockTaskList(...args) ?? []) as Array<{ id: string }>;
      for (const row of rows) this.listed.set(row.id, row);
      return rows;
    };
    getById = (id: string) => mockTaskGetById(id) ?? this.listed.get(id);
    update = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => undefined);
    getUserPausedTaskIds = () => new Set<string>();
    insert = vi.fn();
    updateAppliedSettings = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = (...args: unknown[]) => mockSwimlaneList(...args);
  },
}));

vi.mock('../../src/main/pty/session-manager', () => ({ SessionManager: class {} }));
vi.mock('../../src/main/config/config-manager', () => ({ ConfigManager: class {} }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));
vi.mock('../../src/main/transition-engine/session-startup/timing', () => ({
  startStartupTimer: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: (...args: unknown[]) => mockPrepareAgentSpawn(...(args as [never])),
}));

import { autoSpawnTasks } from '../../src/main/transition-engine/session-startup/auto-spawn';

const ACTIVE_LANE = 'lane-active';

interface RegistryRow {
  id: string;
  taskId: string;
  status: string;
}

function activeLane() {
  return {
    id: ACTIVE_LANE,
    name: ACTIVE_LANE,
    role: null,
    auto_spawn: true,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    auto_command: null,
    handoff_context: false,
    plan_exit_target_id: null,
  };
}

function task(id: string) {
  return { id, swimlane_id: ACTIVE_LANE, profile_id: null, worktree_path: null };
}

async function runScopedAutoSpawn(registry: RegistryRow[], onlyTaskIds: ReadonlySet<string>) {
  const sessionManager = {
    // Any row counts here, exited or not, which is why scoped mode cannot use it.
    hasSessionForTask: vi.fn((taskId: string) => registry.some((row) => row.taskId === taskId)),
    listSessions: vi.fn(() => registry),
    getShell: vi.fn(async () => 'powershell'),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async (input: { id: string }) => ({ id: input.id })),
  };
  await autoSpawnTasks(
    'proj-1',
    '/mock/project',
    sessionManager as never,
    { getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits', cliPaths: {} } })) } as never,
    'claude',
    null,
    null,
    null,
    [],
    onlyTaskIds,
  );
  return sessionManager;
}

function preparedTaskIds(): string[] {
  return mockPrepareAgentSpawn.mock.calls.map((call) => (call[0] as unknown as { task: { id: string } }).task.id);
}

describe('autoSpawnTasks: onlyTaskIds scopes the pass to the lost tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([activeLane()]);
  });

  it('leaves a task outside the set alone, even with no session at all', async () => {
    mockTaskList.mockReturnValue([task('task-lost'), task('task-exited-earlier')]);

    await runScopedAutoSpawn([{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }], new Set(['task-lost']));

    expect(preparedTaskIds()).toEqual(['task-lost']);
  });

  it('restarts a lost task whose only row is the exited one the loss left behind', async () => {
    mockTaskList.mockReturnValue([task('task-lost')]);

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost']);
    expect(sessionManager.hasSessionForTask).not.toHaveBeenCalled();
  });

  it('skips a lost task the resume already took back, or left a paused placeholder for', async () => {
    mockTaskList.mockReturnValue([task('task-resumed'), task('task-paused'), task('task-lost')]);

    await runScopedAutoSpawn(
      [
        { id: 'session-resumed', taskId: 'task-resumed', status: 'running' },
        { id: 'session-paused', taskId: 'task-paused', status: 'suspended' },
        { id: 'session-lost', taskId: 'task-lost', status: 'exited' },
      ],
      new Set(['task-resumed', 'task-paused', 'task-lost']),
    );

    expect(preparedTaskIds()).toEqual(['task-lost']);
  });

  it('does nothing for an empty set, not even a lane scan', async () => {
    await runScopedAutoSpawn([], new Set());

    expect(mockSwimlaneList).not.toHaveBeenCalled();
    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
  });
});

/** What a successful `prepareAgentSpawn` hands the spawn pass. */
function preparedSpawn(taskId: string) {
  return {
    ok: true as const,
    data: {
      sessionRecordId: `session-new-${taskId}`,
      command: 'claude',
      cwd: '/mock/project',
      extraEnv: null,
      statusOutputPath: '/mock/status.json',
      eventsOutputPath: '/mock/events.jsonl',
      adapter: { name: 'claude', sessionType: 'claude_agent' },
      agentSessionId: 'agent-1',
      agent: 'claude',
      permissionMode: 'acceptEdits',
      appliedModel: null,
      appliedEffort: null,
    },
  };
}

/**
 * The preparation awaits the shell and the agent's detection, seconds on a
 * real machine, and the user can act on the task meanwhile. The spawn re-reads
 * the task under its lifecycle lock and leaves one a user action took over.
 *
 * Red-green: drop the re-check in the spawn pass and the last two fail.
 */
describe('autoSpawnTasks: the spawn re-checks its task under the task lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskGetById.mockReset();
    mockTaskGetById.mockImplementation(() => undefined);
    mockSwimlaneList.mockReturnValue([activeLane()]);
    mockTaskList.mockReturnValue([task('task-lost')]);
  });

  it('spawns the lost task when nothing took it over during the preparation', async () => {
    mockPrepareAgentSpawn.mockImplementationOnce(async () => preparedSpawn('task-lost') as never);

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
    );

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn over a session the user started while the agent was being prepared', async () => {
    const registry: RegistryRow[] = [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }];
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      registry.push({ id: 'session-user', taskId: 'task-lost', status: 'running' });
      return preparedSpawn('task-lost') as never;
    });

    const sessionManager = await runScopedAutoSpawn(registry, new Set(['task-lost']));

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('does not spawn a task moved to another column while the agent was being prepared', async () => {
    mockPrepareAgentSpawn.mockImplementationOnce(async () => {
      mockTaskGetById.mockImplementation((id) => (id === 'task-lost' ? { ...task('task-lost'), swimlane_id: 'lane-todo' } : undefined));
      return preparedSpawn('task-lost') as never;
    });

    const sessionManager = await runScopedAutoSpawn(
      [{ id: 'session-lost', taskId: 'task-lost', status: 'exited' }],
      new Set(['task-lost']),
    );

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });
});
