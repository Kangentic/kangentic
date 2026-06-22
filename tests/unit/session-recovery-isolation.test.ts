/**
 * Isolation-aware recovery dedup (step 3b) in resumeSuspendedSessions
 * (src/main/transition-engine/session-startup/resume-suspended.ts).
 *
 * Feature intent for the per-column session feature:
 *   A task can hold multiple independently-resumable session records -
 *   one for its main track (isolated_swimlane_id: null) and one per
 *   isolated column it has visited (isolated_swimlane_id: '<lane-id>').
 *   On app restart, recovery MUST:
 *     (a) Resume ONLY the session that matches the task's CURRENT column's
 *         target (resolveIsolatedSwimlaneId(currentLane)).
 *     (b) PRESERVE all other-track records so re-entering their column later
 *         continues their own conversation. This means no retire/exit call.
 *     (c) An orphaned non-target record (the one that was live at crash) is
 *         CAS-upgraded to 'suspended' (not retired) so it is not reprocessed
 *         on the next startup.
 *
 * Also covers startup isolation tagging (gap 3): the session that gets
 * spawned carries the correct isolated_swimlane_id from the old record, and
 * autoSpawnTasks passes resolveIsolatedSwimlaneId(lane) into the spawn call
 * for fresh auto-spawns.
 *
 * The harness mirrors session-auto-resume-orphan-upgrade.test.ts to keep
 * mock patterns consistent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord, Task } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Module-level mock fns shared across all FakeSessionRepository instances.
// Reconfigured per-test in beforeEach.
// ---------------------------------------------------------------------------

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoMarkAllRunningAsOrphaned = vi.fn();
const sessionRepoMarkRunningAsOrphanedExcluding = vi.fn();

const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();

// ---------------------------------------------------------------------------
// Hoisted mocks: must appear before any import that loads the module under test
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

// SessionRepository: all instances delegate to module-level mock fns.
// getLatestForTaskByTypeAndIsolation is called inside the preparation pass;
// returns null so prep treats it as a fresh spawn (no resume) unless
// overridden by individual tests.
vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    getResumable = () => sessionRepoGetResumable();
    getOrphaned = () => sessionRepoGetOrphaned();
    // OS-killed gather: no interrupted-exited records in these tests.
    getInterruptedExited = () => [] as SessionRecord[];
    markAllRunningAsOrphaned = () => sessionRepoMarkAllRunningAsOrphaned();
    markRunningAsOrphanedExcluding = (...args: unknown[]) =>
      sessionRepoMarkRunningAsOrphanedExcluding(...args);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
    getUserPausedTaskIds = vi.fn(() => new Set<string>());
    insert = vi.fn();
    updateAppliedSettings = vi.fn();
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = (swimlaneId?: string) => {
      if (swimlaneId !== undefined) {
        // autoSpawnTasks calls list(swimlaneId): return tasks in that lane.
        return taskRepoList().filter((t: Task) => t.swimlane_id === swimlaneId);
      }
      return taskRepoList();
    };
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
    getById = vi.fn(() => null);
  }
  return { TaskRepository: FakeTaskRepository };
});

// SwimlaneRepository: configurable per-test via the swimlaneListMock module var.
const swimlaneListMock = vi.fn(() => [
  { id: 'lane-main', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
]);
const swimlaneGetByIdMock = vi.fn((id: string) => swimlaneListMock().find((l) => l.id === id) ?? null);
vi.mock('../../src/main/db/repositories/swimlane-repository', () => {
  class FakeSwimlaneRepository {
    list = () => swimlaneListMock();
    getById = (id: string) => swimlaneGetByIdMock(id);
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
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------

import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import { autoSpawnTasks } from '../../src/main/transition-engine/session-startup/auto-spawn';
import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'claude',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-uuid-main',
    command: 'claude --resume agent-uuid-main',
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
    id: 'task-1',
    display_id: 1,
    title: 'Test task',
    description: '',
    swimlane_id: 'lane-main',
    position: 0,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
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
    getUserPausedTaskIds: vi.fn(() => new Set<string>()),
  };
}

function makeConfigManager(autoResumeSessionsOnRestart = true) {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

// ---------------------------------------------------------------------------
// Tests: isolation-aware recovery dedup (step 3b)
// ---------------------------------------------------------------------------

describe('resumeSuspendedSessions: isolation-aware dedup (step 3b)', () => {
  beforeEach(() => {
    // Reset all module-level mock fns before each test.
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
    swimlaneListMock.mockReturnValue([
      { id: 'lane-main', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    swimlaneGetByIdMock.mockImplementation((id: string) =>
      swimlaneListMock().find((l) => l.id === id) ?? null,
    );
  });

  it('task in a main column: main record is recovered, isolated record is preserved (not retired)', async () => {
    // Arrange: two records for the same task - main track and isolated track.
    // The task currently sits in a main column, so only the main record must
    // enter recovery. The isolated record must not be retired or exited.
    //
    // Expected behavior derived from feature intent:
    //   - Main record -> toRecover -> passed to prepareAgentSpawn.
    //   - Isolated record -> preserved. No retireRecord call for it.
    //   - Because the isolated record is 'suspended' (not 'orphaned'), no
    //     markRecordSuspended call is needed for it either.
    const mainRecord = makeRecord({
      id: 'record-main',
      isolated_swimlane_id: null,
      status: 'suspended',
      started_at: '2026-01-01T10:00:00.000Z',
    });
    const isolatedRecord = makeRecord({
      id: 'record-iso',
      isolated_swimlane_id: 'lane-review',
      status: 'suspended',
      started_at: '2026-01-01T09:00:00.000Z',
    });

    sessionRepoGetResumable.mockReturnValue([mainRecord, isolatedRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-main' })]);

    // prepareAgentSpawn returns failure (unknown-agent) so the spawn does not
    // fire, but the dedup logic runs before the preparation pass.
    vi.mocked(prepareAgentSpawn).mockResolvedValue({ ok: false, reason: 'unknown-agent' });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: isolated record was NOT retired (preserved for later column entry).
    const retiredIds = retireRecordMock.mock.calls.map((call) => call[1]);
    expect(retiredIds).not.toContain('record-iso');

    // Assert: main record WAS passed to prepareAgentSpawn (it entered toRecover).
    // prepareAgentSpawn receives the record's cwd - assert it was called at all.
    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
  });

  it('orphaned non-target record is CAS-upgraded to suspended (not retired)', async () => {
    // Arrange: task is in a main column. It has:
    //   - A suspended main record (the target for this restart).
    //   - An orphaned isolated record (was live at crash in the isolated column
    //     but the task was moved to main while the app was down - impossible
    //     in practice, but the code must be correct regardless).
    //
    // Feature intent: the orphaned non-target record must be CAS-upgraded to
    // 'suspended' so it is not re-processed on next restart. It must NOT be
    // retired - doing so would destroy the record and prevent re-entering the
    // isolated column from picking up that conversation.
    const mainRecord = makeRecord({
      id: 'record-main',
      isolated_swimlane_id: null,
      status: 'suspended',
      started_at: '2026-01-01T10:00:00.000Z',
    });
    const orphanedIsolatedRecord = makeRecord({
      id: 'record-iso-orphaned',
      isolated_swimlane_id: 'lane-review',
      status: 'orphaned',
      started_at: '2026-01-01T09:00:00.000Z',
    });

    sessionRepoGetResumable.mockReturnValue([mainRecord]);
    sessionRepoGetOrphaned.mockReturnValue([orphanedIsolatedRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-main' })]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({ ok: false, reason: 'unknown-agent' });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: orphaned non-target record was CAS-upgraded to 'suspended'.
    expect(markRecordSuspendedMock).toHaveBeenCalledWith(
      expect.anything(),
      'record-iso-orphaned',
      'system',
    );

    // Assert: orphaned non-target record was NOT retired.
    const retiredIds = retireRecordMock.mock.calls.map((call) => call[1]);
    expect(retiredIds).not.toContain('record-iso-orphaned');
  });

  it('task in an isolated column: isolated record is recovered, main record is preserved', async () => {
    // Arrange: task currently sits in an isolated column ('lane-review').
    // The isolated record must enter recovery; the main record is preserved.
    //
    // Add 'lane-review' to the swimlane list so resolveIsolatedSwimlaneId
    // returns 'lane-review' (not null) for the task's current column.
    swimlaneListMock.mockReturnValue([
      { id: 'lane-main', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
      { id: 'lane-review', auto_spawn: true, session_target: 'isolated', session_spawn_strategy: 'always_spawn_new' },
    ]);

    const mainRecord = makeRecord({
      id: 'record-main',
      isolated_swimlane_id: null,
      status: 'suspended',
      started_at: '2026-01-01T09:00:00.000Z',
    });
    const isolatedRecord = makeRecord({
      id: 'record-iso',
      isolated_swimlane_id: 'lane-review',
      status: 'suspended',
      started_at: '2026-01-01T10:00:00.000Z',
    });

    sessionRepoGetResumable.mockReturnValue([mainRecord, isolatedRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-review' })]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({ ok: false, reason: 'unknown-agent' });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: main record was NOT retired.
    const retiredIds = retireRecordMock.mock.calls.map((call) => call[1]);
    expect(retiredIds).not.toContain('record-main');

    // Assert: isolated record was passed to prepareAgentSpawn (entered toRecover).
    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: startup isolation tagging (gap 3)
//
// The session spawned on recovery must carry the old record's
// isolated_swimlane_id so the DB row inserted after the spawn has the
// correct isolation discriminator.
//
// autoSpawnTasks must also pass resolveIsolatedSwimlaneId(lane) into spawn
// so fresh auto-spawns for isolated-column tasks get the right discriminator.
// ---------------------------------------------------------------------------

describe('resumeSuspendedSessions: spawn carries correct isolated_swimlane_id', () => {
  beforeEach(() => {
    markRecordSuspendedMock.mockClear();
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
    swimlaneListMock.mockReturnValue([
      { id: 'lane-main', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    swimlaneGetByIdMock.mockImplementation((id: string) =>
      swimlaneListMock().find((l) => l.id === id) ?? null,
    );
  });

  it('spawning a main-track recovery passes isolatedSwimlaneId=null to sessionManager.spawn', async () => {
    // The main record has isolated_swimlane_id: null.
    // The spawn input must carry null so the new DB row gets the same discriminator.
    const mainRecord = makeRecord({
      id: 'record-main',
      isolated_swimlane_id: null,
      status: 'suspended',
      agent_session_id: 'agent-uuid-main',
    });

    sessionRepoGetResumable.mockReturnValue([mainRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-main' })]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: true,
      data: {
        adapter: { name: 'claude', sessionType: 'claude_agent', getExitSequence: () => ['\x03'] } as never,
        agent: 'claude',
        command: 'claude --resume agent-uuid-main',
        cwd: '/project/cwd',
        sessionRecordId: 'new-record-id',
        agentSessionId: 'agent-uuid-main',
        permissionMode: 'default',
        statusOutputPath: '/project/.kangentic/sessions/new-record-id/status.json',
        eventsOutputPath: '/project/.kangentic/sessions/new-record-id/events.jsonl',
        extraEnv: null,
      },
    });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: spawn was called with isolatedSwimlaneId = null (the main track).
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (sessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnArg.isolatedSwimlaneId).toBeNull();
  });

  it('spawning an isolated-track recovery passes the swimlane id to sessionManager.spawn', async () => {
    // The isolated record has isolated_swimlane_id: 'lane-review'.
    // The spawn must carry this id so the new DB row is keyed to the same
    // isolated track.
    swimlaneListMock.mockReturnValue([
      { id: 'lane-review', auto_spawn: true, session_target: 'isolated', session_spawn_strategy: 'always_spawn_new' },
    ]);

    const isolatedRecord = makeRecord({
      id: 'record-iso',
      isolated_swimlane_id: 'lane-review',
      status: 'suspended',
      agent_session_id: 'agent-uuid-iso',
    });

    sessionRepoGetResumable.mockReturnValue([isolatedRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-review' })]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: true,
      data: {
        adapter: { name: 'claude', sessionType: 'claude_agent', getExitSequence: () => ['\x03'] } as never,
        agent: 'claude',
        command: 'claude --resume agent-uuid-iso',
        cwd: '/project/cwd',
        sessionRecordId: 'new-record-id-iso',
        agentSessionId: 'agent-uuid-iso',
        permissionMode: 'default',
        statusOutputPath: '/project/.kangentic/sessions/new-record-id-iso/status.json',
        eventsOutputPath: '/project/.kangentic/sessions/new-record-id-iso/events.jsonl',
        extraEnv: null,
      },
    });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: spawn was called with the correct isolatedSwimlaneId.
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (sessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnArg.isolatedSwimlaneId).toBe('lane-review');
  });

  it('recovery spawn passes resuming: true so the activity engine seeds idle, not thinking', async () => {
    // The activity-indicator feature seeds a FRESH task spawn as 'thinking'
    // (performSpawn: !input.resuming && !input.transient). A recovered session
    // carries no prompt (prepare-spawn: prompt undefined), so it must come up
    // idle - the recovery spawn input sets resuming: true to suppress the
    // thinking seed. Without it, every restart shows a false green "active"
    // indicator on recovered tasks.
    const mainRecord = makeRecord({
      id: 'record-main',
      isolated_swimlane_id: null,
      status: 'suspended',
      agent_session_id: 'agent-uuid-main',
    });

    sessionRepoGetResumable.mockReturnValue([mainRecord]);
    taskRepoList.mockReturnValue([makeTask({ swimlane_id: 'lane-main' })]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: true,
      data: {
        adapter: { name: 'claude', sessionType: 'claude_agent', getExitSequence: () => ['\x03'] } as never,
        agent: 'claude',
        command: 'claude --resume agent-uuid-main',
        cwd: '/project/cwd',
        sessionRecordId: 'new-record-id',
        agentSessionId: 'agent-uuid-main',
        permissionMode: 'default',
        statusOutputPath: '/project/.kangentic/sessions/new-record-id/status.json',
        eventsOutputPath: '/project/.kangentic/sessions/new-record-id/events.jsonl',
        extraEnv: null,
      },
    });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: the recovery spawn input carries resuming: true (seeds idle).
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (sessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnArg.resuming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: autoSpawnTasks isolation tagging
// ---------------------------------------------------------------------------

describe('autoSpawnTasks: resolveIsolatedSwimlaneId(lane) passed into spawn', () => {
  beforeEach(() => {
    retireRecordMock.mockClear();
    taskRepoList.mockClear();
    taskRepoUpdateMock.mockClear();
    vi.mocked(prepareAgentSpawn).mockClear();
    swimlaneListMock.mockReturnValue([]);
  });

  it('main-lane auto-spawn passes isolatedSwimlaneId=null', async () => {
    // A task in a normal 'main' column auto-spawns with no isolation.
    // The spawn must tag the session record with isolated_swimlane_id=null.
    swimlaneListMock.mockReturnValue([
      { id: 'lane-exec', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-exec', swimlane_id: 'lane-exec', session_id: null }),
    ]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: true,
      data: {
        adapter: { name: 'claude', sessionType: 'claude_agent', getExitSequence: () => ['\x03'] } as never,
        agent: 'claude',
        command: 'claude --session-id new-agent-uuid',
        cwd: '/project/cwd',
        sessionRecordId: 'auto-record-main',
        agentSessionId: 'new-agent-uuid',
        permissionMode: 'default',
        statusOutputPath: '/project/.kangentic/sessions/auto-record-main/status.json',
        eventsOutputPath: '/project/.kangentic/sessions/auto-record-main/events.jsonl',
        extraEnv: null,
      },
    });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await autoSpawnTasks('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: spawn was called with isolatedSwimlaneId=null.
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (sessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnArg.isolatedSwimlaneId).toBeNull();
  });

  it('isolated-lane auto-spawn passes the swimlane id as isolatedSwimlaneId', async () => {
    // A task in an isolated column auto-spawns with the column's swimlane id.
    // The spawn must tag the session record so re-entering the column later
    // can resume the correct conversation track.
    swimlaneListMock.mockReturnValue([
      { id: 'lane-review', auto_spawn: true, session_target: 'isolated', session_spawn_strategy: 'always_spawn_new' },
    ]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-review', swimlane_id: 'lane-review', session_id: null }),
    ]);

    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: true,
      data: {
        adapter: { name: 'claude', sessionType: 'claude_agent', getExitSequence: () => ['\x03'] } as never,
        agent: 'claude',
        command: 'claude --session-id new-iso-uuid',
        cwd: '/project/cwd',
        sessionRecordId: 'auto-record-iso',
        agentSessionId: 'new-iso-uuid',
        permissionMode: 'default',
        statusOutputPath: '/project/.kangentic/sessions/auto-record-iso/status.json',
        eventsOutputPath: '/project/.kangentic/sessions/auto-record-iso/events.jsonl',
        extraEnv: null,
      },
    });

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await autoSpawnTasks('proj-1', '/project', sessionManager as never, configManager as never);

    // Assert: spawn was called with the lane's id as isolatedSwimlaneId.
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (sessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnArg.isolatedSwimlaneId).toBe('lane-review');
  });
});
