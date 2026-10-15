/**
 * Startup recovery of a session whose conversation the agent deleted
 * (`resumeSuspendedSessions`, src/main/transition-engine/session-startup/resume-suspended.ts).
 * `prepareAgentSpawn` decides the start-over and builds the recap
 * (`startOver: 'expired'`, a `prompt`, `expiredLastActiveAt`); this file pins
 * what the SPAWN PASS does with that prepared spawn, which nothing else covers
 * because every other recovery test mocks the preparation to fail or to resume:
 *
 * - The spawn is seeded as a prompted one (`resuming: false`), because the
 *   recap is its whole opening prompt and the agent works on it at once. A
 *   resume or a never-started fresh spawn carries no prompt and seeds idle
 *   (`resuming: true`), the documented orphan-recovery contract.
 * - The inserted session record keeps the recap as its `prompt`.
 * - `onConversationExpired` is told once, with the task and the date the deleted
 *   conversation last ran. A never-started or ordinary resume never calls it.
 * - The new session is marked a recap session (`markRecapSession`), so its first
 *   turn end runs no On agent turn end rows. Main and isolated sessions alike:
 *   startup builds the recap as the whole prompt for both.
 * - The project's team-shared default base branch reaches `prepareAgentSpawn`,
 *   where it picks the recap's base ref.
 * - The recap's sources are the project's own (`createExpiredRecapSources(projectId)`),
 *   built once per pass and handed to every record's preparation, so a recap
 *   reads the old conversation's tail and the branch state for real. A
 *   preparation handed none would build every recap bare.
 *
 * `recap-turns` is left real and read back through `isRecapTurn`, so the mark is
 * observed rather than assumed; its module-level map is cleared before each test.
 * `expired-recap-sources` is wrapped, not replaced: the real factory still runs,
 * and the wrapper only records the project id it was asked for and what it built.
 *
 * Red-green: change `resuming: !input.prompt` to `true`, delete the
 * `markRecapSession(newSession.id)` line, delete the `onConversationExpired?.(...)`
 * call or change its fields, drop `prompt: input.prompt ?? null` from
 * the insert, delete `boardDefaultBaseBranch,` from the `prepareAgentSpawn`
 * input, delete `recapSources,` from it, change `createExpiredRecapSources(projectId)`
 * to another id, or move it inside the per-record loop, and the matching test
 * below fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetOrphaned = vi.fn(() => [] as SessionRecord[]);
const sessionRepoGetInterruptedExited = vi.fn(() => [] as SessionRecord[]);
const sessionRepoInsertMock = vi.fn();
const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();
const swimlaneRepoList = vi.fn(() => [] as Swimlane[]);
// The record a resume would continue, so the recovered record has a conversation.
const latestForTaskByTypeAndIsolation = vi.fn((): SessionRecord | null => null);

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({}) as never) }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));

const retireRecordMock = vi.fn(() => true);
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: vi.fn(() => true),
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
    // The spawn pass confirms the record is unchanged: answers with the gathered one.
    findByAnyId = (recordId: string): SessionRecord | undefined => (
      [...sessionRepoGetResumable(), ...sessionRepoGetOrphaned(), ...sessionRepoGetInterruptedExited()]
        .find((record) => record.id === recordId)
    );
    insert = (...args: unknown[]) => sessionRepoInsertMock(...args);
    updateAppliedSettings = vi.fn();
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    list = () => taskRepoList();
    getById = (taskId: string) => taskRepoList().find((task) => task.id === taskId) ?? null;
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

const prepareAgentSpawnMock = vi.fn();
vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({
  prepareAgentSpawn: (...args: unknown[]) => prepareAgentSpawnMock(...args),
}));
vi.mock('../../src/main/transition-engine/spawn-intent', () => ({
  isResumeEligible: (record: SessionRecord | null | undefined) => !!record?.agent_session_id,
}));

// The REAL factory still runs (so the sources are the shipped ones); the wrapper
// only records which project it was asked for and what it built.
const recapSourcesFactory = vi.hoisted(() => ({
  projectIds: [] as string[],
  built: [] as unknown[],
}));
vi.mock('../../src/main/transition-engine/expired-recap-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/transition-engine/expired-recap-sources')>();
  return {
    ...actual,
    createExpiredRecapSources: (projectId: string) => {
      const sources = actual.createExpiredRecapSources(projectId);
      recapSourcesFactory.projectIds.push(projectId);
      recapSourcesFactory.built.push(sources);
      return sources;
    },
  };
});

// column-strategy, session-isolation and recap-turns are deliberately left UNMOCKED.
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import { isRecapTurn, resetRecapSessionsForTests } from '../../src/main/automations/turn-end/recap-turns';

const RECAP = 'The agent deleted this task\'s earlier conversation. Summarize where the work stands, then wait.';
const EXPIRED_LAST_ACTIVE_AT = '2026-07-01T09:30:00.000Z';

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
    title: 'Resume after the cleanup window',
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

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Executing',
    role: null,
    auto_spawn: true,
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

/** A prepared spawn as `prepareAgentSpawn` returns it, ready for the spawn pass. */
function preparedSpawn(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      adapter: { name: 'claude', sessionType: 'claude_agent', removeHooks: vi.fn(), getExitSequence: () => ['\x03'] },
      agent: 'claude',
      command: 'claude --session-id agent-session-new',
      cwd: '/project/cwd',
      sessionRecordId: 'prepared-session',
      agentSessionId: 'agent-session-new',
      permissionMode: 'default',
      statusOutputPath: '/project/.kangentic/sessions/prepared-session/status.json',
      eventsOutputPath: '/project/.kangentic/sessions/prepared-session/events.jsonl',
      extraEnv: null,
      appliedModel: null,
      appliedEffort: null,
      resumed: false,
      prompt: null,
      startOver: null,
      expiredLastActiveAt: null,
      ...overrides,
    },
  };
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async () => ({ id: 'prepared-session', status: 'running' })),
    getShell: vi.fn(async () => '/bin/sh'),
    findLiveSessionByTaskId: vi.fn((): { id: string } | undefined => undefined),
  };
}

