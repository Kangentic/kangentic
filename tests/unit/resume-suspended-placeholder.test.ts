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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetInterruptedExited = vi.fn(() => [] as SessionRecord[]);
const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();
const swimlaneRepoList = vi.fn(() => [] as Swimlane[]);

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
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = () => taskRepoList();
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
  isResumeEligible: vi.fn(() => false),
}));

// column-strategy and session-isolation are deliberately left UNMOCKED: the
// profile fold and the isolation key are part of what this branch must get right.
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';

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

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
    // Reaching the preparation pass is the proof it was not caught by the
    // !auto_spawn branch at all.
    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an auto-spawn column to the normal resume path', async () => {
    sessionRepoGetResumable.mockReturnValue([makeRecord()]);
    swimlaneRepoList.mockReturnValue([makeLane({ auto_spawn: true })]);
    const sessionManager = makeSessionManager();

    await runResume(sessionManager);

    expect(sessionManager.registerSuspendedPlaceholder).not.toHaveBeenCalled();
  });
});
