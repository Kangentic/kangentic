/**
 * Line breaks survive every way `handleTaskMove` hands a column's message to a
 * live agent (src/main/ipc/handlers/task-move.ts):
 *
 *   - the SOURCE column's On task exit rows (awaited inside the exit budget),
 *   - the warm move's injection of the DESTINATION column's first message,
 *   - the rest of the destination's On task enter rows (fire and forget).
 *
 * Keystrokes flatten newlines to spaces, so a multi-line message must be pasted
 * (`terminalSubmit.submitContent`), and a one-line message must stay on the
 * keystroke scheduler, which is the only way a slash command runs.
 *
 * The automation runner is replaced by a stub that walks a fixed list of
 * Send message rows and calls `deliverToAgent` for each, the way the real
 * runner does, and the turn wait is mocked so each test decides when the
 * agent's turn ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, AutoCommandMode } from '../../src/shared/types';
import type { TurnCompletionResult } from '../../src/main/transition-engine/turn-completion';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';

interface MessageRow {
  id: string;
  message: string;
  mode: AutoCommandMode;
  /** The row's Condition, as the automations repository lists it. Absent: none. */
  condition?: string | null;
  /** The row's Frequency limit, as the automations repository lists it. Absent: none. */
  max_runs?: number | null;
}

const hoisted = vi.hoisted(() => ({
  turnWaits: [] as Array<{ sessionId: string; signal: AbortSignal | undefined; resolve: (result: TurnCompletionResult) => void }>,
  /** Send message rows per `${laneId}:${trigger}`. */
  rows: new Map<string, MessageRow[]>(),
  /** Every group the stub runner was asked to run, with the skip list the move handed it. */
  engineRuns: [] as Array<{
    trigger: 'enter' | 'exit';
    alreadyDelivered: ReadonlySet<string> | undefined;
    agentEndingReason: string | undefined;
  }>,
  /**
   * Rows the REAL runner would skip after its own checks: a Condition the
   * Automation agent answered no, or a spent Frequency limit. The stub honors
   * them after the `alreadyDelivered` check, in the real runner's order.
   */
  runnerSkips: new Set<string>(),
  /** The per-row signal the stub runner hands an exit row, so a test can stop it. */
  exitRowController: null as AbortController | null,
  rowErrors: [] as string[],
  /** What each exit row's delivery returned for its run's detail (undefined: the adapter's own word). */
  exitDetails: [] as Array<string | void>,
  /** Messages held for the task, in order, with what the harness's event log read at the time. */
  holds: [] as Array<{ message: string; eventsBefore: string[] }>,
  /** The harness's event log, shared so the held-messages mock can write to it. */
  events: [] as string[],
  reports: [] as InjectionReport[],
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/git/git-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/git-client')>()),
  gitAt: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));
// `getGlobalDb` is read by the dev-port ledger when a warm move resolves `{{port}}`
// (`getDevPortForTask` -> `DevPortRepository.listForTask`, which calls
// `.prepare(...).all(taskId)`). Left off the mock, vitest throws on the missing
// export, the ledger degrades to no lease and prints that stack trace. An empty
// table is the same answer the degraded read gave, so no assertion moves.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getGlobalDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => ({
      id: 'rec-main',
      task_id: 'task-paste-0001',
      isolated_swimlane_id: null,
      agent_session_id: 'agent-A',
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      session_type: 'claude_agent',
      permission_mode: null,
      applied_model: null,
      applied_effort: null,
    }));
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
    // Unknown by id, so `resolveOwnSessionRecord` falls back to the latest record above.
    findByAnyId = vi.fn(() => undefined);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
    // Read by a move to Done's completion analytics.
    getSummaryForTask = vi.fn(() => null);
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
// The real plan builder by default: with no adapter it carries the message
// alone, which is the plain warm move. One case overrides it with a settings
// write ahead of the message.
vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>();
  return { ...actual, prepareInjectionPlan: vi.fn(actual.prepareInjectionPlan) };
});
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', async () => {
  const { interpolateTaskTemplate } = await import('../../src/main/agent/shared/template-utils');
  const { resolveTaskTemplateVars } = await import('../../src/main/agent/shared/task-template-resolvers');
  return {
    interpolateTemplate: vi.fn((template: string) => template),
    resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
    execVersion: vi.fn(async () => '1.0.0'),
    interpolateTaskTemplate,
    resolveTaskTemplateVars,
  };
});
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({
  reportAutoCommandOutcome: vi.fn((_context: unknown, _tasks: unknown, _task: unknown, report: InjectionReport) => {
    hoisted.reports.push(report);
  }),
}));
// The hold writes to the project database, which this harness does not have.
// Recorded instead, with the moment it ran, so a case can pin it after the suspend.
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return {
    ...actual,
    clearHeldMessages: vi.fn(),
    holdTaskMessage: vi.fn((_context: unknown, input: { message: string }) => {
      hoisted.holds.push({ message: input.message, eventsBefore: [...hoisted.events] });
      return { status: 'held', displayId: 1, rowId: `held-${hoisted.holds.length}` };
    }),
  };
});
vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: vi.fn((
    _sessionManager: unknown,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ) => new Promise<TurnCompletionResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve('aborted');
      return;
    }
    options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
    hoisted.turnWaits.push({ sessionId, signal: options.signal, resolve });
  })),
}));

