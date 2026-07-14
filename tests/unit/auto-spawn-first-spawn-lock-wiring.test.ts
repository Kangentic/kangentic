/**
 * Wiring tests for the startup auto-spawn reconcile
 * (src/main/transition-engine/session-startup/auto-spawn.ts).
 *
 * autoSpawnTasks routes every spawn through prepareAgentSpawn, which runs the
 * shared spawn preamble (the first-spawn Advanced-override lock + agent
 * resolution). The preamble needs two inputs only this caller can supply:
 * a live TaskRepository handle (`tasks`) and the first-ever-spawn signal
 * (`hasSessionRecord`, derived from the session repository - a task can sit
 * in an auto_spawn lane with no LIVE session yet still have session HISTORY,
 * e.g. after a crash, and must not be treated as a first spawn).
 *
 * The type system forces the parameters to exist; what it cannot express is
 * that `hasSessionRecord` is derived from the right query. These thin tests
 * pin that derivation. prepareAgentSpawn itself is mocked (returning a skip
 * signal to short-circuit the spawn pass); its lock behavior is covered by
 * prepare-spawn-first-spawn-lock.test.ts.
 *
 * Red-green: on the pre-wiring caller (no tasks / hasSessionRecord args),
 * both assertions fail (undefined instead of the repo / boolean).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrepareAgentSpawn = vi.fn(async () => ({ ok: false as const, reason: 'cli-not-found' as const }));
const mockTaskList = vi.fn();
const mockTaskUpdate = vi.fn();
const mockGetLatestForTask = vi.fn();
const mockGetUserPausedTaskIds = vi.fn(() => new Set<string>());
const mockSwimlaneList = vi.fn();

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = (...args: unknown[]) => mockTaskList(...args);
    update = (...args: unknown[]) => mockTaskUpdate(...args);
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = (...args: unknown[]) => mockGetLatestForTask(...args);
    getUserPausedTaskIds = (...args: unknown[]) => mockGetUserPausedTaskIds(...args);
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

const TASK_ID = 'task-auto-spawn-001';
const LANE_ID = 'lane-executing';

function makeSessionManager() {
  return {
    hasSessionForTask: vi.fn(() => false),
    getShell: vi.fn(async () => 'powershell'),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(),
  };
}

function makeConfigManager() {
  return {
    getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits', cliPaths: {} } })),
  };
}

async function runAutoSpawn() {
  await autoSpawnTasks(
    'proj-123',
    '/mock/project',
    makeSessionManager() as never,
    makeConfigManager() as never,
    'claude',
    null,
    'claude-opus-4-8',
    'xhigh',
  );
}

type PreparedSpawnInput = {
  task: { id: string };
  hasSessionRecord: boolean;
  tasks: { update: (input: unknown) => void };
};

describe('autoSpawnTasks first-spawn lock wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([
      { id: LANE_ID, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LANE_ID, worktree_path: null, branch_name: null },
    ]);
    mockGetUserPausedTaskIds.mockReturnValue(new Set());
  });

  it('passes hasSessionRecord: false and the live task repository for a never-spawned task', async () => {
    mockGetLatestForTask.mockReturnValue(undefined);

    await runAutoSpawn();

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    const prepareInput = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as PreparedSpawnInput;
    expect(prepareInput.task).toMatchObject({ id: TASK_ID });
    expect(prepareInput.hasSessionRecord).toBe(false);
    expect(mockGetLatestForTask).toHaveBeenCalledWith(TASK_ID);
    // The tasks handle is the REAL repository instance, so a lock inside the
    // preamble actually persists.
    prepareInput.tasks.update({ id: TASK_ID, agent_override: 'codex' });
    expect(mockTaskUpdate).toHaveBeenCalledWith({ id: TASK_ID, agent_override: 'codex' });
  });

  it('passes hasSessionRecord: true when the task has session history (crash recovery shape)', async () => {
    mockGetLatestForTask.mockReturnValue({ id: 'rec-1', task_id: TASK_ID, status: 'exited' });

    await runAutoSpawn();

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    const prepareInput = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as PreparedSpawnInput;
    expect(prepareInput.hasSessionRecord).toBe(true);
  });
});
