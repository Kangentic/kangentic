/**
 * What a user loses if these reports go quiet: a task that starts with no opening
 * prompt, or an agent handed a task with no pointer to the conversation the last
 * agent had, a restored or promoted card with no agent, a reset that leaves the
 * worktree and branch on disk, a Done task whose worktree is never taken, a base
 * branch that was never recorded, a bulk delete that lost an item, a setup failure
 * the agent was never told of. Each of these catches keeps the handler answering, so
 * nothing reaches the IPC wrap and nothing reaches Sentry. It would look like a
 * quiet day.
 *
 * Each case imports the real module afresh (`vi.resetModules`, so each reporter's
 * latch starts empty), makes ONE dependency throw a code defect whose message quotes
 * text a user could have written, and reads the call that reached
 * `reportHandledError`: its source, its `area` and `step` tags, and a serialization
 * of everything sent (message, stack, tags, contexts, fingerprint) that must hold no
 * user text. Each case also pins what the user still gets. Where a catch guards an
 * expected outcome, a second case pins that the outcome sends nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Swimlane, Task } from '../../src/shared/types';
import { reportedFailures, reportedText, type ReportedFailure } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

/** Text a user could have written, which must never leave with a report. */
const USER_TEXT = 'Fix Acme billing export';

function defect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
}

function abortError(): DOMException {
  return new DOMException(`The task moved on from ${USER_TEXT}`, 'AbortError');
}

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the test's teardown can unmock it. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

function stepReports(): ReportedFailure[] {
  return reportedFailures(reportHandledError).filter((call) => call.tags.source === 'handler_step');
}

/** Everything one report sent, as text, so a leak of the user's words anywhere in it shows. */
function serialized(call: ReportedFailure): string {
  return reportedText({ mock: { calls: [[call.sent, call.tags, call.contexts, call.fingerprint]] } });
}

/** One `handler_step` report went out, under this area and step, carrying no user text. */
function expectOnlyStepReport(area: string, step: string, errorName = 'TypeError'): void {
  const calls = stepReports();
  expect(calls).toHaveLength(1);
  expect(calls[0].tags).toMatchObject({ source: 'handler_step', area, step, error_name: errorName });
  expect(calls[0].sent.message).toBe(`Handled handler_step failure: ${errorName}`);
  expect(serialized(calls[0])).not.toMatch(/acme/i);
}

const temporaryFolders: string[] = [];

function makeTemporaryFolder(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryFolders.push(folder);
  return folder;
}

/** Let every pending microtask chain and zero-delay timer run, before a "reported nothing" check. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const folder of temporaryFolders.splice(0)) {
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// spawnAgent
// ---------------------------------------------------------------------------

const TASK_ID = 'task-aaa00001';
const LANE_ID = 'lane-review';
const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-new';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: USER_TEXT,
    description: '',
    labels: [],
    worktree_path: '/mock/project/.kangentic/worktrees/export',
    branch_name: 'export',
    base_branch: null,
    swimlane_id: LANE_ID,
    profile_id: null,
    agent: 'codex',
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

/** The previous agent's record: it exists, so a handoff has context to package and a resume has a record. */
const PREVIOUS_RECORD = {
  id: 'record-previous',
  task_id: TASK_ID,
  session_type: 'claude_agent',
  isolated_swimlane_id: null,
  status: 'suspended',
  suspended_by: null,
  agent_session_id: 'agent-session-previous',
  cwd: '/mock/project',
  started_at: '2026-10-31T00:00:00.000Z',
  suspended_at: '2026-10-31T02:00:00.000Z',
  exited_at: null,
};

interface SpawnLoad {
  isHandoff?: boolean;
  /** What the agent registry answers for each agent name. */
  registryGet?: (agentName: string) => unknown;
  handoffInsert?: () => { id: string };
  handoffUpdateToSession?: () => void;
  /** The repositories `getProjectRepos` hands back. */
  repos?: () => Record<string, unknown>;
  awaitQueuedSessionStart?: () => Promise<boolean>;
}

async function loadSpawnAgent(load: SpawnLoad = {}) {
  installMocks({
    '../../src/main/transition-engine/agent-resolver': () => ({
      resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: load.isHandoff === true })),
    }),
    '../../src/main/agent/agent-registry': () => ({
      agentRegistry: { get: vi.fn(load.registryGet ?? (() => ({ sessionType: 'claude_agent' }))) },
    }),
    '../../src/main/held-messages/held-messages': async () => ({
      ...(await vi.importActual<typeof import('../../src/main/held-messages/held-messages')>('../../src/main/held-messages/held-messages')),
      claimHeldMessages: vi.fn(() => null),
    }),
    '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
    '../../src/main/db/repositories/handoff-repository': () => ({
      HandoffRepository: class {
        insert = vi.fn(load.handoffInsert ?? (() => ({ id: 'handoff-1' })));
        updateToSession = vi.fn(load.handoffUpdateToSession ?? (() => undefined));
      },
    }),
    '../../src/main/dev-ports/dev-port-allocator': () => ({ getDevPortForTask: vi.fn(() => null) }),
    '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class { getById = vi.fn(() => undefined); } }),
    '../../src/main/db/repositories/session-repository': () => ({
      SessionRepository: class {
        getLatestForTask() { return PREVIOUS_RECORD; }
        getLatestForTaskByTypeAndIsolation() { return undefined; }
      },
    }),
    '../../src/main/ipc/helpers/project-repos': () => ({
      getProjectRepos: vi.fn(load.repos ?? (() => ({
        tasks: { getById: vi.fn(), update: vi.fn() },
        swimlanes: { getById: vi.fn(() => undefined) },
        automations: { listForColumn: vi.fn(() => []) },
        automationRuns: {},
        attachments: {},
      }))),
    }),
    '../../src/main/ipc/helpers/task-git': () => ({
      ensureTaskWorktree: vi.fn(),
      ensureTaskBranchCheckout: vi.fn(),
      notifySpawnBlocked: vi.fn(),
      notifyConversationExpired: vi.fn(),
    }),
    '../../src/main/diagnostics/project-log-context': () => ({
      runWithProjectLogContext: vi.fn((_name: string, work: () => unknown) => work()),
    }),
    ...(load.awaitQueuedSessionStart ? {
      '../../src/main/automations/turn-end/agent-message-delivery': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/automations/turn-end/agent-message-delivery')>('../../src/main/automations/turn-end/agent-message-delivery')),
        awaitQueuedSessionStart: load.awaitQueuedSessionStart,
      }),
    } : {}),
  });
  const { spawnAgent } = await import('../../src/main/ipc/helpers/agent-spawn');
  return spawnAgent;
}

interface SpawnDeps {
  resume?: () => Promise<unknown>;
  /** The record the task's latest session read answers. */
  latestRecord?: unknown;
  /** A spawn's lookup of the destination's own record, which makes the resume eligible. */
  destinationRecord?: unknown;
  listIsolatedSince?: () => unknown[];
  /** The column's Send message row, which the runner hands to `startAgent`. */
  columnMessage?: string;
  typedOpening?: string | null;
  queued?: boolean;
}

