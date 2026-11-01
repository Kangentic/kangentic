/**
 * The agent a new worktree's setup script lets start early: its launcher, its
 * preview of the spawn preamble, and the two helpers that choose how the
 * script and the agent overlap.
 *
 * - `createEarlyAgentLauncher` (src/main/ipc/helpers/agent-spawn.ts) is the one
 *   caller of `TransitionEngine.launchEarlyAgent`. It runs without the task
 *   lock, so every guard in it is the only thing between a column that must
 *   not start an agent and a hidden PTY nobody asked for. It launches nothing
 *   (returns null) unless the spawn the caller is about to make would start
 *   this agent fresh and first, and it never throws.
 * - `previewSpawnPreamble` (src/main/transition-engine/spawn-preamble.ts) is
 *   the preamble's lock computed on a COPY and written nowhere, because the
 *   launcher takes no task lock.
 * - `resolveInitScriptMode` and `setupStillRunningFor` pick the overlap mode
 *   from the project's `git.initScript` and `git.holdPromptForInitScript`, and
 *   decide whether the opening prompt carries the "setup is still running" note.
 *
 * Harness. `createTransitionEngine` is defined in agent-spawn.ts and called
 * from the launcher by its local binding, so it cannot be intercepted from
 * outside. The `TransitionEngine` class it constructs is replaced instead, by a
 * class whose instances share two spies (`agentStartsFirstOnEnter` and
 * `launchEarlyAgent`). The spawn-preamble module, the column strategy fold and
 * the worktree creation registry are real: the handoff and the lock need the
 * real resolver, and the registry is a pure in-memory map.
 *
 * Red-green:
 * - The refusal tests (session_id, auto_spawn, role, held pause,
 *   agentStartsFirstOnEnter, handoff) go red when the guard they name is
 *   removed, because the engine spy then records a launch. Each fixture differs
 *   from a launching baseline in exactly that one field, and each also asserts
 *   the step just before the guard ran, so a fixture that tripped an earlier
 *   guard cannot pass.
 * - The missing-task test goes red through its console.warn assertion: without
 *   the guard the catch still returns null, but it warns.
 * - explicitStart lifts exactly the auto_spawn and held-pause refusals.
 * - The "never throws" tests go red if a call moves outside the try or the
 *   `await` on `launchEarlyAgent` is dropped (the rejection then escapes).
 * - The preview tests go red if the preview mutates its input, or persists.
 * - The overlap-mode and setup-note tests go red on their own return values.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { BoardProfile, Project, Swimlane, Task } from '../../src/shared/types';
import type { SessionRecordStatus, SuspendedBy } from '../../src/shared/types';
import type { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';

const engineSpies = vi.hoisted(() => ({
  agentStartsFirstOnEnter: vi.fn(),
  launchEarlyAgent: vi.fn(),
  constructions: [] as unknown[][],
}));
const sessionRepositoryState = vi.hoisted(() => ({
  getLatestForTask: vi.fn(),
  constructions: [] as unknown[][],
}));
const mockGetProjectDb = vi.hoisted(() => vi.fn());
const mockLoadTaskProfile = vi.hoisted(() => vi.fn());

// The engine and the agent registry are stubbed so agent-spawn.ts loads without
// SessionManager -> node-pty and every agent adapter (same strategy as
// create-transition-engine-recap-wiring.test.ts).
vi.mock('../../src/main/transition-engine/transition-engine', () => ({
  TransitionEngine: class {
    constructor(...constructorArguments: unknown[]) {
      engineSpies.constructions.push(constructorArguments);
    }
    agentStartsFirstOnEnter = engineSpies.agentStartsFirstOnEnter;
    launchEarlyAgent = engineSpies.launchEarlyAgent;
  },
}));
vi.mock('../../src/main/transition-engine/expired-recap-sources', () => ({
  createExpiredRecapSources: vi.fn(() => ({})),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: mockGetProjectDb }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    constructor(...constructorArguments: unknown[]) {
      sessionRepositoryState.constructions.push(constructorArguments);
    }
    getLatestForTask = sessionRepositoryState.getLatestForTask;
  },
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: mockLoadTaskProfile,
}));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class {
    insert = vi.fn(() => ({ id: 'handoff-1' }));
    updateToSession = vi.fn();
  },
}));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageInBackground: vi.fn(),
}));
vi.mock('../../src/main/dev-ports/dev-port-allocator', () => ({
  getDevPortForTask: vi.fn(() => null),
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = vi.fn(() => undefined);
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({})),
}));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  notifyConversationExpired: vi.fn(),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, run: () => unknown) => run()),
}));

import {
  createEarlyAgentLauncher,
  resolveInitScriptMode,
  setupStillRunningFor,
} from '../../src/main/ipc/helpers/agent-spawn';
import { previewSpawnPreamble } from '../../src/main/transition-engine/spawn-preamble';
import { runWorktreeCreation } from '../../src/main/git/worktree-creation-registry';

type LauncherInput = Parameters<typeof createEarlyAgentLauncher>[0];
type EarlyLaunchInput = Parameters<TransitionEngine['launchEarlyAgent']>[0];
type SettingsLane = Parameters<typeof previewSpawnPreamble>[0]['settingsLane'];

const TASK_ID = 'task-early-001';
const LANE_ID = 'lane-build';
const PROJECT_ID = 'project-early-001';
const PROJECT_PATH = path.join(os.tmpdir(), 'early-agent-launcher-project');
const WORKTREE_PATH = path.join(PROJECT_PATH, '.kangentic', 'worktrees', 'early-task');

const PROJECT_ROW = {
  id: PROJECT_ID,
  name: 'Early Project',
  path: PROJECT_PATH,
  default_agent: 'claude',
  default_model: 'claude-opus-4-8',
  default_effort: 'xhigh',
} as Project;

/** The handle the engine's launch resolves, told apart from any other by identity. */
const EARLY_HANDLE: EarlyAgentHandle = {
  sessionId: 'early-session-001',
  taskId: TASK_ID,
  agentName: 'codex',
  agentSessionId: null,
  command: 'codex',
  cwd: WORKTREE_PATH,
  launchKey: 'launch-key',
  launchedAt: 0,
  isSettled: () => false,
  markAdopted: () => true,
  discard: async () => undefined,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'Build the thing',
    description: 'Do the thing',
    swimlane_id: LANE_ID,
    position: 0,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    profile_id: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

/** A column that would start a Codex agent, with values distinct from the project's and the global's. */
function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Build',
    role: null,
    position: 1,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: 'acceptEdits',
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: 'codex',
    model_override: 'codex-model',
    effort_override: 'high',
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Swimlane;
}

