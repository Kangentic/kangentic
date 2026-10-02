/**
 * Startup recovery of OS-killed agent sessions
 * (src/main/transition-engine/session-startup/resume-suspended.ts).
 *
 * Incident (2026-06-06): a computer restart hard-killed three live agents
 * (tasks #172/#173/#174). Windows recorded each as status='exited' with the
 * abnormal code 1073807364, which the old startup gather (suspended + orphaned
 * only) could not see, so autoSpawnTasks minted fresh EMPTY $0 sessions and the
 * multi-hundred-tool conversations were orphaned (~$19 of work).
 *
 * The fix widens the gather with getInterruptedExited() and routes those records
 * through the existing dedup/resume pipeline, so they resume via
 * `--resume <original-agent-session-id>` instead of being abandoned.
 *
 * Harness mirrors session-recovery-isolation.test.ts. Distinctly, this suite:
 *   - drives the SPAWN path (prepareAgentSpawn returns ok), and
 *   - uses a faithful isResumeEligible (the real 3-line predicate) plus a
 *     getLatestForTaskByTypeAndIsolation that looks records up from an in-memory
 *     DB list, so the resume decision is exercised end-to-end.
 *
 * Red-green: remove `...interruptedExited` from `allRecords` in
 * resume-suspended.ts and the hard-kill cases stop resuming (no spawn).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SessionRecord, Task } from '../../src/shared/types';
import { PTY_HOST_LOST_EXIT_CODE } from '../../src/shared/pty-host';

// Incident agent_session_id for task #172 ($8.82, 145 tools) - used verbatim so
// this unit test is the empirical red-green for the recovered conversation.
const INCIDENT_172_AGENT_SESSION_ID = '1194b985-5340-4fe5-8f3d-56879c81e4f3';

// ---------------------------------------------------------------------------
// Module-level mock fns shared across all FakeSessionRepository instances.
// ---------------------------------------------------------------------------

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetInterruptedExited = vi.fn(() => [] as SessionRecord[]);
const sessionRepoMarkAllRunningAsOrphaned = vi.fn();
const sessionRepoMarkRunningAsOrphanedExcluding = vi.fn();
const sessionRepoInsert = vi.fn();

// The in-memory "DB" the resume-decision lookup reads from. Populated per-test
// with every record the repo knows about; getLatestForTaskByTypeAndIsolation
// returns the newest match (mirrors the real ORDER BY started_at DESC LIMIT 1).
let dbRecords: SessionRecord[] = [];
function latestForTaskByTypeAndIsolation(
  taskId: string,
  sessionType: string,
  isolatedSwimlaneId: string | null,
): SessionRecord | undefined {
  return dbRecords
    .filter(
      (record) =>
        record.task_id === taskId &&
        record.session_type === sessionType &&
        record.isolated_swimlane_id === isolatedSwimlaneId,
    )
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))[0];
}

const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({ app: { isPackaged: false } }));

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
    getInterruptedExited = () => sessionRepoGetInterruptedExited();
    markAllRunningAsOrphaned = () => sessionRepoMarkAllRunningAsOrphaned();
    markRunningAsOrphanedExcluding = (...args: unknown[]) =>
      sessionRepoMarkRunningAsOrphanedExcluding(...args);
    getLatestForTaskByTypeAndIsolation = (
      taskId: string,
      sessionType: string,
      isolatedSwimlaneId: string | null,
    ) => latestForTaskByTypeAndIsolation(taskId, sessionType, isolatedSwimlaneId);
    getUserPausedTaskIds = () => new Set<string>();
    insert = (...args: unknown[]) => sessionRepoInsert(...args);
    updateAppliedSettings = vi.fn();
    // The resume pass confirms under the task lock that its record still exists.
    findByAnyId = (id: string) => dbRecords.find((record) => record.id === id);
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = (swimlaneId?: string) => {
      if (swimlaneId !== undefined) {
        return taskRepoList().filter((task: Task) => task.swimlane_id === swimlaneId);
      }
      return taskRepoList();
    };
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
    // The spawn pass re-reads its task under the task lock.
    getById = vi.fn((id: string) => taskRepoList().find((task: Task) => task.id === id));
  }
  return { TaskRepository: FakeTaskRepository };
});

const swimlaneListMock = vi.fn(() => [
  { id: 'lane-exec', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
]);
vi.mock('../../src/main/db/repositories/swimlane-repository', () => {
  class FakeSwimlaneRepository {
    list = () => swimlaneListMock();
    getById = (id: string) => swimlaneListMock().find((lane) => lane.id === id) ?? null;
  }
  return { SwimlaneRepository: FakeSwimlaneRepository };
});

vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: vi.fn(),
}));

// Faithful copy of the real isResumeEligible (spawn-intent.ts) - kept inline so
// the test stays hermetic (no transitive imports) while exercising the real
// decision: a non-null agent_session_id, not run_script, not queued is eligible,
// regardless of exited vs suspended vs orphaned status.
vi.mock('../../src/main/transition-engine/spawn-intent', () => ({
  isResumeEligible: (record: SessionRecord | undefined) =>
    !!record?.agent_session_id &&
    record.session_type !== 'run_script' &&
    record.status !== 'queued',
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------

import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExitedRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: 'task-1',
    session_type: 'claude',
    isolated_swimlane_id: null,
    agent_session_id: INCIDENT_172_AGENT_SESSION_ID,
    command: `claude --resume ${INCIDENT_172_AGENT_SESSION_ID}`,
    cwd: '/project/cwd',
    permission_mode: 'default',
    prompt: null,
    status: 'exited',
    exit_code: 1073807364, // Windows hard-kill code from the incident
    started_at: '2026-06-06T10:00:00.000Z',
    suspended_at: null,
    exited_at: '2026-06-06T12:00:00.000Z',
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
    swimlane_id: 'lane-exec',
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
    created_at: '2026-06-06T10:00:00.000Z',
    updated_at: '2026-06-06T10:00:00.000Z',
    ...overrides,
  };
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async (input: { id: string }) => ({ id: input.id })),
    getShell: vi.fn(async () => '/bin/sh'),
    hasSessionForTask: vi.fn(() => false),
    findLiveSessionByTaskId: vi.fn(() => undefined),
  };
}

function makeConfigManager(autoResumeSessionsOnRestart = true) {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

/** prepareAgentSpawn that echoes the resume agent_session_id back through the
 *  spawn input, so spawn() receives the ORIGINAL id when resuming. */
