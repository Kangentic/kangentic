/**
 * Startup recovery of a task whose agent runs on an SSH host, with the host or its link down (#913).
 * `ssh-remote.md` says nothing is pruned, demoted, retired or deleted for want of a host, and this is
 * where that is tested for the cold-open recovery pass (`resumeSuspendedSessions`):
 *
 * - A resume that cannot be prepared because the host cannot be asked keeps the conversation resumable.
 *   This is the case a link that is down reaches: preparation needs the host's details first.
 * - A spawn that THROWS for a remote task keeps the record resumable, where one on this computer that
 *   throws still retires it. A PTY spawn that reaches the host and fails does not throw: it resolves with
 *   an exited session (`handleSpawnFailure`), which is the same for a local task and not covered here.
 * - Neither touches the task row, spawns an agent beside the paused one, or demotes a worktree.
 *
 * What a user loses if it breaks: they close the laptop on a train, reopen Kangentic with the host out of
 * reach, and every remote task's paused card is now an ended one, or a fresh agent starts beside the
 * conversation that is still running on the host.
 *
 * The harness mocks the repositories like `resume-suspended-expired-recap.test.ts`, which pins the
 * spawn pass for a local project; the sessions and the lock are the real code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

const sessionRepoGetResumable = vi.fn(() => [] as SessionRecord[]);
const sessionRepoInsertMock = vi.fn();
const taskRepoList = vi.fn(() => [] as Task[]);
const taskRepoUpdateMock = vi.fn();
const swimlaneRepoList = vi.fn(() => [] as Swimlane[]);
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
    getOrphaned = () => [] as SessionRecord[];
    getInterruptedExited = () => [] as SessionRecord[];
    markAllRunningAsOrphaned = vi.fn();
    markRunningAsOrphanedExcluding = vi.fn();
    getLatestForTaskByTypeAndIsolation = () => latestForTaskByTypeAndIsolation();
    findByAnyId = (recordId: string): SessionRecord | undefined => sessionRepoGetResumable().find((record) => record.id === recordId);
    insert = (...args: unknown[]) => sessionRepoInsertMock(...args);
    updateAppliedSettings = vi.fn();
  }
  return { SessionRepository: FakeSessionRepository };
});

vi.mock('../../src/main/db/repositories/task-repository', () => {
  class FakeTaskRepository {
    listCappedColumnTasks() { return []; }
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

import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'claude',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-session-1',
    command: 'claude --task test',
    cwd: '/shell/remote-project',
    permission_mode: 'default',
    prompt: null,
    status: 'suspended',
    exit_code: null,
    started_at: '2026-11-03T10:00:00.000Z',
    suspended_at: '2026-11-03T11:00:00.000Z',
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

function makeTask(): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Fix the build on the host',
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
    created_at: '2026-11-03T10:00:00.000Z',
    updated_at: '2026-11-03T10:00:00.000Z',
  } as Task;
}

function makeLane(): Swimlane {
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
  } as Swimlane;
}

function preparedSpawn(remote: boolean) {
  return {
    ok: true,
    data: {
      adapter: { name: 'claude', sessionType: 'claude_agent', removeHooks: vi.fn(), getExitSequence: () => ['\x03'] },
      agent: 'claude',
      command: 'claude --resume agent-session-1',
      cwd: '/shell/remote-project',
      sessionRecordId: 'prepared-session',
      agentSessionId: 'agent-session-1',
      permissionMode: 'default',
      statusOutputPath: '/shell/status.json',
      eventsOutputPath: '/shell/events.jsonl',
      extraEnv: null,
      appliedModel: null,
      appliedEffort: null,
      resumed: true,
      prompt: null,
      startOver: null,
      expiredLastActiveAt: null,
      ...(remote ? { remote: { hostId: 'host-1', cwd: '/home/dev/api' } } : {}),
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

async function runRecovery(sessionManager: ReturnType<typeof makeSessionManager>): Promise<void> {
  await resumeSuspendedSessions(
    'proj-1',
    '/shell',
    sessionManager as never,
    { load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: true } })), getEffectiveConfig: vi.fn(() => ({ agent: {} })) } as never,
    null,
    null,
    null,
    null,
    [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareAgentSpawnMock.mockReset();
  retireRecordMock.mockReturnValue(true);
  sessionRepoGetResumable.mockReturnValue([makeRecord()]);
  taskRepoList.mockReturnValue([makeTask()]);
  swimlaneRepoList.mockReturnValue([makeLane()]);
  latestForTaskByTypeAndIsolation.mockReturnValue(makeRecord());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  latestForTaskByTypeAndIsolation.mockReturnValue(null);
  vi.restoreAllMocks();
});

describe('startup recovery of a task on a host that cannot be reached', () => {
  it('keeps the conversation resumable when the resume cannot be prepared, and changes nothing else', async () => {
    prepareAgentSpawnMock.mockRejectedValue(new Error('Kangentic has no connection to host-1 right now'));
    const sessionManager = makeSessionManager();

    await runRecovery(sessionManager);

    expect(retireRecordMock).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }));
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(sessionRepoInsertMock).not.toHaveBeenCalled();
    expect(taskRepoUpdateMock).not.toHaveBeenCalled();
  });

  it('keeps the conversation resumable when the spawn onto the host throws', async () => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn(true));
    const sessionManager = makeSessionManager();
    sessionManager.spawn.mockRejectedValue(new Error('Kangentic has no connection to host-1 right now'));

    await runRecovery(sessionManager);

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(retireRecordMock).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }));
    expect(sessionRepoInsertMock).not.toHaveBeenCalled();
    expect(taskRepoUpdateMock).not.toHaveBeenCalled();
  });

  it('still retires the record when a spawn on this computer throws: the behavior a local project always had', async () => {
    prepareAgentSpawnMock.mockResolvedValue(preparedSpawn(false));
    const sessionManager = makeSessionManager();
    sessionManager.spawn.mockRejectedValue(new Error('spawn ENOENT'));

    await runRecovery(sessionManager);

    expect(retireRecordMock).toHaveBeenCalledWith(expect.anything(), 'record-1');
  });
});