/** Stands in for the automation runner: one `deliverToAgent` per Send message row. */
function makeEngine() {
  return {
    executeTransition: vi.fn(async (
      task: Task,
      lane: Swimlane,
      trigger: 'enter' | 'exit',
      runOptions: {
        signal: AbortSignal;
        alreadyDelivered?: Set<string>;
        agentEndingReason?: string;
        deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal, runId: string) => Promise<string | void>;
      },
    ) => {
      hoisted.engineRuns.push({
        trigger,
        alreadyDelivered: runOptions.alreadyDelivered,
        agentEndingReason: runOptions.agentEndingReason,
      });
      // The real runner skips every Send message row when the move ends the
      // agent (pinned in automation-runner.test.ts), so the stub does too.
      if (runOptions.agentEndingReason) return { outcomes: [], failures: [] };
      // Mirrors the real engine's gate (TransitionEngine.executeTransition, pinned
      // in transition-engine-automations-disabled.test.ts): a task whose
      // automations are disabled has every row recorded as skipped and nothing
      // delivered. Without it the stub would type a disabled task's rows anyway,
      // and the warm move's own part could not be told apart from the group's.
      // Like the real gate it reads the task FRESH from the repository and falls
      // back to the object it was handed, so a move that still holds a stale
      // object is gated by the stored row here too.
      const storedTask = mockGetProjectRepos().tasks.getById(task.id) ?? task;
      if (storedTask.automations_disabled) return { outcomes: [], failures: [] };
      for (const row of hoisted.rows.get(`${lane.id}:${trigger}`) ?? []) {
        // Checked first, as the real runner does: a row named here is recorded
        // as sent and never reaches its Condition or Frequency checks.
        if (runOptions.alreadyDelivered?.has(row.id)) continue;
        if (hoisted.runnerSkips.has(row.id)) continue;
        // The real runner hands each row its own signal (the move's, combined
        // with this row's slice of the exit budget) and isolates its failure.
        let rowSignal = runOptions.signal;
        if (trigger === 'exit') {
          hoisted.exitRowController = new AbortController();
          rowSignal = hoisted.exitRowController.signal;
        }
        try {
          const detail = await runOptions.deliverToAgent(row.message, row.mode, rowSignal, `run-${row.id}`);
          if (trigger === 'exit') hoisted.exitDetails.push(detail);
        } catch (error) {
          hoisted.rowErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { outcomes: [], failures: [] };
    }),
  };
}

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => makeEngine()),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  reapTaskLeftovers: vi.fn(async () => ({ tasksLeftRunningInWorktree: new Set<string>() })),
  reportAutomationFailures: vi.fn(),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { prepareInjectionPlan } from '../../src/main/transition-engine/injection-plan';
import { supersedeMessageDeliveries } from '../../src/main/automations/turn-end/turn-end-passes';

const TASK_ID = 'task-paste-0001';
const SESSION_ID = 'active-session-1';
const LANE_A = 'lane-a';
const LANE_B = 'lane-b';
const LANE_C = 'lane-c';
const LANE_TODO = 'lane-todo';
const LANE_DONE = 'lane-done';
/** A column with "Start an agent here" off. */
const LANE_PARKED = 'lane-parked';
const MULTI_LINE = 'The reviewer says:\n- fix the null check\n- add a test';

