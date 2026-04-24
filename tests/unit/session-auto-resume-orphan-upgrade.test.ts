/**
 * Tests for the auto-resume-disabled branch in resumeSuspendedSessions
 * (src/main/engine/session-startup/resume-suspended.ts).
 *
 * When `autoResumeSessionsOnRestart=false`, the branch does NOT spawn a new
 * session. For orphaned records it atomically transitions status to
 * 'suspended' (with suspended_by='system' - 'user' is reserved for explicit
 * pause-button presses, to keep task-move's spawnAgent resume behavior
 * working on subsequent drags). It then registers a placeholder so the
 * renderer shows a Resume button, and clears task.session_id so
 * SESSION_RESUME's precondition check passes.
 *
 * All collaborators are mocked aggressively so only this branch's observable
 * effects are asserted: mock call counts and arguments on markRecordSuspended,
 * sessionManager.registerSuspendedPlaceholder, and taskRepo.update.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord, Task } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Module-level mock fns shared across all FakeSessionRepository instances.
// They are reconfigured per-test in beforeEach.
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
vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordSuspended: (...args: unknown[]) => markRecordSuspendedMock(...args),
  retireRecord: (...args: unknown[]) => retireRecordMock(...args),
}));

// SessionRepository mock: all instances delegate to module-level mock fns so
// per-test configuration via those fns controls what the function under test sees.
vi.mock('../../src/main/db/repositories/session-repository', () => {
  class FakeSessionRepository {
    getResumable = () => sessionRepoGetResumable();
    getOrphaned = () => sessionRepoGetOrphaned();
    markAllRunningAsOrphaned = () => sessionRepoMarkAllRunningAsOrphaned();
    markRunningAsOrphanedExcluding = (...args: unknown[]) =>
      sessionRepoMarkRunningAsOrphanedExcluding(...args);
    // getLatestForTaskByType is called inside the preparation pass (which
    // is only reached when a record enters toProcess). These tests skip that
    // pass, but define the method to avoid "not a function" errors.
    getLatestForTaskByType = vi.fn(() => null);
  }
  return { SessionRepository: FakeSessionRepository };
});

// TaskRepository mock: all instances delegate to module-level taskRepoList
// and taskRepoUpdateMock so tests can assert on session_id clears.
vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = () => taskRepoList();
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
  }
  return { TaskRepository: FakeTaskRepository };
});

// SwimlaneRepository: one lane with auto_spawn=true (no excluded lanes)
vi.mock('../../src/main/db/repositories/swimlane-repository', () => {
  class FakeSwimlaneRepository {
    list = vi.fn(() => [{ id: 'lane-1', auto_spawn: true }]);
    getById = vi.fn(() => ({ id: 'lane-1', auto_spawn: true }));
  }
  return { SwimlaneRepository: FakeSwimlaneRepository };
});

// prepareAgentSpawn is never reached because all records are filtered out
// before the preparation pass in these tests.
vi.mock('../../src/main/engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: vi.fn(),
}));

vi.mock('../../src/main/engine/spawn-intent', () => ({
  isResumeEligible: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------

import { resumeSuspendedSessions } from '../../src/main/engine/session-startup/resume-suspended';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeOrphanedRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'claude',
    agent_session_id: null,
    command: 'claude --task test',
    cwd: '/project/cwd',
    permission_mode: 'default',
    prompt: null,
    status: 'orphaned',
    exit_code: null,
    started_at: '2026-04-23T10:00:00.000Z',
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
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
    swimlane_id: 'lane-1',
    position: 0,
    agent: null,
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
    created_at: '2026-04-23T10:00:00.000Z',
    updated_at: '2026-04-23T10:00:00.000Z',
    ...overrides,
  };
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(),
    getShell: vi.fn(async () => '/bin/sh'),
  };
}

function makeConfigManager(autoResumeSessionsOnRestart: boolean) {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resumeSuspendedSessions: auto-resume-disabled branch (autoResumeSessionsOnRestart=false)', () => {
  beforeEach(() => {
    // Reset all module-level mock fns to clean defaults before each test
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
  });

  it("orphaned happy path: CAS succeeds with 'system' marker, placeholder registered, no spawn", async () => {
    // Arrange: one orphaned record, setting disabled, CAS returns true
    sessionRepoGetOrphaned.mockReturnValue([makeOrphanedRecord()]);
    taskRepoList.mockReturnValue([makeTask()]);

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(false);

    // Act
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      configManager as never,
    );

    // Assert: CAS called with 'system' (reserves 'user' for explicit pauses)
    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);
    expect(markRecordSuspendedMock).toHaveBeenCalledWith(
      expect.anything(),
      'record-1',
      'system',
    );

    // Assert: placeholder registered for the task
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'proj-1',
      cwd: '/project/cwd',
    });

    // Assert: no spawn was attempted
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('CAS-failure path: markRecordSuspended returns false - placeholder is NOT registered', async () => {
    // Arrange: CAS fails (concurrent retire already transitioned the record)
    markRecordSuspendedMock.mockReturnValue(false);

    sessionRepoGetOrphaned.mockReturnValue([makeOrphanedRecord()]);
    taskRepoList.mockReturnValue([makeTask()]);

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(false);

    // Act
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      configManager as never,
    );

    // Assert: CAS was still attempted
    expect(markRecordSuspendedMock).toHaveBeenCalledTimes(1);

    // Assert: placeholder NOT registered because CAS failed
    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();

    // Assert: no spawn
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('already-suspended records (from shutdown) register a placeholder without an extra CAS', async () => {
    // Arrange: record is already 'suspended' with suspended_by='system'
    // (graceful-quit case - syncShutdownCleanup already marked it). The
    // auto-resume-disabled branch does NOT re-transition already-suspended
    // records - it just registers the placeholder and clears
    // task.session_id.
    const alreadySuspendedRecord = makeOrphanedRecord({
      status: 'suspended',
      suspended_by: 'system',
      suspended_at: '2026-04-23T10:00:00.000Z',
    });

    sessionRepoGetResumable.mockReturnValue([alreadySuspendedRecord]);
    sessionRepoGetOrphaned.mockReturnValue([]);
    taskRepoList.mockReturnValue([makeTask({ session_id: 'stale-pty-id' })]);

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(false);

    // Act
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      configManager as never,
    );

    // Assert: no CAS transition - record was already 'suspended'
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();

    // Assert: placeholder registered
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);

    // Assert: stale task.session_id cleared so SESSION_RESUME's precondition passes
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({
      id: 'task-1',
      session_id: null,
    });

    // Assert: no spawn
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("user-paused records (explicit Pause button) register a placeholder, auto-resume setting aside", async () => {
    // Arrange: record is 'suspended' with suspended_by='user' (user clicked
    // the Pause button). Even with autoResumeSessionsOnRestart=true, the
    // explicit pause must be respected - register a placeholder, don't
    // auto-resume.
    const userPausedRecord = makeOrphanedRecord({
      status: 'suspended',
      suspended_by: 'user',
      suspended_at: '2026-04-23T10:00:00.000Z',
    });

    sessionRepoGetResumable.mockReturnValue([userPausedRecord]);
    sessionRepoGetOrphaned.mockReturnValue([]);
    taskRepoList.mockReturnValue([makeTask()]);

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true); // auto-resume ON

    // Act
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      configManager as never,
    );

    // Assert: no CAS, placeholder registered, no spawn
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('guard-flip: when autoResumeSessionsOnRestart=true, orphaned record skips the disabled branch', async () => {
    // Arrange: setting is true (default). The orphaned record must NOT be
    // transitioned via the disabled branch. It enters toProcess and the
    // preparation pass. The key assertion is that markRecordSuspended is
    // never called (the disabled branch was not entered). The preparation
    // pass will retire the record (prepareAgentSpawn returns a failure),
    // which is fine - we only care that the branch did not fire.
    const { prepareAgentSpawn } = await import(
      '../../src/main/engine/session-startup/prepare-spawn'
    );
    vi.mocked(prepareAgentSpawn).mockResolvedValue({
      ok: false,
      reason: 'unknown-agent',
    } as never);

    sessionRepoGetOrphaned.mockReturnValue([makeOrphanedRecord()]);
    taskRepoList.mockReturnValue([makeTask()]);

    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager(true);

    // Act
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      configManager as never,
    );

    // Assert: disabled branch was NOT entered
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();

    // Assert: no suspended placeholder registered via the disabled branch
    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });
});
