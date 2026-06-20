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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord, Task } from '../../src/shared/types';

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
    getById = vi.fn(() => null);
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

      // Resume was requested with the ORIGINAL conversation id.
      expect(prepareAgentSpawn).toHaveBeenCalledTimes(1);
      expect(prepareAgentSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: { agentSessionId: INCIDENT_172_AGENT_SESSION_ID },
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
