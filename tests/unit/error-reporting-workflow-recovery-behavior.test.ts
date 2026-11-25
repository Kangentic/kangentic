/**
 * What a user loses if these reports go quiet: a workflow runs unattended, often
 * overnight, and every site here used to answer a failure with a log line and a
 * fallback. A recovery that could not arm left a task stalled with no notice, a
 * lock that could not read its workflow let any move through, a paused workflow's
 * agent kept running, a plan that could not be read was planned again from the
 * brief, and nobody was at the desk to read the log.
 *
 * Each case runs the real workflow module on real, migrated SQLite, makes one
 * dependency throw (a repository method, a database open, a session manager
 * call), and reads the call that reached `reportHandledError`: its `source`, its
 * `stage`, and that nothing a user wrote left with it. The thrown errors carry a
 * task title in their message for that last check.
 *
 * The move path, the session handlers and the agent CLI are mocked at the edge,
 * as in `workflow-service.test.ts`. Modules are imported once and the reporter's
 * latch is cleared per test (`reset()`), since the repository classes a test
 * spies on must be the ones the module under test holds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TurnEndedPayload } from '../../src/main/pty/session-manager';
import type { PlanApproval, Swimlane, Task, Workflow } from '../../src/shared/types';
import type { RecoveryEntry } from '../../src/main/workflows/workflow-recovery-state';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

type DatabaseOpener = 'getProjectDb' | 'getExistingProjectDb' | 'getOpenProjectDb' | 'peekProjectDb';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  globalDb: null as unknown,
  /** Per opener and project: the error an open of that project's database throws. */
  failures: new Map<string, () => Error>(),
  adapter: null as unknown,
  handleTaskMove: vi.fn(),
  pauseTaskSession: vi.fn(),
  waitForOwnAgentTurn: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  sendToRenderer: vi.fn(),
  checkConditions: vi.fn(),
  deliverMessage: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => {
  const failIfAsked = (opener: string, projectId: string): void => {
    const makeError = harness.failures.get(`${opener}:${projectId}`);
    if (makeError) throw makeError();
  };
  return {
    getProjectDb: (projectId: string) => {
      failIfAsked('getProjectDb', projectId);
      const database = harness.dbs.get(projectId);
      if (!database) throw new Error(`No database for ${projectId}`);
      return database;
    },
    getExistingProjectDb: (projectId: string) => {
      failIfAsked('getExistingProjectDb', projectId);
      return harness.dbs.get(projectId) ?? null;
    },
    getOpenProjectDb: (projectId: string) => {
      failIfAsked('getOpenProjectDb', projectId);
      return harness.dbs.get(projectId) ?? null;
    },
    peekProjectDb: (projectId: string, read: (database: unknown) => unknown) => {
      failIfAsked('peekProjectDb', projectId);
      const database = harness.dbs.get(projectId);
      return database ? read(database) : null;
    },
    // The dev-port ledger a task delete releases into.
    getGlobalDb: () => harness.globalDb,
  };
});
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: harness.sendToRenderer }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: harness.handleTaskMove }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: harness.pauseTaskSession }));
vi.mock('../../src/main/ipc/handlers/session-resume', () => ({ resumeTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/session-reconcile')>()),
  reconcileTaskSessionRef: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/own-call-turn-wait', () => ({
  OWN_CALL_TURN_WAIT_MS: 30_000,
  markOwnCallSession: () => () => undefined,
  isSessionInOwnCall: () => false,
  waitForOwnAgentTurn: harness.waitForOwnAgentTurn,
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  autoSpawnForTask: vi.fn(),
  conditionCheckDeps: () => ({}),
  resolveInjectionVerifier: () => null,
}));
vi.mock('../../src/main/ipc/helpers/task-git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/task-git')>()),
  notifySpawnBlocked: harness.notifySpawnBlocked,
}));
vi.mock('../../src/main/ipc/helpers/task-delete', () => ({ deleteTaskWithCleanup: vi.fn() }));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/automations/turn-end/turn-end-passes')>()),
  supersedeTurnEndWork: vi.fn(),
}));
vi.mock('../../src/main/automations/condition-check/condition-check', () => ({
  checkAutomationConditions: harness.checkConditions,
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageToSession: harness.deliverMessage,
  deliverMessageAfterMove: vi.fn(),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: () => harness.adapter, has: () => true, list: () => [] },
}));
vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: async () => [{ name: 'claude', found: true, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } }],
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: harness.retrievalCall } }));
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: async (options: { agentPath: string; prompt?: string }) => ({ agentPath: options.agentPath, prompt: options.prompt }),
}));
vi.mock('../../src/main/pty/turn-settled', () => ({ isTurnSettled: () => true }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { runGlobalMigrations } = await import('../../src/main/db/migrations');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { TaskMoveRepository } = await import('../../src/main/db/repositories/task-move-repository');
const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
const { AutomationRunRepository } = await import('../../src/main/db/repositories/automation-run-repository');
const { setHomeLinkRemover } = await import('../../src/main/db/repositories/workflow-home-links');
const { workflowEngineReporter } = await import('../../src/main/workflows/workflow-report');
const service = await import('../../src/main/workflows/workflow-service');
const viewService = await import('../../src/main/workflows/workflow-view-service');
const agent = await import('../../src/main/workflows/workflow-agent');
const agentPrompt = await import('../../src/main/workflows/workflow-agent-prompt');
const promptFacts = await import('../../src/main/workflows/workflow-prompt-facts');
const home = await import('../../src/main/workflows/workflow-home');
const lockCheck = await import('../../src/main/workflows/workflow-lock-check');
const workflowTasks = await import('../../src/main/workflows/workflow-tasks');
const recovery = await import('../../src/main/workflows/workflow-recovery');
const recoveryState = await import('../../src/main/workflows/workflow-recovery-state');
const step = await import('../../src/main/workflows/workflow-step');
const hangCheck = await import('../../src/main/workflows/workflow-hang-check');
const { safeLanes } = await import('../../src/main/workflows/workflow-lanes');
const { isNeverStarted } = await import('../../src/main/workflows/workflow-never-started');
const { detachProjectFromWorkflows } = await import('../../src/main/workflows/workflow-project-delete');
const { pauseWorkflowsOfProject } = await import('../../src/main/workflows/workflow-hidden-project');
const { announceBoardChange } = await import('../../src/main/workflows/workflow-board-announce');
const workflowChanged = await import('../../src/main/workflows/workflow-changed');
const { registerWorkflowEngine, getWorkflowEngine } = await import('../../src/main/workflows/workflow-engine-host');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');
const { setWorkflowRuntimeContext } = await import('../../src/main/workflows/workflow-runtime');
const { workflowMemoryGate } = await import('../../src/main/workflows/workflow-memory-gate');
const { adoptLegacyPlanApproval } = await import('../../src/main/plan-approval/workflow-plan-approval');
const { IPC } = await import('../../src/shared/ipc-channels');

import { openTestDatabase } from './helpers/test-database';
import { reportedText as sharedReportedText } from './helpers/reported-failures';

/** A task title, in every thrown message, so a report that carried the message would carry it. */
const USER_TEXT = 'Fix Acme billing';
const SESSION_ID = 'session-report-1';
const WORK_SERIAL = 3;

/** A code defect: never an expected failure, whatever the chokepoint. */
const defect = (): Error => new TypeError(`Cannot read the title of "${USER_TEXT}"`);
/** A database that will not read: an environment failure, grouped by its code. */
const sqliteBusy = (): Error => Object.assign(new Error(`database is locked while reading ${USER_TEXT}`), { code: 'SQLITE_BUSY' });
/** What better-sqlite3 throws for a statement on a connection a project delete closed. */
const closedConnection = (): Error => new TypeError('The database connection is not open');

const ALL_OPENERS: DatabaseOpener[] = ['getProjectDb', 'getExistingProjectDb', 'getOpenProjectDb', 'peekProjectDb'];

function failDatabase(projectId: string, makeError: () => Error, openers: DatabaseOpener[] = ALL_OPENERS): void {
  for (const opener of openers) harness.failures.set(`${opener}:${projectId}`, makeError);
}

/** Everything the reports carried, as text, so user text cannot hide in any field. */
const reportedText = (): string => sharedReportedText(reportHandledError);

/** The one report that was sent: its tags, checked for the stage, and for user text. */
function expectOneReport(stage: string, extraTags: Record<string, string> = {}): void {
  expect(reportHandledError.mock.calls.map((call) => (call[1] as Record<string, string>).stage)).toEqual([stage]);
  expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'workflow_engine', stage, ...extraTags });
  expect(reportedText()).not.toMatch(/acme/i);
}

