/**
 * Board Profiles at startup RECOVERY (resumeSuspendedSessions), distinct from
 * auto-spawn-profile-scoped.test.ts which covers the same contract for FRESH
 * spawns (autoSpawnTasks). Both functions gained their own `laneForTask`
 * profile-fold, so both need their own regression lock - a fix to one does
 * not imply the other stayed correct, and historically (auto_command) a
 * profile-scoped behavior shipped correct on one spawn path and silently
 * missing on the other.
 *
 * Feature intent (see resume-suspended.ts step 4 comment):
 *   `auto_spawn` is resolved PER TASK via its folded lane, not per raw
 *   column, because auto_spawn is one of the ten profile-scoped strategy
 *   fields. A lane-keyed exclusion set built before any task is in hand
 *   (the pre-profile design) cannot see a profile that flips the flag.
 *
 * Also locks the preserved "lane missing means not excluded" semantics
 * (`resolvedLane &&` before the auto_spawn check): the pre-profile lane-keyed
 * exclusion set could only ever contain lanes that EXIST, so a task whose
 * column was deleted was never excluded from recovery. Folding a profile over
 * `laneMap.get(task.swimlane_id)` must preserve that - a missing base lane has
 * nothing to fold onto and must resolve to "undefined lane", not "excluded".
 *
 * Red-green: reverting resume-suspended.ts's `laneForTask` back to
 * `laneMap.get(task.swimlane_id)` (module-scope, ignoring profiles) makes the
 * two profile-scoped tests below fail.
 *
 * Harness mirrors session-recovery-isolation.test.ts (mock set + helpers) to
 * keep resume-suspended.ts's test patterns consistent; column-strategy.ts and
 * session-isolation.ts are left UNMOCKED so the real profile fold runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BoardProfile, SessionRecord, Task } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Module-level mock fns shared across all Fake*Repository instances.
// Reconfigured per-test in beforeEach.
// ---------------------------------------------------------------------------

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoMarkAllRunningAsOrphaned = vi.fn();
const sessionRepoMarkRunningAsOrphanedExcluding = vi.fn();

const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();

// ---------------------------------------------------------------------------
// Hoisted mocks: must appear before any import that loads the module under test.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({}) as never),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

const markRecordSuspendedMock = vi.fn(() => true);
const retireRecordMock = vi.fn(() => true);
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: (...args: unknown[]) => markRecordSuspendedMock(...args),
  retireRecord: (...args: unknown[]) => retireRecordMock(...args),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    getResumable = () => sessionRepoGetResumable();
    getOrphaned = () => sessionRepoGetOrphaned();
    getInterruptedExited = () => [] as SessionRecord[];
    markAllRunningAsOrphaned = () => sessionRepoMarkAllRunningAsOrphaned();
    markRunningAsOrphanedExcluding = (...args: unknown[]) =>
      sessionRepoMarkRunningAsOrphanedExcluding(...args);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
    getLatestForTask = vi.fn(() => undefined);
    getUserPausedTaskIds = vi.fn(() => new Set<string>());
    insert = vi.fn();
    updateAppliedSettings = vi.fn();
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = () => taskRepoList();
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
    getById = vi.fn(() => null);
  }
  return { TaskRepository: FakeTaskRepository };
});

const swimlaneListMock = vi.fn(() => [] as unknown[]);
vi.mock('../../src/main/db/repositories/swimlane-repository', () => {
  class FakeSwimlaneRepository {
    list = () => swimlaneListMock();
  }
  return { SwimlaneRepository: FakeSwimlaneRepository };
});

vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-intent', () => ({
  isResumeEligible: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered.
// ---------------------------------------------------------------------------

import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TASK_ID = 'task-001';
const QUIET_LANE = 'lane-quiet';
const LOUD_LANE = 'lane-loud';

/** A full LaneStrategyFields-shaped lane, matching auto-spawn-profile-scoped.test.ts's helper. */
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

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'record-1',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: null,
    command: 'claude --session-id new-agent-uuid',
    cwd: '/project/cwd',
    permission_mode: 'default',
    prompt: null,
    status: 'suspended',
    exit_code: null,
    started_at: '2026-01-01T10:00:00.000Z',
    suspended_at: '2026-01-01T11:00:00.000Z',
    exited_at: null,
    suspended_by: 'system',
    total_cost_usd: null,
    total_input_tokens: null,
    total_output_tokens: null,
    model_id: null,
    model_display_name: null,
    total_duration_ms: null,
    tool_call_count: null,
    lines_added: null,
    lines_removed: null,
    files_changed: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'Test task',
    description: '',
    swimlane_id: LOUD_LANE,
    position: 0,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    auto_command: null,
    profile_id: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-01-01T10:00:00.000Z',
    updated_at: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async () => ({ id: 'new-pty-session-1' })),
    getShell: vi.fn(async () => '/bin/sh'),
    hasSessionForTask: vi.fn(() => false),
  };
}