function makeSwimlane(id: string): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeTask(swimlaneId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: swimlaneId,
    position: 0,
    agent: 'claude',
    session_id: SESSION_ID,
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    automations_disabled: false,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Rows as the automations repository lists them, for `resolveColumnMessage`. */
function listForColumn(laneId: string) {
  return (hoisted.rows.get(`${laneId}:enter`) ?? []).map((row, index) => ({
    id: row.id,
    swimlane_id: laneId,
    name: 'Message',
    type: 'send_message',
    trigger: 'enter',
    position: index,
    enabled: true,
    config: { message: row.message, mode: row.mode },
    condition: row.condition ?? null,
    max_runs: row.max_runs ?? null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }));
}

/**
 * `taskOverrides` shapes the task the move works with. `storedRowOverrides`, when
 * given, shapes the STORED row every later read sees instead, which is how a
 * case tells a fresh read from the object the move already holds: the move's own
 * task is the first `tasks.getById` call (`reconcileTaskSessionRef`, ahead of
 * every other read of the repository), and a read after it is a fresh one. Left
 * out, both are the same, which is every case that does not care. The split is
 * by call order, so a harness that sets it drives a single move.
 */
function makeHarness(
  startLane: string,
  taskOverrides: Partial<Task> = {},
  storedRowOverrides: Partial<Task> = taskOverrides,
) {
  // Stateful: the task stays live in whatever column the last move put it.
  let currentLane = startLane;
  let getByIdCalls = 0;
  const taskRepo = {
    getById: vi.fn(() => {
      getByIdCalls += 1;
      return makeTask(currentLane, getByIdCalls === 1 ? taskOverrides : storedRowOverrides);
    }),
    move: vi.fn((input: { targetSwimlaneId: string }) => { currentLane = input.targetSwimlaneId; }),
    update: vi.fn(),
    list: vi.fn(() => [makeTask(currentLane, taskOverrides)]),
    archive: vi.fn(),
    // Cleared by a move to Done.
    setWorktreeSkipReason: vi.fn(),
  };
  const lanes = new Map([LANE_A, LANE_B, LANE_C].map((id) => [id, makeSwimlane(id)]));
  lanes.set(LANE_TODO, { ...makeSwimlane(LANE_TODO), name: 'To Do', role: 'todo' });
  lanes.set(LANE_DONE, { ...makeSwimlane(LANE_DONE), name: 'Done', role: 'done' });
  lanes.set(LANE_PARKED, { ...makeSwimlane(LANE_PARKED), name: 'Code Review', auto_spawn: false });
  const swimlaneRepo = {
    getById: vi.fn((id: string) => lanes.get(id) ?? null),
    list: vi.fn(() => [...lanes.values()]),
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    automations: { listForColumn: vi.fn(listForColumn), getForTrigger: vi.fn(() => []) },
    automationRuns: { start: vi.fn(), finish: vi.fn(), recordSkipped: vi.fn(), updateDetail: vi.fn() },
    attachments: { deleteByTaskId: vi.fn(), getPathsForTask: vi.fn(() => []) },
  });

  const events = hoisted.events;
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      drainQueue: vi.fn(),
      columnBlocks: vi.fn(() => false),
      isResuming: vi.fn(() => false),
      holdColumnSlot: vi.fn(() => () => undefined),
      removeByTaskId: vi.fn(),
      killByTaskId: vi.fn(),
      listSessions: vi.fn(() => []),
      suspend: vi.fn(async () => { events.push('suspend'); }),
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      awaitInputReady: vi.fn(async () => true),
      isAgentLaunching: vi.fn(() => false),
      awaitAgentLaunched: vi.fn(async () => true),
      findLiveSessionByTaskId: vi.fn(() => null),
      getUsageCache: vi.fn((): Record<string, unknown> => ({})),
      getFirstReportedEffort: vi.fn((): string | null => null),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        git: { defaultBaseBranch: 'main' },
        agent: { permissionMode: 'acceptEdits' },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null), getBoardProfiles: vi.fn(() => []) },
    terminalSubmitScheduler: {
      cancel: vi.fn(() => { events.push('scheduler-cancel'); }),
      scheduleKeystrokes: vi.fn(),
      hasPending: vi.fn(() => false),
    },
    terminalSubmit: {
      // Ends on a later macrotask, so a paste nobody awaits would end after
      // the move's own scheduler cancel rather than before it.
      submitContent: vi.fn(async () => {
        events.push('paste-start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('paste-end');
      }),
    },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  return { context, events };
}

function move(context: unknown, targetSwimlaneId: string): Promise<void> {
  return handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId, targetPosition: 0 }, 'renderer');
}

/** Let the background paste's awaits run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

/**
 * The message the warm move's injection plan was built with. Its last call: the
 * move's first call is `readLiveSessionFate`'s, which asks only whether the
 * session restarts and passes no message.
 */
function injectionAutoCommand(): string | undefined {
  return vi.mocked(prepareInjectionPlan).mock.calls.at(-1)?.[0].autoCommand;
}

/** The enter group the move ran, with the skip list it was handed. */
function enterRun() {
  return hoisted.engineRuns.find((run) => run.trigger === 'enter');
}

/** The texts of every keystroke burst scheduled, one array per burst. */
function scheduledBursts(context: ReturnType<typeof makeHarness>['context']): string[][] {
  return context.terminalSubmitScheduler.scheduleKeystrokes.mock.calls.map(
    (call) => (call[2] as Array<{ text: string }>).map((command) => command.text),
  );
}

