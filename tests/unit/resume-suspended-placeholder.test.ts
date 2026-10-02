/**
 * A suspended session in a non-auto-spawn CUSTOM column keeps its Resume button.
 *
 * The renderer decides both the click target and the Resume control from whether
 * a session exists in its store, and that store is fed from the in-memory
 * registry, not the DB. A session that exists only as a DB row is invisible
 * unless startup registers a placeholder for it.
 *
 * `resumeSuspendedSessions`' `!auto_spawn` branch fires BEFORE either of the two
 * placeholder branches, and its `status === 'suspended'` case used to do nothing
 * at all: no CAS, no retire, no placeholder. The record silently vanished. The
 * task then presented exactly like a To Do card - clicking it opened the edit
 * form, and there was no Resume anywhere - even though `SESSION_RESUME` is
 * perfectly willing to resume there (it rejects only role 'todo').
 *
 * This is independent of any column edit: it strands ANY task with a suspended
 * session in ANY non-auto-spawn custom column, after any restart.
 *
 * The guard is the column's ROLE, not its auto_spawn flag: To Do and Done are
 * both auto_spawn=0 by default and both deliberately hide Resume, and a To Do
 * card additionally relies on having NO session so it opens straight into the
 * edit form.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetInterruptedExited = vi.fn(() => [] as SessionRecord[]);
const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();
// The task as it is stored NOW. A give-up re-reads it under the task lock, so a
// test that changes the task during the preparation overrides this one, and the
// file's beforeEach puts the default back.
const storedTaskDefault = (taskId: string): Task | null => taskRepoList().find((task) => task.id === taskId) ?? null;
const taskRepoGetById = vi.fn(storedTaskDefault);
// The record as it is stored NOW, read the same way. Defaults to the gathered one.
const storedRecordDefault = (recordId: string): SessionRecord | null => (
  [...sessionRepoGetResumable(), ...sessionRepoGetOrphaned(), ...sessionRepoGetInterruptedExited()]
    .find((record) => record.id === recordId) ?? null
);
const sessionRepoFindByAnyId = vi.fn(storedRecordDefault);
const swimlaneRepoList = vi.fn(() => [] as Swimlane[]);
// The record a resume would continue. None by default, so a record that reaches
// the preparation pass has no conversation to resume there.
const latestForTaskByTypeAndIsolation = vi.fn((): SessionRecord | null => null);

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({}) as never) }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));

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
    markAllRunningAsOrphaned = vi.fn();
    markRunningAsOrphanedExcluding = vi.fn();
    getLatestForTaskByTypeAndIsolation = () => latestForTaskByTypeAndIsolation();
    findByAnyId = (recordId: string) => sessionRepoFindByAnyId(recordId);
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = () => taskRepoList();
    getById = (taskId: string) => taskRepoGetById(taskId);
    update = (...args: unknown[]) => taskRepoUpdateMock(...args);
  }
  return { TaskRepository: FakeTaskRepository };
});

vi.mock('../../src/main/db/repositories/swimlane-repository', () => {
  class FakeSwimlaneRepository {
    list = () => swimlaneRepoList();
    getById = vi.fn(() => swimlaneRepoList()[0]);
  }
  return { SwimlaneRepository: FakeSwimlaneRepository };
});

// Returns undefined, so any record that reaches the preparation pass fails
// there. Records under test are all filtered out before it; the one exception
// asserts on this mock precisely to prove it got that far.
const prepareAgentSpawnMock = vi.fn();
vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: (...args: unknown[]) => prepareAgentSpawnMock(...args),
}));
vi.mock('../../src/main/transition-engine/spawn-intent', () => ({
  // The real rule's core: a record with an agent session id can be resumed.
  isResumeEligible: (record: SessionRecord | null | undefined) => !!record?.agent_session_id,
}));

// column-strategy and session-isolation are deliberately left UNMOCKED: the
// profile fold and the isolation key are part of what this branch must get right.
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
// The real lock, which the file leaves unmocked: one test holds it as a Resume does.
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'claude',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-session-1',
    command: 'claude --task test',
    cwd: '/project/cwd',
    permission_mode: 'default',
    prompt: null,
    status: 'suspended',
    exit_code: null,
    started_at: '2026-07-30T10:00:00.000Z',
    suspended_at: '2026-07-30T11:00:00.000Z',
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
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

/** A column with auto_spawn off. `role: null` is a CUSTOM column. */
function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Planning',
    role: null,
    auto_spawn: false,
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    plan_exit_target_id: null,
    ...overrides,
  } as Swimlane;
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(),
    getShell: vi.fn(async () => '/bin/sh'),
    // No live session holds the task, unless a test says one does.
    findLiveSessionByTaskId: vi.fn((): { id: string } | undefined => undefined),
  };
}