function makeSpawnDeps(deps: SpawnDeps = {}) {
  let sessionStarted = false;
  const tasks = {
    getById: vi.fn(() => makeTask({ session_id: sessionStarted ? SESSION_ID : null })),
    update: vi.fn(),
    recordAutoCommandOutcome: vi.fn(),
  };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => deps.latestRecord ?? PREVIOUS_RECORD),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => deps.destinationRecord),
    listIsolatedSince: vi.fn(deps.listIsolatedSince ?? (() => [])),
  };
  const engine = {
    executeTransition: vi.fn(async (
      _task: Task,
      _lane: Swimlane,
      _trigger: string,
      runOptions: { startAgent: (pending?: { message: string; mode: 'immediate' }) => Promise<void> },
    ) => {
      if (!deps.columnMessage) return { outcomes: [], failures: [], startedAgent: false };
      await runOptions.startAgent({ message: deps.columnMessage, mode: 'immediate' });
      return { outcomes: [], failures: [], startedAgent: true };
    }),
    resumeSuspendedSession: vi.fn(async () => {
      if (deps.resume) await deps.resume();
      sessionStarted = true;
      return { startOver: null, recapOnly: false, unsentPrompt: null, typedOpening: deps.typedOpening ?? null };
    }),
    runLegacySpawnAgent: vi.fn(async () => {
      sessionStarted = true;
      return { startOver: null, recapOnly: false, unsentPrompt: null, typedOpening: deps.typedOpening ?? null };
    }),
  };
  const context = {
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, name: 'Project', path: '/mock/project', default_agent: 'claude', default_model: null, default_effort: null })) },
    boardConfigManager: { getBoardProfiles: vi.fn(() => []), getDefaultBaseBranch: vi.fn(() => null) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => undefined) },
    sessionManager: {
      on: vi.fn(),
      off: vi.fn(),
      findLiveSessionByTaskId: vi.fn(() => undefined),
      awaitAgentReady: vi.fn(async () => true),
      awaitInputReady: vi.fn(async () => true),
      isAgentLaunching: vi.fn(() => false),
      awaitAgentLaunched: vi.fn(async () => true),
      getSession: vi.fn(() => ({ id: SESSION_ID, status: deps.queued ? 'queued' : 'running' })),
      agentStartPending: vi.fn(() => false),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'default' }, git: { defaultBaseBranch: 'main' }, mcpServer: { enabled: true } })),
    },
  };
  return { tasks, sessionRepo, engine, context };
}

type SpawnAgentFunction = Awaited<ReturnType<typeof loadSpawnAgent>>;

async function runSpawn(
  spawnAgent: SpawnAgentFunction,
  deps: ReturnType<typeof makeSpawnDeps>,
  extra: { taskOverrides?: Partial<Task>; laneOverrides?: Partial<Swimlane> } = {},
): Promise<void> {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask(extra.taskOverrides),
    fromSwimlaneId: 'lane-previous',
    toLane: makeLane(extra.laneOverrides),
    skipPromptTemplate: true,
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
  });
}

/** The prompt the engine's resume was handed (its 4th argument) and the history pointer (its 7th). */
function resumeArguments(deps: ReturnType<typeof makeSpawnDeps>): { prompt: unknown; historyPointer: unknown } {
  const call = deps.engine.resumeSuspendedSession.mock.calls[0] as unknown[] | undefined;
  if (!call) throw new Error('resumeSuspendedSession was never called');
  return { prompt: call[3], historyPointer: call[6] };
}

