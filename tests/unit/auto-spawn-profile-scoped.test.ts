/**
 * Startup auto-spawn honors a task's Board Profile, not just its column.
 *
 * `auto_spawn` is one of the ten profile-scoped strategy fields, so the startup
 * reconcile cannot decide "which columns spawn" from the swimlane rows alone.
 * It used to: a lane-level `activeLanes` pre-filter ran before any task was in
 * hand, so a profile that flipped auto_spawn was silently ignored at startup
 * while every board-driven path honored it. That asymmetry is the bug class this
 * file pins - a task behaves one way when dragged and another way after a
 * restart.
 *
 * Red-green: restore the `allLanes.filter((lane) => lane.auto_spawn)` pre-filter
 * and both direction tests below fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrepareAgentSpawn = vi.fn(async () => ({ ok: false as const, reason: 'cli-not-found' as const }));
const mockTaskList = vi.fn();
const mockGetLatestForTask = vi.fn(() => undefined);
const mockGetUserPausedTaskIds = vi.fn(() => new Set<string>());
const mockSwimlaneList = vi.fn();

vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = (...args: unknown[]) => mockTaskList(...args);
    update = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = (...args: unknown[]) => mockGetLatestForTask(...(args as []));
    getUserPausedTaskIds = () => mockGetUserPausedTaskIds();
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
import type { BoardProfile } from '../../src/shared/types';

const TASK_ID = 'task-001';
const QUIET_LANE = 'lane-quiet';
const LOUD_LANE = 'lane-loud';

function lane(id: string, autoSpawn: boolean) {
  return {
    id,
    name: id,
    auto_spawn: autoSpawn,
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

async function runAutoSpawn(boardProfiles?: BoardProfile[]) {
  await autoSpawnTasks(
    'proj-1',
    '/mock/project',
    {
      hasSessionForTask: vi.fn(() => false),
      getShell: vi.fn(async () => 'powershell'),
      registerSuspendedPlaceholder: vi.fn(),
      spawn: vi.fn(),
    } as never,
    { getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits', cliPaths: {} } })) } as never,
    'claude',
    null,
    null,
    null,
    boardProfiles,
  );
}

describe('autoSpawnTasks: auto_spawn is resolved per task, not per lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestForTask.mockReturnValue(undefined);
    mockGetUserPausedTaskIds.mockReturnValue(new Set());
  });

  it('spawns a profiled task in a column whose OWN auto_spawn is off', async () => {
    mockSwimlaneList.mockReturnValue([lane(QUIET_LANE, false)]);
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: QUIET_LANE, profile_id: 'p1', worktree_path: null },
    ]);

    await runAutoSpawn([
      { id: 'p1', name: 'Eager', columns: { [QUIET_LANE]: { autoSpawn: true } } },
    ]);

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
  });

  it('skips a profiled task whose profile turns auto_spawn OFF for an otherwise-active column', async () => {
    mockSwimlaneList.mockReturnValue([lane(LOUD_LANE, true)]);
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LOUD_LANE, profile_id: 'p1', worktree_path: null },
    ]);

    await runAutoSpawn([
      { id: 'p1', name: 'Manual', columns: { [LOUD_LANE]: { autoSpawn: false } } },
    ]);

    expect(mockPrepareAgentSpawn).not.toHaveBeenCalled();
  });

  it('leaves an unprofiled task on its column\'s own flag, in both directions', async () => {
    mockSwimlaneList.mockReturnValue([lane(LOUD_LANE, true), lane(QUIET_LANE, false)]);
    mockTaskList.mockImplementation((laneId: string) => (laneId === LOUD_LANE
      ? [{ id: 'task-loud', swimlane_id: LOUD_LANE, profile_id: null, worktree_path: null }]
      : [{ id: 'task-quiet', swimlane_id: QUIET_LANE, profile_id: null, worktree_path: null }]));

    await runAutoSpawn([]);

    expect(mockPrepareAgentSpawn).toHaveBeenCalledTimes(1);
    const input = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as { task: { id: string } };
    expect(input.task.id).toBe('task-loud');
  });

  it('hands prepareAgentSpawn the FOLDED lane, so profile-scoped session_target is honored', async () => {
    mockSwimlaneList.mockReturnValue([lane(LOUD_LANE, true)]);
    mockTaskList.mockReturnValue([
      { id: TASK_ID, swimlane_id: LOUD_LANE, profile_id: 'p1', worktree_path: null },
    ]);

    await runAutoSpawn([
      { id: 'p1', name: 'Isolated', columns: { [LOUD_LANE]: { sessionTarget: 'isolated' } } },
    ]);

    const input = mockPrepareAgentSpawn.mock.calls[0][0] as unknown as {
      swimlane: { session_target: string };
    };
    expect(input.swimlane.session_target).toBe('isolated');
  });

  it('does not scan extra lanes when the board has no profiles', async () => {
    mockSwimlaneList.mockReturnValue([lane(LOUD_LANE, true), lane(QUIET_LANE, false)]);
    mockTaskList.mockReturnValue([]);

    await runAutoSpawn();

    // The quiet lane is never listed: with nothing able to flip its flag, the
    // pre-profile cost is preserved rather than paying a full-board task scan.
    expect(mockTaskList).toHaveBeenCalledTimes(1);
    expect(mockTaskList).toHaveBeenCalledWith(LOUD_LANE);
  });
});