function wirePrepareAgentSpawnEcho() {
  vi.mocked(prepareAgentSpawn).mockImplementation(async (input) => ({
    ok: true,
    data: {
      adapter: { name: 'claude', getExitSequence: () => ['\x03'] } as never,
      agent: 'claude',
      command: `claude --resume ${input.resume?.agentSessionId ?? 'FRESH'}`,
      cwd: input.cwd,
      sessionRecordId: `new-${input.task.id}`,
      agentSessionId: input.resume?.agentSessionId ?? null,
      permissionMode: 'default',
      statusOutputPath: `/project/.kangentic/sessions/new-${input.task.id}/status.json`,
      eventsOutputPath: `/project/.kangentic/sessions/new-${input.task.id}/events.jsonl`,
      extraEnv: null,
    },
  }));
}

beforeEach(() => {
  markRecordSuspendedMock.mockClear();
  markRecordSuspendedMock.mockReturnValue(true);
  retireRecordMock.mockClear();
  sessionRepoGetResumable.mockClear();
  sessionRepoGetResumable.mockReturnValue([]);
  sessionRepoGetOrphaned.mockClear();
  sessionRepoGetOrphaned.mockReturnValue([]);
  sessionRepoGetInterruptedExited.mockClear();
  sessionRepoGetInterruptedExited.mockReturnValue([]);
  sessionRepoMarkAllRunningAsOrphaned.mockClear();
  sessionRepoMarkRunningAsOrphanedExcluding.mockClear();
  sessionRepoInsert.mockClear();
  taskRepoList.mockClear();
  taskRepoList.mockReturnValue([]);
  taskRepoUpdateMock.mockClear();
  dbRecords = [];
  vi.mocked(prepareAgentSpawn).mockReset();
  swimlaneListMock.mockReturnValue([
    { id: 'lane-exec', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
  ]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resumeSuspendedSessions: OS-killed (interrupted-exited) recovery', () => {
  // Cross-platform: the same hard-kill recovery must fire for every OS's kill
  // code (Windows 1073807364, Unix SIGKILL 137 / SIGTERM 143 / SIGINT 130).
  // The gather predicate (tested in session-repository-interrupted-exited.test)
  // selects them all via `exit_code != 0`; here we prove the downstream pipeline
  // resumes each via --resume <original>, never a fresh session.
  describe.each([1073807364, 137, 143, 130])('exit code %i', (exitCode) => {
    it('resumes via --resume <original agent_session_id>, not a fresh $0 session', async () => {
      const record = makeExitedRecord({
        id: 'rec-172',
        task_id: 'task-172',
        exit_code: exitCode,
        agent_session_id: INCIDENT_172_AGENT_SESSION_ID,
      });
      sessionRepoGetInterruptedExited.mockReturnValue([record]);
      dbRecords = [record];
      taskRepoList.mockReturnValue([makeTask({ id: 'task-172', swimlane_id: 'lane-exec' })]);
      wirePrepareAgentSpawnEcho();

      const sessionManager = makeSessionManager();
      await resumeSuspendedSessions(
        'proj-1',
        '/project',
        sessionManager as never,
        makeConfigManager(true) as never,
      );

      // Resume was requested with the ORIGINAL conversation id, threading the
      // matched record's id + cwd and the live repo that power the resume-time
      // /clear-fork reconcile inside prepareAgentSpawn.
      expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
      expect(prepareAgentSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: {
            agentSessionId: INCIDENT_172_AGENT_SESSION_ID,
            recordId: 'rec-172',
            recordCwd: '/project/cwd',
          },
          sessionRepo: expect.anything(),
        }),
      );

      // The spawned PTY carries the original id (so the CLI gets --resume <id>).
      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      const spawnArg = sessionManager.spawn.mock.calls[0][0];
      expect(spawnArg.agentSessionId).toBe(INCIDENT_172_AGENT_SESSION_ID);

      // The fresh-spawn fallback was NOT taken (resume mode, not null).
      expect(spawnArg.agentSessionId).not.toBeNull();
    });
  });

  it('clean exit 0 is never gathered, so it is not resumed on startup', async () => {
    // Defense-in-depth at the orchestration layer: getInterruptedExited (the SQL
    // gather) excludes exit 0, so the recovery pass sees nothing and performs no
    // resume. A user who deliberately /exit-ed is not resurrected.
    sessionRepoGetInterruptedExited.mockReturnValue([]); // exit-0 filtered upstream
    dbRecords = [makeExitedRecord({ exit_code: 0 })];
    taskRepoList.mockReturnValue([makeTask()]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
    );

    expect(prepareAgentSpawn).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('preserves a non-target isolated session as dormant (never clobbered or resumed as main)', async () => {
    // Task #173 shape: it sits in a main column but also holds an isolated Code
    // Review session. Recovery must resume the MAIN session and leave the
    // isolated one dormant (CAS-upgraded to suspended, not retired, not spawned).
    swimlaneListMock.mockReturnValue([
      { id: 'lane-exec', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
      { id: 'lane-review', auto_spawn: true, session_target: 'isolated', session_spawn_strategy: 'always_spawn_new' },
    ]);

    const mainRecord = makeExitedRecord({
      id: 'rec-main',
      task_id: 'task-173',
      isolated_swimlane_id: null,
      agent_session_id: 'main-agent-id',
      started_at: '2026-06-06T10:00:00.000Z',
    });
    const isolatedRecord = makeExitedRecord({
      id: 'rec-iso',
      task_id: 'task-173',
      isolated_swimlane_id: 'lane-review',
      agent_session_id: 'iso-agent-id',
      started_at: '2026-06-06T09:00:00.000Z',
    });
    sessionRepoGetInterruptedExited.mockReturnValue([mainRecord, isolatedRecord]);
    dbRecords = [mainRecord, isolatedRecord];
    taskRepoList.mockReturnValue([makeTask({ id: 'task-173', swimlane_id: 'lane-exec' })]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
    );

    // Only the main session was resumed.
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn.mock.calls[0][0].agentSessionId).toBe('main-agent-id');

    // The isolated session was preserved: upgraded to suspended, NOT retired.
    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-iso', 'system');
    const retiredIds = retireRecordMock.mock.calls.map((call) => call[1]);
    expect(retiredIds).not.toContain('rec-iso');
  });

  it('recovers multiple concurrently-disconnected tasks (the incident hit 3 at once)', async () => {
    const records = [
      makeExitedRecord({ id: 'rec-172', task_id: 'task-172', agent_session_id: 'agent-172' }),
      makeExitedRecord({ id: 'rec-173', task_id: 'task-173', agent_session_id: 'agent-173' }),
      makeExitedRecord({ id: 'rec-174', task_id: 'task-174', agent_session_id: 'agent-174' }),
    ];
    sessionRepoGetInterruptedExited.mockReturnValue(records);
    dbRecords = [...records];
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-172', swimlane_id: 'lane-exec' }),
      makeTask({ id: 'task-173', swimlane_id: 'lane-exec' }),
      makeTask({ id: 'task-174', swimlane_id: 'lane-exec' }),
    ]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
    );

    expect(sessionManager.spawn).toHaveBeenCalledTimes(3);
    const resumedAgentIds = sessionManager.spawn.mock.calls
      .map((call) => call[0].agentSessionId)
      .sort();
    expect(resumedAgentIds).toEqual(['agent-172', 'agent-173', 'agent-174']);
  });

  it('non-auto-spawn column (To Do/Done): preserved as suspended, not resumed', async () => {
    // An OS-killed session whose task sits in a non-auto-spawn column must NOT
    // be resumed on startup; it is CAS-upgraded to suspended so it stays
    // resumable when moved back (mirrors the move-to-Done path) and is not
    // re-gathered every startup.
    swimlaneListMock.mockReturnValue([
      { id: 'lane-todo', auto_spawn: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ]);
    const record = makeExitedRecord({ id: 'rec-todo', task_id: 'task-todo' });
    sessionRepoGetInterruptedExited.mockReturnValue([record]);
    dbRecords = [record];
    taskRepoList.mockReturnValue([makeTask({ id: 'task-todo', swimlane_id: 'lane-todo' })]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
    );

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-todo', 'system');
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(prepareAgentSpawn).not.toHaveBeenCalled();
  });

  it('auto-resume-on-restart OFF: upgraded to suspended + placeholder, not resumed', async () => {
    const record = makeExitedRecord({ id: 'rec-off', task_id: 'task-off' });
    sessionRepoGetInterruptedExited.mockReturnValue([record]);
    dbRecords = [record];
    taskRepoList.mockReturnValue([makeTask({ id: 'task-off', swimlane_id: 'lane-exec' })]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(false) as never, // auto-resume OFF
    );

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-off', 'system');
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('regression: the existing orphaned recovery path still resumes', async () => {
    const orphaned = makeExitedRecord({
      id: 'rec-orphan',
      task_id: 'task-orphan',
      status: 'orphaned',
      exit_code: null,
      exited_at: null,
      agent_session_id: 'agent-orphan',
    });
    sessionRepoGetOrphaned.mockReturnValue([orphaned]);
    sessionRepoGetInterruptedExited.mockReturnValue([]);
    dbRecords = [orphaned];
    taskRepoList.mockReturnValue([makeTask({ id: 'task-orphan', swimlane_id: 'lane-exec' })]);
    wirePrepareAgentSpawnEcho();

    const sessionManager = makeSessionManager();
    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
    );

    expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn.mock.calls[0][0].agentSessionId).toBe('agent-orphan');
  });
});

describe('resumeSuspendedSessions: scoped to the sessions a pty host crash took down (onlySessionIds)', () => {
  // The pty host's crash path runs this mid-run. Its gather would otherwise
  // also find sessions the host never held (an agent that exited non-zero on
  // its own, one suspended earlier this run) and wake them, and its orphan
  // marking would flip every OTHER live session's 'running' record.
  //
  // Red-green: drop the `onlySessionIds ? gathered.filter(...)` narrowing and
  // the unlisted record is resumed too; drop the `if (onlySessionIds)` arm
  // ahead of the orphan marking and the marking mocks fire.

  /** The positional signature: ids sit behind six optional parameters. */
  function resumeScoped(
    sessionManager: ReturnType<typeof makeSessionManager>,
    onlySessionIds: ReadonlySet<string> | undefined,
  ) {
    return resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onlySessionIds,
    );
  }

  function interruptedByHostLoss(recordId: string, taskId: string): SessionRecord {
    return makeExitedRecord({
      id: recordId,
      task_id: taskId,
      exit_code: PTY_HOST_LOST_EXIT_CODE,
      agent_session_id: `agent-${taskId}`,
    });
  }

  function seedTwoInterruptedSessions(): void {
    const lost = interruptedByHostLoss('rec-lost', 'task-lost');
    const unrelated = interruptedByHostLoss('rec-unrelated', 'task-unrelated');
    sessionRepoGetInterruptedExited.mockReturnValue([lost, unrelated]);
    dbRecords = [lost, unrelated];
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-lost', swimlane_id: 'lane-exec' }),
      makeTask({ id: 'task-unrelated', swimlane_id: 'lane-exec' }),
    ]);
    wirePrepareAgentSpawnEcho();
  }

  it('resumes only the listed record and leaves the other interrupted one untouched', async () => {
    seedTwoInterruptedSessions();
    const sessionManager = makeSessionManager();

    await resumeScoped(sessionManager, new Set(['rec-lost']));

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = sessionManager.spawn.mock.calls[0][0];
    expect(spawnArg.taskId).toBe('task-lost');
    expect(spawnArg.agentSessionId).toBe('agent-task-lost');
    // The unlisted record was filtered out before every step: not retired, not
    // upgraded to suspended, not prepared.
    expect(retireRecordMock.mock.calls.map((call) => call[1])).not.toContain('rec-unrelated');
    expect(markRecordSuspendedMock.mock.calls.map((call) => call[1])).not.toContain('rec-unrelated');
    expect(vi.mocked(prepareAgentSpawn).mock.calls.map((call) => call[0].task.id)).toEqual(['task-lost']);
  });

  it('without ids the same gather resumes both, which is what makes the narrowing observable', async () => {
    seedTwoInterruptedSessions();
    const sessionManager = makeSessionManager();

    await resumeScoped(sessionManager, undefined);

    expect(sessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  it('an empty set resumes nothing instead of falling back to everything', async () => {
    seedTwoInterruptedSessions();
    const sessionManager = makeSessionManager();

    await resumeScoped(sessionManager, new Set<string>());

    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(prepareAgentSpawn).not.toHaveBeenCalled();
  });

  it('never marks running records orphaned, whether or not another session is live', async () => {
    seedTwoInterruptedSessions();

    await resumeScoped(makeSessionManager(), new Set(['rec-lost']));
    expect(sessionRepoMarkAllRunningAsOrphaned).not.toHaveBeenCalled();
    expect(sessionRepoMarkRunningAsOrphanedExcluding).not.toHaveBeenCalled();

    const sessionManagerWithLiveTask = makeSessionManager();
    sessionManagerWithLiveTask.listSessions.mockReturnValue([{ taskId: 'task-live', status: 'running' }] as never);
    await resumeScoped(sessionManagerWithLiveTask, new Set(['rec-lost']));
    expect(sessionRepoMarkAllRunningAsOrphaned).not.toHaveBeenCalled();
    expect(sessionRepoMarkRunningAsOrphanedExcluding).not.toHaveBeenCalled();
  });

  it('a startup recovery (no ids) still marks leftover running records orphaned', async () => {
    seedTwoInterruptedSessions();

    await resumeScoped(makeSessionManager(), undefined);
    expect(sessionRepoMarkAllRunningAsOrphaned).toHaveBeenCalledTimes(1);

    const sessionManagerWithLiveTask = makeSessionManager();
    sessionManagerWithLiveTask.listSessions.mockReturnValue([{ taskId: 'task-live', status: 'running' }] as never);
    await resumeScoped(sessionManagerWithLiveTask, undefined);
    expect(sessionRepoMarkRunningAsOrphanedExcluding).toHaveBeenCalledTimes(1);
  });
});

/**
 * The preparation awaits the shell and each agent's detection, and the user
 * can act on the task meanwhile. The resume re-reads its task and its record
 * under the task's lifecycle lock and leaves one a user action took over. It
 * looks for a LIVE session there, not any row: the pty host's crash path leaves
 * the lost row registered, exited, for the very task it resumes.
 *
 * Red-green: drop the re-check and the last three fail; check any row
 * (`hasSessionForTask`) instead of a live one and the first fails.
 */
describe('resumeSuspendedSessions: the resume re-checks its task under the task lock', () => {
  interface RegistryRow {
    id: string;
    taskId: string;
    status: string;
  }

  function managerOver(rows: RegistryRow[]) {
    const manager = makeSessionManager();
    manager.listSessions.mockImplementation(() => rows as never);
    manager.hasSessionForTask.mockImplementation(((taskId: string) => rows.some((row) => row.taskId === taskId)) as never);
    manager.findLiveSessionByTaskId.mockImplementation(((taskId: string) => rows.find(
      (row) => row.taskId === taskId && (row.status === 'running' || row.status === 'queued'),
    )) as never);
    return manager;
  }

  function seedLostSession(duringPreparation: () => void = () => undefined): void {
    const lost = makeExitedRecord({
      id: 'rec-lost',
      task_id: 'task-lost',
      exit_code: PTY_HOST_LOST_EXIT_CODE,
      agent_session_id: 'agent-task-lost',
    });
    sessionRepoGetInterruptedExited.mockReturnValue([lost]);
    dbRecords = [lost];
    taskRepoList.mockReturnValue([makeTask({ id: 'task-lost', swimlane_id: 'lane-exec' })]);
    wirePrepareAgentSpawnEcho();
    const echo = vi.mocked(prepareAgentSpawn).getMockImplementation();
    if (!echo) throw new Error('prepareAgentSpawn is not wired');
    vi.mocked(prepareAgentSpawn).mockImplementation(async (input) => {
      duringPreparation();
      return echo(input);
    });
  }

  function resumeLost(sessionManager: ReturnType<typeof makeSessionManager>) {
    return resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['rec-lost']),
    );
  }

  it('resumes the lost task while its only row is the exited one the host loss left', async () => {
    seedLostSession();
    const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

    await resumeLost(sessionManager);

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not resume over a session the user started during the preparation', async () => {
    const rows: RegistryRow[] = [{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }];
    seedLostSession(() => {
      rows.push({ id: 'session-user', taskId: 'task-lost', status: 'running' });
    });
    const sessionManager = managerOver(rows);

    await resumeLost(sessionManager);

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('does not resume a task moved to another column during the preparation', async () => {
    seedLostSession(() => {
      taskRepoList.mockReturnValue([makeTask({ id: 'task-lost', swimlane_id: 'lane-todo' })]);
    });
    const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

    await resumeLost(sessionManager);

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  describe('a task moved during the preparation', () => {
    // The move had no session to suspend, so in a column that starts no agent
    // the card offered no Resume until the next launch. The resume keeps the
    // record resumable with a paused placeholder there, as the gather keeps a
    // record it finds in such a column. A column that starts agents is the
    // move's own to spawn into.
    //
    // Red-green: drop the placeholder branch from the re-check in
    // resume-suspended.ts and the first test goes red.
    const lanes = (movedTo: { id: string; auto_spawn: boolean }) => [
      { id: 'lane-exec', auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
      { id: movedTo.id, auto_spawn: movedTo.auto_spawn, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    ];

    it('into a column that starts no agent keeps its record resumable, with a paused placeholder', async () => {
      swimlaneListMock.mockReturnValue(lanes({ id: 'lane-manual', auto_spawn: false }));
      seedLostSession(() => {
        taskRepoList.mockReturnValue([makeTask({ id: 'task-lost', swimlane_id: 'lane-manual' })]);
      });
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

      await resumeLost(sessionManager);

      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'rec-lost', 'system');
      expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({ taskId: 'task-lost', projectId: 'proj-1', cwd: '/project/cwd' });
      expect(retireRecordMock).not.toHaveBeenCalled();
    });

    it('into a column that starts agents is left to the move, with no placeholder', async () => {
      swimlaneListMock.mockReturnValue(lanes({ id: 'lane-review', auto_spawn: true }));
      seedLostSession(() => {
        taskRepoList.mockReturnValue([makeTask({ id: 'task-lost', swimlane_id: 'lane-review' })]);
      });
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

      await resumeLost(sessionManager);

      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
      expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    });
  });

  it('does not resume a session the user reset during the preparation', async () => {
    seedLostSession(() => {
      dbRecords = [];
    });
    const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

    await resumeLost(sessionManager);

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  describe('a reset that only clears the task\'s session_id', () => {
    // A Reset leaves the record row and the task's lane unchanged and starts no
    // live session, so the record, lane and live-session checks all still pass.
    // What it changes is `task.session_id`, which it clears to null.
    //
    // Red-green: drop `current.session_id !== input.task.session_id` from the
    // re-check in resume-suspended.ts and the first test spawns over the reset.
    const gatheredTask = () => makeTask({ id: 'task-lost', swimlane_id: 'lane-exec', session_id: 'rec-lost' });

    it('does not resume a task whose session_id was cleared during the preparation, and writes nothing', async () => {
      seedLostSession(() => {
        taskRepoList.mockReturnValue([{ ...gatheredTask(), session_id: null }]);
      });
      // The row the gather read still points at the lost session.
      taskRepoList.mockReturnValue([gatheredTask()]);
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

      await resumeLost(sessionManager);

      expect(vi.mocked(prepareAgentSpawn)).toHaveBeenCalledTimes(1);
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(taskRepoUpdateMock).not.toHaveBeenCalled();
      expect(sessionRepoInsert).not.toHaveBeenCalled();
      expect(retireRecordMock).not.toHaveBeenCalled();
      expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    });

    it('still resumes a task whose non-null session_id is unchanged, so the check is not just refusing every such task', async () => {
      seedLostSession();
      taskRepoList.mockReturnValue([gatheredTask()]);
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);

      await resumeLost(sessionManager);

      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      // The write spies are wired: the resume records the new session on the task.
      expect(taskRepoUpdateMock).toHaveBeenCalledWith({ id: 'task-lost', session_id: 'new-task-lost' });
      expect(sessionRepoInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('a spawn a teardown cancelled', () => {
    // A teardown that ends a session while it spawns (a move, a reset, a project
    // close) rejects the spawn with an AbortError: the canceller took the task
    // over. The pass logs that as a cancellation. "Spawn failed" read as a crash.
    // The record is retired either way, as before.
    //
    // Red-green: drop the `isAbortError` branch in resume-suspended.ts and the
    // first test sees console.error.
    let consoleError: MockInstance<typeof console.error>;
    let consoleLog: MockInstance<typeof console.log>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    });

    it('logs a resume a teardown cancelled as cancelled, not as a failure, and still retires its record', async () => {
      seedLostSession();
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);
      sessionManager.spawn.mockImplementation(async () => {
        throw new DOMException('The session was ended while it was being spawned', 'AbortError');
      });

      await resumeLost(sessionManager);

      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Spawn cancelled for session rec-lost'));
      expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'rec-lost');
      expect(sessionRepoInsert).not.toHaveBeenCalled();
    });

    it('still reports any other rejection as a failure', async () => {
      seedLostSession();
      const sessionManager = managerOver([{ id: 'rec-lost', taskId: 'task-lost', status: 'exited' }]);
      const failure = new Error('the pty host refused the spawn');
      sessionManager.spawn.mockImplementation(async () => {
        throw failure;
      });

      await resumeLost(sessionManager);

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Spawn failed for session rec-lost'), failure);
      expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'rec-lost');
    });
  });
});