describe('spawnAgent: the reads and steps around the agent start', () => {
  it('reports a recap read that throws and starts the conversation with the column\'s message alone', async () => {
    const spawnAgent = await loadSpawnAgent();
    const deps = makeSpawnDeps({
      columnMessage: 'Run the gate and open the PR.',
      destinationRecord: PREVIOUS_RECORD,
      listIsolatedSince: () => { throw defect(); },
    });

    await runSpawn(spawnAgent, deps, { taskOverrides: { agent: 'claude' } });

    // The main conversation comes back without a recap, and with its message.
    expect(resumeArguments(deps).prompt).toBe('Run the gate and open the PR.');
    expectOnlyStepReport('spawn', 'return_recap_read');
  });

  it('reports a source column read that throws and still runs the column\'s automations with no source name', async () => {
    const spawnAgent = await loadSpawnAgent({
      repos: () => ({
        swimlanes: { getById: vi.fn(() => { throw defect(); }) },
        automations: { listForColumn: vi.fn(() => []) },
        tasks: { getById: vi.fn(), update: vi.fn() },
      }),
    });
    const deps = makeSpawnDeps();

    await runSpawn(spawnAgent, deps, { taskOverrides: { agent: 'claude' } });

    expect(deps.engine.executeTransition).toHaveBeenCalledTimes(1);
    const runOptions = deps.engine.executeTransition.mock.calls[0][3] as unknown as { fromColumn: unknown };
    expect(runOptions.fromColumn).toBeNull();
    expectOnlyStepReport('spawn', 'from_column_read');
  });

  describe('the opening prompt a queued session waits for', () => {
    it('reports a wait that throws, and leaves the agent started', async () => {
      const spawnAgent = await loadSpawnAgent({ awaitQueuedSessionStart: () => Promise.reject(defect()) });
      const deps = makeSpawnDeps({ typedOpening: 'Do the thing', queued: true });

      await expect(runSpawn(spawnAgent, deps, { taskOverrides: { agent: 'claude' } })).resolves.toBeUndefined();

      await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
      expectOnlyStepReport('spawn', 'opening_prompt');
      expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    });

    it('reports nothing when the wait ends because the task moved on', async () => {
      const spawnAgent = await loadSpawnAgent({ awaitQueuedSessionStart: () => Promise.reject(abortError()) });
      const deps = makeSpawnDeps({ typedOpening: 'Do the thing', queued: true });

      await runSpawn(spawnAgent, deps, { taskOverrides: { agent: 'claude' } });

      // The catch logs after it decides, so a log line says the report decision was made.
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      await settle();
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });
});

describe('spawnAgent: a handoff between agents', () => {
  const handoffLane = { handoff_context: true, agent_override: 'claude' } satisfies Partial<Swimlane>;

  /** A registry whose source agent (codex) reads its history through `locate`. */
  function registryWithSource(locate: () => Promise<string | null>) {
    return (agentName: string) => (agentName === 'codex'
      ? { sessionType: 'codex_agent', locateSessionHistoryFile: locate }
      : { sessionType: 'claude_agent' });
  }

  it('reports a handoff row that cannot be written, and still hands the task over with its history pointer', async () => {
    const spawnAgent = await loadSpawnAgent({
      isHandoff: true,
      registryGet: registryWithSource(async () => '/mock/history.jsonl'),
      handoffInsert: () => { throw defect(); },
    });
    const deps = makeSpawnDeps();

    await runSpawn(spawnAgent, deps, { laneOverrides: handoffLane });

    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(resumeArguments(deps).historyPointer).toEqual(expect.any(String));
    // The inner catch swallows it, so the outer prepare step does not report it again.
    expectOnlyStepReport('handoff', 'handoff_record');
  });

  it('reports a history lookup that throws, and hands the task over with no pointer', async () => {
    const spawnAgent = await loadSpawnAgent({
      isHandoff: true,
      registryGet: registryWithSource(() => Promise.reject(defect())),
    });
    const deps = makeSpawnDeps();

    await runSpawn(spawnAgent, deps, { laneOverrides: handoffLane });

    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(resumeArguments(deps).historyPointer).toBeUndefined();
    expectOnlyStepReport('handoff', 'handoff_prepare');
  });

  it('rethrows an abort during preparation and reports nothing', async () => {
    const spawnAgent = await loadSpawnAgent({
      isHandoff: true,
      registryGet: registryWithSource(() => Promise.reject(abortError())),
    });
    const deps = makeSpawnDeps();

    await expect(runSpawn(spawnAgent, deps, { laneOverrides: handoffLane })).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a resume that throws, and ends the handoff without an agent', async () => {
    const spawnAgent = await loadSpawnAgent({ isHandoff: true, registryGet: registryWithSource(async () => '/mock/history.jsonl') });
    const deps = makeSpawnDeps({ resume: () => Promise.reject(defect()) });

    await expect(runSpawn(spawnAgent, deps, { laneOverrides: handoffLane })).resolves.toBeUndefined();

    expect(deps.tasks.getById(TASK_ID)?.session_id).toBeNull();
    expectOnlyStepReport('handoff', 'handoff_start');
  });

  it('rethrows an abort of the resume and reports nothing', async () => {
    const spawnAgent = await loadSpawnAgent({ isHandoff: true, registryGet: registryWithSource(async () => '/mock/history.jsonl') });
    const deps = makeSpawnDeps({ resume: () => Promise.reject(abortError()) });

    await expect(runSpawn(spawnAgent, deps, { laneOverrides: handoffLane })).rejects.toMatchObject({ name: 'AbortError' });

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports an audit row that cannot be linked to the new session, and keeps the new agent', async () => {
    const spawnAgent = await loadSpawnAgent({
      isHandoff: true,
      registryGet: registryWithSource(async () => '/mock/history.jsonl'),
      handoffUpdateToSession: () => { throw defect(); },
    });
    const deps = makeSpawnDeps();

    await expect(runSpawn(spawnAgent, deps, { laneOverrides: handoffLane })).resolves.toBeUndefined();

    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(deps.tasks.getById(TASK_ID)?.session_id).toBe(SESSION_ID);
    expectOnlyStepReport('handoff', 'handoff_finalize');
  });
});

// ---------------------------------------------------------------------------
// Handlers that register on ipcMain
// ---------------------------------------------------------------------------

type CapturedHandler = (...handlerArguments: unknown[]) => unknown;

/** An `electron` mock whose `ipcMain.handle` keeps each handler by channel. */
function capturingIpcMain(): { handlers: Map<string, CapturedHandler>; electronMock: () => unknown } {
  const handlers = new Map<string, CapturedHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: CapturedHandler) => { handlers.set(channel, handler); }),
    on: vi.fn(),
  };
  return {
    handlers,
    electronMock: () => ({
      ipcMain,
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
      app: { getPath: vi.fn(), getVersion: vi.fn(() => '0.0.0'), isPackaged: false, getLocale: vi.fn(() => 'en') },
    }),
  };
}

function handlerOf(handlers: Map<string, CapturedHandler>, channel: string): CapturedHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler;
}

const { IPC } = await import('../../src/shared/ipc-channels');
const { DEFAULT_CONFIG } = await import('../../src/shared/types');

// ---------------------------------------------------------------------------
// Task git helpers
// ---------------------------------------------------------------------------