function makeConfigManager() {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: true } })),
    getEffectiveConfig: vi.fn(() => ({ agent: {} })),
  };
}

async function runRecovery(
  sessionManager: ReturnType<typeof makeSessionManager>,
  options?: Parameters<typeof resumeSuspendedSessions>[9],
): Promise<void> {
  await resumeSuspendedSessions(
    'proj-1',
    '/project',
    sessionManager as never,
    makeConfigManager() as never,
    null,
    null,
    null,
    null,
    [],
    options,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  recapSourcesFactory.projectIds.length = 0;
  recapSourcesFactory.built.length = 0;
  resetRecapSessionsForTests();
  prepareAgentSpawnMock.mockReset();
  retireRecordMock.mockReturnValue(true);
  sessionRepoGetResumable.mockReturnValue([makeRecord()]);
  sessionRepoGetOrphaned.mockReturnValue([]);
  sessionRepoGetInterruptedExited.mockReturnValue([]);
  taskRepoList.mockReturnValue([makeTask()]);
  swimlaneRepoList.mockReturnValue([makeLane()]);
  latestForTaskByTypeAndIsolation.mockReturnValue(makeRecord());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  latestForTaskByTypeAndIsolation.mockReturnValue(null);
  vi.restoreAllMocks();
  resetRecapSessionsForTests();
});

describe('resumeSuspendedSessions: a recovered session whose conversation expired', () => {
  const expiredSpawn = () => preparedSpawn({
    startOver: 'expired',
    prompt: RECAP,
    expiredLastActiveAt: EXPIRED_LAST_ACTIVE_AT,
  });

  it('spawns as a prompted session, not an idle resume', async () => {
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());
    const sessionManager = makeSessionManager();

    await runRecovery(sessionManager);

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      id: 'prepared-session',
      taskId: 'task-1',
      resuming: false,
    }));
  });

  it('records the recap as the new session\'s prompt', async () => {
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());

    await runRecovery(makeSessionManager());

    expect(sessionRepoInsertMock).toHaveBeenCalledTimes(1);
    expect(sessionRepoInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'prepared-session',
      task_id: 'task-1',
      prompt: RECAP,
      status: 'running',
    }));
  });

  it('tells the caller once, with the task and when the deleted conversation last ran', async () => {
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());
    const onConversationExpired = vi.fn();

    await runRecovery(makeSessionManager(), { onConversationExpired });

    expect(onConversationExpired).toHaveBeenCalledTimes(1);
    // Exact, so a field added, dropped or renamed fails.
    expect(onConversationExpired).toHaveBeenCalledWith({
      projectId: 'proj-1',
      taskId: 'task-1',
      taskTitle: 'Resume after the cleanup window',
      lastActiveAt: EXPIRED_LAST_ACTIVE_AT,
    });
  });

  it('marks the new session a recap session, so its first turn end runs no turn-end rows', async () => {
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());

    await runRecovery(makeSessionManager());

    // The session's opening turn began at the spawn, before it first went idle.
    expect(isRecapTurn('prepared-session', 1)).toBe(true);
    // The old record's id is not the session that carries the recap.
    expect(isRecapTurn('record-1', 1)).toBe(false);
  });

  it('marks an isolated session too, because startup builds the recap as the whole prompt for both', async () => {
    swimlaneRepoList.mockReturnValue([makeLane({ session_target: 'isolated' })]);
    sessionRepoGetResumable.mockReturnValue([makeRecord({ isolated_swimlane_id: 'lane-1' })]);
    latestForTaskByTypeAndIsolation.mockReturnValue(makeRecord({ isolated_swimlane_id: 'lane-1' }));
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());
    const sessionManager = makeSessionManager();
    const onConversationExpired = vi.fn();

    await runRecovery(sessionManager, { onConversationExpired });

    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      isolatedSwimlaneId: 'lane-1',
      resuming: false,
    }));
    expect(isRecapTurn('prepared-session', 1)).toBe(true);
    expect(onConversationExpired).toHaveBeenCalledTimes(1);
  });

  it('still marks the session when the caller passed no callback', async () => {
    prepareAgentSpawnMock.mockResolvedValue(expiredSpawn());

    await expect(runRecovery(makeSessionManager())).resolves.toBeUndefined();

    expect(isRecapTurn('prepared-session', 1)).toBe(true);
  });
});

