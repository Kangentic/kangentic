/**
 * What the cross-agent handoff branch of `spawnAgent` delivers for a task whose
 * automations the user disabled (src/main/ipc/helpers/agent-spawn.ts, the
 * `canTaskRunAutomations(currentTask).ok` gate ahead of `resolveColumnMessage`).
 *
 * A handoff runs no enter group, so it delivers the column's Send message row
 * itself, through `deliverAgentMessageInBackground`, once the new session
 * exists. A task with its automations disabled is sent no column message there
 * either: the row is simply not read. The task's OWN `auto_command` is the
 * task's input, not an automation, so it still goes out, and as the task-tier
 * pin it keeps the default `immediate` mode instead of borrowing the column
 * row's.
 *
 * - disabled, column message only: nothing is delivered.
 * - enabled, the same column message: delivered once (the control, so the line
 *   above is shown to be able to fail).
 * - disabled, column message and the task's own command: the command is
 *   delivered once, `immediate`, and the column's text never is.
 *
 * Harness: the handoff half of agent-spawn-expired-withhold.test.ts, trimmed to
 * what a handoff needs. The engine is stubbed (`resumeSuspendedSession` resolves
 * an ordinary outcome), delivery is observed and never run, and the gate reads
 * `currentTask` from `tasks.getById` AFTER the resume, not from the `task`
 * argument, so the switch is set on both, except in the last two tests, which
 * set it on only one to show the stored row is the one read.
 *
 * Red-green: make `canTaskRunAutomations` answer ok for every task and the
 * first test fails with the column's text delivered, and the third fails with
 * the command delivered in the column row's `deferred` mode, not `immediate`.
 * Make it refuse every task and only the control fails, with nothing delivered.
 * The third test also fails if a disabled task's own command is dropped along
 * with the column's message. Gate on the `task` argument instead of the
 * re-read `currentTask` and both stored-row tests fail, one with the column's
 * text delivered and the other with nothing delivered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutoCommandMode, Swimlane, Task } from '../../src/shared/types';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';

const mockTaskGetById = vi.fn();
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn();
const mockNotifySpawnBlocked = vi.fn();

const mockExecuteTransition = vi.hoisted(() => vi.fn());
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn<(...callArguments: unknown[]) => Promise<unknown>>(async () => undefined));
const mockResumeSuspendedSession = vi.hoisted(() => vi.fn());
const mockDeliverAgentMessageInBackground = vi.hoisted(() => vi.fn());
const mockListForColumn = vi.fn();

// The engine and the agent registry are stubbed so the module loads without
// pulling in SessionManager -> node-pty and every agent adapter.
vi.mock('../../src/main/transition-engine/transition-engine', () => ({
  TransitionEngine: class {
    executeTransition = mockExecuteTransition;
    runLegacySpawnAgent = mockRunLegacySpawnAgent;
    resumeSuspendedSession = mockResumeSuspendedSession;
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
// The handoff branch writes an audit row; the repository is not under test.
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class {
    insert = vi.fn(() => ({ id: 'handoff-1' }));
    updateToSession = vi.fn();
  },
}));
// Delivery is observed, never run: the real one schedules keystrokes and timers.
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageInBackground: mockDeliverAgentMessageInBackground,
}));
// Resolving the template variables for a delivered message reads a dev-port lease, which needs a database.
vi.mock('../../src/main/dev-ports/dev-port-allocator', () => ({
  getDevPortForTask: vi.fn(() => null),
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = vi.fn(() => undefined);
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask() {
      return undefined;
    }
    getLatestForTaskByTypeAndIsolation() {
      return undefined;
    }
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args), update: vi.fn() },
    swimlanes: { getById: vi.fn(() => undefined) },
    automations: { listForColumn: (...args: unknown[]) => mockListForColumn(...args) },
    automationRuns: {},
    attachments: {},
  })),
}));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  notifySpawnBlocked: (...args: unknown[]) => mockNotifySpawnBlocked(...args),
  notifyConversationExpired: vi.fn(),
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';

const TASK_ID = 'task-handoff-held';
const LANE_ID = 'lane-review';
const PROJECT_ID = 'proj-1';
const COLUMN_TEXT = 'Review the diff';
const TASK_COMMAND = 'Run the checks';

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Review',
    role: null,
    auto_spawn: true,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    auto_command: null,
    handoff_context: false,
    plan_exit_target_id: null,
    ...overrides,
  } as Swimlane;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'Hand off to another agent',
    description: '',
    labels: [],
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    swimlane_id: LANE_ID,
    profile_id: null,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    auto_command: null,
    session_id: null,
    automations_disabled: false,
    ...overrides,
  } as Task;
}

function makeContext() {
  return {
    projectRepo: {
      getById: vi.fn(() => ({
        id: PROJECT_ID, name: 'Example', path: '/mock/project', default_agent: 'claude', default_model: null, default_effort: null,
      })),
    },
    boardConfigManager: { getBoardProfiles: vi.fn(() => []), getDefaultBaseBranch: vi.fn(() => null) },
    sessionManager: { findLiveSessionByTaskId: vi.fn(() => undefined) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'default' },
        git: {},
        mcpServer: { enabled: true },
      })),
    },
  } as never;
}

/** The column's first enabled Send message row, as the handoff delivery reads it. */
function columnMessageRow(mode: AutoCommandMode) {
  return {
    id: 'row-1',
    type: 'send_message',
    trigger: 'enter',
    enabled: true,
    position: 0,
    config: { message: COLUMN_TEXT, mode },
    condition: null,
    max_runs: null,
  };
}

