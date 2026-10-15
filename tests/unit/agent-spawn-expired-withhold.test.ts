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
 * The opposite miss is a spawn that ran fresh with the task template as its
 * prompt (`SpawnOutcome.resumePromptUnsent`): an isolated column whose own
 * conversation expired, a conversation that never started, or a column that
 * always spawns new. A Send message row took the resume's prompt slot, but the
 * template won it, so the message is in no prompt. `startAgent` hands the row's
 * message (or the task's own command) back, and the runner's `deliverToAgent`
 * types it after the spawn as on any fresh spawn. Those tests drive the REAL
 * runner (`runAutomations`) and the real Send message and Start agent adapters
 * with a stubbed engine, so the order the closures are called in is the
 * runner's own, and the run log is the one a user would read.
 *
 * A legacy Start agent row (manifest `needs: []`) opens the agent through
 * `legacySpawnAgent`, not `startAgent`. When that start was recap-only, the
 * next Send message row asks `startAgent`, which finds the session already
 * there and reports the withhold the legacy row could not.
 *
 * Red-green: delete the `if (outcome?.recapOnly) return { withholdMessages: ... }`
 * line in `startAgent` and the first test fails; key it on `outcome?.startOver`
 * and the third fails. Change `if (handoffRecapOnly && effectiveAutoCommand?.trim())`
 * to `if (false && ...)` in the handoff branch and the two withheld handoff
 * tests fail; key `handoffRecapOnly` on `startOver` and the not-recap-only
 * handoff test fails. Delete the `if (takesPromptSlot && outcome?.resumePromptUnsent)`
 * block and every "delivers ... after the spawn" test fails, while the paired
 * "resume carried it" tests keep passing (that pair is the pre-change
 * behavior). Drop only its `pendingTaskOverride = overrideBeforeTake` line and
 * the task-command tests fail with the column's text delivered in its place.
 * Drop the `legacyStartReport` assignment in `legacySpawnAgent` and the
 * recap-only legacy test fails; key it on `startOver` and the isolated one does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentStartReport } from '../../src/main/automations/automation-runner';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';
import type { AutoCommandMode, AutomationConfig, AutomationRunStatus, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';

const mockTaskGetById = vi.fn();
const mockEnsureTaskWorktree = vi.fn();
const mockEnsureTaskBranchCheckout = vi.fn();
const mockNotifySpawnBlocked = vi.fn();

const mockExecuteTransition = vi.hoisted(() => vi.fn());
const mockRunLegacySpawnAgent = vi.hoisted(() => vi.fn<(...callArguments: unknown[]) => Promise<unknown>>(async () => undefined));
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
import { runAutomations } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import { sendMessageAdapter } from '../../src/main/automations/adapters/send-message';
import { legacySpawnAgentAdapter } from '../../src/main/automations/adapters/legacy/spawn-agent';

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
  // clearAllMocks keeps implementations, so a resolved value set by one test would leak into the next.
  mockRunLegacySpawnAgent.mockReset();
  mockRunLegacySpawnAgent.mockResolvedValue(undefined);
});

