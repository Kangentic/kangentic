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
 * there and reports the withhold the legacy row could not. That row sends no
 * message itself, so when no row after it sends the task's own `auto_command`,
 * `spawnAgent` delivers it once the group ends, unless the start was
 * recap-only.
 *
 * A Send message row with no message to send starts the agent the same way
 * from the other side: the runner calls `startAgent(undefined)`, because an
 * empty message is no pending prompt, and then the row returns "No message to
 * send." without calling `deliverToAgent`. On a fresh spawn the task's own
 * command could not take the prompt slot, so `spawnAgent` delivers it once the
 * group ends.
 *
 * Red-green: delete the `if (outcome?.recapOnly) return { withholdMessages: ... }`
 * line in `startAgent` and the first test fails; key it on `outcome?.startOver`
 * and the third fails. Change `if (handoffRecapOnly && effectiveAutoCommand?.trim())`
 * to `if (false && ...)` in the handoff branch and the two withheld handoff
 * tests fail; key `handoffRecapOnly` on `startOver` and the not-recap-only
 * handoff test fails. Drop the `|| outcome?.resumePromptUnsent` half of the
 * restore's condition and every "delivers ... after the spawn" test fails, while the paired
 * "resume carried it" tests keep passing (that pair is the pre-change
 * behavior). Drop only its `pendingTaskOverride = overrideBeforeTake` line and
 * the task-command tests fail with the column's text delivered in its place.
 * Drop the `legacyStartReport` assignment in `legacySpawnAgent` and the
 * recap-only legacy test fails; key it on `startOver` and the isolated one does.
 * Delete the no-row fallback's `if (pendingTaskOverride !== null) await deliverToAgent(...)`
 * line and the first two "no row that needs the agent" tests fail with nothing
 * delivered; delete the `if (outcome?.recapOnly) return ...` line and the
 * recap-only-with-resume-prompt-unsent test there fails with the command delivered.
 * Delete the `await deliverToAgent('', 'immediate')` after a legacy row's start
 * and the first "after a legacy Start agent row" test fails with nothing
 * delivered; deliver there even on a recap-only start and the second fails.
 * Drop `&& !signal?.aborted` from that branch and only the superseded-move test
 * fails; drop `startedAgentInGroup &&` and only the already-live-session test
 * fails; key the branch on the outcome's `startOver` and only the expired
 * fresh-pass test fails.
 * Delete the `startedAgentInGroup = true;` line inside `startAgent` (the one
 * after `engine.resumeSuspendedSession`, not `legacySpawnAgent`'s) and the Send
 * message rows with no message to send fail with nothing delivered, while the
 * tests whose row delivers the command itself keep passing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentStartReport } from '../../src/main/automations/automation-runner';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';