describe('task git helpers', () => {
  const WORKTREE = '/project/.kangentic/worktrees/1';

  async function loadTaskGit(holdTaskMessage: () => unknown) {
    const runWorktreeInitScript = vi.fn();
    installMocks({
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: vi.fn().mockImplementation(function MockWorktreeManager(this: Record<string, unknown>) {
          this.withLock = async (job: () => unknown) => job();
          this.ensureWorktree = vi.fn(async () => ({ worktreePath: WORKTREE, branchName: 'fix-billing', worktreeFolder: '1', baseBranch: 'main', forkPointSha: 'abc' }));
          this.setUpWorktree = vi.fn(async () => undefined);
          this.prepareWorktreeFiles = vi.fn(async () => undefined);
          this.runWorktreeInitScript = runWorktreeInitScript;
        }),
        prepareStaleWorktreeForCreation: vi.fn(async () => false),
      }),
      '../../src/main/held-messages/held-messages': () => ({ holdTaskMessage: vi.fn(holdTaskMessage) }),
      '../../src/main/git/git-client': () => ({ gitAt: vi.fn(() => ({ raw: vi.fn(async () => '') })) }),
      '../../src/main/git/fetch-throttle': () => ({ fetchIfStale: vi.fn(async (_git: unknown, _path: string, branch: string) => branch) }),
    });
    const taskGit = await import('../../src/main/ipc/helpers/task-git');
    return { ...taskGit, runWorktreeInitScript };
  }

  it('reports a live-agent check whose path comparison throws, and finds no occupant', async () => {
    const { findLiveSessionInDirectory } = await loadTaskGit(() => ({ status: 'held' }));
    // A session row whose folder is not text: `path.resolve` throws a TypeError.
    const sessions = [{ id: 'session-1', taskId: TASK_ID, status: 'running', cwd: 42 }];
    const context = { sessionManager: { listSessions: () => sessions } };

    expect(findLiveSessionInDirectory(context as never, '/mock/project')).toBeUndefined();

    expectOnlyStepReport('task_git', 'same_directory_check');
  });

  function setupScriptContext() {
    const send = vi.fn();
    const context = {
      currentProjectPath: null,
      configManager: { getEffectiveConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, git: { ...DEFAULT_CONFIG.git, initScript: 'pnpm install' } })) },
      boardConfigManager: { getDefaultBaseBranchForPath: vi.fn(() => undefined) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      projectRepo: { list: vi.fn(() => []) },
      sessionManager: { listSessions: vi.fn(() => []) },
    };
    const task = { id: 'task-955', title: USER_TEXT, description: '', swimlane_id: 'lane-1', position: 0, worktree_path: null, branch_name: null, base_branch: null, use_worktree: null, agent: null, session_id: null, display_id: 1, labels: null };
    const repo = {
      update: vi.fn(),
      getById: vi.fn(() => task),
      recordWorktree: vi.fn(),
      setWorktreeSkipReason: vi.fn(),
      recoverLegacyWorktreeFolder: vi.fn(() => null),
    };
    return { context, send, task, repo };
  }

  it('reports a held message that cannot be written after the setup script failed, and still warns on the task', async () => {
    const { ensureTaskWorktree, runWorktreeInitScript } = await loadTaskGit(() => { throw defect(); });
    runWorktreeInitScript.mockRejectedValue(new Error('init script exited with code 1'));
    const { context, send, task, repo } = setupScriptContext();

    await ensureTaskWorktree(context as never, task as never, repo as never, '/project', { projectId: 'project-1', initScript: { mode: 'background' } });

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expectOnlyStepReport('task_git', 'setup_failure_notice');
    // The user still got the warning on the task, and the worktree stays recorded.
    expect(send).toHaveBeenCalledWith(IPC.TASK_SPAWN_WARNING, 'task-955', expect.stringContaining('init script'), 'project-1', 'setup-script-failed');
    expect(repo.recordWorktree).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the agent\'s message is refused rather than thrown', async () => {
    const holdTaskMessage = vi.fn(() => ({ status: 'refused', error: 'the task has no agent' }));
    const { ensureTaskWorktree, runWorktreeInitScript } = await loadTaskGit(holdTaskMessage);
    runWorktreeInitScript.mockRejectedValue(new Error('init script exited with code 1'));
    const { context, task, repo } = setupScriptContext();

    await ensureTaskWorktree(context as never, task as never, repo as never, '/project', { projectId: 'project-1', initScript: { mode: 'background' } });

    await vi.waitFor(() => expect(holdTaskMessage).toHaveBeenCalledTimes(1));
    await settle();
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task branch handler
// ---------------------------------------------------------------------------

describe('task branch', () => {
  const PROJECT_PATH = '/project';

  interface GitDoubles {
    projectGit: { status: ReturnType<typeof vi.fn>; diff: ReturnType<typeof vi.fn>; raw: ReturnType<typeof vi.fn> };
    worktreeGit: { status: ReturnType<typeof vi.fn>; diff: ReturnType<typeof vi.fn>; raw: ReturnType<typeof vi.fn> };
  }

  function makeGitDoubles(): GitDoubles {
    return {
      projectGit: { status: vi.fn(async () => ({ files: [], not_added: [] })), diff: vi.fn(async () => ''), raw: vi.fn(async () => '') },
      worktreeGit: { status: vi.fn(), diff: vi.fn(), raw: vi.fn(async () => '') },
    };
  }

  async function loadTaskBranch(git: GitDoubles, worktreeDirectory: string) {
    const { handlers, electronMock } = capturingIpcMain();
    const currentTask = { id: TASK_ID, title: USER_TEXT, session_id: null, worktree_path: null as string | null, base_branch: null, branch_name: null };
    const tasks = { getById: vi.fn(() => currentTask), update: vi.fn() };
    installMocks({
      electron: electronMock,
      '../../src/main/git/git-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/git-client')>('../../src/main/git/git-client')),
        gitAt: vi.fn((cwd: string) => (cwd === worktreeDirectory ? git.worktreeGit : git.projectGit)),
      }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class {
          getLatestForTask(): null { return null; }
          updateCwd(): void { /* no suspended record here */ }
        },
      }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: vi.fn(() => ({ tasks })),
        ensureTaskWorktree: vi.fn(async () => { currentTask.worktree_path = worktreeDirectory; }),
      }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        resolveProjectContext: vi.fn((_context: unknown, projectId?: string | null) => ({ projectId: projectId ?? 'project-1', projectPath: PROJECT_PATH })),
      }),
      '../../src/main/ipc/helpers/task-git': () => ({ resolveEffectiveBaseBranch: vi.fn(), findLiveSessionInDirectory: vi.fn() }),
    });
    const taskBranch = await import('../../src/main/ipc/handlers/task-branch');
    const context = { currentProjectId: 'project-1', currentProjectPath: PROJECT_PATH, sessionManager: { listSessions: () => [] }, boardEvents: { emitBoardChanged: vi.fn() } };
    taskBranch.registerTaskBranchHandlers(context as never);
    return { ...taskBranch, currentTask, tasks, switchBranch: handlerOf(handlers, IPC.TASK_SWITCH_BRANCH) };
  }

  it('reports a changes read that throws, and carries nothing without throwing', async () => {
    const git = makeGitDoubles();
    git.projectGit.status.mockRejectedValue(defect());
    const worktreeDirectory = makeTemporaryFolder('kangentic-fix-acme-billing-');
    const { carryUncommittedChanges } = await loadTaskBranch(git, worktreeDirectory);

    const result = await carryUncommittedChanges(PROJECT_PATH, worktreeDirectory, 'abcd1234');

    // The uncommitted changes stay in the main checkout.
    expect(result).toEqual({ carriedTracked: false, carriedUntracked: [], failedUntracked: [], applyFailed: false });
    expect(git.worktreeGit.raw).not.toHaveBeenCalled();
    expectOnlyStepReport('task_branch', 'carry_changes');
  });

  it('does not report a patch git refused to apply, which the caller already says', async () => {
    const git = makeGitDoubles();
    git.projectGit.status.mockResolvedValue({ files: [{ path: 'a.txt' }], not_added: [] });
    git.projectGit.diff.mockResolvedValue('diff --git a/a.txt b/a.txt');
    git.worktreeGit.raw.mockRejectedValue(new Error('error: patch failed'));
    const worktreeDirectory = makeTemporaryFolder('kangentic-fix-acme-billing-');
    const { carryUncommittedChanges } = await loadTaskBranch(git, worktreeDirectory);

    const result = await carryUncommittedChanges(PROJECT_PATH, worktreeDirectory, 'abcd1234');

    expect(result.applyFailed).toBe(true);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a base branch write that fails when the task already has a worktree, and still records the base on the row', async () => {
    const git = makeGitDoubles();
    git.worktreeGit.raw.mockRejectedValue(defect());
    const worktreeDirectory = makeTemporaryFolder('kangentic-fix-acme-billing-');
    const { switchBranch, currentTask, tasks } = await loadTaskBranch(git, worktreeDirectory);
    currentTask.worktree_path = worktreeDirectory;

    await expect(switchBranch(null, { taskId: TASK_ID, newBaseBranch: 'develop' }, 'project-1')).resolves.toMatchObject({ id: TASK_ID });

    expect(tasks.update).toHaveBeenCalledWith({ id: TASK_ID, base_branch: 'develop' });
    expectOnlyStepReport('task_branch', 'base_branch_write');
  });

  it('reports a base branch write that fails while a worktree is being enabled, and keeps the new worktree', async () => {
    const git = makeGitDoubles();
    git.worktreeGit.raw.mockRejectedValue(defect());
    const worktreeDirectory = makeTemporaryFolder('kangentic-fix-acme-billing-');
    const { switchBranch, tasks } = await loadTaskBranch(git, worktreeDirectory);

    const result = await switchBranch(null, { taskId: TASK_ID, enableWorktree: true, newBaseBranch: 'develop' }, 'project-1');

    expect(result).toMatchObject({ worktree_path: worktreeDirectory });
    expect(tasks.update).toHaveBeenCalledWith({ id: TASK_ID, base_branch: 'develop', use_worktree: 1 });
    expectOnlyStepReport('task_branch', 'base_branch_write');
  });
});