/** One macrotask turn, for work a `setImmediate` or a settled promise scheduled. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeSession {
  id: string;
  taskId: string;
  projectId: string;
  status: string;
  cwd: string;
  startedAt: string;
  transient: boolean;
  resuming: boolean;
  workflowId?: string;
  agentSessionId: string | null;
  accountId?: string | null;
}

/** The slice of SessionManager the workflow modules drive. */
class FakeSessionManager extends EventEmitter {
  sessions: FakeSession[] = [];
  activity: Record<string, string> = {};
  activityReason: unknown = null;
  draft = '';
  private spawnCount = 0;

  suspend = vi.fn(async (sessionId: string): Promise<void> => {
    this.setStatus(sessionId, 'suspended');
  });
  kill = vi.fn((sessionId: string): void => {
    this.setStatus(sessionId, 'exited');
  });
  awaitExit = vi.fn(async (): Promise<void> => undefined);
  remove = vi.fn((sessionId: string): void => {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
  });
  getShell = vi.fn(async () => 'bash');
  spawn = vi.fn(async (options: { taskId: string; projectId: string; cwd: string; resuming: boolean; workflowId: string; agentSessionId: string | null }): Promise<FakeSession> => {
    this.spawnCount += 1;
    const session: FakeSession = {
      id: `pty-spawned-${this.spawnCount}`,
      taskId: options.taskId,
      projectId: options.projectId,
      status: 'running',
      cwd: options.cwd,
      startedAt: '2026-10-04T10:00:00.000Z',
      transient: true,
      resuming: options.resuming,
      workflowId: options.workflowId,
      agentSessionId: options.agentSessionId,
    };
    this.sessions.push(session);
    return session;
  });
  getRawScrollback = vi.fn(async (): Promise<string> => 'No conversation found with session ID: conv-gone');
  markIdleAuthoritative = vi.fn();
  setTaskStopped = vi.fn();
  write = vi.fn();
  signalUserInterrupt = vi.fn();

  listSessions = (): FakeSession[] => this.sessions;
  getSession = (sessionId: string): FakeSession | undefined => this.sessions.find((session) => session.id === sessionId);
  getActivityCache = (): Record<string, string> => this.activity;
  getActivityReason = (): unknown => this.activityReason;
  getSessionAgentName = (): string => 'claude';
  getSessionCliTarget = (): null => null;
  getReportedTranscriptPath = (): string | null => null;
  getPendingDraft = (): string => this.draft;
  getLastUserInputAt = (): number | null => null;
  getOpenWork = (): { toolCalls: unknown[]; backgroundShells: unknown[]; backgroundSubagents: unknown[] } => (
    { toolCalls: [], backgroundShells: [], backgroundSubagents: [] }
  );
  getHeldBackgroundShellIds = (): string[] => [];
  automatedKeysBlocker = (): string | null => null;
  isLatestTurn = (): boolean => true;
  currentWorkSerial = (): number | undefined => WORK_SERIAL;
  currentTurnAnchor = (): null => null;
  getUsageCache = (): Record<string, unknown> => ({});
  getToolCallCount = (): number => 0;
  getCompactionCount = (): number => 0;
  getFreeAgentSlots = (): number => 10;
  listColumnClaims = (): unknown[] => [];

  /** The CLI ends on its own, as one that cannot find the conversation does. */
  exitOnItsOwn(sessionId: string): void {
    this.setStatus(sessionId, 'exited');
    this.emit('exit', sessionId, 1, false);
  }