import type { AutoCommandMode, AutomationConfig, AutomationRunStatus, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { AutomationAdapter } from '../../src/main/automations/shared/automation-adapter';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';

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
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: true, resumePromptUnsent: false });

    // The reason is what the run log shows beside each skipped message row, so
    // it is pinned by its opening words rather than the whole sentence.
    expect(report).toEqual({
      withholdMessages: expect.stringMatching(/^Not sent\. The agent's conversation had expired/),
    });
  });

  it('reports nothing for an ordinary resume, so the column\'s messages go out', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: null, recapOnly: false, resumePromptUnsent: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for an expired start-over that is not recap-only (an isolated column\'s own fresh pass)', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'expired', recapOnly: false, resumePromptUnsent: false });

    expect(report).toBeUndefined();
  });

  it('reports nothing for a conversation that never started, which is a fresh spawn and not a recap', async () => {
    const report = await startAgentThroughSpawnAgent({ startOver: 'never-started', recapOnly: false, resumePromptUnsent: false });

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
    await runHandoff({ startOver: 'expired', recapOnly: true, resumePromptUnsent: false });

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('withholds the task\'s own auto_command the same way', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, resumePromptUnsent: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(1);
  });

  it('logs nothing when the outcome is recap-only but there is no message to withhold', async () => {
    await runHandoff(
      { startOver: 'expired', recapOnly: true, resumePromptUnsent: false },
      { columnMessage: false },
    );

    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(withheldLogLines()).toHaveLength(0);
  });

  it('delivers the column\'s message once for an ordinary handoff', async () => {
    await runHandoff({ startOver: null, recapOnly: false, resumePromptUnsent: false });

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
      { startOver: null, recapOnly: false, resumePromptUnsent: false },
      { columnMessage: false, taskAutoCommand: 'Run the checks' },
    );

    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Run the checks' }),
    );
  });

  it('still delivers when the start-over expired but is not recap-only (an isolated column\'s own fresh pass)', async () => {
    await runHandoff({ startOver: 'expired', recapOnly: false, resumePromptUnsent: false });

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
  return { startOver: null, recapOnly: false, resumePromptUnsent: false, ...fields };
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
  /** The task already has a live session when `spawnAgent` is called, so nothing in the move starts one. */
  sessionAlreadyLive?: boolean;
  /** The move's signal, which a test aborts to supersede the move mid-group. */
  signal?: AbortSignal;
  /** Adapters registered next to the Send message and Start agent ones, for a row that is not either. */
  extraAdapters?: AutomationAdapter[];
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
  let agentStarted = scenario.sessionAlreadyLive === true;
  // The engine's resume is what gives the task its session, so it reads back
  // with one from there on. That holds for the fallback start after the
  // automations too, where no row's `startAgent` wrapper below is involved.
  mockResumeSuspendedSession.mockImplementation(async () => {
    agentStarted = true;
    return scenario.resumeOutcome ?? outcomeOf();
  });
  mockRunLegacySpawnAgent.mockImplementation(async () => {
    agentStarted = true;
    return scenario.legacyOutcome ?? outcomeOf();
  });
  mockTaskGetById.mockImplementation(() => makeTask({ ...scenario.taskFields, session_id: agentStarted ? 'session-new' : null }));

  const registry = new AutomationRegistry();
  registry.register(sendMessageAdapter);
  registry.register(legacySpawnAgentAdapter);
  for (const extraAdapter of scenario.extraAdapters ?? []) registry.register(extraAdapter);
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
    task: makeTask({ ...scenario.taskFields, session_id: scenario.sessionAlreadyLive ? 'session-new' : null }),
    fromSwimlaneId: '*',
    toLane: makeLane(scenario.lane),
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
    signal: scenario.signal,
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

    // Red-green: the `!takesPromptSlot ||` half of the restore's condition in
    // `startAgent`. Without it the slot check consumed the command, and the
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

// A column that has no enter row needing the agent starts it from the fallback
// at the end of `spawnAgent`, with no row's message to send. The only message
// left is the task's own `auto_command`, and docs/integrations/mcp-server/task-tools.md promises it runs
// once the agent spawns for the task. These tests run that fallback: `rows` is
// empty, so the runner never asks `startAgent` and the task's command is the
// one thing that can still go out.
describe('spawnAgent: the task\'s own auto_command in a column with no row that needs the agent', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  // Red-green: delete the fallback's `if (pendingTaskOverride !== null) await deliverToAgent('', 'immediate');`
  // and this test and the next fail with nothing delivered.
  it('delivers the command once after the spawn when it took the prompt slot and the engine reports the resume prompt unsent', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      resumeOutcome: outcomeOf({ startOver: 'never-started', resumePromptUnsent: true }),
    });

    // The enter group ran and started nothing, so the engine call below is the
    // fallback's, and the command it carried as the resume prompt never went out.
    expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: TASK_ID, sessionId: 'session-new', message: TASK_COMMAND, mode: 'immediate', freshlySpawned: true }),
    );
  });

  it('delivers the command once after a plain fresh spawn, whose prompt is the task template and not the command', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      noResumableDestination: true,
    });

    // No conversation to resume and no `skipPromptTemplate`, so the command
    // could not take the prompt slot: the engine got no resume prompt at all.
    expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession.mock.calls[0][3]).toBeUndefined();
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: TASK_ID, sessionId: 'session-new', message: TASK_COMMAND, mode: 'immediate', freshlySpawned: true }),
    );
  });

  it('delivers nothing when the spawn was recap-only, because the recap is the session\'s whole prompt', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      resumeOutcome: outcomeOf({ startOver: 'expired', recapOnly: true }),
    });

    // The command took the slot but the recap replaced it, and a recap-only
    // start never gives the command back to the fallback.
    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
    expect(deliveredMessages()).toEqual([]);
  });

  // The engine never reports both (`resumePromptUnsent` is false whenever
  // `recapOnly` is true), so this is not a state a spawn reaches. It pins the
  // order inside `startAgent`: the recap-only return comes before the restore
  // of the command, so the restore cannot be what lets a command through.
  it('delivers nothing for a recap-only outcome even if it also claimed the resume prompt unsent', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      resumeOutcome: outcomeOf({ startOver: 'expired', recapOnly: true, resumePromptUnsent: true }),
    });

    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(deliveredMessages()).toEqual([]);
  });

  it('does not deliver the command a second time when the resume carried it as its prompt', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      resumeOutcome: outcomeOf({ startOver: null, resumePromptUnsent: false }),
    });

    expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
    expect(mockDeliverAgentMessageInBackground).not.toHaveBeenCalled();
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