function makeSettingsLane(overrides: Partial<NonNullable<SettingsLane>> = {}): NonNullable<SettingsLane> {
  return {
    role: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    ...overrides,
  };
}

function makeSessionRecord(status: SessionRecordStatus, suspendedBy: SuspendedBy | null) {
  return { id: 'session-record-1', task_id: TASK_ID, status, suspended_by: suspendedBy };
}

function makeContext() {
  return {
    sessionManager: {},
    terminalSubmit: {},
    projectRepo: { getById: vi.fn(() => PROJECT_ROW) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'default' },
        git: {},
      })),
    },
  };
}

interface LauncherOptions {
  /** The row `tasks.getById` returns; null for a task that no longer exists. */
  task?: Task | null;
  toLane?: Swimlane;
  explicitStart?: boolean;
  settingsSourceLane?: Swimlane | null;
  signal?: AbortSignal;
}

function buildLauncher(options: LauncherOptions = {}) {
  const taskRow = options.task === undefined ? makeTask() : options.task;
  const tasks = {
    getById: vi.fn(() => taskRow ?? undefined),
    update: vi.fn(),
  };
  const context = makeContext();
  const input = {
    context,
    tasks,
    automations: {},
    automationRuns: {},
    attachments: {},
    taskId: TASK_ID,
    toLane: options.toLane ?? makeSwimlane(),
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    explicitStart: options.explicitStart,
    signal: options.signal,
    ...('settingsSourceLane' in options ? { settingsSourceLane: options.settingsSourceLane } : {}),
  } as unknown as LauncherInput;
  return { launch: createEarlyAgentLauncher(input), tasks, context };
}