beforeEach(async () => {
  // Pastes for one task are chained, so one a test left waiting would hold up
  // the next test's. End every wait and every tracked paste first.
  supersedeMessageDeliveries(TASK_ID);
  for (const wait of hoisted.turnWaits) wait.resolve('aborted');
  await settle();
  vi.clearAllMocks();
  hoisted.turnWaits.length = 0;
  hoisted.rows.clear();
  hoisted.engineRuns.length = 0;
  hoisted.runnerSkips.clear();
  hoisted.exitRowController = null;
  hoisted.rowErrors.length = 0;
  hoisted.exitDetails.length = 0;
  hoisted.holds.length = 0;
  hoisted.events.length = 0;
  hoisted.reports.length = 0;
});

describe('On task exit: a message with line breaks is pasted, awaited inside the exit budget', () => {
  it('pastes an immediate multi-line exit message before the move cancels the scheduler', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: MULTI_LINE, mode: 'immediate' }]);
    const { context, events } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(
      SESSION_ID,
      MULTI_LINE,
      expect.objectContaining({ signal: hoisted.exitRowController?.signal }),
    );
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    // Awaited: the paste finished before Priority 3's scheduler cancel ran.
    // Red: firing the paste without awaiting it puts the cancel first.
    expect(events.indexOf('paste-end')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('paste-end')).toBeLessThan(events.indexOf('scheduler-cancel'));
  });

  it('keeps a one-line exit message on the keystroke scheduler', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: '/compact', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    // The awaited keystroke path resolves on the burst's outcome.
    context.terminalSubmitScheduler.scheduleKeystrokes.mockImplementation((
      _taskId: string,
      _sessionId: string,
      _commands: unknown,
      options: { onOutcome?: (report: Partial<InjectionReport>) => void },
    ) => options.onOutcome?.({ outcome: 'unconfirmed' }));

    await move(context, LANE_B);

    expect(scheduledBursts(context)).toEqual([['/compact']]);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('a deferred multi-line exit message waits for the turn, and the run signal stops it', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: MULTI_LINE, mode: 'deferred' }]);
    const { context } = makeHarness(LANE_A);

    const moving = move(context, LANE_B);
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
    expect(hoisted.turnWaits[0].signal).toBe(hoisted.exitRowController?.signal);

    hoisted.exitRowController?.abort();
    await moving;

    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.rowErrors).toEqual(['The message was not delivered before the exit budget ran out.']);
  });
});

// A task moved into a column with an agent and straight back to To Do.
// Design's exit message failed against an agent the To Do move was about to
// kill, the cleanup sat 13 s on it, and a failure toast with Run again was left
// up. A move that ends the agent now skips the row with a reason instead.
describe('On task exit: a move that ends the agent sends it no message', () => {
  it.each([
    ['To Do, which kills it', LANE_TODO, 'Not sent: moving to To Do ends the agent, so it could not act on the message.'],
    ['Done, which suspends it', LANE_DONE, 'Not sent: moving to Done stops the agent, so it could not act on the message.'],
    [
      'a column that starts no agent, which suspends it',
      LANE_PARKED,
      'Not sent: Code Review starts no agent and stops this one, so it could not act on the message.',
    ],
  ])('a move to %s skips the row with a reason, types and pastes nothing, and waits on nothing', async (_label, target, reason) => {
    hoisted.rows.set(`${LANE_A}:exit`, [
      { id: 'row-exit-line', message: 'Signed off', mode: 'immediate' },
      { id: 'row-exit-paste', message: MULTI_LINE, mode: 'immediate' },
    ]);
    const { context } = makeHarness(LANE_A);

    await move(context, target);

    const exitRun = hoisted.engineRuns.find((run) => run.trigger === 'exit');
    // Red: the exit group ran with no reason and delivered both messages.
    expect(exitRun?.agentEndingReason).toBe(reason);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
  });

  it('a task with no live session moved to To Do passes no ending reason, so the runner records its own not-running skip', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { session_id: null });

    await move(context, LANE_TODO);

    const exitRun = hoisted.engineRuns.find((run) => run.trigger === 'exit');
    expect(exitRun).toBeDefined();
    // Red: with the reason passed regardless, the row would claim the move ended an agent that was never there.
    expect(exitRun?.agentEndingReason).toBeUndefined();
  });

  it('a move to a column that keeps the agent still delivers the message', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: MULTI_LINE, mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(hoisted.engineRuns.find((run) => run.trigger === 'exit')?.agentEndingReason).toBeUndefined();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1);
  });

  it('reports the exit group\'s failures as exit failures, so the notice can leave out Run again', async () => {
    const { reportAutomationFailures } = await import('../../src/main/ipc/helpers/index');
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_TODO);

    expect(reportAutomationFailures).toHaveBeenCalledWith(context, expect.anything(), expect.anything(), 'proj-test', 'exit');
  });
});