/** A Run script row. Its adapter is `failingScriptAdapter`, so no shell runs. */
function scriptRow(position: number): ColumnAutomation {
  return enterRow({ name: 'Run script', type: 'run_script', config: { script: 'npm run setup' }, position });
}

/** Stands in for the Run script adapter: runs `beforeFailing`, then fails as a script that exits non-zero does. */
function failingScriptAdapter(beforeFailing: () => void = () => undefined): AutomationAdapter {
  return {
    id: 'run_script',
    manifest: AUTOMATION_MANIFEST.run_script,
    describe: () => 'Run script',
    execute: async () => {
      beforeFailing();
      throw new Error('Script exited with code 1.');
    },
  };
}

// A legacy Start agent row starts the agent and sends nothing, so in a column
// where no row after it needs the agent, the task's own `auto_command` used to
// go nowhere: `spawnAgent` returned as soon as it saw a session.
describe('spawnAgent: the task\'s own auto_command after a legacy Start agent row', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A failed row is logged by the runner, and the error it rethrows by spawnAgent, both through console.error.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // Red-green: delete the `await deliverToAgent('', 'immediate')` after the
  // enter group and this test fails with nothing delivered.
  it('delivers the command once after the group when the legacy row is the only agent start', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf(),
    });

    expect(mockRunLegacySpawnAgent).toHaveBeenCalledTimes(1);
    // The legacy row's session is the agent; the fallback start does not run.
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: TASK_ID, sessionId: 'session-new', message: TASK_COMMAND, mode: 'immediate', freshlySpawned: true }),
    );
  });

  // Red-green: drop the `if (legacyStartReport)` branch (deliver either way)
  // and this test fails with the command typed over the recap.
  it('delivers nothing when the legacy start opened on an expired conversation\'s recap', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf({ startOver: 'expired', recapOnly: true }),
    });

    expect(deliveredMessages()).toEqual([]);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('the task\'s command is not sent'));
  });

  it('delivers the command once when a Send message row after the legacy row already sent it', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0), messageRow(COLUMN_TEXT, 1)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf(),
    });

    // The message row took the task's command in place of the column's text.
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
  });

  it('delivers nothing when the task has no command of its own', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0)],
      legacyOutcome: outcomeOf(),
    });

    expect(deliveredMessages()).toEqual([]);
  });

  // Red-green: key the branch on the outcome's `startOver` instead of on
  // `legacyStartReport` (store `outcome?.startOver === 'expired'` in
  // `legacySpawnAgent` and test that) and this test fails with nothing
  // delivered. The Send message test above, which pins the column's text, does
  // not fail under that mutation: this is the one that pins the task's command.
  it('delivers the command once when the legacy start was an expired conversation\'s fresh pass, which is not recap-only', async () => {
    await runEnterGroup({
      rows: [startAgentRow(0)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf({ startOver: 'expired', recapOnly: false }),
    });

    // An isolated column keeps its own conversation and runs a normal fresh
    // pass with the recap as context, so nothing waits on the recap and the
    // command is the agent's first instruction.
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('the task\'s command is not sent'));
  });

  // Red-green: delete the `await deliverToAgent('', 'immediate')` after the
  // group and this test fails with nothing delivered, as does the first test
  // in this block.
  it('delivers the command once at the end of the group when the Send message row after the legacy row was skipped', async () => {
    const { rows } = await runEnterGroup({
      // A Condition with no checker behind it skips the row before it can ask
      // for the agent, which the legacy row has already started.
      rows: [startAgentRow(0), { ...messageRow(COLUMN_TEXT, 1), condition: 'The diff is ready for review' }],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf(),
    });

    expect(rows.map((row) => [row.name, row.status])).toEqual([['Start agent', 'succeeded'], ['Message 1', 'skipped']]);
    expect(rows[1].detail).toBe('The condition was not checked.');
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    // Once, and the task's command rather than the skipped row's text: nothing
    // consumed it before the group ended.
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
  });

  // Red-green: drop `startedAgentInGroup &&` from the branch after the group and
  // this test fails with the command delivered to a session this move did not
  // start. The flag is set by a legacy Start agent row or by `startAgent`, and
  // neither runs here. `spawnAgent` is an idempotent ensure, so a second call
  // for a task whose agent is already live must not type the command at it again.
  it('delivers nothing when the task already had a live session and no row in the group started an agent', async () => {
    await runEnterGroup({
      rows: [],
      taskFields: { auto_command: TASK_COMMAND },
      sessionAlreadyLive: true,
    });

    expect(mockRunLegacySpawnAgent).not.toHaveBeenCalled();
    expect(mockResumeSuspendedSession).not.toHaveBeenCalled();
    expect(deliveredMessages()).toEqual([]);
  });

  // The runner rethrows a row's OWN error, not an AbortError, when the move's
  // signal was aborted while the row ran. `spawnAgent`'s catch rethrows only
  // AbortErrors, so the move reaches the code after the group looking as if it
  // ran to the end. A superseded move must not type the command.
  //
  // Red-green: delete `&& !signal?.aborted` from the branch after the enter
  // group and this test fails with the command delivered.
  it('delivers nothing when a row after the legacy row fails with its own error while the move is aborted', async () => {
    const supersededMove = new AbortController();
    const { rows } = await runEnterGroup({
      rows: [startAgentRow(0), scriptRow(1)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf(),
      signal: supersededMove.signal,
      extraAdapters: [failingScriptAdapter(() => supersededMove.abort())],
    });

    // The legacy row started the agent, and the script row was interrupted by
    // the abort and rethrew a plain Error: the case the gate exists for.
    expect(mockRunLegacySpawnAgent).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => [row.name, row.status])).toEqual([['Start agent', 'succeeded'], ['Run script', 'interrupted']]);
    expect(supersededMove.signal.aborted).toBe(true);
    expect(deliveredMessages()).toEqual([]);
  });

  // The control: the same rows and the same failure, with the move left alone.
  // It shows the abort, not the failing row, is what withholds the command, so
  // a gate widened to "any failed row" fails here.
  it('still delivers the command once when the later row failed but the move was not superseded', async () => {
    const { rows } = await runEnterGroup({
      rows: [startAgentRow(0), scriptRow(1)],
      taskFields: { auto_command: TASK_COMMAND },
      legacyOutcome: outcomeOf(),
      extraAdapters: [failingScriptAdapter()],
    });

    expect(rows.map((row) => [row.name, row.status])).toEqual([['Start agent', 'succeeded'], ['Run script', 'failed']]);
    expect(deliveredMessages()).toEqual([TASK_COMMAND]);
  });
});