/** The previous agent's record: it exists, so a handoff has context to package. */
const handoffSessionRepo = {
  getLatestForTask: () => ({
    id: 'record-previous',
    status: 'exited',
    suspended_by: null,
    agent_session_id: null,
    cwd: '/mock/project',
  }),
  getLatestForTaskByTypeAndIsolation: () => undefined,
} as never;

/** An ordinary resume: the conversation did not expire, so the handoff delivers as it always did. */
const ORDINARY_OUTCOME: SpawnOutcome = { startOver: null, recapOnly: false, unsentPrompt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskGetById.mockReset();
  mockExecuteTransition.mockReset();
  mockResumeSuspendedSession.mockReset();
  mockListForColumn.mockReset();
  mockListForColumn.mockReturnValue([]);
  mockDeliverAgentMessageInBackground.mockReset();
  mockRunLegacySpawnAgent.mockReset();
  mockRunLegacySpawnAgent.mockResolvedValue(undefined);
});

describe('spawnAgent: a cross-agent handoff for a task with its automations disabled', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  /**
   * Drive a cross-agent handoff: the task last ran codex and the target column
   * runs claude. The task reads back with a session once the engine resumes it,
   * and the column's message and the task's own command are what the branch
   * decides whether to deliver.
   */
  async function runHandoff(scenario: {
    /** The switch on the stored row, which the gate reads once the new session exists. */
    automationsDisabled: boolean;
    /** The switch on the `task` argument the handoff was started with. Defaults to the stored row's. */
    argumentAutomationsDisabled?: boolean;
    columnMessageMode?: AutoCommandMode;
    taskAutoCommand?: string | null;
  }): Promise<void> {
    const { automationsDisabled, columnMessageMode = 'immediate', taskAutoCommand = null } = scenario;
    const argumentAutomationsDisabled = scenario.argumentAutomationsDisabled ?? automationsDisabled;
    mockResumeSuspendedSession.mockResolvedValue(ORDINARY_OUTCOME);
    mockListForColumn.mockReturnValue([columnMessageRow(columnMessageMode)]);
    // The gate reads this row, not the `task` argument below.
    mockTaskGetById.mockImplementation(() => makeTask({
      agent: 'codex',
      auto_command: taskAutoCommand,
      session_id: 'session-new',
      automations_disabled: automationsDisabled,
    }));

    await spawnAgent({
      context: makeContext(),
      engine: {
        executeTransition: mockExecuteTransition,
        runLegacySpawnAgent: mockRunLegacySpawnAgent,
        resumeSuspendedSession: mockResumeSuspendedSession,
      } as never,
      tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args), update: vi.fn() } as never,
      sessionRepo: handoffSessionRepo,
      task: makeTask({ agent: 'codex', auto_command: taskAutoCommand, automations_disabled: argumentAutomationsDisabled }),
      fromSwimlaneId: 'lane-previous',
      toLane: makeLane({ agent_override: 'claude', handoff_context: true }),
      projectId: PROJECT_ID,
      projectPath: '/mock/project',
    });

    // The handoff branch ran, and not the normal one: it resumes the target
    // agent through the engine itself and starts no enter group. A "delivers
    // nothing" result is therefore the branch's decision and not a path that
    // never got there.
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession.mock.calls[0][5]).toBe('claude');
  }

  function deliveredMessages(): string[] {
    return mockDeliverAgentMessageInBackground.mock.calls.map((call) => (call[1] as { message: string }).message);
  }

  it('delivers nothing when the column has a message and the task has no command of its own', async () => {
    await runHandoff({ automationsDisabled: true });

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('delivers the column\'s message once for an enabled task (the control)', async () => {
    await runHandoff({ automationsDisabled: false });

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: TASK_ID,
        sessionId: 'session-new',
        message: COLUMN_TEXT,
        mode: 'immediate',
        freshlySpawned: true,
      }),
    );
  });

  it('still delivers the task\'s own auto_command once, immediately, and never the column\'s text', async () => {
    // The column row is deferred so the mode shows where the delivery came
    // from: the task's pin has no row, and keeps the default.
    await runHandoff({ automationsDisabled: true, columnMessageMode: 'deferred', taskAutoCommand: TASK_COMMAND });

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: TASK_ID,
        sessionId: 'session-new',
        message: TASK_COMMAND,
        mode: 'immediate',
        freshlySpawned: true,
      }),
    );
    expect(deliveredMessages()).not.toContain(COLUMN_TEXT);
  });

  // The gate reads the row the handoff re-reads AFTER the new session exists
  // (`currentTask`), not the `task` argument it started with: the user can throw
  // the switch while the target agent is spawning. In each case the argument and
  // the stored row disagree.
  it('delivers nothing when the stored row says disabled and the task argument says enabled', async () => {
    await runHandoff({ automationsDisabled: true, argumentAutomationsDisabled: false });

    // Red: gating on the `task` argument delivers the column's text.
    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('delivers the column\'s message once when the stored row says enabled and the task argument says disabled', async () => {
    await runHandoff({ automationsDisabled: false, argumentAutomationsDisabled: true });

    // Red: gating on the `task` argument holds a message the task is owed.
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: TASK_ID,
        sessionId: 'session-new',
        message: COLUMN_TEXT,
        mode: 'immediate',
        freshlySpawned: true,
      }),
    );
  });
});