// kangentic.com #145: Design (opus, high) to Planning (opus, xhigh). The effort
// change restarted the session, and Design's "Signed off" exit message, typed
// into it first, was cut off a second later. The run still said "Delivered", and
// Planning, with no enter message, resumed with no prompt. A move that resumes
// the same conversation now holds the message for the resume, and one that ends
// it for another conversation skips the row.
describe('On task exit: a move that restarts the agent carries the message to its resume', () => {
  const RESTART_DETAIL = `Held: moving to Lane ${LANE_B} restarts the agent to change its effort, so the message goes in its resume prompt.`;

  it('an effort restart types and pastes nothing, and holds the message after the suspend', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [
      { id: 'row-exit-line', message: 'Signed off', mode: 'immediate' },
      { id: 'row-exit-paste', message: MULTI_LINE, mode: 'immediate' },
    ]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    // Red: the exit row typed "Signed off" and pasted the second message into
    // the session the restart then suspended.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.exitDetails).toEqual([RESTART_DETAIL, RESTART_DETAIL]);
    // Held in row order, and only once the session is suspended: held while it
    // was live, the hold would hand them straight to the session being cut off.
    expect(hoisted.holds.map((hold) => hold.message)).toEqual(['Signed off', MULTI_LINE]);
    for (const hold of hoisted.holds) expect(hold.eventsBefore).toContain('suspend');
  });

  it('a model restart says so in the run', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'model' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(hoisted.exitDetails).toEqual([
      `Held: moving to Lane ${LANE_B} restarts the agent to change its model, so the message goes in its resume prompt.`,
    ]);
    expect(hoisted.holds.map((hold) => hold.message)).toEqual(['Signed off']);
  });

  it('a full destination column holds the message for the queued resume', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    context.sessionManager.columnBlocks.mockReturnValue(true);

    await move(context, LANE_B);

    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(hoisted.exitDetails).toEqual([
      `Held: Lane ${LANE_B} is full, so the agent waits there, and the message goes in its resume prompt.`,
    ]);
    expect(hoisted.holds.map((hold) => hold.message)).toEqual(['Signed off']);
  });

  it('Priority 3 acts on the fate decided before the exit group, not a second read of the column gate', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    // Room when the move reads the fate, full by the time Priority 3 runs.
    context.sessionManager.columnBlocks.mockReturnValueOnce(false).mockReturnValue(true);
    context.terminalSubmitScheduler.scheduleKeystrokes.mockImplementation((
      _taskId: string,
      _sessionId: string,
      _commands: unknown,
      options: { onOutcome?: (report: Partial<InjectionReport>) => void },
    ) => options.onOutcome?.({ outcome: 'unconfirmed' }));

    await move(context, LANE_B);

    // Red: a Priority 3 that asks again sees a full column, suspends the
    // session, and the message typed into it is the one cut off.
    expect(context.sessionManager.columnBlocks).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(scheduledBursts(context)).toEqual([['Signed off']]);
    expect(hoisted.holds).toHaveLength(0);
  });

  it('a yield whose suspend rejects still holds the message, and the run says the restart did not finish', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    context.sessionManager.columnBlocks.mockReturnValue(true);
    context.sessionManager.suspend.mockRejectedValueOnce(new Error('The host did not answer.'));

    await move(context, LANE_B).catch(() => undefined);

    expect(hoisted.holds.map((hold) => hold.message)).toEqual(['Signed off']);
    expect(mockGetProjectRepos().automationRuns.updateDetail).toHaveBeenCalledWith(
      'run-row-exit',
      `Held: the restart for Lane ${LANE_B} did not finish, so the message goes to the agent still running after its turn, or else to the task's next agent.`,
    );
  });

  it('a message longer than a held message may be fails its row, and nothing is held', async () => {
    const tooLong = 'x'.repeat(20_001);
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: tooLong, mode: 'immediate' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(hoisted.rowErrors).toEqual([
      `Not delivered: moving to Lane ${LANE_B} restarts the agent, and a message carried to its resume can be at most 20000 characters. This one is 20001.`,
    ]);
    expect(hoisted.holds).toHaveLength(0);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('a refused hold rewrites the run, so it never says the message waits', async () => {
    const { holdTaskMessage } = await import('../../src/main/held-messages/held-messages');
    vi.mocked(holdTaskMessage).mockReturnValueOnce({ status: 'refused', error: 'The task is gone.' });
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(mockGetProjectRepos().automationRuns.updateDetail).toHaveBeenCalledWith(
      'run-row-exit',
      `Not delivered: moving to Lane ${LANE_B} restarted the agent, and the message could not be held for it: The task is gone.`,
    );
  });

  it('a suspend that throws still holds the message, and the run says the restart did not finish instead of naming a resume', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);
    context.sessionManager.suspend.mockRejectedValueOnce(new Error('The host did not answer.'));

    await move(context, LANE_B).catch(() => undefined);

    expect(hoisted.holds.map((hold) => hold.message)).toEqual(['Signed off']);
    // Red: without `restartFailed` the run keeps "goes in its resume prompt"
    // for a restart that never happened.
    expect(mockGetProjectRepos().automationRuns.updateDetail).toHaveBeenCalledWith(
      'run-row-exit',
      `Held: the restart for Lane ${LANE_B} did not finish, so the message goes to the agent still running after its turn, or else to the task's next agent.`,
    );
  });

  it('a successful restart leaves the run\'s held detail as it is', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(hoisted.holds).toHaveLength(1);
    expect(mockGetProjectRepos().automationRuns.updateDetail).not.toHaveBeenCalled();
  });

  it('a session switch skips the row with a reason, and holds nothing', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    // An isolated destination wants another track than the live main session.
    const isolatedLane = { ...makeSwimlane(LANE_C), session_target: 'isolated' as const };
    const repos = mockGetProjectRepos();
    const lookUp = repos.swimlanes.getById.getMockImplementation();
    repos.swimlanes.getById.mockImplementation((id: string) => (id === LANE_C ? isolatedLane : lookUp?.(id)));

    await move(context, LANE_C);

    // Red: no reason, and the message typed into the main session the switch suspended.
    expect(hoisted.engineRuns.find((run) => run.trigger === 'exit')?.agentEndingReason).toBe(
      `Not sent: moving to Lane ${LANE_C} starts a new session, so this one could not act on the message.`,
    );
    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(hoisted.holds).toHaveLength(0);
  });

  it('a handoff to another agent skips the row with a reason, and holds nothing', async () => {
    const { resolveTargetAgent } = await import('../../src/main/transition-engine/agent-resolver');
    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'codex', isHandoff: true });
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(hoisted.engineRuns.find((run) => run.trigger === 'exit')?.agentEndingReason).toBe(
      `Not sent: moving to Lane ${LANE_B} hands the task to another agent, so this one could not act on the message.`,
    );
    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(hoisted.holds).toHaveLength(0);
  });

  it('a move that keeps the session types the message as before, with the adapter\'s own word', async () => {
    hoisted.rows.set(`${LANE_A}:exit`, [{ id: 'row-exit', message: 'Signed off', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);
    context.terminalSubmitScheduler.scheduleKeystrokes.mockImplementation((
      _taskId: string,
      _sessionId: string,
      _commands: unknown,
      options: { onOutcome?: (report: Partial<InjectionReport>) => void },
    ) => options.onOutcome?.({ outcome: 'unconfirmed' }));

    await move(context, LANE_B);

    expect(scheduledBursts(context)).toEqual([['Signed off']]);
    expect(hoisted.exitDetails).toEqual([undefined]);
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(hoisted.holds).toHaveLength(0);
  });
});