// A Send message row with no message needs the agent, so the runner starts it
// through `startAgent`, but `pendingPrompt` is undefined for an empty message
// and the row's `execute` returns "No message to send." without calling
// `deliverToAgent`. Nothing in the group sends the task's own `auto_command`,
// so it has to go out once the group ends.
describe('spawnAgent: the task\'s own auto_command after a Send message row with no message to send', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  /** `readMessage` trims, so both read as no message. */
  const EMPTY_MESSAGES = [
    { name: 'an empty message', message: '' },
    { name: 'a message of only whitespace', message: '  \n\t ' },
  ];

  describe.each(EMPTY_MESSAGES)('$name', ({ message }) => {
    // Red-green: delete the `startedAgentInGroup = true;` line inside
    // `startAgent` and this test fails with nothing delivered. The row
    // statuses are what show the Send message row, and not the no-row
    // fallback, started the agent.
    it('delivers the command once after a fresh spawn whose prompt is the task template', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(message)],
        taskFields: { auto_command: TASK_COMMAND },
        noResumableDestination: true,
      });

      expect(mockExecuteTransition).toHaveBeenCalledTimes(1);
      expect(mockRunLegacySpawnAgent).not.toHaveBeenCalled();
      // No conversation to resume and no `skipPromptTemplate`, so the command
      // could not take the prompt slot: the engine got no resume prompt at all.
      expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBeUndefined();
      expect(rows.map((row) => [row.name, row.status, row.detail])).toEqual([['Message 0', 'succeeded', 'No message to send.']]);
      expect(deliveredMessages()).toEqual([TASK_COMMAND]);
      expect(mockDeliverAgentMessageInBackground).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ taskId: TASK_ID, sessionId: 'session-new', message: TASK_COMMAND, mode: 'immediate', freshlySpawned: true }),
      );
    });

    // Red-green: the same deletion. The command took the prompt slot and the
    // engine reports it never reached the agent, so the restore hands it back
    // and only the end of the group can send it.
    it('delivers the command once after the spawn when it took the prompt slot and the engine reports the resume prompt unsent', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(message)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ startOver: 'never-started', resumePromptUnsent: true }),
      });

      expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
      expect(rows.map((row) => [row.name, row.status, row.detail])).toEqual([['Message 0', 'succeeded', 'No message to send.']]);
      expect(deliveredMessages()).toEqual([TASK_COMMAND]);
    });

    it('does not deliver the command a second time when the resume carried it as its prompt', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(message)],
        taskFields: { auto_command: TASK_COMMAND },
        resumeOutcome: outcomeOf({ resumePromptUnsent: false }),
      });

      expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(mockResumeSuspendedSession.mock.calls[0][3]).toBe(TASK_COMMAND);
      expect(rows.map((row) => [row.name, row.status, row.detail])).toEqual([['Message 0', 'succeeded', 'No message to send.']]);
      expect(deliveredMessages()).toEqual([]);
    });

    it('delivers nothing when the task has no command of its own', async () => {
      const { rows } = await runEnterGroup({
        rows: [messageRow(message)],
        noResumableDestination: true,
      });

      expect(mockResumeSuspendedSession).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => [row.name, row.status, row.detail])).toEqual([['Message 0', 'succeeded', 'No message to send.']]);
      expect(deliveredMessages()).toEqual([]);
    });
  });
});