describe('spawnAgent: an expired conversation withholds the column\'s messages', () => {
  it('reports the messages withheld, with the run-log reason, when the outcome is recap-only', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: true, messageDropped: false, resumePromptUnsent: false });

    // The reason is what the run log shows beside each skipped message row, so
    // it is pinned by its opening words rather than the whole sentence.
    expect(report).toEqual({
      withholdMessages: expect.stringMatching(/^Not sent\. The agent's conversation had expired/),
    });
  });

  it('reports nothing for an ordinary resume, so the column\'s messages go out', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: null, recapOnly: false, messageDropped: false, resumePromptUnsent: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for an expired start-over that is not recap-only (an isolated column\'s own fresh pass)', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: false, messageDropped: false, resumePromptUnsent: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for a conversation that never started, which is a fresh spawn and not a recap', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'never-started', recapOnly: false, messageDropped: false, resumePromptUnsent: false });

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
    await runHandoff({ startOver: 'expired', recapOnly: true, messageDropped: false, resumePromptUnsent: false });

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('withholds the task\'s own auto_command the same way', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, messageDropped: false, resumePromptUnsent: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('logs nothing when the outcome is recap-only but there is no message to withhold', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, messageDropped: false, resumePromptUnsent: false },
      { columnMessage: false },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(0);
  });

  it('delivers the column\'s message once for an ordinary handoff', async () => {
    await runHandoff({ startOver: null, recapOnly: false, messageDropped: false, resumePromptUnsent: false });

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
      { startOver: null, recapOnly: false, messageDropped: false, resumePromptUnsent: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Run the checks' }),
    );
  });

  it('still delivers when the start-over expired but is not recap-only (an isolated column\'s own fresh pass)', async () => {
    await runHandoff({ startOver: 'expired', recapOnly: false, messageDropped: false, resumePromptUnsent: false });

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(withheldLogLines()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The enter group, driven by the real runner
// ---------------------------------------------------------------------------

const COLUMN_TEXT = 'Review the diff';
const TASK_COMMAND = 'Run the checks';

/** A spawn outcome that changed nothing; a test names only the fields it cares about. */
function outcomeOf(fields: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return { startOver: null, recapOnly: false, messageDropped: false, resumePromptUnsent: false, ...fields };
}

function enterRow(fields: Pick<ColumnAutomation, 'name' | 'type' | 'config' | 'position'>): ColumnAutomation {
  return {
    id: `row-${fields.position}`,
    swimlane_id: LANE_ID,
    trigger: 'enter',
    enabled: true,
    condition: null,
    max_runs: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...fields,
  } as ColumnAutomation;
}

/** A Send message row. Its name is its position, so a run log line reads as `Message 1`. */
function messageRow(message: string, position = 0): ColumnAutomation {
  return enterRow({ name: `Message ${position}`, type: 'send_message', config: { message, mode: 'immediate' }, position });
}

/** The legacy Start agent row: its type `needs` no agent, and it opens one through `legacySpawnAgent`. */
function startAgentRow(position = 0): ColumnAutomation {
  return enterRow({ name: 'Start agent', type: 'spawn_agent', config: { promptTemplate: '{{task_xml}}' }, position });
}

interface RunLogRow {
  id: string;
  name: string;
  status: AutomationRunStatus;
  detail: string | null;
}

/** Records what the runner wrote, so an assertion reads like the run log a user sees. */
function fakeRunLog() {
  const rows: RunLogRow[] = [];
  const record = (input: { id: string; automation: ColumnAutomation }, status: AutomationRunStatus, detail: string | null): void => {
    rows.push({ id: input.id, name: input.automation.name, status, detail });
  };
  const repository = {
    start: (input: { id: string; automation: ColumnAutomation }) => record(input, 'running', null),
    finish: (id: string, status: AutomationRunStatus, detail: string | null) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, { status, detail });
    },
    recordSkipped: (input: { id: string; automation: ColumnAutomation }, reason: string) => record(input, 'skipped', reason),
    recordDeliveredByCaller: (input: { id: string; automation: ColumnAutomation }, detail: string) => record(input, 'succeeded', detail),
  };
  return { rows, repository: repository as unknown as AutomationRunRepository };
}

/** What `spawnAgent` hands the engine's `executeTransition` for an enter group. */
interface EnterGroupOptions {
  signal: AbortSignal;
  startAgent: (pendingPrompt?: string) => Promise<AgentStartReport | void>;
  deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void>;
  legacySpawnAgent: (config: AutomationConfig) => Promise<void>;
  suppressAgentMessages?: boolean;
}

/** The destination's suspended conversation: eligible to resume, so a message can take the prompt slot. */
const resumableDestinationRepo = {
  getLatestForTask: () => undefined,
  getLatestForTaskByTypeAndIsolation: () => ({
    id: 'record-suspended',
    agent_session_id: 'aaaaaaaa-1111-4222-8333-444444444444',
    session_type: 'claude_agent',
    status: 'suspended',
    cwd: '/mock/project',
  }),
} as never;

interface EnterGroupScenario {
  rows: ColumnAutomation[];
  /** What the engine resolves for the resume `startAgent` asks for. */
  resumeOutcome?: SpawnOutcome;
  /** What the engine resolves for a legacy Start agent row. */
  legacyOutcome?: SpawnOutcome;
  lane?: Partial<Swimlane>;
  /** Fields of the task as `spawnAgent` receives it, such as its own `auto_command`. */
  taskFields?: Partial<Task>;
  /** The destination has no conversation to resume, so a message cannot take the prompt slot. */
  noResumableDestination?: boolean;
}

/** No suspended conversation at the destination: the spawn is fresh from the start. */
const freshDestinationRepo = {
  getLatestForTask: () => undefined,
  getLatestForTaskByTypeAndIsolation: () => undefined,
} as never;

/**
 * Drive `spawnAgent` for a move into a column with these enter rows. The stubbed
 * engine's `executeTransition` runs the REAL `runAutomations` over them with the
 * real Send message and Start agent adapters, handing it the `startAgent`,
 * `deliverToAgent` and `legacySpawnAgent` that `spawnAgent` built. So the order
 * the closures are called in, and what each row records, are the runner's own.
 * Once an agent start has resolved the task reads back with a session.
 */
async function runEnterGroup(scenario: EnterGroupScenario): Promise<{ rows: RunLogRow[] }> {
  let agentStarted = false;
  mockResumeSuspendedSession.mockResolvedValue(scenario.resumeOutcome ?? outcomeOf());
  mockRunLegacySpawnAgent.mockImplementation(async () => {
    agentStarted = true;
    return scenario.legacyOutcome ?? outcomeOf();
  });
  mockTaskGetById.mockImplementation(() => makeTask({ ...scenario.taskFields, session_id: agentStarted ? 'session-new' : null }));

  const registry = new AutomationRegistry();
  registry.register(sendMessageAdapter);
  registry.register(legacySpawnAgentAdapter);
  const runLog = fakeRunLog();

  mockExecuteTransition.mockImplementation(async (task: Task, lane: Swimlane, _trigger: string, groupOptions: EnterGroupOptions) => runAutomations({
    automations: scenario.rows,
    column: lane,
    runs: runLog.repository,
    signal: groupOptions.signal,
    registry,
    suppressAgentMessages: groupOptions.suppressAgentMessages,
    startAgent: async (pendingPrompt) => {
      const report = await groupOptions.startAgent(pendingPrompt);
      agentStarted = true;
      return report;
    },
    context: {
      task,
      column: lane,
      fromColumn: null,
      toColumn: lane,
      trigger: 'enter',
      cwd: '/mock/project',
      projectId: PROJECT_ID,
      projectPath: '/mock/project',
      projectName: 'Example',
      templateVars: {},
      sessionHost: { getShell: async () => 'bash' },
      deliverToAgent: groupOptions.deliverToAgent,
      showNotification: vi.fn(),
      legacySpawnAgent: groupOptions.legacySpawnAgent,
    },
  }));

  await spawnAgent({
    context: makeContext(),
    engine: {
      executeTransition: mockExecuteTransition,
      runLegacySpawnAgent: mockRunLegacySpawnAgent,
      resumeSuspendedSession: mockResumeSuspendedSession,
    } as never,
    tasks: { getById: (...args: unknown[]) => mockTaskGetById(...args), update: vi.fn() } as never,
    sessionRepo: scenario.noResumableDestination ? freshDestinationRepo : resumableDestinationRepo,
    task: makeTask(scenario.taskFields),
    fromSwimlaneId: '*',
    toLane: makeLane(scenario.lane),
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
  });

  return { rows: runLog.rows };
}

/** The message of each background delivery, in order. */
function deliveredMessages(): string[] {
  return mockDeliverAgentMessageInBackground.mock.calls.map((call) => (call[1] as { message: string }).message);
}

describe('spawnAgent: a message that took the resume\'s prompt slot, after a spawn that ran fresh', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  // The spawn resolved fresh in each of these, so the template, not the
  // message, was the prompt. The lane and `startOver` are the ones the engine
  // would report them with; `spawnAgent` itself reads only the outcome's flag.
  const FRESH_SPAWNS: Array<{ name: string; lane: Partial<Swimlane>; startOver: SpawnOutcome['startOver'] }> = [
    { name: 'an isolated column whose own conversation expired', lane: { session_target: 'isolated' }, startOver: 'expired' },
    { name: 'a column that always spawns a new session', lane: { session_spawn_strategy: 'always_spawn_new' }, startOver: null },
    { name: 'a conversation that never started', lane: {}, startOver: 'never-started' },
  ];

  describe.each(FRESH_SPAWNS)('$name', ({ lane, startOver }) => {
    it('delivers the row\'s message once, after the spawn, when the engine reports the resume prompt unsent', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        lane,
        resumeOutcome: outcomeOf({ startOver, resumePromptUnsent: true }),
      });

      // The message took the prompt slot, so nothing but the engine's report
      // tells `spawnAgent` that the prompt it asked for never went out.
      expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(COLUMN_TEXT);
      expect(deliveredMessages()).toEqual([COLUMN_TEXT]);
      expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ taskId: TASK_ID, sessionId: 'session-new', message: COLUMN_TEXT, mode: 'immediate', freshlySpawned: true }),
      );
      expect(rows.map((row) => row.status)).toEqual(['succeeded']);
    });

    it('does not deliver it a second time when the engine reports the resume carried it', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        lane,
        resumeOutcome: outcomeOf({ startOver, resumePromptUnsent: false }),
      });

      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(COLUMN_TEXT);
      expect(deliveredMessages()).toEqual([]);
      expect(rows.map((row) => row.status)).toEqual(['succeeded']);
    });
  });

  describe('a task with its own auto_command', () => {
    it('delivers the task\'s command, not the column\'s text, once the resume prompt was unsent', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ startOver: 'never-started', resumePromptUnsent: true }),
      });

      // The task's command outranks the column's message and is what took the slot.
      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
      expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    });

    it('does not deliver the task\'s command a second time when the resume carried it', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ resumePromptUnsent: false }),
      });

      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
      expect(deliveredMessages()).toEqual([]);
    });

    it('spends the command once: the next message row is the column\'s own text', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT, 0), messageRow('Then summarize', 1)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ startOver: 'never-started', resumePromptUnsent: true }),
      });

      expect(deliveredMessages()).toEqual([TASK_COMMAND, 'Then summarize']);
    });

    it('spends the command on the resume when it rode there: only the next row is delivered', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT, 0), messageRow('Then summarize', 1)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ resumePromptUnsent: false }),
      });

      expect(deliveredMessages()).toEqual(['Then summarize']);
    });

    // Red-green: `if (!takesPromptSlot) pendingTaskOverride = overrideBeforeTake`
    // in `startAgent`. Without it the slot check consumed the command, and the
    // column's text went out in its place.
    it('delivers the task\'s command after a fresh spawn the message could not ride', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        taskFields: { auto_command: TASK_COMMAND },
        noResumableDestination: true,
      });

      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBeUndefined();
      expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    });

    it('delivers the column\'s text after a fresh spawn when the task has no command', async () => {
      await runEnterGroup({
        rows: [messageRow(COLUMN_TEXT)],
        noResumableDestination: true,
      });

      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBeUndefined();
      expect(deliveredMessages()).toEqual([COLUMN_TEXT]);
    });
  });
});