describe('On task enter, warm move: the column message and the rows after it', () => {
  it('pastes a multi-line first message after the turn ends, and the group does not send it again', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: MULTI_LINE, mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    // Red: building the plan with the message puts it in a keystroke burst.
    expect(injectionAutoCommand()).toBe('');
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();

    hoisted.turnWaits[0].resolve('completed');
    await vi.waitFor(() => expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1));
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(SESSION_ID, MULTI_LINE, expect.anything());
    await settle();
    // One delivery only: the enter group skipped the row the injection carried.
    expect(hoisted.turnWaits).toHaveLength(1);
    expect(hoisted.reports.map((report) => report.outcome)).toEqual(['unconfirmed']);
  });

  it('keeps a one-line first message in the keystroke burst', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(scheduledBursts(context)).toEqual([['/code-review']]);
    await settle();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
    // The unguarded control for the describe below: the burst carries the
    // message, and the enter group is told to skip the row it carried.
    expect(injectionAutoCommand()).toBe('/code-review');
    expect(enterRun()?.alreadyDelivered).toEqual(new Set(['row-first']));
  });

  it('a settings change restarts the session, and the message is neither typed nor pasted into the old one', async () => {
    // A model or effort change restarts the session, whose respawn carries the
    // column's message as its starting prompt. Red: pasting here as well would
    // send it into a session that is being stopped, and a second time after.
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: MULTI_LINE, mode: 'deferred' }]);
    vi.mocked(prepareInjectionPlan).mockImplementationOnce(() => ({ sequence: [], verifier: null, restartReason: 'effort' }));
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await settle();

    expect(context.sessionManager.suspend).toHaveBeenCalledWith(SESSION_ID);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
  });

  it('pastes a later multi-line enter row, and keeps a later one-line row as keystrokes', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [
      { id: 'row-first', message: '/standup', mode: 'immediate' },
      { id: 'row-second', message: MULTI_LINE, mode: 'immediate' },
      { id: 'row-third', message: 'Then run the tests.', mode: 'immediate' },
    ]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    // The first row rides the injection burst; the third is the group's own
    // keystroke delivery. The second never reaches the scheduler.
    expect(scheduledBursts(context)).toEqual([['/standup'], ['Then run the tests.']]);
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
    hoisted.turnWaits[0].resolve('completed');
    await vi.waitFor(() => expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(
      SESSION_ID,
      MULTI_LINE,
      expect.anything(),
    ));
  });

  it('a later move out of the column cancels an enter paste still waiting for the turn', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: MULTI_LINE, mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
    const pendingWait = hoisted.turnWaits[0];

    await move(context, LANE_C);
    await settle();

    // Red: dropping `supersedeMessageDeliveries` from the move leaves this
    // wait running, and it pastes Lane B's message in Lane C.
    expect(pendingWait.signal?.aborted).toBe(true);
    pendingWait.resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.reports.map((report) => report.outcome)).toEqual(['cancelled']);
  });

  it('a reorder within the column keeps the enter paste', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: MULTI_LINE, mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));

    await move(context, LANE_B);
    await settle();

    expect(hoisted.turnWaits[0].signal?.aborted).toBe(false);
    hoisted.turnWaits[0].resolve('completed');
    await vi.waitFor(() => expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1));
  });
});