// ---------------------------------------------------------------------------
// Task cleanup
// ---------------------------------------------------------------------------

describe('task cleanup', () => {
  const PROJECT_PATH = '/mock/project';
  const TASK = {
    id: 'task-1',
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/task-1-abcd',
    branch_name: 'feature-1',
  };

  interface CleanupLoad {
    discardAnnotationDraft?: () => Promise<void>;
    removeWorktree?: () => Promise<boolean>;
    moveWorktreeAside?: () => Promise<boolean>;
    withLock?: (operation: () => Promise<unknown>) => Promise<unknown>;
  }

  async function loadTaskCleanup(load: CleanupLoad = {}) {
    const removeWorktree = vi.fn(load.removeWorktree ?? (async () => true));
    const moveWorktreeAside = vi.fn(load.moveWorktreeAside ?? (async () => true));
    const scheduleRemovedWorktreeDeletion = vi.fn();
    installMocks({
      '../../src/main/browser/annotation-drafts': () => ({ discardAnnotationDraft: vi.fn(load.discardAnnotationDraft ?? (async () => undefined)) }),
      '../../src/main/git/worktree-manager': () => ({
        GitQueuePriority: { USER: 0, BACKGROUND: 10 },
        prepareWorktreeForRemoval: async () => undefined,
        WorktreeManager: class {
          removeWorktree = removeWorktree;
          moveWorktreeAside = moveWorktreeAside;
          pruneWorktrees = vi.fn();
          removeBranch = vi.fn();
          withLock = load.withLock ?? (async (operation: () => Promise<unknown>) => operation());
        },
      }),
      '../../src/main/git/worktree-head': () => ({ readWorktreeHead: async () => ({ branch: null, sha: null }) }),
      '../../src/main/ipc/handlers/git-stats-capture': () => ({ waitForChurnRead: async () => undefined }),
      '../../src/main/git/worktree-creation-registry': () => ({ waitForWorktreeCreation: async () => false }),
      '../../src/main/git/removed-worktrees': () => ({ scheduleRemovedWorktreeDeletion }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(), getOpenProjectDb: vi.fn(() => null) }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class {} }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/stop-script/terminal-stop': () => ({ stopBeforeReap: vi.fn(async () => undefined) }),
      '../../src/main/transition-engine/resume-id-reconcile': () => ({ backgroundSessionHoldingConversation: vi.fn(async () => null) }),
    });
    const taskCleanup = await import('../../src/main/ipc/helpers/task-cleanup');
    return { ...taskCleanup, removeWorktree, moveWorktreeAside, scheduleRemovedWorktreeDeletion };
  }

  function makeCleanupContext() {
    return {
      currentProjectPath: PROJECT_PATH,
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      projectRepo: { list: () => [] },
      // The reap finds nothing left running: it is not the step under test.
      sessionManager: { removeByTaskId: vi.fn(), reapTaskProcesses: vi.fn(async () => []), listProcesses: vi.fn() },
      configManager: { load: () => ({}), getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
    };
  }

  function makeCleanupTasks() {
    return { update: vi.fn(), getById: vi.fn(() => ({ id: 'task-1' })), setWorktreeSkipReason: vi.fn() };
  }

  it('reports an annotation draft that cannot be removed, and still removes the worktree', async () => {
    const { cleanupTaskResources, removeWorktree } = await loadTaskCleanup({ discardAnnotationDraft: () => Promise.reject(defect()) });
    const tasks = makeCleanupTasks();

    await expect(cleanupTaskResources(makeCleanupContext() as never, TASK, tasks as never, undefined, PROJECT_PATH)).resolves.toBeUndefined();

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith(expect.objectContaining({ worktree_path: null }));
    expectOnlyStepReport('task_cleanup', 'annotation_draft_remove');
  });

  it('reports a worktree removal that throws, and keeps the task\'s worktree fields for the startup retry', async () => {
    const { cleanupTaskResources } = await loadTaskCleanup({ withLock: () => Promise.reject(defect()) });
    const tasks = makeCleanupTasks();

    await expect(cleanupTaskResources(makeCleanupContext() as never, { ...TASK, title: USER_TEXT }, tasks as never, undefined, PROJECT_PATH)).resolves.toBeUndefined();

    expect(tasks.update).not.toHaveBeenCalled();
    expectOnlyStepReport('task_cleanup', 'worktree_cleanup');
  });

  it('reports nothing for a removal that finds the directory held, which the worktree manager reports itself', async () => {
    const { cleanupTaskResources, removeWorktree } = await loadTaskCleanup({ removeWorktree: async () => false });
    const tasks = makeCleanupTasks();

    await cleanupTaskResources(makeCleanupContext() as never, TASK, tasks as never, undefined, PROJECT_PATH);

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(tasks.update).not.toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a Done move aside that throws, and keeps the worktree path for the retry', async () => {
    const { deleteTaskWorktree, scheduleRemovedWorktreeDeletion } = await loadTaskCleanup({ moveWorktreeAside: () => Promise.reject(defect()) });
    const tasks = makeCleanupTasks();

    await expect(deleteTaskWorktree(makeCleanupContext() as never, TASK, tasks as never, PROJECT_PATH)).resolves.toBe(false);

    expect(tasks.update).not.toHaveBeenCalled();
    expect(scheduleRemovedWorktreeDeletion).not.toHaveBeenCalled();
    expectOnlyStepReport('task_cleanup', 'done_worktree_delete');
  });

  it('reports nothing when the move aside is refused and the in-place removal reports its own failure', async () => {
    const { deleteTaskWorktree, removeWorktree } = await loadTaskCleanup({ moveWorktreeAside: async () => false, removeWorktree: async () => false });
    const tasks = makeCleanupTasks();

    await expect(deleteTaskWorktree(makeCleanupContext() as never, TASK, tasks as never, PROJECT_PATH)).resolves.toBe(false);

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  describe('the WSL distros a reap also scans', () => {
    async function readDistros(listProjects: () => unknown[]): Promise<string[] | undefined> {
      const { leftoverSweepOptions } = await loadTaskCleanup();
      const options = leftoverSweepOptions({ projectRepo: { list: listProjects }, configManager: { load: () => ({}) } } as never, PROJECT_PATH);
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      // The read is Windows-only: CI's Linux runner would return before the catch otherwise.
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        return options.wslDistrosOf?.(['task-1']);
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    }

    it('reports a project read that throws, and answers that no distro is known', async () => {
      await expect(readDistros(() => { throw defect(); })).resolves.toEqual([]);
      expectOnlyStepReport('task_cleanup', 'wsl_distros_read');
    });

    it('reports nothing when the project database is not open', async () => {
      await expect(readDistros(() => [{ id: 'project-1', path: PROJECT_PATH }])).resolves.toEqual([]);
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// The leftover-process toast
// ---------------------------------------------------------------------------

describe('the leftover-process report', () => {
  const TITLES = new Map([[TASK_ID, USER_TEXT]]);
  const entry = {
    taskId: TASK_ID, pid: 2001, startKey: 'start-2001', label: 'node (app)', outcome: 'stopped' as const, reason: null, place: 'worktree' as const,
  };

  it('reports a send that throws, and still tells the analytics listener', async () => {
    vi.useFakeTimers();
    const { LeftoverProcessReports, REPORT_QUIET_MS } = await import('../../src/main/ipc/helpers/leftover-process-reports');
    const reports = new LeftoverProcessReports();
    const listener = vi.fn();
    reports.setReportListener(listener);

    reports.add(() => { throw defect(); }, [entry], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS + 1);

    // The user is never told what the task left running, and the timer callback did not throw.
    expectOnlyStepReport('task_cleanup', 'leftover_report_send');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the send works', async () => {
    vi.useFakeTimers();
    const { LeftoverProcessReports, REPORT_QUIET_MS } = await import('../../src/main/ipc/helpers/leftover-process-reports');
    const reports = new LeftoverProcessReports();
    const send = vi.fn();

    reports.add(send, [entry], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS + 1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Restoring from the archive
// ---------------------------------------------------------------------------

describe('task archive', () => {
  interface ArchiveLoad {
    cleanupTaskSession?: () => Promise<void>;
    spawnAgent?: () => Promise<void>;
    targetLane: { id: string; role: string | null; auto_spawn: boolean };
  }

  async function registerArchive(load: ArchiveLoad) {
    const { handlers, electronMock } = capturingIpcMain();
    const taskMap = new Map<string, Record<string, unknown>>([
      [TASK_ID, { id: TASK_ID, title: USER_TEXT, swimlane_id: 'lane-done', worktree_path: null, session_id: null, branch_name: null, base_branch: null }],
    ]);
    const tasks = {
      list: vi.fn(() => []),
      getById: vi.fn((id: string) => taskMap.get(id) ?? null),
      unarchive: vi.fn((id: string) => taskMap.get(id)),
      reorderWithinSwimlane: vi.fn(),
    };
    const lanes = [
      { id: 'lane-done', role: 'done', auto_spawn: false, auto_command: null, permission_mode: null },
      { auto_command: null, permission_mode: null, ...load.targetLane },
    ];
    const swimlanes = { list: vi.fn(() => lanes), getById: vi.fn((id: string) => lanes.find((lane) => lane.id === id) ?? null) };
    const spawnAgent = vi.fn(load.spawnAgent ?? (async () => undefined));
    const cleanupTaskSession = vi.fn(load.cleanupTaskSession ?? (async () => undefined));
    installMocks({
      electron: electronMock,
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class {} }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class {} }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class {} }),
      '../../src/main/db/repositories/attachment-repository': () => ({ AttachmentRepository: class {} }),
      '../../src/main/git/worktree-manager': () => ({ WorktreeManager: class {} }),
      '../../src/main/git/git-checks': () => ({ isAutoGeneratedBranch: vi.fn(() => false) }),
      '../../src/main/git/fetch-throttle': () => ({ fetchIfStale: vi.fn(async () => 'main') }),
      '../../src/main/git/node-modules-link': () => ({ linkNodeModules: vi.fn(), removeNodeModulesPath: vi.fn() }),
      '../../src/main/config/config-manager': () => ({ ConfigManager: class {} }),
      '../../src/main/agent/shared': () => ({ interpolateTemplate: vi.fn((template: string) => template), resolveBridgeScript: vi.fn(), execVersion: vi.fn() }),
      '../../src/main/ipc/handlers/task-move': () => ({ handleTaskMove: vi.fn() }),
      '../../src/main/held-messages/held-messages': () => ({ clearHeldMessages: vi.fn() }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: vi.fn(() => ({ tasks, swimlanes, automations: {}, automationRuns: {}, attachments: {} })),
        ensureTaskWorktree: vi.fn(async () => null),
        ensureTaskBranchCheckout: vi.fn(async () => undefined),
        notifySpawnBlocked: vi.fn(),
        createTransitionEngine: vi.fn(() => ({})),
        cleanupTaskSession,
        spawnAgent,
      }),
    });
    const { registerTaskArchiveHandlers } = await import('../../src/main/ipc/handlers/task-archive');
    const context = {
      currentProjectId: 'project-1',
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: { listSessions: vi.fn(() => []) },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
      boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null), getBoardProfiles: vi.fn(() => []) },
      projectRepo: { getById: vi.fn(() => ({ id: 'project-1', default_agent: 'claude', default_model: null, default_effort: null })) },
      boardEvents: { emitBoardChanged: vi.fn() },
    };
    registerTaskArchiveHandlers(context as never);
    return {
      unarchive: handlerOf(handlers, IPC.TASK_UNARCHIVE),
      bulkUnarchive: handlerOf(handlers, IPC.TASK_BULK_UNARCHIVE),
      spawnAgent,
      cleanupTaskSession,
    };
  }

  const ACTIVE_LANE = { id: 'lane-doing', role: null, auto_spawn: true };
  const TODO_LANE = { id: 'lane-todo', role: 'todo', auto_spawn: false };

  it('reports a session reset that throws, and still returns the restored task', async () => {
    const { unarchive } = await registerArchive({ targetLane: TODO_LANE, cleanupTaskSession: () => Promise.reject(defect()) });

    await expect(unarchive(null, { id: TASK_ID, targetSwimlaneId: TODO_LANE.id })).resolves.toMatchObject({ id: TASK_ID });

    expectOnlyStepReport('archive', 'session_reset');
  });

  it('reports an agent start that throws on a restore, and returns the restored task', async () => {
    const { unarchive, spawnAgent } = await registerArchive({ targetLane: ACTIVE_LANE, spawnAgent: () => Promise.reject(defect()) });

    await expect(unarchive(null, { id: TASK_ID, targetSwimlaneId: ACTIVE_LANE.id })).resolves.toMatchObject({ id: TASK_ID });

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('archive', 'unarchive_spawn');
  });

  it('reports nothing more for a start failure the spawn already reported', async () => {
    const { markReported } = await import('../../src/main/analytics/handled-report');
    const alreadyReported = defect();
    markReported(alreadyReported);
    const { unarchive } = await registerArchive({ targetLane: ACTIVE_LANE, spawnAgent: () => Promise.reject(alreadyReported) });

    await expect(unarchive(null, { id: TASK_ID, targetSwimlaneId: ACTIVE_LANE.id })).resolves.toMatchObject({ id: TASK_ID });

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports an agent start that throws in a bulk restore, and the batch finishes', async () => {
    const { bulkUnarchive, spawnAgent } = await registerArchive({ targetLane: ACTIVE_LANE, spawnAgent: () => Promise.reject(defect()) });

    await expect(bulkUnarchive(null, [TASK_ID], ACTIVE_LANE.id, 'project-1')).resolves.toBeUndefined();

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('archive', 'unarchive_spawn');
  });
});

// ---------------------------------------------------------------------------
// Bulk delete
// ---------------------------------------------------------------------------

describe('task bulk delete', () => {
  it('reports an item whose row cannot be deleted, lists it in the answer, and goes on with the others', async () => {
    const { handlers, electronMock } = capturingIpcMain();
    const taskMap = new Map<string, Record<string, unknown>>([
      ['task-a', { id: 'task-a', title: USER_TEXT, worktree_path: null, session_id: null, branch_name: null }],
      ['task-b', { id: 'task-b', title: 'Other', worktree_path: null, session_id: null, branch_name: null }],
    ]);
    const tasks = {
      getById: vi.fn((id: string) => taskMap.get(id) ?? null),
      delete: vi.fn((id: string) => {
        if (id === 'task-a') throw defect();
        taskMap.delete(id);
      }),
    };
    installMocks({
      electron: electronMock,
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn() }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class {} }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class {} }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class {} }),
      '../../src/main/db/repositories/attachment-repository': () => ({ AttachmentRepository: class {} }),
      '../../src/main/git/worktree-manager': () => ({ WorktreeManager: class {} }),
      '../../src/main/git/git-checks': () => ({ isAutoGeneratedBranch: vi.fn(() => false) }),
      '../../src/main/git/fetch-throttle': () => ({ fetchIfStale: vi.fn(async () => 'main') }),
      '../../src/main/git/node-modules-link': () => ({ linkNodeModules: vi.fn(), removeNodeModulesPath: vi.fn() }),
      '../../src/main/config/config-manager': () => ({ ConfigManager: class {} }),
      '../../src/main/agent/shared': () => ({ interpolateTemplate: vi.fn((template: string) => template), resolveBridgeScript: vi.fn(), execVersion: vi.fn() }),
      '../../src/main/ipc/handlers/task-branch': () => ({ carryUncommittedChanges: vi.fn() }),
      '../../src/main/ipc/handlers/task-move': () => ({ handleTaskMove: vi.fn() }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: vi.fn(() => ({ tasks, attachments: { deleteByTaskId: vi.fn() }, swimlanes: { list: vi.fn(() => []), getById: vi.fn() } })),
        cleanupTaskResources: vi.fn(async () => undefined),
        ensureTaskWorktree: vi.fn(),
        ensureTaskBranchCheckout: vi.fn(),
        notifySpawnBlocked: vi.fn(),
        createTransitionEngine: vi.fn(() => ({})),
        interpolateTemplate: vi.fn((template: string) => template),
      }),
    });
    const { registerTaskCrudHandlers } = await import('../../src/main/ipc/handlers/task-crud');
    const context = {
      currentProjectId: 'project-1',
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: { listSessions: vi.fn(() => []), getActivityCache: vi.fn(() => ({})) },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
      boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
      terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
      projectRepo: { getById: vi.fn((projectId: string) => ({ id: projectId, path: '/mock/project' })) },
      boardEvents: { emitBoardChanged: vi.fn() },
    };
    registerTaskCrudHandlers(context as never);

    const result = await handlerOf(handlers, IPC.TASK_BULK_DELETE)(null, ['task-a', 'task-b']) as { deleted: number; failures: Array<{ id: string }> };

    expect(result.deleted).toBe(1);
    expect(result.failures.map((failure) => failure.id)).toEqual(['task-a']);
    expect(taskMap.has('task-b')).toBe(false);
    expectOnlyStepReport('task_crud', 'bulk_delete_item');
  });
});