  private setStatus(sessionId: string, status: string): void {
    const session = this.getSession(sessionId);
    if (session) session.status = status;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  default_agent: null;
}

describe('workflow failures that used to be only logged', () => {
  let root: string;
  let projects: ProjectRow[];
  let hiddenProjects: ProjectRow[];
  let manager: FakeSessionManager;
  let context: IpcContext;
  let describeStartupFailure: ReturnType<typeof vi.fn>;
  let buildCommand: ReturnType<typeof vi.fn>;
  let historyFile: string;

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    harness.dbs.set(projectId, projectDatabase);
    return projectDatabase;
  }

  const dbOf = (projectId: string): Database.Database => harness.dbs.get(projectId) as Database.Database;
  const lanesOf = (projectId: string): Swimlane[] => new SwimlaneRepository(dbOf(projectId)).list();
  const todoOf = (projectId: string): Swimlane => lanesOf(projectId).find((lane) => lane.role === 'todo')!;
  const executingOf = (projectId: string): Swimlane => lanesOf(projectId).find((lane) => lane.name === 'Executing')!;
  const tasksOf = (projectId: string) => new TaskRepository(dbOf(projectId));
  const workflowsOf = (projectId: string) => new WorkflowRepository(dbOf(projectId));

  /** A workflow homed on `home`, running. */
  function runningWorkflow(): string {
    const workflows = workflowsOf('home');
    const workflowId = workflows.create({ title: USER_TEXT }).id;
    workflows.markStarted(workflowId);
    return workflowId;
  }

  /** A task of a workflow homed on `home`, on `projectId`'s board. */
  function createTask(projectId: string, workflowId: string, swimlaneId: string): Task {
    return tasksOf(projectId).create({
      title: USER_TEXT,
      description: '',
      swimlane_id: swimlaneId,
      workflow: {
        workflow_id: workflowId,
        workflow_project_id: 'home',
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
        plan_approval: null,
      },
    });
  }

  /** A running workflow's task at work in Executing, with a live agent session. */
  function workingTask(): { workflowId: string; task: Task; column: Swimlane } {
    const workflowId = runningWorkflow();
    const column = executingOf('home');
    const created = createTask('home', workflowId, column.id);
    tasksOf('home').update({ id: created.id, session_id: SESSION_ID });
    manager.sessions.push({
      id: SESSION_ID,
      taskId: created.id,
      projectId: 'home',
      status: 'running',
      cwd: path.join(root, 'home'),
      startedAt: '2026-10-04T10:00:00.000Z',
      transient: false,
      resuming: false,
      agentSessionId: 'agent-session-1',
    });
    manager.activity[SESSION_ID] = 'idle';
    return { workflowId, task: tasksOf('home').getById(created.id)!, column };
  }

  function recoveryTargetOf(working: { workflowId: string; task: Task; column: Swimlane }) {
    return { projectId: 'home', taskId: working.task.id, sessionId: SESSION_ID, columnId: working.column.id, workflowId: working.workflowId };
  }

  /** A recovery entry for a stopped turn, as `ensureEntry` builds one. */
  function recoveryEntry(working: { workflowId: string; task: Task; column: Swimlane }, overrides: Partial<RecoveryEntry> = {}): RecoveryEntry {
    const entry: RecoveryEntry = {
      ...recoveryTargetOf(working),
      attemptIndex: 0,
      countedNudges: 0,
      countedSinceNotice: 0,
      noticeSent: false,
      startedAt: Date.now(),
      workingWait: false,
      holdUntil: null,
      verdict: { workSerial: WORK_SERIAL, verdict: 'stopped', reason: 'It stopped before its marker.', blockers: [] },
      pendingNudge: null,
      lastTurnFromNudge: false,
      restartedAt: null,
      memoryHoldNoted: false,
      siblingsToldThrough: null,
      timer: null,
      inFlight: false,
      ...overrides,
    };
    recoveryState.setRecoveryEntry(entry);
    return entry;
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    reportHandledError.mockReset();
    workflowEngineReporter.reset();
    harness.failures.clear();
    harness.dbs.clear();
    const globalDatabase = openTestDatabase();
    runGlobalMigrations(globalDatabase);
    harness.globalDb = globalDatabase;
    for (const mock of [harness.handleTaskMove, harness.pauseTaskSession, harness.waitForOwnAgentTurn, harness.notifySpawnBlocked,
      harness.sendToRenderer, harness.checkConditions, harness.deliverMessage, harness.retrievalCall]) {
      mock.mockReset();
    }
    harness.pauseTaskSession.mockImplementation(async () => 'not-live');
    harness.retrievalCall.mockImplementation(async () => ({ outcome: 'indexed' }));
    harness.deliverMessage.mockImplementation(async () => undefined);
    recoveryState.resetWorkflowRecoveryForTests();
    workflowMemoryGate.resetForTests();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-reports-'));
    projects = [];
    for (const [id, name] of [['home', 'kangentic'], ['mobile', 'kangentic-mobile']]) {
      const checkout = path.join(root, id);
      fs.mkdirSync(checkout);
      database(id);
      projects.push({ id, name, path: checkout, default_agent: null });
    }
    hiddenProjects = [];
    historyFile = path.join(root, 'agent-session-1.jsonl');
    fs.writeFileSync(historyFile, '{}\n');

    describeStartupFailure = vi.fn(() => true);
    buildCommand = vi.fn(() => 'mock-agent-command');
    harness.adapter = {
      name: 'claude',
      displayName: 'Claude Code',
      sessionType: 'claude_agent',
      kangenticMcp: 'per-session',
      supportsReadOnlyLaunch: true,
      supportsCallerSessionId: true,
      supportsReadableDirectories: true,
      resumePromptDelivery: 'command-line',
      detect: vi.fn(async () => ({ found: true, path: '/mock/bin/claude' })),
      ensureTrust: vi.fn(async () => undefined),
      buildCommand,
      removeHooks: vi.fn(),
      getExitSequence: () => ['\x03'],
      describeStartupFailure,
      hungTurn: { quietLimitMs: 20 * 60_000, interruptKeys: '\x1b' },
      locateSessionHistoryFile: async () => historyFile,
      statSubagentTranscripts: () => null,
    };

    manager = new FakeSessionManager();
    context = {
      projectRepo: {
        list: () => projects,
        listHidden: () => hiddenProjects,
        listIncludingHidden: () => [...projects, ...hiddenProjects],
        getById: (id: string) => projects.find((project) => project.id === id),
        isHidden: (id: string) => hiddenProjects.some((project) => project.id === id),
      },
      sessionManager: manager,
      boardEvents: { emitBoardChanged: vi.fn(), onBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      desktopNotifier: { notifyWorkflowTask: vi.fn() },
      terminalSubmitScheduler: { hasPending: () => false },
      configManager: {
        load: () => ({}),
        getEffectiveConfig: () => ({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: { agent: 'claude', model: 'haiku', effort: null } }),
      },
      boardConfigManager: { getBoardProfiles: () => [], getDefaultBaseBranch: () => null, getDefaultBaseBranchForPath: () => 'main' },
      mcpServerHandle: { urlForProject: (projectId: string) => `http://127.0.0.1:9/mcp/${projectId}`, token: 'test-token' },
    } as unknown as IpcContext;
  });

  afterEach(async () => {
    harness.failures.clear();
    getWorkflowEngine()?.dispose();
    setHomeLinkRemover(null);
    setWorkflowWake(null);
    setWorkflowRuntimeContext(null);
    workflowChanged.setWorkflowChangedWindow(null);
    hangCheck.stopWorkflowHangCheck();
    recoveryState.resetWorkflowRecoveryForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
    (harness.globalDb as Database.Database).close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('reads of the workflow a task is in', () => {
    const member = { workflow_id: 'workflow-1', workflow_project_id: null };

    it('reports membership_read and still counts the task as a member (fails closed)', () => {
      failDatabase('home', defect);

      expect(home.isInWorkflow(member, 'home')).toBe(true);

      expectOneReport('membership_read', { error_name: 'TypeError' });
    });

    it('reports workflow_state_read when a paused check reads as not paused (fails open)', () => {
      failDatabase('home', sqliteBusy);

      expect(home.isTaskWorkflowPaused(member, 'home')).toBe(false);

      expectOneReport('workflow_state_read', { errno: 'SQLITE_BUSY' });
    });

    it('reports step_task_read when the step-task check cannot read the board', () => {
      failDatabase('home', defect);

      expect(home.isRunningWorkflowStepTask('home', 'task-1')).toBe(false);

      expectOneReport('step_task_read');
    });

    it('reports step_applies_read when the turn end cannot tell whether a step check applies', () => {
      failDatabase('home', defect);

      expect(step.workflowStepApplies(member, 'home')).toBe(false);

      expectOneReport('step_applies_read');
    });

    it('reports lanes_read when a board reads as having no columns', () => {
      failDatabase('home', defect);

      expect(safeLanes('home')).toEqual([]);

      expectOneReport('lanes_read');
    });

    it('reports never_started_read and deletes nothing on a guess', () => {
      const todo = todoOf('home');
      const task = createTask('home', runningWorkflow(), todo.id);
      failDatabase('home', defect);

      expect(isNeverStarted('home', task, [todo])).toBe(false);

      expectOneReport('never_started_read');
    });

    it('reports nothing for an ordinary task, which reads no workflow at all', () => {
      failDatabase('home', defect);

      expect(home.isInWorkflow({ workflow_id: null, workflow_project_id: null }, 'home')).toBe(false);
      expect(step.workflowStepApplies({ workflow_id: null, workflow_project_id: null }, 'home')).toBe(false);

      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('the workflow lock', () => {
    function memberTask(): Task {
      return createTask('home', runningWorkflow(), executingOf('home').id);
    }

    it('reports lock_read when the lock cannot read the workflow and lets the move through', () => {
      const task = memberTask();
      failDatabase('home', defect);

      const refusal = lockCheck.checkWorkflowMove(context, {
        projectId: 'home', task, toSwimlaneId: todoOf('home').id, origin: 'renderer', moverIsTaskAgent: false,
      });

      expect(refusal).toBeNull();
      expectOneReport('lock_read');
    });

    it('reports lock_title_read when a refusal cannot name the workflow', () => {
      const task = memberTask();
      failDatabase('home', defect);

      expect(lockCheck.workflowTitleOf(task, 'home')).toBe('its workflow');

      expectOneReport('lock_title_read');
    });

    it('reports hold_refusal_read and still refuses the hold (fails closed)', () => {
      const task = memberTask();
      failDatabase('home', defect);

      expect(lockCheck.taskHoldRefusal(task, 'home')).toContain('its workflow');

      expectOneReport('hold_refusal_read');
    });

    it('reports nothing from the pre-check, which the check inside the task lock repeats', () => {
      const task = memberTask();
      failDatabase('home', defect);

      expect(lockCheck.readTaskForWorkflowPrecheck('home', task.id)).toBeNull();

      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('a read of a workflow\'s tasks across boards', () => {
    it('reports tasks_read for a board that will not read, and marks it unread', () => {
      failDatabase('mobile', sqliteBusy);

      const read = workflowTasks.readWorkflowTasks(context, 'home', 'workflow-1');

      expect([...read.unreadProjectIds]).toEqual(['mobile']);
      expectOneReport('tasks_read', { errno: 'SQLITE_BUSY' });
    });

    it('reports task_hold when a link\'s end cannot be looked up, and keeps holding', () => {
      failDatabase('mobile', sqliteBusy);

      const state = workflowTasks.linkEndState(context, { projectId: 'mobile', taskId: 'task-1' }, 'workflow-1', new Set(), new Set());

      expect(state).toBe('held');
      expectOneReport('task_hold', { errno: 'SQLITE_BUSY' });
    });

    it('rethrows anything that is not a SQLite failure, and reports nothing itself', () => {
      failDatabase('mobile', defect);

      expect(() => workflowTasks.readWorkflowTasks(context, 'home', 'workflow-1')).toThrow(TypeError);
      expect(() => workflowTasks.linkEndState(context, { projectId: 'mobile', taskId: 'task-1' }, 'workflow-1', new Set(), new Set())).toThrow(TypeError);

      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('the legacy plan approval', () => {
    function legacyDraft(): Workflow {
      const created = workflowsOf('home').create({ title: USER_TEXT });
      return { ...created, plan_approval: 'automatic' as PlanApproval };
    }

    it('reports plan_approval_adopt when the copy onto the tasks will not write', () => {
      const workflow = legacyDraft();
      vi.spyOn(WorkflowRepository.prototype, 'writeAdoptedDraft').mockImplementation(() => { throw sqliteBusy(); });

      expect(adoptLegacyPlanApproval(context, 'home', workflow)).toBe(workflow);

      expectOneReport('plan_approval_adopt', { errno: 'SQLITE_BUSY' });
    });

    it('rethrows anything that is not a SQLite failure, and reports nothing itself', () => {
      const workflow = legacyDraft();
      vi.spyOn(WorkflowRepository.prototype, 'writeAdoptedDraft').mockImplementation(() => { throw defect(); });

      expect(() => adoptLegacyPlanApproval(context, 'home', workflow)).toThrow(TypeError);

      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('what the workflow agent and a task\'s agent are told', () => {
    it('reports columns_read when the first message cannot list the board\'s columns', () => {
      failDatabase('home', defect);

      expect(agentPrompt.describeColumnsForPlanning('home')).toBe('');

      expectOneReport('columns_read');
    });

    it('reports columns_history_read when the columns lose their automations and counts', () => {
      vi.spyOn(AutomationRepository.prototype, 'listForColumn').mockImplementation(() => { throw defect(); });

      expect(agentPrompt.describeColumnsForPlanning('home')).toContain('Executing');

      expectOneReport('columns_history_read');
    });

    it('reports brief_source_read when the brief cannot name its source task', () => {
      const workflow = { ...workflowsOf('home').create({ title: USER_TEXT }), brief: `${USER_TEXT}\n\nDetails.`, source_task_id: 'task-1' };
      failDatabase('home', defect);

      expect(agentPrompt.briefXmlOf('home', workflow)).toContain('Details.');

      expectOneReport('brief_source_read');
    });

    // Answering "no plan saved" here gave the agent a new workflow's first message. It
    // planned from the brief again, and its save replaced every task the user had shaped.
    it('reports plan_read, and tells the agent to read the plan itself before it saves anything', async () => {
      const workflow = workflowsOf('home').create({ title: USER_TEXT });
      vi.spyOn(WorkflowRepository.prototype, 'getById').mockImplementation(() => { throw defect(); });

      const message = await agentPrompt.buildWorkflowAgentContinueMessage(context, 'home', workflow, 'template', 'not-resumed');

      expect(message).toContain('Read it first with kangentic_get_workflow');
      expect(message).toContain('save nothing until you have');
      expect(message).not.toContain('<saved_plan>');
      expectOneReport('plan_read');
    });

    it('reports nothing when the workflow is gone, which is a refusal', async () => {
      const workflow = { ...workflowsOf('home').create({ title: USER_TEXT }), id: 'workflow-gone' };

      expect(await agentPrompt.buildWorkflowAgentContinueMessage(context, 'home', workflow, 'template', 'not-resumed')).toBeNull();

      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports prompt_link_read when a link\'s far end cannot be read, and keeps the block', () => {
      const workflowId = runningWorkflow();
      const blocker = createTask('mobile', workflowId, executingOf('mobile').id);
      const blocked = createTask('home', workflowId, todoOf('home').id);
      new TaskLinkRepository(dbOf('home')).insert({
        workflow_id: workflowId,
        blocker_project_id: 'mobile',
        blocker_task_id: blocker.id,
        blocked_project_id: 'home',
        blocked_task_id: blocked.id,
      });
      failDatabase('mobile', defect);

      const facts = promptFacts.readWorkflowPromptFacts(blocked, 'home');

      expect(facts?.waitsFor).toEqual([]);
      expectOneReport('prompt_link_read');
    });

    it('reports prompt_facts when the whole workflow block is left out of a task\'s prompt', () => {
      const blocked = createTask('home', runningWorkflow(), todoOf('home').id);
      failDatabase('home', defect);

      expect(promptFacts.readWorkflowPromptFacts(blocked, 'home')).toBeNull();

      expectOneReport('prompt_facts');
    });
  });

  describe('the workflow service', () => {
    function draftWithPlan(sourceTaskId: string | null = null): Workflow {
      const workflow = service.createWorkflow('home', { brief: USER_TEXT, sourceTaskId });
      return service.savePlan(context, 'home', workflow.id, {
        title: USER_TEXT,
        tasks: [{ key: 'api', title: USER_TEXT, description: 'Add the API.' }],
        links: [],
      });
    }

    it('reports stalls_read when a board\'s run log cannot be read', () => {
      const workflowId = runningWorkflow();
      failDatabase('home', defect);

      const stallOf = service.stallReader({ id: workflowId, state: 'running' } as Workflow);

      expect(stallOf('home', { id: 'task-1' })).toBeNull();
      expectOneReport('stalls_read');
    });

    it('reports take_in_read when a plan read cannot name the task it takes in', () => {
      const taken = tasksOf('home').create({ title: USER_TEXT, description: '', swimlane_id: todoOf('home').id });
      const workflow = workflowsOf('home').create({ title: USER_TEXT });
      workflowsOf('home').saveDraft(workflow.id, {
        tasks: [{
          key: 'task-1', title: USER_TEXT, description: '', project_id: null, existing_task_id: taken.id,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], labels: [], priority: 0,
          canvas_x: null, canvas_y: null, plan_approval: null,
          base_branch: null, use_worktree: null, run_mode: 'column', profile_id: null, agent_override: null,
          model_override: null, effort_override: null, permission_mode: null,
        }],
        links: [],
      });
      vi.spyOn(TaskRepository.prototype, 'getById').mockImplementation(() => { throw defect(); });

      const view = service.readWorkflow(context, 'home', workflow.id);

      expect(view.tasks[0].column).toBe('an unknown column (taken in at Start)');
      expectOneReport('take_in_read');
    });

    it('reports start_done_move when Start cannot move its source task to Done', async () => {
      const source = tasksOf('home').create({ title: USER_TEXT, description: '', swimlane_id: todoOf('home').id });
      const workflow = draftWithPlan(source.id);
      harness.handleTaskMove.mockImplementation(async () => { throw defect(); });

      const started = await service.startWorkflow(context, 'home', workflow.id);

      expect(started.workflow.state).toBe('running');
      expect(started.supersededSource).toBeNull();
      expectOneReport('start_done_move');
    });

    it('reports start_undo when a failed Start cannot take back what it wrote', async () => {
      const workflow = draftWithPlan();
      const startFailure = new Error('the home write failed');
      vi.spyOn(WorkflowRepository.prototype, 'markStarted').mockImplementation(() => { throw startFailure; });
      vi.spyOn(TaskRepository.prototype, 'delete').mockImplementation(() => { throw defect(); });

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toBe(startFailure);

      expectOneReport('start_undo');
    });

    it('reports pause_member when the agent that paused its own workflow cannot be paused', async () => {
      const working = workingTask();
      harness.waitForOwnAgentTurn.mockImplementation(async () => { throw defect(); });

      const paused = await service.pauseWorkflow(context, 'home', working.workflowId, 'a test', { callerSessionId: SESSION_ID });

      expect(paused.callerPausesAfterTurn).toBe(true);
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      expectOneReport('pause_member');
    });

    it('reports delete_end_agent when a deleted workflow\'s agent cannot be ended', async () => {
      const workflow = workflowsOf('home').create({ title: USER_TEXT });
      manager.listSessions = () => { throw defect(); };

      service.deleteWorkflow(context, 'home', workflow.id);

      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      expectOneReport('delete_end_agent');
    });

    it('reports view_read when the Workflows view cannot read when a task left each column', () => {
      const working = workingTask();
      vi.spyOn(TaskMoveRepository.prototype, 'listForTask').mockImplementation(() => { throw defect(); });

      const detail = viewService.readWorkflowDetail(context, 'home', working.workflowId);

      expect(detail.tasks).toHaveLength(1);
      expectOneReport('view_read');
    });
  });

  describe('the step check', () => {
    function turnEnded(taskId: string): TurnEndedPayload {
      return {
        sessionId: SESSION_ID,
        taskId,
        projectId: 'home',
        agentSessionId: 'agent-session-1',
        isolatedSwimlaneId: null,
        turnStartedAt: null,
        workSerial: WORK_SERIAL,
        transcriptAnchor: null,
      };
    }

    function runStep(working: { task: Task; column: Swimlane }) {
      return step.runWorkflowStep(context, {
        payload: turnEnded(working.task.id),
        columnId: working.column.id,
        signal: new AbortController().signal,
        readAgentReply: async () => 'The gate passed on the committed tree.',
      });
    }

    beforeEach(() => {
      harness.checkConditions.mockImplementation(async () => ({
        ok: true,
        answers: new Map([[step.WORKFLOW_STEP_CHECK_ID, { met: true, reason: 'It ends on the marker.' }]]),
        agentName: 'Scripted agent',
        callId: null,
      }));
    });

    it('reports step_move when a done step\'s move throws, and hands recovery a failed move', async () => {
      const working = workingTask();
      harness.handleTaskMove.mockImplementation(async () => { throw defect(); });

      const result = await runStep(working);

      expect(result).toMatchObject({ verdict: 'move-failed' });
      expectOneReport('step_move');
    });

    it('reports nothing when the move was refused because the workflow was paused meanwhile', async () => {
      const working = workingTask();
      harness.handleTaskMove.mockImplementation(async () => {
        workflowsOf('home').setState(working.workflowId, 'paused');
        throw defect();
      });

      expect(await runStep(working)).toBeUndefined();

      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports step_record when the step\'s answer cannot be written to the run log', async () => {
      const working = workingTask();
      // A move a newer one superseded: the task stays, and the step records that.
      harness.handleTaskMove.mockImplementation(async () => undefined);
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowStep').mockImplementation(() => { throw defect(); });

      const result = await runStep(working);

      expect(result).toMatchObject({ verdict: 'done' });
      expectOneReport('step_record');
    });
  });

  describe('recovery', () => {
    it('reports recovery_verdict when a step verdict cannot be taken', () => {
      const working = workingTask();
      failDatabase('home', defect, ['getProjectDb']);

      recovery.afterWorkflowStep(context, recoveryTargetOf(working), { verdict: 'stopped', reason: 'It stopped.', workSerial: WORK_SERIAL });

      expectOneReport('recovery_verdict');
    });

    it('reports recovery_hold_move when a held move cannot be kept', () => {
      const working = workingTask();
      failDatabase('home', defect, ['getProjectDb']);

      recovery.holdRowMoveForBackgroundWork(context, recoveryTargetOf(working), { rowId: 'row-1', targetName: 'Code Review', workSerial: WORK_SERIAL });

      expectOneReport('recovery_hold_move');
    });

    it('reports recovery_drained when a drained turn cannot be taken', () => {
      const working = workingTask();
      recoveryEntry(working, { verdict: { workSerial: WORK_SERIAL, verdict: 'working', reason: null, blockers: [] } });
      manager.getOpenWork = () => { throw defect(); };

      recovery.noteHeldTurnDrained(context, recoveryTargetOf(working));

      expectOneReport('recovery_drained');
    });

    it('reports recovery_record when a new recovery cannot be written to the run log', () => {
      const working = workingTask();
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowRecoveryStart').mockImplementation(() => { throw defect(); });

      recovery.startWorkflowRecoveryOver(context, recoveryTargetOf(working));

      expectOneReport('recovery_record');
    });

    it('reports recovery_resume when a resumed task\'s recovery cannot be picked up', () => {
      const working = workingTask();
      failDatabase('home', defect, ['getProjectDb']);

      recovery.resumeWorkflowRecovery(context, recoveryTargetOf(working));

      expectOneReport('recovery_resume');
    });

    it('reports recovery_arm when an idle session\'s recovery cannot be armed', () => {
      workingTask();
      vi.spyOn(TaskRepository.prototype, 'getById').mockImplementation(() => { throw defect(); });

      recovery.armWorkflowRecoveryOnIdle(context, SESSION_ID);

      expectOneReport('recovery_arm');
    });

    it('reports nothing when the board will not open at an idle edge: the open path reports that', () => {
      workingTask();
      failDatabase('home', sqliteBusy, ['getProjectDb']);

      recovery.armWorkflowRecoveryOnIdle(context, SESSION_ID);

      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports recovery_mark_failed when a nudge whose turn failed cannot be marked', () => {
      const working = workingTask();
      recoveryEntry(working, { pendingNudge: { rowId: 'row-1' }, countedNudges: 1, countedSinceNotice: 1 });
      vi.spyOn(AutomationRunRepository.prototype, 'finish').mockImplementation(() => { throw defect(); });

      recovery.noteRecoveryTurnFailed(context, SESSION_ID);

      expectOneReport('recovery_mark_failed');
    });

    it('reports recovery_attempt when an attempt throws, and still spends its step', async () => {
      const working = workingTask();
      const entry = recoveryEntry(working);
      vi.spyOn(TaskRepository.prototype, 'getById').mockImplementation(() => { throw defect(); });

      await recovery.runRecoveryAttempt(context, working.task.id, new AbortController().signal);

      expect(entry.attemptIndex).toBe(1);
      expectOneReport('recovery_attempt');
    });

    it('reports recovery_record when an attempt cannot be written to the run log', async () => {
      const working = workingTask();
      // The user has text typed and the hold has run out, so the attempt is spent and recorded.
      manager.draft = 'still typing';
      recoveryEntry(working, { holdUntil: Date.now() - 1_000 });
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowRecovery').mockImplementation(() => { throw defect(); });

      await recovery.runRecoveryAttempt(context, working.task.id, new AbortController().signal);

      expect(harness.deliverMessage).not.toHaveBeenCalled();
      expectOneReport('recovery_record');
    });

    it('reports siblings_read when a nudge cannot name the siblings whose PR landed, and still nudges', async () => {
      const working = workingTask();
      recoveryEntry(working);
      vi.spyOn(TaskMoveRepository.prototype, 'visitStartedAt').mockImplementation(() => { throw defect(); });

      await recovery.runRecoveryAttempt(context, working.task.id, new AbortController().signal);

      expect(harness.deliverMessage).toHaveBeenCalledTimes(1);
      expectOneReport('siblings_read');
    });

    it('reports recovery_record when a wait on the user cannot be written', () => {
      const working = workingTask();
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowWaiting').mockImplementation(() => { throw defect(); });

      recovery.afterWorkflowStep(context, recoveryTargetOf(working), { verdict: 'waiting', reason: 'Which layout?', workSerial: WORK_SERIAL });

      expectOneReport('recovery_record');
    });

    function stall(working: { workflowId: string; task: Task; column: Swimlane }) {
      return { projectId: 'home', taskId: working.task.id, workflowId: working.workflowId, columnId: working.column.id, reason: 'it stopped.', countedNudges: 4 };
    }

    it('reports recovery_record when a stall cannot be written, and still tells the user', () => {
      const working = workingTask();
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowStall').mockImplementation(() => { throw defect(); });

      recovery.announceWorkflowStall(context, stall(working));

      expect(context.desktopNotifier.notifyWorkflowTask).toHaveBeenCalledTimes(1);
      expectOneReport('recovery_record');
    });

    it('reports stall_notice when the desktop notice throws', () => {
      const working = workingTask();
      vi.mocked(context.desktopNotifier.notifyWorkflowTask).mockImplementation(() => { throw defect(); });

      recovery.announceWorkflowStall(context, stall(working));

      expectOneReport('stall_notice');
    });

    it('reports stall_notice when the phone notice throws', () => {
      const working = workingTask();
      const withPhone = { ...context, mobileBridgeService: { notifyWorkflowTask: () => { throw defect(); } } } as unknown as IpcContext;

      recovery.announceWorkflowStall(withPhone, stall(working));

      expectOneReport('stall_notice');
    });
  });

  describe('the hang check', () => {
    it('reports hang_check when a session cannot be checked', async () => {
      workingTask();
      manager.getActivityCache = () => { throw defect(); };

      await hangCheck.checkForHungTurns(context);

      expectOneReport('hang_check');
    });

    it('reports hang_record when an interrupted turn cannot be written to the run log', async () => {
      workingTask();
      manager.activity[SESSION_ID] = 'thinking';
      manager.activityReason = { kind: 'turn-active' };
      const quietSince = new Date(Date.now() - 25 * 60_000);
      fs.utimesSync(historyFile, quietSince, quietSince);
      vi.spyOn(AutomationRunRepository.prototype, 'recordWorkflowInterrupt').mockImplementation(() => { throw defect(); });

      await hangCheck.checkForHungTurns(context);

      expect(manager.write).toHaveBeenCalledWith(SESSION_ID, '\x1b');
      expectOneReport('hang_record');
    });
  });

  describe('a project that is deleted or hidden', () => {
    it('reports project_delete_detach when the deleted board\'s own tasks cannot be released', () => {
      vi.spyOn(TaskRepository.prototype, 'listWorkflowMemberships').mockImplementation(() => { throw defect(); });

      detachProjectFromWorkflows(context, 'mobile');

      expectOneReport('project_delete_detach');
    });

    it('reports project_delete_detach when another board cannot be detached from the project', () => {
      vi.spyOn(TaskRepository.prototype, 'releaseMembersOfHome').mockImplementation(() => { throw defect(); });

      detachProjectFromWorkflows(context, 'mobile');

      expectOneReport('project_delete_detach');
    });

    it('reports project_delete_workflows when a workflow left with no task cannot be deleted', () => {
      const workflowId = runningWorkflow();
      createTask('mobile', workflowId, executingOf('mobile').id);
      vi.spyOn(WorkflowRepository.prototype, 'delete').mockImplementation(() => { throw defect(); });

      detachProjectFromWorkflows(context, 'mobile');

      expectOneReport('project_delete_workflows');
    });

    it('reports hidden_project_read when a hidden project\'s workflows cannot be read', async () => {
      vi.spyOn(TaskRepository.prototype, 'listWorkflowMemberships').mockImplementation(() => { throw defect(); });

      await pauseWorkflowsOfProject(context, 'mobile');

      expectOneReport('hidden_project_read');
    });

    it('reports hidden_project_pause when a workflow cannot be paused for a removed host', async () => {
      runningWorkflow();
      vi.spyOn(WorkflowRepository.prototype, 'setState').mockImplementation(() => { throw defect(); });

      await pauseWorkflowsOfProject(context, 'home');

      expectOneReport('hidden_project_pause');
    });
  });

  describe('listeners of a change', () => {
    it('reports board_listener when a board listener throws, and still reloads the board', () => {
      vi.mocked(context.boardEvents.emitBoardChanged).mockImplementation(() => { throw defect(); });

      announceBoardChange(context, 'home');

      expect(harness.sendToRenderer).toHaveBeenCalledWith(context.mainWindow, IPC.TASK_MOVED_BY_AUTOMATION, 'home');
      expectOneReport('board_listener');
    });

    it('reports changed_listener when a listener of workflow changes throws', () => {
      vi.useFakeTimers();
      const stopListening = workflowChanged.onWorkflowChanged(() => { throw defect(); });

      workflowChanged.notifyWorkflowChanged('home', 'workflow-1');
      vi.advanceTimersByTime(100);
      stopListening();

      expectOneReport('changed_listener');
    });
  });

  describe('the engine host', () => {
    const DEBOUNCE_MS = 150;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
    });

    function waitingTask(): string {
      const workflowId = runningWorkflow();
      createTask('home', workflowId, todoOf('home').id);
      return workflowId;
    }

    it('reports unread when a registered board will not read, once however many boards', async () => {
      vi.spyOn(WorkflowRepository.prototype, 'hasActive').mockImplementation(() => { throw sqliteBusy(); });
      registerWorkflowEngine(context);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expectOneReport('unread', { errno: 'SQLITE_BUSY' });
    });

    it('reports hidden_project_read when a hidden board cannot be read', async () => {
      waitingTask();
      hiddenProjects.push({ id: 'hidden', name: 'kangentic-remote', path: path.join(root, 'hidden'), default_agent: null });
      failDatabase('hidden', sqliteBusy);
      harness.handleTaskMove.mockImplementation(async () => undefined);
      registerWorkflowEngine(context);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expectOneReport('hidden_project_read', { errno: 'SQLITE_BUSY' });
    });

    it('reports start_failure_notice when the toast for a failed start throws', async () => {
      waitingTask();
      // An abort is an expected failure, so the start itself reports nothing.
      harness.handleTaskMove.mockImplementation(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
      harness.notifySpawnBlocked.mockImplementation(() => { throw defect(); });
      registerWorkflowEngine(context);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(harness.handleTaskMove).toHaveBeenCalledTimes(1);
      expectOneReport('start_failure_notice');
    });

    it('reports start_failure_notice when the stall notice for a start that keeps failing throws', async () => {
      waitingTask();
      harness.handleTaskMove.mockImplementation(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
      harness.sendToRenderer.mockImplementation((_window: unknown, channel: string) => {
        if (channel === IPC.WORKFLOW_STALLED) throw defect();
      });
      registerWorkflowEngine(context);

      // Past the half hour a start may keep failing before the user is told.
      await vi.advanceTimersByTimeAsync(40 * 60_000);

      expect(harness.handleTaskMove.mock.calls.length).toBeGreaterThan(4);
      expectOneReport('start_failure_notice');
    });

    it('reports open_workflows_read when a deleted task\'s board cannot list its workflows', () => {
      registerWorkflowEngine(context);
      const onBoardChanged = vi.mocked(context.boardEvents.onBoardChanged).mock.calls[0][0];
      vi.spyOn(WorkflowRepository.prototype, 'listOpen').mockImplementation(() => { throw defect(); });

      onBoardChanged({ projectId: 'home', change: 'task-deleted', ids: ['task-1'] });

      expectOneReport('open_workflows_read');
    });
  });

  describe('the workflow\'s own agent', () => {
    /** A workflow whose agent has a recorded conversation, so a start resumes it. */
    function workflowWithConversation(): string {
      const workflows = workflowsOf('home');
      const workflowId = workflows.create({ title: USER_TEXT }).id;
      workflows.setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conv-1', cwd: projects[0].path });
      return workflowId;
    }

    /** A running agent session of the workflow, as a start leaves it. */
    function runningAgent(workflowId: string, agentSessionId: string | null = 'conv-1'): FakeSession {
      const session: FakeSession = {
        id: 'pty-agent-1',
        taskId: workflowId,
        projectId: 'home',
        status: 'running',
        cwd: projects[0].path,
        startedAt: '2026-10-04T10:00:00.000Z',
        transient: true,
        resuming: true,
        workflowId,
        agentSessionId,
      };
      manager.sessions.push(session);
      manager.activity[session.id] = 'idle';
      return session;
    }

    it('reports agent_db_write when the agent\'s spend cannot be written, and still pauses it', async () => {
      const workflowId = workflowWithConversation();
      const session = runningAgent(workflowId);
      failDatabase('home', defect, ['getProjectDb']);

      await agent.pauseWorkflowAgent(context, workflowId);

      expect(manager.suspend).toHaveBeenCalledWith(session.id);
      expectOneReport('agent_db_write');
    });

    it('reports agent_db_read when the conversation a resumed agent\'s spend is filed under cannot be read', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId, null);
      failDatabase('home', defect, ['getExistingProjectDb']);

      await agent.pauseWorkflowAgent(context, workflowId);

      expectOneReport('agent_db_read');
    });

    it('reports nothing for a database a project delete closed', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId, null);
      failDatabase('home', closedConnection, ['getProjectDb', 'getExistingProjectDb']);

      await agent.pauseWorkflowAgent(context, workflowId);

      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports agent_turn_index when the worker cannot record the agent\'s turns', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);
      harness.retrievalCall.mockImplementation(async () => { throw defect(); });

      await agent.pauseWorkflowAgent(context, workflowId);

      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      expectOneReport('agent_turn_index');
    });

    it('reports nothing when the retrieval worker is down, which the next stop makes up for', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);
      harness.retrievalCall.mockImplementation(async () => {
        throw Object.assign(new Error('The retrieval worker exited'), { name: 'RetrievalUnavailableError' });
      });

      await agent.pauseWorkflowAgent(context, workflowId);
      await nextTurn();

      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports agent_turn_index when the request for the agent\'s turns cannot be built', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);
      manager.getSessionAgentName = () => { throw defect(); };

      await agent.pauseWorkflowAgent(context, workflowId);

      expectOneReport('agent_turn_index');
    });

    it('reports agent_conversation_record when the conversation the agent reported cannot be recorded', () => {
      const workflowId = workflowWithConversation();
      const session = runningAgent(workflowId);
      agent.registerWorkflowAgentLifecycle(context);
      vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation').mockImplementation(() => { throw defect(); });

      manager.emit('agent-session-id', session.id, workflowId, 'home', 'conv-2');

      expectOneReport('agent_conversation_record');
    });

    it('reports agent_db_read when a restart for new read access cannot read what the agent lacks', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      failDatabase('home', defect, ['getExistingProjectDb']);
      await nextTurn();

      expect(manager.suspend).not.toHaveBeenCalled();
      expectOneReport('agent_db_read');
    });

    it('reports nothing when a project delete closed the database before that restart ran', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      failDatabase('home', closedConnection, ['getExistingProjectDb']);
      await nextTurn();

      expect(manager.suspend).not.toHaveBeenCalled();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports agent_access_restart when the restart for new read access fails', async () => {
      const workflowId = workflowWithConversation();
      runningAgent(workflowId);
      manager.suspend.mockImplementation(async () => { throw defect(); });

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      await nextTurn();
      await nextTurn();

      expectOneReport('agent_access_restart');
    });

    it('reports agent_forget_session when a conversation the CLI could not find cannot be forgotten', async () => {
      const workflowId = workflowWithConversation();
      agent.registerWorkflowAgentLifecycle(context);
      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      expect(status.session?.resuming).toBe(true);
      vi.spyOn(WorkflowRepository.prototype, 'forgetAgentSessionId').mockImplementation(() => { throw defect(); });

      manager.exitOnItsOwn(status.session!.id);

      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      // Nothing started over: the pane keeps the agent that exited.
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expectOneReport('agent_forget_session');
    });

    it('reports agent_pause_mid_start when a Pause pressed during a start cannot stop the new agent', async () => {
      const workflowId = workflowWithConversation();
      const spawnRunning = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementation(async (options) => {
        // The user presses Pause while the agent spawns: no session exists yet to stop.
        await agent.pauseWorkflowAgent(context, workflowId);
        return spawnRunning(options);
      });
      manager.suspend.mockImplementation(async () => { throw defect(); });

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status.session?.status).toBe('running');
      expectOneReport('agent_pause_mid_start');
    });

    it('reports agent_db_read when a start cannot read whether its workflow is still open', async () => {
      const workflowId = workflowWithConversation();
      // The read fails after the CLI was found and its command built.
      buildCommand.mockImplementation(() => {
        failDatabase('home', defect, ['getProjectDb']);
        return 'mock-agent-command';
      });

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status.unavailable).toBe('This workflow no longer exists.');
      expect(manager.spawn).not.toHaveBeenCalled();
      expectOneReport('agent_db_read');
    });

    it('reports nothing when a project delete closed the database while the start found its CLI', async () => {
      const workflowId = workflowWithConversation();
      buildCommand.mockImplementation(() => {
        failDatabase('home', closedConnection, ['getProjectDb']);
        return 'mock-agent-command';
      });

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status.unavailable).toBe('This workflow no longer exists.');
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });
});