function makeConfigManager(autoResumeSessionsOnRestart = true) {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

async function runResume(boardProfiles?: BoardProfile[]) {
  await resumeSuspendedSessions(
    'proj-1',
    '/project',
    makeSessionManager() as never,
    makeConfigManager(true) as never,
    'claude',
    null,
    null,
    null,
    boardProfiles,
  );
}

describe('resumeSuspendedSessions: auto_spawn is resolved per task, not per lane', () => {
  beforeEach(() => {
    markRecordSuspendedMock.mockClear();
    markRecordSuspendedMock.mockReturnValue(true);
    retireRecordMock.mockClear();
    sessionRepoGetResumable.mockClear();
    sessionRepoGetResumable.mockReturnValue([]);
    sessionRepoGetOrphaned.mockClear();
    sessionRepoGetOrphaned.mockReturnValue([]);
    sessionRepoMarkAllRunningAsOrphaned.mockClear();
    sessionRepoMarkRunningAsOrphanedExcluding.mockClear();
    taskRepoList.mockClear();
    taskRepoList.mockReturnValue([]);
    taskRepoUpdateMock.mockClear();
    vi.mocked(prepareAgentSpawn).mockClear();
    vi.mocked(prepareAgentSpawn).mockResolvedValue({ ok: false, reason: 'unknown-agent' });
    swimlaneListMock.mockReturnValue([lane(LOUD_LANE, true)]);
  });

  it('recovers a profiled task whose column has auto_spawn OFF but the profile turns it ON', async () => {
    swimlaneListMock.mockReturnValue([lane(QUIET_LANE, false)]);
    sessionRepoGetResumable.mockReturnValue([makeRecord({ isolated_swimlane_id: null })]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: QUIET_LANE, profile_id: 'p1' })]);

    await runResume([{ id: 'p1', name: 'Eager', columns: { [QUIET_LANE]: { autoSpawn: true } } }]);

    // Not skipped by the auto_spawn exclusion check: entered the preparation
    // pass and reached prepareAgentSpawn. (The mock then fails with
    // 'unknown-agent', which retires the record for an UNRELATED reason -
    // that retire is not what this test is about.)
    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
  });

  it('preserves (does not resume) an orphaned record whose column has auto_spawn ON but the profile turns it OFF', async () => {
    swimlaneListMock.mockReturnValue([lane(LOUD_LANE, true)]);
    const orphaned = makeRecord({ id: 'record-orphaned', isolated_swimlane_id: null, status: 'orphaned' });
    sessionRepoGetOrphaned.mockReturnValue([orphaned]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: LOUD_LANE, profile_id: 'p1' })]);

    await runResume([{ id: 'p1', name: 'Manual', columns: { [LOUD_LANE]: { autoSpawn: false } } }]);

    // Excluded before the preparation pass: never reaches prepareAgentSpawn.
    expect(prepareAgentSpawn).not.toHaveBeenCalled();
    // Orphaned + excluded-by-profile mirrors the pre-existing orphaned-lane
    // retire behavior (see resume-suspended.ts step 4's else-if branch).
    expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'record-orphaned');
  });

  it("leaves an unprofiled task's recovery on its column's own auto_spawn flag, in both directions", async () => {
    swimlaneListMock.mockReturnValue([lane(LOUD_LANE, true), lane(QUIET_LANE, false)]);
    const loudRecord = makeRecord({ id: 'record-loud', task_id: 'task-loud', isolated_swimlane_id: null });
    const quietRecord = makeRecord({ id: 'record-quiet', task_id: 'task-quiet', isolated_swimlane_id: null });
    sessionRepoGetResumable.mockReturnValue([loudRecord, quietRecord]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-loud', swimlane_id: LOUD_LANE, profile_id: null }),
      makeTask({ id: 'task-quiet', swimlane_id: QUIET_LANE, profile_id: null }),
    ]);

    await runResume([]);

    // Only the loud-lane task's record reaches preparation.
    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
  });

  it("a task whose column has been deleted is NOT treated as excluded (missing lane means 'not excluded', preserved from the pre-profile design)", async () => {
    // 'lane-deleted' is not in the swimlane list at all - the base lane lookup
    // (laneMap.get) misses, and applyProfileToLane(undefined, ...) returns
    // null, so laneForTask falls back to `?? lane` (undefined). The
    // `resolvedLane &&` guard must treat that as "not excluded", exactly as
    // the pre-profile lane-keyed exclusion set (which could only ever contain
    // lanes that exist) did.
    swimlaneListMock.mockReturnValue([lane(LOUD_LANE, true)]);
    sessionRepoGetResumable.mockReturnValue([makeRecord({ isolated_swimlane_id: null })]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-deleted', profile_id: null })]);

    await runResume();

    // Not skipped by the auto_spawn exclusion check (same caveat re: the
    // mock's own 'unknown-agent' retire as the test above).
    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
  });
});