/** The argument `launchEarlyAgent` was called with, for the one call a test expects. */
function theLaunchInput(): EarlyLaunchInput {
  expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
  return engineSpies.launchEarlyAgent.mock.calls[0][0] as EarlyLaunchInput;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  engineSpies.constructions.length = 0;
  engineSpies.agentStartsFirstOnEnter.mockReset();
  engineSpies.agentStartsFirstOnEnter.mockReturnValue(true);
  engineSpies.launchEarlyAgent.mockReset();
  engineSpies.launchEarlyAgent.mockResolvedValue(EARLY_HANDLE);
  sessionRepositoryState.constructions.length = 0;
  sessionRepositoryState.getLatestForTask.mockReset();
  sessionRepositoryState.getLatestForTask.mockReturnValue(undefined);
  mockGetProjectDb.mockReset();
  mockGetProjectDb.mockReturnValue({ database: 'project-db-handle' });
  mockLoadTaskProfile.mockReset();
  mockLoadTaskProfile.mockReturnValue(null);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('createEarlyAgentLauncher: what it will not launch', () => {
  it('launches nothing when the task row is gone', async () => {
    const { launch } = buildLauncher({ task: null });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // A missing row is a quiet refusal. Without the guard the next line would
    // throw on the undefined row and the catch would also return null, but it
    // would warn about it.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sessionRepositoryState.getLatestForTask).not.toHaveBeenCalled();
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('launches nothing when the task already has a session', async () => {
    const { launch, tasks } = buildLauncher({ task: makeTask({ session_id: 'live-session-1' }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // The task was read, and nothing past that guard ran.
    expect(tasks.getById).toHaveBeenCalledWith(TASK_ID);
    expect(sessionRepositoryState.getLatestForTask).not.toHaveBeenCalled();
    expect(engineSpies.agentStartsFirstOnEnter).not.toHaveBeenCalled();
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('launches nothing when the column has auto_spawn off', async () => {
    const { launch, tasks } = buildLauncher({ toLane: makeSwimlane({ auto_spawn: false }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // The task passed its guard; the column refused before the session was read.
    expect(tasks.getById).toHaveBeenCalledWith(TASK_ID);
    expect(sessionRepositoryState.getLatestForTask).not.toHaveBeenCalled();
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it.each(['todo', 'done'] as const)('launches nothing into a %s column even with auto_spawn on', async (role) => {
    const { launch } = buildLauncher({ toLane: makeSwimlane({ role, auto_spawn: true }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(sessionRepositoryState.getLatestForTask).not.toHaveBeenCalled();
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it.each(['user', 'auto'] as const)('launches nothing for a task paused by %s, which waits for the user', async (suspendedBy) => {
    sessionRepositoryState.getLatestForTask.mockReturnValue(makeSessionRecord('suspended', suspendedBy));
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // The latest session was read for this task, and the check stopped before the engine's question.
    expect(sessionRepositoryState.getLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(engineSpies.agentStartsFirstOnEnter).not.toHaveBeenCalled();
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('does not treat a system suspend (a quit or a move) as a held pause', async () => {
    sessionRepositoryState.getLatestForTask.mockReturnValue(makeSessionRecord('suspended', 'system'));
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
  });

  it('launches nothing when a row that needs no agent runs first on enter', async () => {
    engineSpies.agentStartsFirstOnEnter.mockReturnValue(false);
    const lane = makeSwimlane();
    const { launch } = buildLauncher({ toLane: lane });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // The held-pause guard passed (the session was read), and the engine was asked about this column.
    expect(sessionRepositoryState.getLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(engineSpies.agentStartsFirstOnEnter).toHaveBeenCalledTimes(1);
    expect(engineSpies.agentStartsFirstOnEnter.mock.calls[0][0]).toMatchObject({ id: LANE_ID });
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('launches nothing for a handoff: the task last ran another agent than the column resolves', async () => {
    // The task last ran claude and the column resolves codex.
    const { launch } = buildLauncher({ task: makeTask({ agent: 'claude' }), toLane: makeSwimlane({ agent_override: 'codex' }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    // Every guard before the handoff check passed.
    expect(engineSpies.agentStartsFirstOnEnter).toHaveBeenCalledTimes(1);
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('launches nothing for a handoff to the project default agent when the column names none', async () => {
    // The task last ran codex and nothing overrides the project default (claude).
    const { launch } = buildLauncher({ task: makeTask({ agent: 'codex' }), toLane: makeSwimlane({ agent_override: null }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.agentStartsFirstOnEnter).toHaveBeenCalledTimes(1);
    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('launches for a task whose last agent is the one the column resolves, which is no handoff', async () => {
    const { launch } = buildLauncher({ task: makeTask({ agent: 'codex' }), toLane: makeSwimlane({ agent_override: 'codex' }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(theLaunchInput().agentOverride).toBe('codex');
  });
});

describe('createEarlyAgentLauncher: explicitStart', () => {
  it('lifts the auto_spawn refusal', async () => {
    const { launch } = buildLauncher({ toLane: makeSwimlane({ auto_spawn: false }), explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps refusing a column with auto_spawn off when the start is not explicit', async () => {
    const { launch } = buildLauncher({ toLane: makeSwimlane({ auto_spawn: false }), explicitStart: false });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it.each(['user', 'auto'] as const)('lifts the held-pause refusal for a task paused by %s', async (suspendedBy) => {
    sessionRepositoryState.getLatestForTask.mockReturnValue(makeSessionRecord('suspended', suspendedBy));
    const { launch } = buildLauncher({ explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
  });

  it('lifts both refusals at once', async () => {
    sessionRepositoryState.getLatestForTask.mockReturnValue(makeSessionRecord('suspended', 'user'));
    const { launch } = buildLauncher({ toLane: makeSwimlane({ auto_spawn: false }), explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
  });

  it.each(['todo', 'done'] as const)('does not lift the %s role gate', async (role) => {
    const { launch } = buildLauncher({ toLane: makeSwimlane({ role, auto_spawn: true }), explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('does not lift the rule that an enter row needing no agent goes first', async () => {
    engineSpies.agentStartsFirstOnEnter.mockReturnValue(false);
    const { launch } = buildLauncher({ explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('does not lift the session_id refusal', async () => {
    const { launch } = buildLauncher({ task: makeTask({ session_id: 'live-session-1' }), explicitStart: true });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });
});

describe('createEarlyAgentLauncher: the launch', () => {
  it('hands the engine the worktree, the column\'s permission mode and the resolved agent, and returns the engine\'s handle', async () => {
    const abortController = new AbortController();
    const { launch } = buildLauncher({ signal: abortController.signal });

    const handle = await launch(WORKTREE_PATH);

    expect(handle).toBe(EARLY_HANDLE);
    const launchInput = theLaunchInput();
    expect(launchInput.worktreePath).toBe(WORKTREE_PATH);
    // The lane's own mode, distinct from the global default ('default').
    expect(launchInput.permissionOverride).toBe('acceptEdits');
    // The column's agent, distinct from the project default ('claude').
    expect(launchInput.agentOverride).toBe('codex');
    expect(launchInput.task.id).toBe(TASK_ID);
    expect(launchInput.signal).toBe(abortController.signal);
    // The column's model and effort win over the project's.
    expect(launchInput.spawnOverrides).toMatchObject({ model: 'codex-model', effort: 'high' });
  });

  it('resolves the project default agent when the column names none', async () => {
    const { launch } = buildLauncher({ toLane: makeSwimlane({ agent_override: null, model_override: null, effort_override: null }) });

    await launch(WORKTREE_PATH);

    const launchInput = theLaunchInput();
    expect(launchInput.agentOverride).toBe('claude');
    expect(launchInput.spawnOverrides).toMatchObject({ model: 'claude-opus-4-8', effort: 'xhigh' });
  });

  it('builds the engine on the project\'s own database and reads the task\'s latest session there', async () => {
    const { launch } = buildLauncher();

    await launch(WORKTREE_PATH);

    expect(mockGetProjectDb).toHaveBeenCalledWith(PROJECT_ID);
    expect(sessionRepositoryState.constructions).toHaveLength(1);
    expect(sessionRepositoryState.constructions[0][0]).toEqual({ database: 'project-db-handle' });
    expect(sessionRepositoryState.getLatestForTask).toHaveBeenCalledWith(TASK_ID);
    expect(engineSpies.constructions).toHaveLength(1);
  });

  it('folds the task\'s Board Profile over the column before it decides whether the column starts an agent', async () => {
    const profile: BoardProfile = {
      id: 'profile-1',
      name: 'Careful',
      columns: { [LANE_ID]: { autoSpawn: true, permissionMode: 'plan' } },
    };
    mockLoadTaskProfile.mockReturnValue(profile);
    const task = makeTask({ profile_id: 'profile-1' });
    const { launch, context } = buildLauncher({ task, toLane: makeSwimlane({ auto_spawn: false }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBe(EARLY_HANDLE);

    expect(mockLoadTaskProfile).toHaveBeenCalledWith(context, task, PROJECT_PATH);
    // The folded lane supplies both the gate and the permission mode.
    expect(theLaunchInput().permissionOverride).toBe('plan');
  });

  it('does not let a Board Profile that turns auto_spawn off start an agent', async () => {
    const profile: BoardProfile = {
      id: 'profile-2',
      name: 'Quiet',
      columns: { [LANE_ID]: { autoSpawn: false } },
    };
    mockLoadTaskProfile.mockReturnValue(profile);
    const { launch } = buildLauncher({ task: makeTask({ profile_id: 'profile-2' }), toLane: makeSwimlane({ auto_spawn: true }) });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });
});

describe('createEarlyAgentLauncher: the Advanced override lock is previewed, never written', () => {
  const SOURCE_LANE_FIELDS: Partial<Swimlane> = {
    id: 'lane-where-the-task-was-configured',
    agent_override: 'gemini',
    model_override: 'gemini-model',
    effort_override: 'low',
    permission_mode: 'plan',
  };

  it('locks the four fields to what the SOURCE column showed, on a copy, and writes nothing', async () => {
    const storedTask = makeTask({ run_mode: 'agent_override' });
    const taskBeforeLaunch = structuredClone(storedTask);
    const { launch, tasks } = buildLauncher({
      task: storedTask,
      settingsSourceLane: makeSwimlane(SOURCE_LANE_FIELDS),
    });

    await launch(WORKTREE_PATH);

    const launchInput = theLaunchInput();
    expect(launchInput.agentOverride).toBe('gemini');
    expect(launchInput.task).toMatchObject({
      agent_override: 'gemini',
      model_override: 'gemini-model',
      effort_override: 'low',
      permission_mode: 'plan',
    });
    // The destination column still supplies the spawn's own permission override.
    expect(launchInput.permissionOverride).toBe('acceptEdits');
    // Nothing persisted, and the row the repository handed out is untouched.
    expect(tasks.update).not.toHaveBeenCalled();
    expect(launchInput.task).not.toBe(storedTask);
    expect(storedTask).toEqual(taskBeforeLaunch);
  });

  it('locks against the destination column when no source column is given', async () => {
    const { launch, tasks } = buildLauncher({ task: makeTask({ run_mode: 'agent_override' }) });

    await launch(WORKTREE_PATH);

    const launchInput = theLaunchInput();
    expect(launchInput.agentOverride).toBe('codex');
    expect(launchInput.task).toMatchObject({
      agent_override: 'codex',
      model_override: 'codex-model',
      effort_override: 'high',
      permission_mode: 'acceptEdits',
    });
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('locks to the project and global defaults when the source column no longer resolves', async () => {
    const { launch, tasks } = buildLauncher({
      task: makeTask({ run_mode: 'agent_override' }),
      settingsSourceLane: null,
    });

    await launch(WORKTREE_PATH);

    const launchInput = theLaunchInput();
    expect(launchInput.agentOverride).toBe('claude');
    expect(launchInput.task).toMatchObject({
      agent_override: 'claude',
      model_override: 'claude-opus-4-8',
      effort_override: 'xhigh',
      permission_mode: 'default',
    });
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('leaves a Column Settings task unlocked', async () => {
    const storedTask = makeTask({ run_mode: 'column_settings' });
    const { launch } = buildLauncher({ task: storedTask });

    await launch(WORKTREE_PATH);

    expect(theLaunchInput().task).toMatchObject({
      agent_override: null,
      model_override: null,
      effort_override: null,
      permission_mode: null,
    });
  });
});

describe('createEarlyAgentLauncher: it never throws', () => {
  it('resolves null when the engine\'s launch rejects, and says so', async () => {
    engineSpies.launchEarlyAgent.mockRejectedValue(new Error('the PTY host went away'));
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves null, quietly, when the launch is aborted', async () => {
    engineSpies.launchEarlyAgent.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves null when the project database cannot be opened', async () => {
    mockGetProjectDb.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('resolves null when the task read throws', async () => {
    const { launch, tasks } = buildLauncher();
    tasks.getById.mockImplementation(() => {
      throw new Error('row is corrupt');
    });

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });

  it('resolves null when the engine\'s question about the column throws', async () => {
    engineSpies.agentStartsFirstOnEnter.mockImplementation(() => {
      throw new Error('automation repository closed');
    });
    const { launch } = buildLauncher();

    await expect(launch(WORKTREE_PATH)).resolves.toBeNull();

    expect(engineSpies.launchEarlyAgent).not.toHaveBeenCalled();
  });
});

describe('previewSpawnPreamble', () => {
  const NO_PROJECT_FALLBACK_GLOBAL = () => 'bypassPermissions' as const;

  it('returns a copy carrying the locked values for the first-ever spawn of an Agent Override task, and leaves the input alone', () => {
    const inputTask = makeTask({ run_mode: 'agent_override' });
    const inputBeforeCall = structuredClone(inputTask);

    const { task: previewTask, resolution } = previewSpawnPreamble({
      task: inputTask,
      hasSessionRecord: false,
      settingsLane: makeSettingsLane({
        agent_override: 'codex',
        model_override: 'codex-model',
        effort_override: 'high',
        permission_mode: 'plan',
      }),
      destinationLane: { agent_override: 'gemini' },
      project: PROJECT_ROW,
      globalPermissionMode: NO_PROJECT_FALLBACK_GLOBAL,
    });

    expect(previewTask).not.toBe(inputTask);
    expect(previewTask).toMatchObject({
      agent_override: 'codex',
      model_override: 'codex-model',
      effort_override: 'high',
      permission_mode: 'plan',
    });
    // The destination column never leaks into the locked contract, and the locked agent wins resolution.
    expect(resolution).toEqual({ agent: 'codex', isHandoff: false });
    expect(inputTask).toEqual(inputBeforeCall);
  });

  it('locks still-inherited fields to the project defaults and the global permission mode', () => {
    const globalPermissionMode = vi.fn(NO_PROJECT_FALLBACK_GLOBAL);

    const { task: previewTask, resolution } = previewSpawnPreamble({
      task: makeTask({ run_mode: 'agent_override' }),
      hasSessionRecord: false,
      settingsLane: makeSettingsLane(),
      destinationLane: { agent_override: null },
      project: PROJECT_ROW,
      globalPermissionMode,
    });

    expect(previewTask).toMatchObject({
      agent_override: 'claude',
      model_override: 'claude-opus-4-8',
      effort_override: 'xhigh',
      permission_mode: 'bypassPermissions',
    });
    expect(resolution.agent).toBe('claude');
    expect(globalPermissionMode).toHaveBeenCalledTimes(1);
  });

  it('locks when the task is leaving To Do, even though a session record exists', () => {
    const { task: previewTask } = previewSpawnPreamble({
      task: makeTask({ run_mode: 'agent_override', agent: 'claude' }),
      hasSessionRecord: true,
      settingsLane: makeSettingsLane({ role: 'todo', agent_override: 'claude', permission_mode: 'plan' }),
      destinationLane: null,
      project: PROJECT_ROW,
      globalPermissionMode: NO_PROJECT_FALLBACK_GLOBAL,
    });

    expect(previewTask).toMatchObject({ agent_override: 'claude', permission_mode: 'plan' });
  });

  it('locks nothing for a task that already spawned and is not leaving To Do', () => {
    const inputTask = makeTask({ run_mode: 'agent_override', agent: 'claude' });
    const globalPermissionMode = vi.fn(NO_PROJECT_FALLBACK_GLOBAL);

    const { task: previewTask } = previewSpawnPreamble({
      task: inputTask,
      hasSessionRecord: true,
      settingsLane: makeSettingsLane({ agent_override: 'codex' }),
      destinationLane: null,
      project: PROJECT_ROW,
      globalPermissionMode,
    });

    expect(previewTask).toEqual(inputTask);
    expect(previewTask).not.toBe(inputTask);
    expect(globalPermissionMode).not.toHaveBeenCalled();
  });

  it('locks nothing for a Column Settings task, but still returns a copy', () => {
    const inputTask = makeTask({ run_mode: 'column_settings' });

    const { task: previewTask } = previewSpawnPreamble({
      task: inputTask,
      hasSessionRecord: false,
      settingsLane: makeSettingsLane({ agent_override: 'codex' }),
      destinationLane: null,
      project: PROJECT_ROW,
      globalPermissionMode: NO_PROJECT_FALLBACK_GLOBAL,
    });

    expect(previewTask).toEqual(inputTask);
    expect(previewTask).not.toBe(inputTask);
  });

  it('locks nothing for a Board Profile task, whose ladder is the contract', () => {
    const { task: previewTask } = previewSpawnPreamble({
      task: makeTask({ run_mode: 'agent_override', profile_id: 'profile-1' }),
      hasSessionRecord: false,
      settingsLane: makeSettingsLane({ agent_override: 'codex' }),
      destinationLane: null,
      project: PROJECT_ROW,
      globalPermissionMode: NO_PROJECT_FALLBACK_GLOBAL,
    });

    expect(previewTask.agent_override).toBeNull();
  });

  it('resolves a handoff when the task last ran another agent than the destination column names', () => {
    const { resolution } = previewSpawnPreamble({
      task: makeTask({ agent: 'claude' }),
      hasSessionRecord: true,
      settingsLane: null,
      destinationLane: { agent_override: 'codex' },
      project: PROJECT_ROW,
      globalPermissionMode: NO_PROJECT_FALLBACK_GLOBAL,
    });

    expect(resolution).toEqual({ agent: 'codex', isHandoff: true });
  });
});

describe('resolveInitScriptMode', () => {
  const launcher = vi.fn(async () => null);

  function contextWithGit(git: Record<string, unknown> | undefined) {
    return { configManager: { getEffectiveConfig: vi.fn(() => ({ git })) } };
  }

  it('is undefined when there is no project path, and reads no config', () => {
    const context = contextWithGit({ initScript: 'npm install' });

    expect(resolveInitScriptMode(context as never, null, launcher)).toBeUndefined();
    expect(context.configManager.getEffectiveConfig).not.toHaveBeenCalled();
  });

  it('is undefined when the project has no git settings', () => {
    expect(resolveInitScriptMode(contextWithGit(undefined) as never, PROJECT_PATH, launcher)).toBeUndefined();
  });

  it('is undefined when no setup script is configured', () => {
    expect(resolveInitScriptMode(contextWithGit({}) as never, PROJECT_PATH, launcher)).toBeUndefined();
  });

  it.each(['', '   ', '\n\t '])('is undefined when the setup script is blank (%j)', (blankScript) => {
    const context = contextWithGit({ initScript: blankScript, holdPromptForInitScript: true });

    expect(resolveInitScriptMode(context as never, PROJECT_PATH, launcher)).toBeUndefined();
  });

  it('asks the config for the project it was given', () => {
    const context = contextWithGit({ initScript: 'npm install' });

    resolveInitScriptMode(context as never, PROJECT_PATH, launcher);

    expect(context.configManager.getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('is background, with no launcher, when the prompt is not held for the script', () => {
    const context = contextWithGit({ initScript: 'npm install', holdPromptForInitScript: false });

    expect(resolveInitScriptMode(context as never, PROJECT_PATH, launcher)).toEqual({ mode: 'background' });
  });

  it('is hold-prompt with the launcher when the prompt is held for the script', () => {
    const context = contextWithGit({ initScript: 'npm install', holdPromptForInitScript: true });

    const mode = resolveInitScriptMode(context as never, PROJECT_PATH, launcher);

    expect(mode).toEqual({ mode: 'hold-prompt', launchAgent: launcher });
    expect(mode?.mode === 'hold-prompt' && mode.launchAgent).toBe(launcher);
  });

  it('is hold-prompt when the hold setting was never written, so only an explicit false opts out', () => {
    const context = contextWithGit({ initScript: 'npm install' });

    const mode = resolveInitScriptMode(context as never, PROJECT_PATH, launcher);

    expect(mode?.mode).toBe('hold-prompt');
  });
});

describe('setupStillRunningFor', () => {
  const BACKGROUND = { mode: 'background' } as const;
  const HOLD_PROMPT = { mode: 'hold-prompt', launchAgent: vi.fn(async () => null) } as const;
  const IN_FLIGHT_PATH = path.join(os.tmpdir(), 'early-agent-launcher-in-flight');
  const FINISHED_PATH = path.join(os.tmpdir(), 'early-agent-launcher-finished');

  function contextWithScript(initScript: string | undefined) {
    return { configManager: { getEffectiveConfig: vi.fn(() => ({ git: { initScript } })) } };
  }

  /** Run `body` while a worktree creation holds `worktreePath` in the registry, then let it settle. */
  async function withCreationInFlight(worktreePath: string, body: () => void): Promise<void> {
    let releaseCreation: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    // The registry claims the path synchronously, so it is in flight as soon as this returns.
    const creation = runWorktreeCreation(worktreePath, undefined, () => gate);
    try {
      body();
    } finally {
      releaseCreation();
      await creation;
    }
  }

  it('names the trimmed script while the background setup is still running in the new worktree', async () => {
    const context = contextWithScript('  npm install  ');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      const note = setupStillRunningFor(context as never, PROJECT_PATH, BACKGROUND, IN_FLIGHT_PATH);

      expect(typeof note).toBe('string');
      expect(note).toContain('`npm install`');
      expect(note).not.toContain('  npm install');
      expect(context.configManager.getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
    });
  });

  it('is undefined when the script already finished', async () => {
    const context = contextWithScript('npm install');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      // A different path than the one in flight: this worktree's creation has settled.
      expect(setupStillRunningFor(context as never, PROJECT_PATH, BACKGROUND, FINISHED_PATH)).toBeUndefined();
    });
  });

  it('is undefined once the creation in flight settles', async () => {
    const context = contextWithScript('npm install');
    await withCreationInFlight(IN_FLIGHT_PATH, () => undefined);

    expect(setupStillRunningFor(context as never, PROJECT_PATH, BACKGROUND, IN_FLIGHT_PATH)).toBeUndefined();
  });

  it('is undefined when the mode is not background', async () => {
    const context = contextWithScript('npm install');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      expect(setupStillRunningFor(context as never, PROJECT_PATH, HOLD_PROMPT, IN_FLIGHT_PATH)).toBeUndefined();
      expect(setupStillRunningFor(context as never, PROJECT_PATH, undefined, IN_FLIGHT_PATH)).toBeUndefined();
    });
  });

  it('is undefined when no worktree was created, because only a new worktree runs its script', async () => {
    const context = contextWithScript('npm install');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      expect(setupStillRunningFor(context as never, PROJECT_PATH, BACKGROUND, null)).toBeUndefined();
    });
  });

  it('is undefined when there is no project path', async () => {
    const context = contextWithScript('npm install');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      expect(setupStillRunningFor(context as never, null, BACKGROUND, IN_FLIGHT_PATH)).toBeUndefined();
    });
  });

  it('is undefined when the configured script has gone blank', async () => {
    const context = contextWithScript('   ');

    await withCreationInFlight(IN_FLIGHT_PATH, () => {
      expect(setupStillRunningFor(context as never, PROJECT_PATH, BACKGROUND, IN_FLIGHT_PATH)).toBeUndefined();
    });
  });
});