describe('resumeSuspendedSessions: a recovered session that did not expire', () => {
  it.each([
    ['a conversation that never started', { startOver: 'never-started' }],
    ['an ordinary resume', { startOver: null, resumed: true }],
  ])('seeds %s idle, with no prompt, no notice and no recap mark', async (_label, overrides) => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn(overrides));
    const sessionManager = makeSessionManager();
    const onConversationExpired = vi.fn();

    await runRecovery(sessionManager, { onConversationExpired });

    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ id: 'prepared-session', resuming: true }));
    expect(sessionRepoInsertMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'prepared-session', prompt: null }));
    expect(onConversationExpired).not.toHaveBeenCalled();
    expect(isRecapTurn('prepared-session', 1)).toBe(false);
  });
});

describe('resumeSuspendedSessions: the default base branch for the recap', () => {
  it('hands the project\'s board default base branch to the spawn preparation', async () => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn());

    await runRecovery(makeSessionManager(), { boardDefaultBaseBranch: 'develop' });

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    expect(prepareAgentSpawnMock).toHaveBeenCalledWith(expect.objectContaining({ boardDefaultBaseBranch: 'develop' }));
  });

  it('passes none when the caller supplied none, leaving the config\'s default to decide', async () => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn());

    await runRecovery(makeSessionManager());

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    const preparationInput = prepareAgentSpawnMock.mock.calls[0][0] as { boardDefaultBaseBranch?: string | null };
    expect(preparationInput.boardDefaultBaseBranch ?? null).toBeNull();
  });
});

describe('resumeSuspendedSessions: the recap sources handed to the spawn preparation', () => {
  interface PreparationInput {
    recapSources?: {
      readTaskSummary?: unknown;
      readConversationTail?: unknown;
      readGitState?: unknown;
    };
  }
  const preparationInputOf = (callIndex: number): PreparationInput => (
    prepareAgentSpawnMock.mock.calls[callIndex][0] as PreparationInput
  );

  it('builds the sources for the project being recovered and hands that set to the preparation', async () => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn());

    await runRecovery(makeSessionManager());

    // The factory is asked for THIS project: a recap reads the index and the
    // old conversation's saved copy by project id.
    expect(recapSourcesFactory.projectIds).toEqual(['proj-1']);
    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(1);
    const { recapSources } = preparationInputOf(0);
    // The very set the factory built, not a copy or an empty stand-in.
    expect(recapSources).toBe(recapSourcesFactory.built[0]);
    // The two reads the recap cannot do without once the agent's file is gone.
    expect(recapSources?.readConversationTail).toEqual(expect.any(Function));
    expect(recapSources?.readGitState).toEqual(expect.any(Function));
  });

  it('builds one set per pass and shares it across every recovered task, so one slow worker read is paid once', async () => {
    sessionRepoGetResumable.mockReturnValue([
      makeRecord({ id: 'record-1', task_id: 'task-1' }),
      makeRecord({ id: 'record-2', task_id: 'task-2' }),
    ]);
    taskRepoList.mockReturnValue([
      makeTask({ id: 'task-1', display_id: 1 }),
      makeTask({ id: 'task-2', display_id: 2, title: 'A second task' }),
    ]);
    prepareAgentSpawnMock
      .mockResolvedValueOnce(preparedSpawn({ sessionRecordId: 'prepared-session-1' }))
      .mockResolvedValueOnce(preparedSpawn({ sessionRecordId: 'prepared-session-2' }));

    await runRecovery(makeSessionManager());

    expect(prepareAgentSpawnMock).toHaveBeenCalledTimes(2);
    // Built once, outside the per-record loop: a set per record would restart
    // the worker-wait budget for each expired task in turn.
    expect(recapSourcesFactory.built).toHaveLength(1);
    expect(preparationInputOf(0).recapSources).toBe(recapSourcesFactory.built[0]);
    expect(preparationInputOf(1).recapSources).toBe(recapSourcesFactory.built[0]);
  });
});