// ---------------------------------------------------------------------------
// Run again
// ---------------------------------------------------------------------------

describe('running one automation again', () => {
  async function runAgain(executeSingleAutomation: () => Promise<unknown>) {
    installMocks({
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/ipc/handlers/system': () => ({ showDesktopNotification: vi.fn() }),
      '../../src/main/transition-engine/spawn-progress': () => ({ createProgressCallback: vi.fn(() => vi.fn()), clearSpawnProgress: vi.fn() }),
      '../../src/main/ipc/helpers/auto-command-outcome': () => ({ reportAutoCommandOutcome: vi.fn() }),
      '../../src/main/ipc/helpers/agent-spawn': () => ({
        resolveInjectionVerifier: vi.fn(() => null),
        createTransitionEngine: vi.fn(() => ({ executeSingleAutomation: vi.fn(executeSingleAutomation) })),
      }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        getProjectRepos: vi.fn(() => ({
          automations: { listAll: vi.fn(() => [{ id: 'row-script', swimlane_id: 'lane-design', type: 'run_script', trigger: 'exit', config: {} }]) },
          swimlanes: { getById: vi.fn(() => ({ id: 'lane-design', name: 'Design' })) },
          tasks: { getById: vi.fn(() => ({ id: TASK_ID, title: USER_TEXT, agent: 'claude', swimlane_id: 'lane-planning', session_id: null })) },
          automationRuns: {},
          attachments: {},
        })),
      }),
    });
    const { runAutomationAgain } = await import('../../src/main/ipc/helpers/automation-run-again');
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, path: '/mock/project' })) },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: {},
      terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
      terminalSubmit: { submitContent: vi.fn(async () => undefined) },
    };
    return runAutomationAgain(context as never, PROJECT_ID, TASK_ID, 'row-script');
  }

  it('reports a run that could not start, and answers the user that it failed', async () => {
    const result = await runAgain(() => Promise.reject(defect()));

    expect(result.ok).toBe(false);
    expectOnlyStepReport('task_crud', 'automation_run_again');
  });

  it('reports nothing for a run that outlasted its budget', async () => {
    const result = await runAgain(() => Promise.reject(abortError()));

    expect(result.ok).toBe(false);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

describe('backlog', () => {
  interface BacklogLoad {
    targetLaneAutoSpawn?: boolean;
    spawnAgent?: () => Promise<void>;
    adapter?: { fetch: () => Promise<unknown>; listExternalIds?: () => Promise<string[]> };
  }

  async function registerBacklog(load: BacklogLoad = {}) {
    const { handlers, electronMock } = capturingIpcMain();
    const task = { id: TASK_ID, display_id: 7, title: USER_TEXT, description: '', swimlane_id: 'lane-todo', session_id: null, priority: 0, labels: [] };
    const repos = {
      backlog: { getById: vi.fn(() => ({ id: 'backlog-1', title: USER_TEXT, description: '', labels: [], priority: 0 })), delete: vi.fn(), findByExternalIds: vi.fn(() => new Set<string>()) },
      tasks: { create: vi.fn(() => task), getById: vi.fn(() => task), update: vi.fn(), delete: vi.fn() },
      attachments: { add: vi.fn(), list: vi.fn(() => []), deleteByTaskId: vi.fn() },
      backlogAttachments: { list: vi.fn(() => []), deleteByTaskId: vi.fn() },
      cache: {
        count: vi.fn(() => 5),
        getWatermark: vi.fn(() => undefined),
        getOldestFetchedAt: vi.fn(() => undefined),
        upsertMany: vi.fn(() => ({ added: 0, updated: 0 })),
        pruneMissing: vi.fn(() => 0),
        getForSource: vi.fn(() => []),
      },
    };
    const spawnAgent = vi.fn(load.spawnAgent ?? (async () => undefined));
    const removeByTaskId = vi.fn();
    const projectContext = { projectId: 'project-1', projectPath: '/mock/project' };
    installMocks({
      electron: electronMock,
      'node:fs': () => ({ default: { existsSync: vi.fn(() => false), readFileSync: vi.fn(() => Buffer.from('')), mkdirSync: vi.fn(), copyFileSync: vi.fn() } }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})), getExistingProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/backlog-repository': () => ({
        BacklogRepository: class {
          getById = repos.backlog.getById;
          delete = repos.backlog.delete;
          findByExternalIds = repos.backlog.findByExternalIds;
        },
      }),
      '../../src/main/db/repositories/remote-item-cache-repository': () => ({
        RemoteItemCacheRepository: class {
          count = repos.cache.count;
          getWatermark = repos.cache.getWatermark;
          getOldestFetchedAt = repos.cache.getOldestFetchedAt;
          upsertMany = repos.cache.upsertMany;
          pruneMissing = repos.cache.pruneMissing;
          getForSource = repos.cache.getForSource;
        },
      }),
      '../../src/main/db/repositories/task-repository': () => ({
        TaskRepository: class {
          create = repos.tasks.create;
          getById = repos.tasks.getById;
          update = repos.tasks.update;
          delete = repos.tasks.delete;
        },
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({
        SwimlaneRepository: class { getById = () => ({ id: 'lane-todo', auto_spawn: load.targetLaneAutoSpawn ?? false, role: 'todo' }); },
      }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class { getTransitionsFor = () => []; } }),
      '../../src/main/db/repositories/attachment-repository': () => ({
        AttachmentRepository: class {
          add = repos.attachments.add;
          list = repos.attachments.list;
          deleteByTaskId = repos.attachments.deleteByTaskId;
        },
      }),
      '../../src/main/db/repositories/backlog-attachment-repository': () => ({
        BacklogAttachmentRepository: class {
          list = repos.backlogAttachments.list;
          deleteByTaskId = repos.backlogAttachments.deleteByTaskId;
        },
      }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class { getLatestForTask = () => null; } }),
      '../../src/main/ipc/handlers/task-move': () => ({}),
      '../../src/main/boards': () => ({
        boardRegistry: { get: vi.fn(() => null), requireStable: vi.fn(() => load.adapter) },
        ImportSourceStore: class { list = vi.fn(() => []); add = vi.fn(); remove = vi.fn(); updateLabel = vi.fn(); },
      }),
      '../../src/main/boards/adapters/asana': () => ({ registerAsanaIpcHandlers: vi.fn() }),
      '../../src/main/workflows/workflow-home': () => ({ isInWorkflow: vi.fn(() => false) }),
      '../../src/main/workflows/workflow-lock-check': () => ({ workflowTitleOf: vi.fn() }),
      '../../src/main/automations/turn-end/turn-end-passes': () => ({ supersedeMessageDeliveries: vi.fn() }),
      '../../src/main/ipc/helpers/project-repos': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/project-repos')>('../../src/main/ipc/helpers/project-repos')),
        resolveProjectContext: () => projectContext,
        getProjectRepos: () => ({ tasks: repos.tasks, attachments: repos.attachments }),
      }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: () => ({ tasks: repos.tasks, attachments: repos.attachments }),
        resolveProjectContext: () => projectContext,
        ensureTaskWorktree: vi.fn(async () => undefined),
        ensureTaskBranchCheckout: vi.fn(async () => undefined),
        notifySpawnBlocked: vi.fn(),
        spawnAgent,
        autoSpawnForTask: vi.fn(async () => undefined),
        reportAutomationFailures: vi.fn(),
        createTransitionEngine: vi.fn(() => ({})),
        cleanupTaskResources: vi.fn(async () => undefined),
        openAttachmentFile: vi.fn(),
      }),
    });
    const { registerBacklogHandlers } = await import('../../src/main/ipc/handlers/backlog');
    registerBacklogHandlers({
      currentProjectId: 'project-1',
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: { listSessions: vi.fn(() => []), removeByTaskId },
      terminalSubmitScheduler: { cancel: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      boardConfigManager: { getDefaultBaseBranch: () => null },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      projectRepo: { getById: () => ({ path: '/mock/project' }) },
    } as never);
    return { handlers, repos, spawnAgent, removeByTaskId };
  }

  const promoteInput = { backlogTaskIds: ['backlog-1'], targetSwimlaneId: 'lane-todo' };

  it('reports an agent start that throws after a promote, and the promote still answers with the created task', async () => {
    const { handlers, spawnAgent } = await registerBacklog({ targetLaneAutoSpawn: true, spawnAgent: () => Promise.reject(defect()) });

    await expect(handlerOf(handlers, IPC.BACKLOG_PROMOTE)(null, promoteInput)).resolves.toHaveLength(1);

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('backlog', 'promote_spawn');
  });

  it('reports nothing for a promote the user moved on from, and ends its session', async () => {
    const { handlers, removeByTaskId, repos } = await registerBacklog({ targetLaneAutoSpawn: true, spawnAgent: () => Promise.reject(abortError()) });

    await handlerOf(handlers, IPC.BACKLOG_PROMOTE)(null, promoteInput);

    // The abort branch ends the task's session, which says the background work ran.
    await vi.waitFor(() => expect(removeByTaskId).toHaveBeenCalledWith(TASK_ID));
    await settle();
    expect(repos.tasks.update).toHaveBeenCalledWith({ id: TASK_ID, session_id: null });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  const reconcileInput = { source: 'azure_devops', repository: 'org/proj', mode: 'incremental' };

  it('reports an id listing that throws, keeps what the fetch synced, and answers with the cache', async () => {
    const adapter = {
      fetch: vi.fn(async () => ({ issues: [], totalCount: 0, hasNextPage: false })),
      listExternalIds: vi.fn(() => Promise.reject(defect())),
    };
    const { handlers, repos } = await registerBacklog({ adapter });

    await expect(handlerOf(handlers, IPC.BACKLOG_IMPORT_RECONCILE)(null, reconcileInput)).resolves.toMatchObject({ issues: [], removed: 0 });

    expect(repos.cache.upsertMany).toHaveBeenCalledTimes(1);
    expect(repos.cache.pruneMissing).not.toHaveBeenCalled();
    expectOnlyStepReport('backlog', 'import_prune');
  });

  it('reports nothing when the provider is unreachable for the id listing', async () => {
    const unreachable = Object.assign(new Error('gh is not signed in'), { name: 'GhUnavailableError' });
    const adapter = {
      fetch: vi.fn(async () => ({ issues: [], totalCount: 0, hasNextPage: false })),
      listExternalIds: vi.fn(() => Promise.reject(unreachable)),
    };
    const { handlers } = await registerBacklog({ adapter });

    await expect(handlerOf(handlers, IPC.BACKLOG_IMPORT_RECONCILE)(null, reconcileInput)).resolves.toMatchObject({ removed: 0 });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
