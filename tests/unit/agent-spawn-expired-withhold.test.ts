/**
 * The seam between the engine and the automation runner for an expired
 * conversation. `engine.resumeSuspendedSession` reports a `SpawnOutcome`; when
 * its `recapOnly` is true the new session opened on a recap that asks the agent
 * to summarize and wait, so the column's messages must not be sent on top of
 * it. The runner learns that from `startAgent`'s return value
 * (`AgentStartReport.withholdMessages`, src/main/automations/automation-runner.ts),
 * and `spawnAgent`'s `startAgent` closure (src/main/ipc/helpers/agent-spawn.ts)
 * is the one place that turns the outcome into that report. The engine tests
 * pin the outcome and the runner tests pin what a report does, so without this
 * file nothing proves the two are connected.
 *
 * `executeTransition` is the seam: the stubbed engine hands the test the
 * `startAgent` that `spawnAgent` built, exactly as the real runner receives it,
 * and the test calls it the way the runner does for a row that needs the agent.
 *
 * - `recapOnly: true` returns the withhold report, carrying the run-log reason.
 * - `recapOnly: false` returns nothing, so the column's messages go out.
 * - An expired start-over that is NOT recap-only (an isolated column keeps its
 *   own conversation and runs its normal fresh pass with the recap as context)
 *   returns nothing either. That case fails a report keyed on `startOver`
 *   instead of `recapOnly`.
 *
 * The cross-agent handoff branch of `spawnAgent` is the other path that resumes
 * through the engine. It runs no enter group, so it delivers the column's
 * message (or the task's own `auto_command`) itself, through
 * `deliverAgentMessageInBackground`, once the new session exists. It keeps the
 * engine's outcome as `handoffRecapOnly`, and when the target agent's older
 * conversation had expired the recap is the session's whole prompt, so that
 * message is not typed over it: one console line says why and nothing is
 * delivered. A handoff onto a conversation that did not expire delivers as it
 * always did. The handoff tests below drive `spawnAgent` with a task whose
 * agent differs from the target column's, and watch the mocked delivery.
 *
 * Red-green: delete the `if (outcome?.recapOnly) return { withholdMessages: ... }`
 * line in `startAgent` and the first test fails; key it on `outcome?.startOver`
 * and the third fails. Change `if (handoffRecapOnly && effectiveAutoCommand?.trim())`
 * to `if (false && ...)` in the handoff branch and the two withheld handoff
 * tests fail; key `handoffRecapOnly` on `startOver` and the not-recap-only
 * handoff test fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentStartReport } from '../../src/main/automations/automation-runner';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';
import type { Swimlane, Task } from '../../src/shared/types';

const mockTaskGetById = vi.fn();
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn();
const mockNotifySpawnBlocked = vi.fn();

const mockExecuteTransition = vi.hoisted(() => vi.fn());
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn(async () => {}));
const mockResumeSuspendedSession = vi.hoisted(() => vi.fn());
const mockDeliverAgentMessageInBackground = vi.hoisted(() => vi.fn());
const mockListForColumn = vi.fn();

// Same avoidance strategy as auto-spawn-for-task-explicit-start-forward.test.ts:
// the engine and the agent registry are stubbed so the module loads without
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

const TASK_ID = 'task-expired-withhold';
const LANE_ID = 'lane-review';
const PROJECT_ID = 'proj-1';

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
    title: 'Resume after the cleanup window',
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

/** The sessionless repository the closure's resume-eligibility lookup reads. */
const sessionlessSessionRepo = {
  getLatestForTask: () => undefined,
  getLatestForTaskByTypeAndIsolation: () => undefined,
} as never;

/**
 * Drive `spawnAgent` and return what its `startAgent` closure handed the
 * runner, called the way the runner calls it for a row that needs the agent.
 * Once the closure has run the task reads back with a session, so the
 * fallback start after the automations stands down and the engine is asked to
 * resume exactly once.
 */
async function startAgentThroughSpawnAgent(outcome: SpawnOutcome): Promise<AgentStartReport | void> {
  mockResumeSuspendedSession.mockResolvedValue(outcome);
  let agentStarted = false;
  mockTaskGetById.mockImplementation(() => makeTask({ session_id: agentStarted ? 'session-new' : null }));
  let report: AgentStartReport | void = undefined;
  mockExecuteTransition.mockImplementation(async (
    _task: unknown, _lane: unknown, _phase: unknown,
    runnerOptions: { startAgent: (pendingPrompt?: string) => Promise<AgentStartReport | void> },
  ) => {
    report = await runnerOptions.startAgent('Review the diff');
    agentStarted = true;
    return { outcomes: [], failures: [], startedAgent: true };
  });

  await spawnAgent({
    context: makeContext(),
    engine: {
      executeTransition: mockExecuteTransition,
      runLegacySpawnAgent: mockRunLegacySpawnAgent,
      resumeSuspendedSession: mockResumeSuspendedSession,
    } as never,
    tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args), update: vi.fn() } as never,
    sessionRepo: sessionlessSessionRepo,
    task: makeTask(),
    fromSwimlaneId: '*',
    toLane: makeLane(),
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
  });

  // The closure reached the engine, so a "returns nothing" result below is the
  // closure's own decision and not a start that never happened.
  expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
  return report;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskGetById.mockReset();
  mockExecuteTransition.mockReset();
  mockResumeSuspendedSession.mockReset();
  mockListForColumn.mockReset();
  mockListForColumn.mockReturnValue([]);
  mockDeliverAgentMessageInBackground.mockReset();
});