// The warm move used to bundle the column's first message into its injection
// burst and name that row `alreadyDelivered`, which the runner honors BEFORE its
// Condition and Frequency checks. A row guarded by either was therefore sent on
// every warm move, whatever the Condition said and however often it had run.
// Now `resolveColumnMessage` reports `guarded`, and the move leaves a guarded
// row to the runner: nothing is bundled and nothing is pre-delivered.
describe('On task enter, warm move: a first message with a Condition or a Frequency limit is the runner\'s to send', () => {
  const GUARDED_ROW_CASES: Array<{ label: string; guard: Pick<MessageRow, 'condition' | 'max_runs'> }> = [
    { label: 'a Condition', guard: { condition: 'The PR is ready to merge.' } },
    { label: 'a Frequency limit', guard: { max_runs: 1 } },
    { label: 'a Frequency limit of zero', guard: { max_runs: 0 } },
  ];

  it.each(GUARDED_ROW_CASES)('does not bundle a one-line message with $label into the burst, and pre-delivers nothing', async ({ guard }) => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate', ...guard }]);
    // The runner checks the guard and says no: the Condition is not met, or the
    // Frequency limit is spent.
    hoisted.runnerSkips.add('row-first');
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await settle();

    // Red before the fix: the plan was built with '/code-review', the burst typed
    // it into the live session, and the group was told to skip the row.
    expect(injectionAutoCommand()).toBe('');
    expect(enterRun()).toBeDefined();
    expect(enterRun()?.alreadyDelivered).toBeUndefined();
    // The runner skipped the row, so the message reached the agent by no path.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
  });

  it('sends the message once, through the group, when the runner lets a guarded row run', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [
      { id: 'row-first', message: '/code-review', mode: 'immediate', condition: 'The PR is ready to merge.' },
    ]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe('');
    expect(enterRun()?.alreadyDelivered).toBeUndefined();
    // Exactly one delivery, and it is the group's own, not the injection's.
    expect(scheduledBursts(context)).toEqual([['/code-review']]);
  });

  it('pastes a guarded multi-line message once, through the group, after the turn ends', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [
      { id: 'row-first', message: MULTI_LINE, mode: 'immediate', max_runs: 2 },
    ]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);

    expect(enterRun()?.alreadyDelivered).toBeUndefined();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();

    hoisted.turnWaits[0].resolve('completed');
    await vi.waitFor(() => expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1));
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(SESSION_ID, MULTI_LINE, expect.anything());
    await settle();
    // One delivery only: the injection pasted nothing of its own.
    expect(hoisted.turnWaits).toHaveLength(1);
  });

  const UNGUARDED_ROW_CASES: Array<{ label: string; guard: Pick<MessageRow, 'condition' | 'max_runs'> }> = [
    { label: 'no Condition and no Frequency limit', guard: {} },
    { label: 'a blank Condition and a null Frequency limit', guard: { condition: '   ', max_runs: null } },
  ];

  it.each(UNGUARDED_ROW_CASES)('still bundles the message into the burst and pre-delivers it with $label', async ({ guard }) => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate', ...guard }]);
    const { context } = makeHarness(LANE_A);

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe('/code-review');
    expect(enterRun()?.alreadyDelivered).toEqual(new Set(['row-first']));
    // One burst, the injection's; the group skipped the row it carried.
    expect(scheduledBursts(context)).toEqual([['/code-review']]);
  });
});