describe('spawnAgent: a legacy Start agent row that opened the agent on an expired conversation', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('withholds the Send message row after it, which the run log records as skipped with the expired-conversation reason', async () => {
    const { rows } = await runEnterGroup({
      rows: [startAgentRow(0), messageRow(COLUMN_TEXT, 1)],
      legacyOutcome: outcomeOf({ startOver: 'expired', recapOnly: true }),
    });

    // The legacy row started the agent, so the message row's own start found
    // the session already there instead of resuming one.
    expect(mockRunLegacySpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(deliveredMessages()).toEqual([]);
    expect(rows.map((row) => [row.name, row.status])).toEqual([['Start agent', 'succeeded'], ['Message 1', 'skipped']]);
    expect(rows[1].detail).toMatch(/^Not sent\. The agent's conversation had expired/);
  });

  it('delivers the Send message row when the legacy start was an ordinary one', async () => {
    const { rows } = await runEnterGroup({
      rows: [startAgentRow(0), messageRow(COLUMN_TEXT, 1)],
      legacyOutcome: outcomeOf(),
    });

    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(deliveredMessages()).toEqual([COLUMN_TEXT]);
    expect(rows.map((row) => [row.name, row.status])).toEqual([['Start agent', 'succeeded'], ['Message 1', 'succeeded']]);
  });

  it('delivers the Send message row when the start-over expired but is not recap-only (an isolated column\'s own fresh pass)', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0), messageRow(COLUMN_TEXT, 1)],
      legacyOutcome: outcomeOf({ startOver: 'expired', recapOnly: false }),
    });

    expect(deliveredMessages()).toEqual([COLUMN_TEXT]);
  });

  it('withholds every Send message row after it, not only the first', async () => {
    const { rows } = await runEnterGroup({
      rows: [startAgentRow(0), messageRow(COLUMN_TEXT, 1), messageRow('Then summarize', 2)],
      legacyOutcome: outcomeOf({ startOver: 'expired', recapOnly: true }),
    });

    expect(deliveredMessages()).toEqual([]);
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'skipped', 'skipped']);
  });
});