describe('spawnAgent: an expired conversation withholds the column\'s messages', () => {
  it('reports the messages withheld, with the run-log reason, when the outcome is recap-only', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: true, messageDropped: false });

    // The reason is what the run log shows beside each skipped message row, so
    // it is pinned by its opening words rather than the whole sentence.
    expect(report).toEqual({
      withholdMessages: expect.stringMatching(/^Not sent\. The agent's conversation had expired/),
    });
  });

  it('reports nothing for an ordinary resume, so the column\'s messages go out', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: null, recapOnly: false, messageDropped: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for an expired start-over that is not recap-only (an isolated column\'s own fresh pass)', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: false, messageDropped: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for a conversation that never started, which is a fresh spawn and not a recap', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'never-started', recapOnly: false, messageDropped: false });

    expect(report).toBeUndefined();
  });
});

/** The column's first enabled Send message row, as the handoff delivery reads it. */
const COLUMN_MESSAGE_ROW = {
  id: 'row-1',
  type: 'send_message',
  trigger: 'enter',
  enabled: true,
  position: 0,
  config: { message: 'Review the diff', mode: 'immediate' },
  condition: null,
  max_runs: null,
};

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

describe('spawnAgent: a handoff onto an expired conversation withholds the column\'s message', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  /**
   * Drive a cross-agent handoff: the task last ran codex and the target column
   * runs claude. The engine resolves `outcome`, the task then reads back with a
   * session, and the column's message (or the task's own command) is what the
   * branch decides whether to deliver.
   */
  async function runHandoff(
    outcome: SpawnOutcome,
    messages: { columnMessage?: boolean; taskAutoCommand?: string | null } = {},
  ): Promise<void> {
    const { columnMessage = true, taskAutoCommand = null } = messages;
    mockResumeSuspendedSession.mockResolvedValue(outcome);
    mockListForColumn.mockReturnValue(columnMessage ? [COLUMN_MESSAGE_ROW] : []);
    mockTaskGetById.mockImplementation(() => makeTask({
      agent: 'codex', auto_command: taskAutoCommand, session_id: 'session-new',
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
      task: makeTask({ agent: 'codex', auto_command: taskAutoCommand }),
      fromSwimlaneId: 'lane-previous',
      toLane: makeLane({ agent_override: 'claude', handoff_context: true }),
      projectId: PROJECT_ID,
      projectPath: '/mock/project',
    });

    // The handoff branch ran, and not the normal one: it resumes the target
    // agent through the engine itself, with the history pointer as its prefix,
    // and starts no enter group. A "delivers nothing" result below is therefore
    // the branch's decision and not a path that never got there.
    expect(mockExecuteTransition).not.toHaveBeenCalled();
    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    const resumeArguments = mockResumeSuspendedSession.mock.calls[0];
    expect(resumeArguments[5]).toBe('claude');
    expect(typeof resumeArguments[6]).toBe('string');
  }

  /** The console lines the withheld branch writes. */
  function withheldLogLines(): string[] {
    return consoleLogSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => /^\[spawnAgent\] Handoff for task task-exp: the conversation had expired/.test(line));
  }

  it('delivers nothing and logs once when the outcome is recap-only and the column has a message', async () => {
    await runHandoff({ startOver: 'expired', recapOnly: true, messageDropped: false });

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('withholds the task\'s own auto_command the same way', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, messageDropped: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('logs nothing when the outcome is recap-only but there is no message to withhold', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, messageDropped: false },
      { columnMessage: false },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(0);
  });

  it('delivers the column\'s message once for an ordinary handoff', async () => {
    await runHandoff({ startOver: null, recapOnly: false, messageDropped: false });

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: TASK_ID,
        sessionId: 'session-new',
        message: 'Review the diff',
        mode: 'immediate',
        freshlySpawned: true,
      }),
    );
    expect(withheldLogLines()).toHaveLength(0);
  });

  it('delivers the task\'s own auto_command once for an ordinary handoff', async () => {
    await runHandoff(
      { startOver: null, recapOnly: false, messageDropped: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Run the checks' }),
    );
  });

  it('still delivers when the start-over expired but is not recap-only (an isolated column\'s own fresh pass)', async () => {
    await runHandoff({ startOver: 'expired', recapOnly: false, messageDropped: false });

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(withheldLogLines()).toHaveLength(0);
  });
});