/** Auto-resume ON by default, so the placeholder cannot come from that branch. */
function makeConfigManager(autoResumeSessionsOnRestart = true) {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

async function runResume(sessionManager: ReturnType<typeof makeSessionManager>, autoResume = true) {
  await resumeSuspendedSessions(
    'proj-1',
    '/project',
    sessionManager as never,
    makeConfigManager(autoResume) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  markRecordSuspendedMock.mockReturnValue(true);
  retireRecordMock.mockReturnValue(true);
  sessionRepoGetResumable.mockReturnValue([]);
  sessionRepoGetOrphaned.mockReturnValue([]);
  sessionRepoGetInterruptedExited.mockReturnValue([]);
  taskRepoList.mockReturnValue([makeTask()]);
  taskRepoGetById.mockImplementation(storedTaskDefault);
  sessionRepoFindByAnyId.mockImplementation(storedRecordDefault);
  swimlaneRepoList.mockReturnValue([makeLane()]);
});

describe('resumeSuspendedSessions: a suspended record in a non-auto-spawn column', () => {
  it('registers a placeholder in a CUSTOM column, so Resume is reachable', async () => {
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'proj-1',
      cwd: '/project/cwd',
    });
    // Never a fresh spawn: this column does not want agents, it just must not
    // hide the session that is already there.
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('clears task.session_id so SESSION_RESUME can spawn rather than hand back a stale ref', async () => {
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    taskRepoList.mockReturnValue([makeTask({ session_id: 'stale-session' })]);

    await runResume(makeSessionManager());

    expect(taskRepoUpdateMock).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
  });

  it('registers a placeholder for a user-paused record too', async () => {
    // The reporter's own task was user-paused. The pause stays sticky against
    // an auto-spawn, but it must still be visible and resumable by hand.
    sessionRepoGetResumable.mockReturnValue([makeRecord({ suspended_by: 'user' })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
  });

  it('registers nothing in To Do', async () => {
    // To Do hides Resume by design, and a To Do card relies on having no session
    // so that clicking it opens the edit form (TaskCard's initialEdit).
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    swimlaneRepoList.mockReturnValue([makeLane({ role: 'todo', name: 'To Do' })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });

  it('registers nothing in Done', async () => {
    // Done is NOT excluded by the renderer: `canToggle` gates on isInTodo only,
    // and SESSION_RESUME throws only for role 'todo'. So a placeholder here
    // WOULD surface a Resume button on a Done card. The guard has to be here.
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    swimlaneRepoList.mockReturnValue([makeLane({ role: 'done', name: 'Done' })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });

  it('upgrades an OS-killed record and registers a placeholder for it', async () => {
    // An 'exited' record already became resumable here; it was just as invisible
    // as the suspended one afterwards.
    sessionRepoGetInterruptedExited.mockReturnValue([
      makeRecord({ status: 'exited', exit_code: 1, suspended_by: null }),
    ]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'record-1', 'system');
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
  });

  it('registers nothing when the OS-killed upgrade loses its CAS', async () => {
    // A concurrent retire won the race, so there is no longer a resumable record
    // to advertise.
    sessionRepoGetInterruptedExited.mockReturnValue([
      makeRecord({ status: 'exited', exit_code: 1, suspended_by: null }),
    ]);
    markRecordSuspendedMock.mockReturnValue(false);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });

  it('still retires a crashed record, with no placeholder (regression guard)', async () => {
    // Pre-existing behavior that the fix must not widen: an orphaned record in a
    // non-auto-spawn column is not resumable, so it is retired, not advertised.
    sessionRepoGetOrphaned.mockReturnValue([makeRecord({ status: 'orphaned', suspended_by: null })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'record-1');
    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });

  it('still processes a record whose column is missing (regression guard)', async () => {
    // The `resolvedLane &&` short-circuit: a task whose column no longer exists
    // was never excluded, so it must fall through to the normal resume path
    // rather than being caught by the new placeholder branch.
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    swimlaneRepoList.mockReturnValue([]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    // Reaching the preparation pass is the proof it was not caught by the
    // !auto_spawn branch at all. (The mocked preparation fails, and a failed
    // preparation keeps the record resumable, so a placeholder may follow it,
    // never precede it.)
    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expectNoPlaceholderBeforePreparation(sessionManager);
  });

  it('leaves an auto-spawn column to the normal resume path', async () => {
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expectNoPlaceholderBeforePreparation(sessionManager);
  });
});

/** No placeholder came from a branch ahead of the preparation pass. */
function expectNoPlaceholderBeforePreparation(sessionManager: ReturnType<typeof makeSessionManager>): void {
  const preparedAt = prepareAgentSpawnMock.mock.invocationCallOrder[0];
  expect(preparedAt).toBeDefined();
  expect(sessionManager.registerSuspendedPlaceholder.mock.invocationCallOrder.every((order) => order > preparedAt)).toBe(true);
}

/**
 * A resume that cannot be prepared keeps its conversation: the record stays
 * resumable (suspended, by the system), the card shows Resume, and the next
 * launch tries again. Retired, it let the auto-spawn pass start a fresh agent
 * over the task, after a crash and at startup alike.
 *
 * Red-green: put `retireRecord(sessionRepo, record.id)` back in either
 * preparation-failure branch of resume-suspended.ts and the retire and
 * placeholder assertions go red.
 */
describe('resumeSuspendedSessions: a resume whose preparation fails', () => {
  beforeEach(() => {
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    // There is a conversation to resume.
    latestForTaskByTypeAndIsolation.mockReturnValue(makeRecord());
  });

  afterEach(() => {
    // `clearAllMocks` in the file's beforeEach keeps an implementation.
    prepareAgentSpawnMock.mockReset();
    latestForTaskByTypeAndIsolation.mockReturnValue(null);
  });

  // Nothing to keep: a record with no agent session id yet is retired as before,
  // so the auto-spawn pass can start the task fresh, which is all a resume of it
  // could have done. A placeholder there would offer a Resume with nothing behind it.
  //
  // Red-green: keep every record resumable whatever `canResume` says and the
  // retire and no-placeholder assertions go red.
  it('retires a record with no conversation to keep, and registers no placeholder', async () => {
    latestForTaskByTypeAndIsolation.mockReturnValue(null);
    sessionRepoGetOrphaned.mockReturnValue([makeRecord({ status: 'orphaned', suspended_by: null, agent_session_id: null })]);
    prepareAgentSpawnMock.mockResolvedValue({ ok: false, reason: 'cli-not-found' });
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'record-1');
    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
  });

  it('keeps an orphaned record resumable when the agent cannot be found, and retires nothing', async () => {
    sessionRepoGetOrphaned.mockReturnValue([makeRecord({ status: 'orphaned', suspended_by: null })]);
    prepareAgentSpawnMock.mockResolvedValue({ ok: false, reason: 'cli-not-found' });
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'record-1', 'system');
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({ taskId: 'task-1', projectId: 'proj-1', cwd: '/project/cwd' });
    expect(retireRecordMock).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('keeps a record resumable when the preparation throws', async () => {
    sessionRepoGetInterruptedExited.mockReturnValue([makeRecord({ status: 'exited', exit_code: 1, suspended_by: null })]);
    prepareAgentSpawnMock.mockRejectedValue(new Error('agent detection failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sessionManager = makeSessionManager();
    try {
      await runResume(sessionManager);
    } finally {
      consoleError.mockRestore();
    }

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'record-1', 'system');
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(retireRecordMock).not.toHaveBeenCalled();
  });

  it('registers a placeholder for an already suspended record with no upgrade, and clears the task\'s stale session ref', async () => {
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    taskRepoList.mockReturnValue([makeTask({ session_id: 'stale-session' })]);
    prepareAgentSpawnMock.mockResolvedValue({ ok: false, reason: 'unknown-agent' });
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
    expect(retireRecordMock).not.toHaveBeenCalled();
  });

  it('registers nothing when the upgrade loses its CAS', async () => {
    sessionRepoGetOrphaned.mockReturnValue([makeRecord({ status: 'orphaned', suspended_by: null })]);
    prepareAgentSpawnMock.mockResolvedValue({ ok: false, reason: 'cli-not-found' });
    markRecordSuspendedMock.mockReturnValue(false);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });
});

/**
 * The give-up of a resume that has a conversation awaited the shell and agent
 * detection, so a Resume, a move or a reset may own the task by the time it
 * settles. It settles under the task lock, against the task and record as they
 * are then (`keepResumableIfUnchanged`), and keeps nothing that moved on. Each
 * change below is made INSIDE the mocked preparation, the only moment it can
 * happen, so what the give-up read before it is not what it acts on.
 *
 * Every "keeps nothing" case would otherwise take the keep path, which writes the
 * CAS, the placeholder and the task's `session_id`: the task starts with a stale
 * `session_id` so that last write would show.
 */
describe('resumeSuspendedSessions: a failed preparation settles against what changed meanwhile', () => {
  const consoleSpies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    // There is a conversation to resume, so the give-up keeps rather than retires.
    latestForTaskByTypeAndIsolation.mockReturnValue(makeRecord());
    sessionRepoGetOrphaned.mockReturnValue([makeRecord({ status: 'orphaned', suspended_by: null })]);
    taskRepoList.mockReturnValue([makeTask({ session_id: 'stale-session' })]);
    consoleSpies.push(
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    prepareAgentSpawnMock.mockReset();
    latestForTaskByTypeAndIsolation.mockReturnValue(null);
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  /** A preparation that changes the world, then fails to find the agent CLI. */
  async function runFailedPreparation(
    duringPreparation: (sessionManager: ReturnType<typeof makeSessionManager>) => void,
  ): Promise<ReturnType<typeof makeSessionManager>> {
    const sessionManager = makeSessionManager();
    prepareAgentSpawnMock.mockImplementation(async () => {
      duringPreparation(sessionManager);
      return { ok: false, reason: 'cli-not-found' };
    });

    await runResume(sessionManager);

    // The give-up ran and re-read the task under the lock, so a "nothing kept"
    // result below is the re-check's doing and not a path that never got there.
    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expect(taskRepoGetById).toHaveBeenCalledWith('task-1');
    return sessionManager;
  }

  function expectNothingKept(sessionManager: ReturnType<typeof makeSessionManager>): void {
    expect(markRecordSuspendedMock).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
    expect(taskRepoUpdateMock).not.toHaveBeenCalled();
    // Nor retired: the record is left exactly as the change left it.
    expect(retireRecordMock).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  }

  // Red-green: drop `recordNow.status !== record.status` from
  // keepResumableIfUnchanged and the exited record is CAS'd back to suspended
  // (markRecordSuspended called) and gets a placeholder under the live agent.
  it('keeps nothing when the record changed status, as a Resume leaves it (orphaned, now exited)', async () => {
    const sessionManager = await runFailedPreparation(() => {
      sessionRepoFindByAnyId.mockReturnValue(makeRecord({ status: 'exited', suspended_by: null, exited_at: '2026-07-30T12:00:00.000Z' }));
    });

    expectNothingKept(sessionManager);
  });

  // Red-green: drop `current.session_id !== task.session_id` and the keep path
  // runs: the CAS, the placeholder and a write clearing the new session's ref.
  it('keeps nothing when the task\'s session_id changed (a Resume put a session on it)', async () => {
    const sessionManager = await runFailedPreparation(() => {
      taskRepoGetById.mockReturnValue(makeTask({ session_id: 'resumed-session' }));
    });

    expectNothingKept(sessionManager);
  });

  // Red-green: drop `sessionManager.findLiveSessionByTaskId(task.id)` from the
  // re-check and the live agent's task gets a placeholder and a cleared session_id.
  it('keeps nothing when a live session holds the task', async () => {
    const sessionManager = await runFailedPreparation((manager) => {
      manager.findLiveSessionByTaskId.mockReturnValue({ id: 'live-session' });
    });

    expectNothingKept(sessionManager);
    expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledWith('task-1');
  });

  // Done has auto_spawn off, so only the RESUME_HIDDEN_ROLES clause refuses it.
  //
  // Red-green: drop `hidesResume` from the moved-column check and the task is
  // kept in Done, where a placeholder would surface a Resume button.
  it('keeps nothing when the task moved into a Done column', async () => {
    swimlaneRepoList.mockReturnValue([
      makeLane({ id: 'lane-1', auto_spawn: true }),
      makeLane({ id: 'lane-done', name: 'Done', role: 'done', auto_spawn: false }),
    ]);

    const sessionManager = await runFailedPreparation(() => {
      taskRepoGetById.mockReturnValue(makeTask({ swimlane_id: 'lane-done', session_id: 'stale-session' }));
    });

    expectNothingKept(sessionManager);
  });

  // The give-up waits for the task's lock. A Resume holds it while it retires this
  // record and starts its agent, and what it wrote must be there when the give-up
  // reads. Every case above changes the world INSIDE the preparation, before the
  // give-up starts, so each would pass for a give-up that never took the lock. This
  // one changes it from a holder the give-up has to queue behind.
  //
  // Red-green: call `keepResumableIfUnchanged` directly in `giveUpPreparation`
  // (resume-suspended.ts), with no `withTaskLock`. The give-up then reads the
  // record while the holder still owns the task and takes the keep path
  // (markRecordSuspended is called), so the assertions before the release go red.
  it('settles under the task lock: it waits for a holder of the task, then reads what the holder left', async () => {
    let releaseHolder: () => void = () => undefined;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const sessionManager = makeSessionManager();
    prepareAgentSpawnMock.mockImplementation(async () => {
      // A Resume takes the lock while this resume is being prepared, and before it
      // lets go it has retired the record.
      void withTaskLock('task-1', async () => {
        await holderGate;
        sessionRepoFindByAnyId.mockReturnValue(makeRecord({ status: 'exited', suspended_by: null, exited_at: '2026-07-30T12:00:00.000Z' }));
      });
      return { ok: false, reason: 'cli-not-found' };
    });

    try {
      const run = runResume(sessionManager);
      await vi.waitFor(() => expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1));
      // Intentional fixed wait: this asserts a non-occurrence, which cannot be
      // polled. The give-up is microtask work end to end (it makes no timer), so a
      // give-up that was not queued behind the holder has finished by the time one
      // macrotask has passed.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(markRecordSuspendedMock).not.toHaveBeenCalled();
      expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
      expect(taskRepoUpdateMock).not.toHaveBeenCalled();

      releaseHolder();
      await run;

      // It ran once the holder let go, and read the record the holder left.
      expect(taskRepoGetById).toHaveBeenCalledWith('task-1');
      expectNothingKept(sessionManager);
    } finally {
      // A failed assertion above must not leave the lock held for the next test.
      releaseHolder();
    }
  });

  // The positive control for the four above: the same give-up, moved into a
  // column that starts no agent and does not hide Resume, still keeps. Without it
  // those four would also pass against a give-up that never keeps anything.
  //
  // Red-green: make keepResumableIfUnchanged return false for a moved task and
  // the CAS, placeholder and session_id assertions go red.
  it('keeps the record resumable when the task moved into a custom column that starts no agent', async () => {
    swimlaneRepoList.mockReturnValue([
      makeLane({ id: 'lane-1', auto_spawn: true }),
      makeLane({ id: 'lane-manual', name: 'Manual', role: null, auto_spawn: false }),
    ]);

    const sessionManager = await runFailedPreparation(() => {
      taskRepoGetById.mockReturnValue(makeTask({ swimlane_id: 'lane-manual', session_id: 'stale-session' }));
    });

    expect(markRecordSuspendedMock).toHaveBeenCalledWith(expect.anything(), 'record-1', 'system');
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({ taskId: 'task-1', projectId: 'proj-1', cwd: '/project/cwd' });
    expect(taskRepoUpdateMock).toHaveBeenCalledWith({ id: 'task-1', session_id: null });
    expect(retireRecordMock).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });
});

describe('resumeSuspendedSessions scoped to the sessions a pty host crash took down', () => {
  it('recovers only the lost session, not an earlier abnormal exit or a session suspended this run, and orphans nothing', async () => {
    // Mid-run the gather also finds records the host never held. A host crash
    // must not wake them: that spends tokens and changes the board unasked.
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-lost' }),
      makeTask({ id: 'task-earlier' }),
      makeTask({ id: 'task-suspended' }),
    ]);
    sessionRepoGetInterruptedExited.mockReturnValue([
      makeRecord({ id: 'lost', task_id: 'task-lost', status: 'exited', exit_code: -2, suspended_by: null }),
      makeRecord({ id: 'earlier', task_id: 'task-earlier', status: 'exited', exit_code: 1, suspended_by: null }),
    ]);
    sessionRepoGetResumable.mockReturnValue([makeRecord({ id: 'suspended', task_id: 'task-suspended' })]);
    const sessionManager = makeSessionManager();

    await resumeSuspendedSessions(
      'proj-1',
      '/project',
      sessionManager as never,
      makeConfigManager(true) as never,
      null,
      null,
      null,
      null,
      [],
      new Set(['lost']),
    );

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expect(prepareAgentSpawnMock).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: 'task-lost' }) }));
    // The other two records are left exactly as they were. (The mocked
    // preparation fails, so only 'lost' itself is retired.)
    const touchedRecordIds = [...retireRecordMock.mock.calls, ...markRecordSuspendedMock.mock.calls]
      .map((call) => (call as unknown[])[1]);
    expect(touchedRecordIds).not.toContain('earlier');
    expect(touchedRecordIds).not.toContain('suspended');
  });

  it('without a scope recovers all three, as startup always has', async () => {
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-lost' }),
      makeTask({ id: 'task-earlier' }),
      makeTask({ id: 'task-suspended' }),
    ]);
    sessionRepoGetInterruptedExited.mockReturnValue([
      makeRecord({ id: 'lost', task_id: 'task-lost', status: 'exited', exit_code: -2, suspended_by: null }),
      makeRecord({ id: 'earlier', task_id: 'task-earlier', status: 'exited', exit_code: 1, suspended_by: null }),
    ]);
    sessionRepoGetResumable.mockReturnValue([makeRecord({ id: 'suspended', task_id: 'task-suspended' })]);

    await runResume(makeSessionManager());

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(3);
  });
});