// A task with its automations disabled is sent no column message on a warm move
// (task-move.ts, Priority 3): the enter group records the row as skipped with
// the reason instead, so the message must not ride the injection burst or the
// paste either. The task's OWN auto_command is the task's input rather than an
// automation, and still goes out. The stub engine mirrors the real gate (see
// makeEngine), so every "not sent" assertion below is about the warm move's own
// part; each case has an enabled control over the same rows.
describe('On task enter, warm move: a task with its automations disabled is sent no column message', () => {
  const OWN_COMMAND = '/own-command';

  it('does not bundle a one-line column message into the burst, and pre-delivers nothing', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { automations_disabled: true });

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe('');
    expect(enterRun()).toBeDefined();
    expect(enterRun()?.alreadyDelivered).toBeUndefined();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('bundles the same message into the burst for an enabled task (the control)', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { automations_disabled: false });

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe('/code-review');
    expect(enterRun()?.alreadyDelivered).toEqual(new Set(['row-first']));
    expect(scheduledBursts(context)).toEqual([['/code-review']]);
  });

  it('does not paste or wait for the turn to paste a multi-line column message', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: MULTI_LINE, mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { automations_disabled: true });

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe('');
    expect(hoisted.turnWaits).toHaveLength(0);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // A no-over-block case, not a gate case: the task's pin outranks the column on
  // the burst, so the plan is the same with the switch on or off. What it pins is
  // that the disabled check does not take the task's own input down with the
  // column's message. The column row's absence comes from the group's gate, which
  // the stub mirrors.
  it('still sends the task\'s own auto_command, and not the column message beside it', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { automations_disabled: true, auto_command: OWN_COMMAND });

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe(OWN_COMMAND);
    // The burst carried the task's pin, not the column's row, so the group was
    // not told to skip it. It is recorded as skipped instead of sent.
    expect(enterRun()?.alreadyDelivered).toBeUndefined();
    expect(scheduledBursts(context)).toEqual([[OWN_COMMAND]]);
  });

  it('sends the task\'s own auto_command and then the column\'s row for an enabled task (the control)', async () => {
    hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
    const { context } = makeHarness(LANE_A, { automations_disabled: false, auto_command: OWN_COMMAND });

    await move(context, LANE_B);
    await settle();

    // The task's pin outranks the column on the burst, so it is the same plan as
    // above; what the switch changes is that the group then delivers the row.
    expect(injectionAutoCommand()).toBe(OWN_COMMAND);
    expect(scheduledBursts(context)).toEqual([[OWN_COMMAND], ['/code-review']]);
  });

  it('still sends the task\'s own auto_command into a column that has no message', async () => {
    const { context } = makeHarness(LANE_A, { automations_disabled: true, auto_command: OWN_COMMAND });

    await move(context, LANE_B);
    await settle();

    expect(injectionAutoCommand()).toBe(OWN_COMMAND);
    expect(scheduledBursts(context)).toEqual([[OWN_COMMAND]]);
  });

  // The warm move decides from a FRESH read of the stored row, not from the task
  // object it was handed: the user can throw the switch between the move's first
  // read and the injection, and the enter group's engine gate reads fresh too,
  // so a stale decision here would type a message the group then records as
  // skipped, or hold one the group sent. In
  // both cases below the move's own task says one thing and the stored row the
  // other.
  describe('the decision reads the stored row, not the task the move holds', () => {
    it('types nothing when the stored row says disabled and the task the move holds says enabled', async () => {
      hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
      const { context } = makeHarness(LANE_A, { automations_disabled: false }, { automations_disabled: true });

      await move(context, LANE_B);
      await settle();

      // Red: gating on the held task bundles '/code-review' into the burst and
      // names the row delivered.
      expect(injectionAutoCommand()).toBe('');
      expect(enterRun()).toBeDefined();
      expect(enterRun()?.alreadyDelivered).toBeUndefined();
      // The group's gate reads the stored row as well, so it types nothing either.
      expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
      expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    });

    it('types the message when the stored row says enabled and the task the move holds says disabled', async () => {
      hoisted.rows.set(`${LANE_B}:enter`, [{ id: 'row-first', message: '/code-review', mode: 'immediate' }]);
      const { context } = makeHarness(LANE_A, { automations_disabled: true }, { automations_disabled: false });

      await move(context, LANE_B);
      await settle();

      // Red: gating on the held task leaves the plan empty, and the group (whose
      // gate reads the stored row) then sends the row itself, so the message is
      // typed by the group and not carried by the burst.
      expect(injectionAutoCommand()).toBe('/code-review');
      expect(enterRun()?.alreadyDelivered).toEqual(new Set(['row-first']));
      expect(scheduledBursts(context)).toEqual([['/code-review']]);
    });
  });
});
