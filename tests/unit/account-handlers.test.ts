/**
 * registerAccountHandlers (ipc/handlers/accounts.ts) against fakes: electron's ipcMain, the
 * sign-in runner, the usage refresher, the agent registry and the session reconcile. The account
 * service, the continuation, the repository (real in-memory SQLite) and the move loop are real.
 *
 * Pins the malformed sign-in request and the row a failed sign-in leaves, the failed-turn report,
 * the way a Switch to counts a restart, and that an agent whose conversations stay on their
 * account is never moved by a usage limit.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSession {
  id: string;
  taskId: string;
  projectId: string;
  transient: boolean;
  status: string;
  accountId: string | null;
  agentName: string;
  resuming?: boolean;
  workflowId?: string;
  agentSessionId?: string;
  cwd?: string;
}

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  database: null as import('better-sqlite3').Database | null,
  configDir: '',
  adapters: {} as Record<string, unknown>,
  sessions: [] as FakeSession[],
  taskSessionIds: {} as Record<string, string>,
  accountsConfig: { orderMode: 'manual', autoSwitchAtLimit: true } as { orderMode: string; autoSwitchAtLimit: boolean },
  report: vi.fn(),
  defectReport: vi.fn(),
  restart: vi.fn(),
  restartTerminal: vi.fn(async (..._args: unknown[]) => 'moved'),
  restartWorkflow: vi.fn(async (..._args: unknown[]) => 'moved'),
  runner: {
    start: vi.fn(),
    cancel: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    backlog: vi.fn(() => ''),
    dispose: vi.fn(),
  },
  refresher: {
    start: vi.fn(),
    dispose: vi.fn(),
    refreshAccount: vi.fn(async () => undefined),
    refreshAll: vi.fn(async () => undefined),
    readBeforeRanking: vi.fn(async () => undefined),
    checkHome: vi.fn(async () => undefined),
  },
  watchSync: vi.fn(),
  /** What `getProjectDb` hands out. Null: it throws, as a project with no database would. */
  projectDb: null as unknown,
  sessionHomes: {} as Record<string, string | null>,
  /** What the handlers gave the session manager to find an account's home with. */
  accountHomeResolver: null as ((accountId: string) => string | null | undefined) | null,
  /** Each session's activity; a session not named reads idle. */
  activity: {} as Record<string, string>,
  /** Text typed into a session's input box. */
  drafts: {} as Record<string, string>,
  /** What `automatedKeysBlocker` answers: a reason, or null for none. */
  keysBlocker: null as string | null,
  /** What `getOpenWork` answers for every session. */
  openWork: { toolCalls: [], backgroundShells: [], backgroundSubagents: [] } as { toolCalls: unknown[]; backgroundShells: unknown[]; backgroundSubagents: unknown[] },
  /** What `getActivityStatsSnapshot` answers for every session. */
  activityStats: null as { subagentDepth: number } | null,
  /** What `getSessionCliTarget` answers for every session. */
  cliTarget: null as unknown,
  /** How many times the activity cache was read, to tell which look of the mover a test is at. */
  activityReads: 0,
  /** The retrieval worker's answer to `transcript.toolResultsWritten`. */
  retrievalCall: vi.fn(async (..._args: unknown[]): Promise<boolean | null> => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { hoisted.handlers.set(channel, handler); }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { hoisted.handlers.set(channel, handler); }),
  },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../src/main/db/database', () => ({
  getGlobalDb: () => hoisted.database,
  // No session records unless a test sets `projectDb`: a session's opening prompt then reads as none.
  getProjectDb: () => {
    if (hoisted.projectDb) return hoisted.projectDb;
    throw new Error('no project database in this test');
  },
}));
vi.mock('../../src/main/config/paths', () => ({ PATHS: { get configDir() { return hoisted.configDir; } } }));
vi.mock('../../src/main/accounts/account-report', () => ({
  reportAccountProblem: hoisted.report,
  accountsReporter: { report: hoisted.defectReport, reset: vi.fn() },
  scrubFailureDetail: (detail: string) => detail,
}));
vi.mock('../../src/main/accounts/account-login', () => ({ AccountLoginRunner: vi.fn(function () { return hoisted.runner; }) }));
vi.mock('../../src/main/accounts/account-usage', () => ({ AccountUsageRefresher: vi.fn(function () { return hoisted.refresher; }) }));
// The watch set is what registration hands `sync`; the real watch would open files.
vi.mock('../../src/main/accounts/account-login-watch', () => ({
  AccountLoginWatch: vi.fn(function () { return { sync: hoisted.watchSync, dispose: vi.fn(), watchedFiles: () => [] }; }),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => hoisted.adapters[name],
    list: () => Object.keys(hoisted.adapters),
  },
}));
vi.mock('../../src/main/agent/shared/cli-target', () => ({ resolveCliTarget: async () => null }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({ restartSessionForSettingsChange: hoisted.restart }));
// A Command Terminal and a workflow's agent restart through their own handlers (task #1200).
vi.mock('../../src/main/ipc/handlers/transient-sessions', () => ({ restartCommandTerminalOn: hoisted.restartTerminal }));
vi.mock('../../src/main/workflows/workflow-agent', () => ({ restartWorkflowAgentOn: hoisted.restartWorkflow }));
vi.mock('../../src/main/retrieval/retrieval-client', async () => ({
  ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
  retrievalClient: { call: hoisted.retrievalCall },
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: () => ({
    tasks: {
      getById: (taskId: string) => (taskId in hoisted.taskSessionIds ? { id: taskId, session_id: hoisted.taskSessionIds[taskId] } : null),
    },
  }),
}));

const { registerAccountHandlers, stopAccounts } = await import('../../src/main/ipc/handlers/accounts');
const { noteAccountsConfigChanged } = await import('../../src/main/accounts/accounts-config-changed');
const { sendToRenderer } = await import('../../src/main/ipc/send-to-renderer');
const { setAccountService } = await import('../../src/main/accounts/account-service');
const { AccountUsageRefresher } = await import('../../src/main/accounts/account-usage');
const { AgentAccountRepository } = await import('../../src/main/db/repositories/agent-account-repository');
const { runGlobalMigrations } = await import('../../src/main/db/migrations/global-schema');
const { IPC } = await import('../../src/shared/ipc-channels');
const { beginBoot, noteWindowLoaded, resetBootSettleForTests, isBootSettled, BOOT_SETTLE_FLOOR_MS } = await import('../../src/main/boot-settle');
// The mock above stands in for the refresher everywhere else; the startup gate needs the real one.
const { AccountUsageRefresher: ActualAccountUsageRefresher } = await vi.importActual<typeof import('../../src/main/accounts/account-usage')>('../../src/main/accounts/account-usage');
const { EventType } = await import('../../src/shared/types');
const { CONTINUE_PROMPT } = await import('../../src/main/accounts/account-continuation');
const { withTaskLock } = await import('../../src/main/ipc/task-lifecycle-lock');
const { forgetRecapSession, markRecapSession, recapKindOf, resetRecapSessionsForTests, whenRecapTurnEnds } = await import('../../src/main/automations/turn-end/recap-turns');

import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { AgentAccount } from '../../src/shared/agent-accounts';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const PROJECT_ID = 'project-1';

let root: string;
let home: string;
let repository: InstanceType<typeof AgentAccountRepository>;
let sessionManager: EventEmitter;

function adapterFor(name: string, accountOverrides: Record<string, unknown> = {}): unknown {
  return {
    name,
    detect: async () => ({ found: true, path: '/usr/bin/test-cli' }),
    accounts: {
      kind: 'folder',
      accountEnv: (accountFolder: string) => ({ TEST_AGENT_HOME: accountFolder }),
      homeEnvVars: ['TEST_AGENT_HOME'],
      defaultHome: () => home,
      loginArgs: ['login'],
      sharedEntries: [{ name: 'projects', how: 'link-dir', conversationBearing: true }],
      identify: async () => ({ signedIn: true, email: null, plan: null, hasSubscription: null }),
      overridingCredentialEnvVars: [],
      ...accountOverrides,
    },
  };
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = hoisted.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return Promise.resolve(handler(null, ...args));
}

/** The agent's own login plus one folder account, both ok. */
function seedAccounts(agent: string): { own: AgentAccount; second: AgentAccount } {
  const own = repository.insert({ agent, kind: 'default' });
  const second = repository.insert({ agent, kind: 'folder', folderPath: path.join(root, 'accounts', agent, '2') });
  return { own, second };
}

function addSession(session: Partial<FakeSession> & Pick<FakeSession, 'id' | 'taskId' | 'agentName'>): void {
  hoisted.sessions.push({ projectId: PROJECT_ID, transient: false, status: 'running', accountId: null, ...session });
  if (!session.transient && session.status !== 'suspended') hoisted.taskSessionIds[session.taskId] = session.id;
}

function fail(sessionId: string, detail: string): void {
  sessionManager.emit('event', sessionId, { type: EventType.TurnFailed, detail });
}

function reportedProblems(): string[] {
  return hoisted.report.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-handlers-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  hoisted.configDir = path.join(root, 'config');
  hoisted.database = new Database(':memory:');
  runGlobalMigrations(hoisted.database);
  repository = new AgentAccountRepository(() => hoisted.database!);
  hoisted.handlers.clear();
  hoisted.sessions = [];
  hoisted.taskSessionIds = {};
  hoisted.accountsConfig = { orderMode: 'manual', autoSwitchAtLimit: true };
  hoisted.adapters = {};
  hoisted.report.mockReset();
  hoisted.defectReport.mockClear();
  hoisted.projectDb = null;
  hoisted.refresher.refreshAccount.mockClear();
  hoisted.runner.start.mockReset();
  // A restart that succeeds puts the task's live session on the account it was asked for.
  hoisted.restartTerminal.mockClear();
  hoisted.restartWorkflow.mockClear();
  hoisted.restart.mockReset();
  hoisted.restart.mockImplementation(async (_context: unknown, _projectId: string, _path: string, taskId: string, options: { accountId: string }) => {
    const live = hoisted.sessions.find((session) => session.taskId === taskId && session.status === 'running' && !session.transient);
    if (live) live.accountId = options.accountId;
    return { ok: true };
  });
  hoisted.activity = {};
  hoisted.drafts = {};
  hoisted.keysBlocker = null;
  hoisted.openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
  hoisted.activityStats = null;
  hoisted.cliTarget = null;
  hoisted.activityReads = 0;
  hoisted.retrievalCall.mockReset();
  hoisted.retrievalCall.mockResolvedValue(true);
  sessionManager = Object.assign(new EventEmitter(), {
    listSessions: () => hoisted.sessions,
    getSession: (sessionId: string) => hoisted.sessions.find((session) => session.id === sessionId),
    getSessionAgentName: (sessionId: string) => hoisted.sessions.find((session) => session.id === sessionId)?.agentName,
    // Every session sits idle at its prompt unless a test says otherwise: a move takes it at once.
    getActivityCache: () => {
      hoisted.activityReads += 1;
      return Object.fromEntries(hoisted.sessions.map((session) => [session.id, hoisted.activity[session.id] ?? 'idle']));
    },
    automatedKeysBlocker: () => hoisted.keysBlocker,
    getOpenWork: () => hoisted.openWork,
    getActivityStatsSnapshot: () => hoisted.activityStats,
    getPendingDraft: (sessionId: string) => hoisted.drafts[sessionId] ?? null,
    readPendingDraft: async (sessionId: string) => hoisted.drafts[sessionId] ?? null,
    getSessionCliTarget: () => hoisted.cliTarget,
    getSessionHomeAccountId: (sessionId: string) => hoisted.sessionHomes[sessionId] ?? null,
    setAccountHomeResolver: (resolver: (accountId: string) => string | null | undefined) => { hoisted.accountHomeResolver = resolver; },
  });
  hoisted.sessionHomes = {};
  hoisted.refresher.checkHome.mockClear();
  hoisted.watchSync.mockClear();
});

function register() {
  const context = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    sessionManager,
    projectRepo: { getById: () => ({ path: path.join(root, 'project') }) },
    configManager: {
      load: () => ({ agent: { accounts: hoisted.accountsConfig, cliPaths: {} } }),
      save: (patch: { agent: { accounts: typeof hoisted.accountsConfig } }) => { hoisted.accountsConfig = patch.agent.accounts; },
    },
  } as unknown as IpcContext;
  return registerAccountHandlers(context);
}

/** The dependencies registration gave the service, which no public method hands back. */
function dependenciesOf(service: ReturnType<typeof register>): {
  resolveCliPath: (agent: string) => Promise<string | null>;
  resolveCliVersion: (agent: string) => Promise<string | null>;
} {
  return (service as unknown as { dependencies: ReturnType<typeof dependenciesOf> }).dependencies;
}

afterEach(() => {
  vi.useRealTimers();
  stopAccounts();
  setAccountService(null);
  hoisted.database?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what registration gives the account service and the session manager', () => {
  function adapterDetecting(name: string, detection: Record<string, unknown>): unknown {
    return { ...(adapterFor(name) as Record<string, unknown>), detect: async () => detection };
  }

  it('answers the CLI path and version from the adapter detection, and null where nothing was found', async () => {
    hoisted.adapters = {
      'found-agent': adapterDetecting('found-agent', { found: true, path: '/usr/bin/found-cli', version: '2.1.319 (Claude Code)' }),
      'missing-agent': adapterDetecting('missing-agent', { found: false, path: '/usr/bin/ignored', version: '1.0.0' }),
      'empty-path-agent': adapterDetecting('empty-path-agent', { found: true, path: '', version: '3.0.0' }),
      'no-version-agent': adapterDetecting('no-version-agent', { found: true, path: '/usr/bin/other-cli' }),
    };
    const dependencies = dependenciesOf(register());

    await expect(dependencies.resolveCliPath('found-agent')).resolves.toBe('/usr/bin/found-cli');
    await expect(dependencies.resolveCliVersion('found-agent')).resolves.toBe('2.1.319 (Claude Code)');
    await expect(dependencies.resolveCliPath('missing-agent')).resolves.toBeNull();
    await expect(dependencies.resolveCliVersion('missing-agent')).resolves.toBeNull();
    await expect(dependencies.resolveCliPath('empty-path-agent')).resolves.toBeNull();
    await expect(dependencies.resolveCliPath('no-version-agent')).resolves.toBe('/usr/bin/other-cli');
    await expect(dependencies.resolveCliVersion('no-version-agent')).resolves.toBeNull();
    await expect(dependencies.resolveCliPath('no-such-agent')).resolves.toBeNull();
    await expect(dependencies.resolveCliVersion('no-such-agent')).resolves.toBeNull();
  });

  it('puts the detected CLI version on the report of a usage read that failed twice', async () => {
    const { EmptyUsageReadError } = await import('../../src/main/accounts/account-support');
    hoisted.adapters = {
      'move-agent': {
        ...(adapterFor('move-agent', {
          readIdleUsage: async () => { throw new EmptyUsageReadError('run-failed', { runFailure: { kind: 'timeout', exitCode: null } }); },
        }) as Record<string, unknown>),
        detect: async () => ({ found: true, path: '/usr/bin/test-cli', version: '2.1.319 (Claude Code)' }),
      },
    };
    const { own } = seedAccounts('move-agent');
    const service = register();
    await service.refreshUsage(own.id);
    await service.refreshUsage(own.id);

    const usageReports = hoisted.report.mock.calls.filter((call) => call[0] === 'usage-read-empty');
    expect(usageReports).toHaveLength(1);
    expect(usageReports[0][4]).toMatchObject({ run_failure: 'timeout', agent_cli_version: '2.1.319' });
  });

  it('gives the session manager a resolver of an account\'s home: the folder, null for the own login, undefined for no row', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    const resolver = hoisted.accountHomeResolver!;

    expect(resolver).toBeTypeOf('function');
    expect(resolver(second.id)).toBe(second.folderPath);
    expect(resolver(own.id)).toBeNull();
    expect(resolver('no-such-account')).toBeUndefined();
  });
});

describe('ACCOUNTS_START_LOGIN', () => {
  beforeEach(() => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    register();
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['an empty object', {}],
    ['an agent that is not a string', { agent: 5 }],
    ['an account id that is not a string and no agent', { accountId: 5 }],
  ])('answers unsupported for %s without throwing or making a row', async (_label, request) => {
    await expect(invoke(IPC.ACCOUNTS_START_LOGIN, request)).resolves.toEqual({ ok: false, reason: 'unsupported' });
    expect(repository.list()).toEqual([]);
    expect(hoisted.runner.start).not.toHaveBeenCalled();
  });

  it('removes the row the request created when the sign-in terminal fails to start', async () => {
    hoisted.runner.start.mockRejectedValue(new Error('spawn failed\nsecond line'));
    const result = await invoke(IPC.ACCOUNTS_START_LOGIN, { agent: 'move-agent' });
    expect(result).toEqual({ ok: false, reason: 'failed', message: 'spawn failed' });
    expect(repository.listForAgent('move-agent').map((account) => account.kind)).toEqual(['default']);
  });

  it('keeps an existing row when the terminal fails to start for a sign-in on it', async () => {
    const existing = repository.insert({ agent: 'move-agent', kind: 'folder', folderPath: path.join(root, 'accounts', '2'), status: 'signed-out' });
    hoisted.runner.start.mockRejectedValue(new Error('spawn failed'));
    const result = await invoke(IPC.ACCOUNTS_START_LOGIN, { accountId: existing.id });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(repository.getById(existing.id)).not.toBeNull();
  });

  it('keeps the new row, and answers with the login, when the terminal starts', async () => {
    hoisted.runner.start.mockResolvedValue('login-1');
    const result = await invoke(IPC.ACCOUNTS_START_LOGIN, { agent: 'move-agent' }) as { ok: boolean; loginId: string; accountId: string };
    expect(result).toMatchObject({ ok: true, loginId: 'login-1' });
    expect(repository.getById(result.accountId)).toMatchObject({ kind: 'folder', status: 'signed-out' });
  });
});

describe('the failed-turn report', () => {
  let second: AgentAccount;
  let own: AgentAccount;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { isConversationRefusal: (detail: string) => detail.includes('refused') }) };
    ({ own, second } = seedAccounts('move-agent'));
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    register();
  });

  async function moveTaskToSecond(): Promise<void> {
    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 1, failed: 0 });
  }

  it('reports turn-failed-after-move once for a failure within ten minutes of a move', async () => {
    await moveTaskToSecond();
    vi.setSystemTime(Date.now() + TEN_MINUTES_MS - 1000);
    fail('s1', 'something broke');
    expect(hoisted.report).toHaveBeenCalledTimes(1);
    // The last two are the caller's error and tags, and this report has neither.
    expect(hoisted.report).toHaveBeenCalledWith('turn-failed-after-move', 'move-agent', { detail: 'something broke' }, undefined, undefined);
    fail('s1', 'something broke again');
    expect(hoisted.report).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a failure more than ten minutes after the move', async () => {
    await moveTaskToSecond();
    vi.setSystemTime(Date.now() + TEN_MINUTES_MS + 1000);
    fail('s1', 'something broke');
    expect(reportedProblems()).toEqual([]);
  });

  it('reports nothing for a failure with no move', () => {
    fail('s1', 'something broke');
    expect(reportedProblems()).toEqual([]);
  });

  it('reports nothing for a transient session, and keeps the move for the task session', async () => {
    await moveTaskToSecond();
    addSession({ id: 'terminal-1', taskId: 't1', agentName: 'move-agent', accountId: second.id, transient: true });
    fail('terminal-1', 'something broke');
    expect(reportedProblems()).toEqual([]);
    fail('s1', 'something broke');
    expect(reportedProblems()).toEqual(['turn-failed-after-move']);
  });

  it('reports conversation-refused when the adapter reads the detail as a refusal, with no move needed', () => {
    fail('s1', 'conversation refused for this account');
    expect(hoisted.report).toHaveBeenCalledWith('conversation-refused', 'move-agent', { detail: 'conversation refused for this account' }, undefined, undefined);
  });

  it('reports no refusal for a transient session', () => {
    addSession({ id: 'terminal-1', taskId: 't2', agentName: 'move-agent', accountId: own.id, transient: true });
    fail('terminal-1', 'conversation refused for this account');
    expect(reportedProblems()).toEqual([]);
  });
});

describe('ACCOUNTS_SWITCH_TO restarting sessions', () => {
  it('counts a session whose task moved on as moved when the live session is already on the target', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    // The task has since taken a new session, which already runs on the target. It comes first in
    // the registry so it is the task's live session; the old one is still listed as running.
    addSession({ id: 's2', taskId: 't1', agentName: 'move-agent', accountId: second.id });
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    hoisted.taskSessionIds.t1 = 's2';

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, agent: 'move-agent', moved: 1, failed: 0 });
    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  it('counts a session whose task moved on as failed when the live session is not on the target', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    // The task's current session is not running, so nothing runs on the target.
    addSession({ id: 's2', taskId: 't1', agentName: 'move-agent', accountId: own.id, status: 'suspended' });
    hoisted.taskSessionIds.t1 = 's2';

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 0, failed: 1 });
    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  it('counts a restart that comes back on a different account as failed', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    // The restart succeeds but the session is back on the agent's own login.
    hoisted.restart.mockImplementationOnce(async () => ({ ok: true }));

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 0, failed: 1 });
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
  });

  it('counts a restart that puts the session on the target as moved', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 1, failed: 0 });
    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ phase: 'switching-account', accountId: second.id });
  });

  it('moves a Command Terminal and a workflow agent too, each through its own restart', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 'terminal', taskId: 'tag-1', agentName: 'move-agent', accountId: own.id, transient: true });
    addSession({ id: 'planner', taskId: 'workflow-1', agentName: 'move-agent', accountId: own.id, transient: true, workflowId: 'workflow-1' });

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 2, pending: 0, failed: 0 });
    // Idle, so nothing is sent to either.
    expect(hoisted.restartTerminal.mock.calls[0].slice(1, 4)).toEqual(['terminal', second.id, undefined]);
    expect(hoisted.restartWorkflow.mock.calls[0].slice(1, 4)).toEqual(['workflow-1', second.id, undefined]);
    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  it('leaves a working session waiting, and moves it at its turn end', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    hoisted.activity.s1 = 'thinking';

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 0, pending: 1, failed: 0 });
    expect(hoisted.restart).not.toHaveBeenCalled();

    hoisted.activity.s1 = 'idle';
    sessionManager.emit('turn-ended', { sessionId: 's1' });
    await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
    // Its turn was over, so it resumes idle: no prompt.
    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ accountId: second.id, resumePrompt: undefined });
  });

  it('never moves a session while text sits in its input box', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    hoisted.drafts.s1 = 'half a thought';

    expect(await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id)).toMatchObject({ moved: 0, pending: 1 });
    sessionManager.emit('activity', 's1', 'idle');
    await new Promise((resolve) => setImmediate(resolve));
    expect(hoisted.restart).not.toHaveBeenCalled();

    hoisted.drafts.s1 = '';
    sessionManager.emit('activity', 's1', 'idle');
    await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
  });

  it('moves no session for an agent whose conversations stay on their account', async () => {
    hoisted.adapters = { 'stay-agent': adapterFor('stay-agent', { conversationsStayOnAccount: true }) };
    const { own, second } = seedAccounts('stay-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'stay-agent', accountId: own.id });

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, agent: 'stay-agent', moved: 0, failed: 0 });
    expect(hoisted.restart).not.toHaveBeenCalled();
    // The list still changed: the account is #1.
    expect(repository.listForAgent('stay-agent')[0].id).toBe(second.id);
  });
});

describe('the continuation at a usage limit', () => {
  it('ignores a usage-limit failure for an agent whose conversations stay on their account', async () => {
    hoisted.adapters = {
      'stay-agent': adapterFor('stay-agent', { conversationsStayOnAccount: true, isUsageLimitFailure: () => true }),
      'move-agent': adapterFor('move-agent', { isUsageLimitFailure: () => true }),
    };
    const stay = seedAccounts('stay-agent');
    const move = seedAccounts('move-agent');
    addSession({ id: 's-stay', taskId: 't-stay', agentName: 'stay-agent', accountId: stay.own.id });
    addSession({ id: 's-move', taskId: 't-move', agentName: 'move-agent', accountId: move.own.id });
    register();

    // The stay agent fails first. Events run in order, so once the control agent's read is seen
    // the stay agent's pass has already had its turn.
    fail('s-stay', 'usage limit reached');
    fail('s-move', 'usage limit reached');
    await expect.poll(() => hoisted.refresher.refreshAccount.mock.calls.length).toBeGreaterThan(0);

    expect(hoisted.refresher.refreshAccount.mock.calls.map((call) => (call as unknown[])[0])).toEqual([move.own.id]);
    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  // Task #1147: a resume Claude refused at a spent limit fired no failed turn, only its start.
  it('decides a resumed task session that starts on a full account, off the event stack', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
    repository.updateUsage(own.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt }]);
    addSession({ id: 's-full', taskId: 't-full', agentName: 'move-agent', accountId: own.id, resuming: true });
    addSession({ id: 's-room', taskId: 't-room', agentName: 'move-agent', accountId: second.id, resuming: true });
    register();

    sessionManager.emit('event', 's-room', { type: EventType.SessionStart });
    sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
    // Never on the event's stack: the spawn that emitted it may hold the task's lock.
    expect(hoisted.refresher.refreshAccount).not.toHaveBeenCalled();
    await expect.poll(() => hoisted.refresher.refreshAccount.mock.calls.length).toBeGreaterThan(0);
    // The session on an account with room started first and read nothing: the first read is the
    // full account's own, made by the decision for the session on it.
    expect(hoisted.refresher.refreshAccount.mock.calls[0]).toEqual([own.id, true]);
  });

  /** A resumed session on a full account, with the second account free to take it. */
  function seedFullResumedSession(): { second: AgentAccount } {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { own, second } = seedAccounts('move-agent');
    const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
    repository.updateUsage(own.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt }]);
    addSession({ id: 's-full', taskId: 't-full', agentName: 'move-agent', accountId: own.id, resuming: true });
    register();
    return { second };
  }

  it('carries the opening prompt from the session record into the move', async () => {
    const { second } = seedFullResumedSession();
    // A minimal project database: the repository reads one session row through `prepare().get()`.
    hoisted.projectDb = { prepare: () => ({ get: () => ({ prompt: 'Read the handoff.' }) }) };

    sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
    await expect.poll(() => hoisted.restart.mock.calls.length).toBeGreaterThan(0);

    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ phase: 'switching-account', accountId: second.id, resumePrompt: 'Read the handoff.' });
    expect(hoisted.defectReport).not.toHaveBeenCalled();
  });

  // Task #1147, the #1145 stall: a return from Code Review resumed the main conversation on the
  // full account, with the recap as its opening prompt and the column's /pull-request waiting on
  // the recap's turn. The move at its start must hand that wait to the session replacing it.
  describe('a session moved during its return recap', () => {
    /** The real restart's effect on the registry: the task's live session is a new one. */
    function restartReplacesSession(newSessionId: string): void {
      hoisted.restart.mockImplementation(async (_context: unknown, _projectId: string, _path: string, taskId: string, options: { accountId: string }) => {
        const old = hoisted.sessions.find((session) => session.taskId === taskId && session.status === 'running');
        if (old) {
          old.status = 'exited';
          // The turn-end runner hears the old session's removal; it is not registered here.
          forgetRecapSession(old.id, false);
        }
        addSession({ id: newSessionId, taskId, agentName: 'move-agent', accountId: options.accountId, resuming: true });
        return { ok: true };
      });
    }

    /** Records how a wait settled, so one that never settles reads as `pending`. */
    function trackWait(wait: Promise<boolean>): () => boolean | 'pending' {
      let outcome: boolean | 'pending' = 'pending';
      void wait.then((proceed) => { outcome = proceed; });
      return () => outcome;
    }

    afterEach(() => {
      resetRecapSessionsForTests();
    });

    it('hands the recap\'s wait to the session that replaces it, which ends it at its own recap turn', async () => {
      seedFullResumedSession();
      hoisted.projectDb = { prepare: () => ({ get: () => ({ prompt: 'While this conversation was away...' }) }) };
      markRecapSession('s-full', 'return');
      const outcome = trackWait(whenRecapTurnEnds('s-full', TEN_MINUTES_MS));
      restartReplacesSession('s-replacement');

      sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
      await expect.poll(() => recapKindOf('s-replacement')).toBe('return');

      expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ resumePrompt: 'While this conversation was away...' });
      expect(recapKindOf('s-full')).toBeNull();
      // Waiting still: the old session's removal did not drop what waited on the recap.
      await Promise.resolve();
      expect(outcome()).toBe('pending');

      forgetRecapSession('s-replacement', true);
      await Promise.resolve();
      expect(outcome()).toBe(true);
    });

    it('lets the wait go at once when the session resumes idle, with no recap turn to wait for', async () => {
      seedFullResumedSession();
      markRecapSession('s-full', 'return');
      const outcome = trackWait(whenRecapTurnEnds('s-full', TEN_MINUTES_MS));
      restartReplacesSession('s-replacement');

      // No project database: the opening prompt reads as none, so the move resumes idle.
      sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
      await expect.poll(() => outcome()).toBe(true);
      expect(recapKindOf('s-replacement')).toBeNull();
    });

    it('lets the wait go at once when the opening prompt is an empty string, which resumes idle too', async () => {
      seedFullResumedSession();
      hoisted.projectDb = { prepare: () => ({ get: () => ({ prompt: '' }) }) };
      markRecapSession('s-full', 'return');
      const outcome = trackWait(whenRecapTurnEnds('s-full', TEN_MINUTES_MS));
      restartReplacesSession('s-replacement');

      sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
      await expect.poll(() => outcome()).toBe(true);
      expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ resumePrompt: '' });
      expect(recapKindOf('s-replacement')).toBeNull();
    });

    it('keeps the mark on the old session, and the wait pending, when the restart fails with it still live', async () => {
      seedFullResumedSession();
      hoisted.projectDb = { prepare: () => ({ get: () => ({ prompt: 'While this conversation was away...' }) }) };
      markRecapSession('s-full', 'return');
      const outcome = trackWait(whenRecapTurnEnds('s-full', TEN_MINUTES_MS));
      // Touches neither the sessions nor the task row: the row still names s-full.
      hoisted.restart.mockImplementation(async () => ({ ok: false, reason: 'x' }));

      sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
      await expect.poll(() => hoisted.restart.mock.calls.length).toBeGreaterThan(0);
      // The move's remaining work runs after the restart settles: let it.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(recapKindOf('s-full')).toBe('return');
      expect(outcome()).toBe('pending');
    });

    it('pauses the recap\'s bound while the session waits with every account full', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
        const { own, second } = seedAccounts('move-agent');
        const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
        for (const full of [own, second]) {
          repository.updateUsage(full.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt }]);
        }
        addSession({ id: 's-full', taskId: 't-full', agentName: 'move-agent', accountId: own.id, resuming: true });
        register();
        markRecapSession('s-full', 'return');
        const outcome = trackWait(whenRecapTurnEnds('s-full', TEN_MINUTES_MS));

        sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
        await vi.waitFor(() => expect(sendToRenderer).toHaveBeenCalledWith(expect.anything(), IPC.ACCOUNTS_ALL_FULL, expect.anything()));

        vi.advanceTimersByTime(TEN_MINUTES_MS + 1);
        await Promise.resolve();
        expect(outcome()).toBe('pending');
        expect(recapKindOf('s-full')).toBe('return');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('still moves, with no prompt, and reports the failure when the session record cannot be read', async () => {
    const { second } = seedFullResumedSession();

    sessionManager.emit('event', 's-full', { type: EventType.SessionStart });
    await expect.poll(() => hoisted.restart.mock.calls.length).toBeGreaterThan(0);

    const options = hoisted.restart.mock.calls[0][4] as { accountId: string; resumePrompt?: string };
    expect(options.accountId).toBe(second.id);
    expect(options.resumePrompt).toBeUndefined();
    expect(hoisted.defectReport).toHaveBeenCalledWith(expect.any(Error), { tags: { stage: 'opening_prompt' } });
  });

  it('reads nothing at the start of a resumed session of an agent whose conversations stay on their account', async () => {
    hoisted.adapters = { 'stay-agent': adapterFor('stay-agent', { conversationsStayOnAccount: true }) };
    const { own } = seedAccounts('stay-agent');
    const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
    repository.updateUsage(own.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt }]);
    addSession({ id: 's-stay', taskId: 't-stay', agentName: 'stay-agent', accountId: own.id, resuming: true });
    register();

    sessionManager.emit('event', 's-stay', { type: EventType.SessionStart });
    // The negative cannot be polled: let the scheduled check run, twice over.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(hoisted.refresher.refreshAccount).not.toHaveBeenCalled();
    expect(hoisted.restart).not.toHaveBeenCalled();
  });
});

describe('keeping Automatic and the tab current', () => {
  beforeEach(() => {
    vi.mocked(sendToRenderer).mockClear();
    hoisted.refresher.refreshAll.mockClear();
    hoisted.refresher.readBeforeRanking.mockClear();
  });

  it('pushes accounts:changed when the accounts settings are saved, and stops after quit', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    register();
    noteAccountsConfigChanged();
    expect(vi.mocked(sendToRenderer).mock.calls.map((call) => call[1])).toEqual([IPC.ACCOUNTS_CHANGED]);
    stopAccounts();
    noteAccountsConfigChanged();
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
  });

  /** Two accounts under Automatic, the agent's own login's week resetting first, and a session on the other. */
  function seedFollowing(): { own: AgentAccount; second: AgentAccount } {
    hoisted.adapters = { 'move-agent': { ...(adapterFor('move-agent') as object), reportsRateLimits: true } };
    hoisted.accountsConfig = { orderMode: 'automatic', autoSwitchAtLimit: true };
    const accounts = seedAccounts('move-agent');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const weekly = (resetsInSeconds: number, usedPercentage: number) => ({
      id: 'seven-day', label: '7d weekly', iconKind: 'period' as const, usedPercentage, resetsAt: nowSeconds + resetsInSeconds, windowDurationSeconds: 604_800,
    });
    repository.updateUsage(accounts.own.id, [weekly(86_400, 86)]);
    repository.updateUsage(accounts.second.id, [weekly(6 * 86_400, 5)]);
    return accounts;
  }

  /** What registration handed the refresher to call after each read. */
  function readSettled(): () => void {
    const options = vi.mocked(AccountUsageRefresher).mock.calls.at(-1)?.[1] as { onReadSettled?: () => void } | undefined;
    if (!options?.onReadSettled) throw new Error('registration gave the refresher no onReadSettled');
    return options.onReadSettled;
  }

  it('moves running sessions to the top account after a usage read, once, with one notice', async () => {
    const { own, second } = seedFollowing();
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: second.id });

    readSettled()();
    await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ phase: 'switching-account', accountId: own.id });
    await vi.waitFor(() => expect(vi.mocked(sendToRenderer).mock.calls.filter((call) => call[1] === IPC.ACCOUNTS_FOLLOWING)).toHaveLength(1));

    // Another read that leaves the top where it was moves nothing, even a session left behind.
    addSession({ id: 's2', taskId: 't2', agentName: 'move-agent', accountId: second.id });
    readSettled()();
    await new Promise((resolve) => setImmediate(resolve));
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
  });

  it('moves nothing under Manual, and re-places sessions when the order goes back to Automatic', async () => {
    const { own, second } = seedFollowing();
    hoisted.accountsConfig = { orderMode: 'manual', autoSwitchAtLimit: true };
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: second.id });
    readSettled()();
    await new Promise((resolve) => setImmediate(resolve));
    expect(hoisted.restart).not.toHaveBeenCalled();

    hoisted.accountsConfig = { orderMode: 'automatic', autoSwitchAtLimit: true };
    noteAccountsConfigChanged();
    await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ accountId: own.id });
  });

  it('shares one refresh between two that overlap, so a double mount runs each CLI once', async () => {
    let identifyCount = 0;
    hoisted.adapters = {
      'move-agent': adapterFor('move-agent', {
        identify: async () => {
          identifyCount += 1;
          return { signedIn: true, email: null, plan: null, hasSubscription: null };
        },
      }),
    };
    seedAccounts('move-agent');
    register();
    await Promise.all([invoke(IPC.ACCOUNTS_REFRESH_USAGE), invoke(IPC.ACCOUNTS_REFRESH_USAGE)]);
    expect(identifyCount).toBe(2);
    expect(hoisted.refresher.refreshAll).toHaveBeenCalledTimes(1);
    await invoke(IPC.ACCOUNTS_REFRESH_USAGE);
    expect(hoisted.refresher.refreshAll).toHaveBeenCalledTimes(2);
  });

  it('clears the shared refresh after it rejects, so a later one starts again', async () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    seedAccounts('move-agent');
    register();
    hoisted.refresher.refreshAll.mockRejectedValueOnce(new Error('refresh defect'));
    await expect(invoke(IPC.ACCOUNTS_REFRESH_USAGE)).rejects.toThrow('refresh defect');
    expect(hoisted.refresher.refreshAll).toHaveBeenCalledTimes(1);
    await expect(invoke(IPC.ACCOUNTS_REFRESH_USAGE)).resolves.toBeUndefined();
    expect(hoisted.refresher.refreshAll).toHaveBeenCalledTimes(2);
  });

  it('reports a sign-in read that throws a plain TypeError, and still reads the usage', async () => {
    hoisted.defectReport.mockClear();
    hoisted.adapters = {
      'move-agent': adapterFor('move-agent', { identify: async () => { throw new TypeError('identify defect'); } }),
    };
    seedAccounts('move-agent');
    register();
    await expect(invoke(IPC.ACCOUNTS_REFRESH_USAGE)).resolves.toBeUndefined();
    expect(hoisted.defectReport).toHaveBeenCalled();
    for (const call of hoisted.defectReport.mock.calls) {
      expect(call[0]).toBeInstanceOf(TypeError);
      expect(call[1]).toEqual({ tags: { stage: 'sign_in_read' } });
    }
    expect(hoisted.refresher.refreshAll).toHaveBeenCalledWith('requested');
  });

  // Manual reads too (task #1147): it skips a full account, and a reading from before it filled
  // says it has room.
  it.each(['automatic', 'manual'] as const)('reads the stale accounts before a spawn chooses one under %s', async (orderMode) => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { readIdleUsage: async () => null }) };
    hoisted.accountsConfig = { orderMode, autoSwitchAtLimit: true };
    const { own, second } = seedAccounts('move-agent');
    register();
    const { resolveSpawnAccount } = await import('../../src/main/accounts/account-service');
    await resolveSpawnAccount('move-agent');
    const asked = hoisted.refresher.readBeforeRanking.mock.calls.map((call) => ((call as unknown[])[0] as AgentAccount[]).map((account) => account.id));
    expect(asked).toEqual([[own.id, second.id]]);
  });
});

// A login replaced in a home (task #1113) is compared with its row at a turn end and a session
// end, but only for an agent with two or more accounts: a one-account user's turn reads no file.
describe('checking a home for a replaced login', () => {
  it('checks the session home at a turn end for an agent with two accounts', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    const { second } = seedAccounts('move-agent');
    register();
    hoisted.sessionHomes.s1 = second.id;
    sessionManager.emit('turn-ended', { sessionId: 's1' });
    expect(hoisted.refresher.checkHome).toHaveBeenCalledTimes(1);
    expect(hoisted.refresher.checkHome).toHaveBeenCalledWith(second.id);
  });

  it('checks nothing at a turn end for an agent with one account', () => {
    hoisted.adapters = { 'solo-agent': adapterFor('solo-agent') };
    const solo = repository.insert({ agent: 'solo-agent', kind: 'default' });
    register();
    hoisted.sessionHomes.s1 = solo.id;
    sessionManager.emit('turn-ended', { sessionId: 's1' });
    expect(hoisted.refresher.checkHome).not.toHaveBeenCalled();
  });

  it('checks nothing for a session with no home account, or a home that has no row', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    seedAccounts('move-agent');
    register();
    hoisted.sessionHomes.s1 = null;
    sessionManager.emit('turn-ended', { sessionId: 's1' });
    hoisted.sessionHomes.s2 = 'no-such-account';
    sessionManager.emit('turn-ended', { sessionId: 's2' });
    expect(hoisted.refresher.checkHome).not.toHaveBeenCalled();
  });

  it('checks the home when a session is removed, and not for a one-account agent', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent'), 'solo-agent': adapterFor('solo-agent') };
    const { own } = seedAccounts('move-agent');
    const solo = repository.insert({ agent: 'solo-agent', kind: 'default' });
    register();
    hoisted.sessionHomes.gone = own.id;
    hoisted.sessionHomes.soloGone = solo.id;
    sessionManager.emit('session-removed', 'soloGone');
    expect(hoisted.refresher.checkHome).not.toHaveBeenCalled();
    sessionManager.emit('session-removed', 'gone');
    expect(hoisted.refresher.checkHome).toHaveBeenCalledTimes(1);
    expect(hoisted.refresher.checkHome).toHaveBeenCalledWith(own.id);
  });
});

// The cards may be answered from an earlier launch; everything that runs the CLI detects it for
// real. account-service-behavior.test.ts injects its own lookups, so only registration shows
// which of the two a path got. Red-green: swap the `forList` argument of `listCliPath` and
// `resolveCliPath` in handlers/accounts.ts and both tests fail.
describe('which detection each account path asks the adapter for', () => {
  function seedDetectingAgent(): ReturnType<typeof vi.fn> {
    const detect = vi.fn(async () => ({ found: true, path: '/usr/bin/test-cli', version: '1.0.0' }));
    hoisted.adapters = { 'move-agent': { ...(adapterFor('move-agent') as Record<string, unknown>), detect } };
    seedAccounts('move-agent');
    return detect;
  }

  it('lets the account cards read a remembered detection, and nothing else', async () => {
    const detect = seedDetectingAgent();
    register();
    detect.mockClear();

    await invoke(IPC.ACCOUNTS_LIST);

    expect(detect).toHaveBeenCalled();
    for (const call of detect.mock.calls) {
      expect(call).toEqual([null, { allowRemembered: true }]);
    }
  });

  it('detects for real, with no options, for the CLI path and the CLI version that a run uses', async () => {
    const detect = seedDetectingAgent();
    const dependencies = dependenciesOf(register());
    detect.mockClear();

    await dependencies.resolveCliPath('move-agent');
    await dependencies.resolveCliVersion('move-agent');

    expect(detect.mock.calls).toEqual([[null], [null]]);
  });
});

// The usage pass starts a CLI per account, so registration holds it behind the launch's settle
// signal. The refresher itself is the real class here, built from the options registration gave
// the mocked constructor. Red-green: drop `startupGate: whenBootSettled` and the pass runs at the
// startup delay, which fails the first assertion.
describe('the startup usage pass waits for the launch to settle', () => {
  const STARTUP_DELAY_MS = 20_000;

  afterEach(() => {
    resetBootSettleForTests();
  });

  it('does not run at the startup delay while the launch is unsettled, and runs once it settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    hoisted.adapters = { 'move-agent': adapterFor('move-agent') };
    beginBoot();
    register();
    const constructions = vi.mocked(AccountUsageRefresher).mock.calls as unknown as Array<[unknown, ConstructorParameters<typeof ActualAccountUsageRefresher>[1]]>;
    const [service, options] = constructions[constructions.length - 1];
    const refresher = new ActualAccountUsageRefresher(service as ConstructorParameters<typeof ActualAccountUsageRefresher>[0], options);
    const refreshAll = vi.spyOn(refresher, 'refreshAll').mockResolvedValue(undefined);
    refresher.start();

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1);
    expect(isBootSettled()).toBe(false);
    expect(refreshAll).not.toHaveBeenCalled();

    // The window loads, and the floor after it is the earliest the launch can settle.
    noteWindowLoaded();
    await vi.advanceTimersByTimeAsync(BOOT_SETTLE_FLOOR_MS - 1);
    expect(refreshAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(isBootSettled()).toBe(true);
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(refreshAll).toHaveBeenCalledWith('startup');
    refresher.dispose();
  });
});

describe('the login files the watch holds', () => {
  const loginFiles = (accountHome: string | null): string[] => [accountHome === null ? 'default-home/.login' : path.join(accountHome, '.login')];

  function lastWatchedSet(): Array<{ accountId: string; filePath: string }> {
    const calls = hoisted.watchSync.mock.calls;
    return calls[calls.length - 1][0] as Array<{ accountId: string; filePath: string }>;
  }

  /**
   * The real refresher calls `onStartup` at the start of its startup pass, which is when the watch
   * starts. The refresher here is a stub, so the test plays that moment.
   */
  function runStartupPass(): void {
    const constructions = vi.mocked(AccountUsageRefresher).mock.calls as unknown as Array<[unknown, { onStartup?: () => void }]>;
    constructions[constructions.length - 1][1].onStartup?.();
  }

  // Registration reads no database: starting the watch there made every registerAllIpc test, whose
  // database is a stub, throw. The startup pass is the first read, and starts it.
  it('starts no watch at registration, and starts it on the refresher\'s startup pass', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { loginFiles }) };
    seedAccounts('move-agent');
    register();
    expect(hoisted.watchSync).not.toHaveBeenCalled();
    runStartupPass();
    expect(hoisted.watchSync).toHaveBeenCalledTimes(1);
    expect(lastWatchedSet()).toHaveLength(2);
  });

  it('lists the default row with no home and a folder row by its path, and skips key-file rows', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { loginFiles }) };
    const { own, second } = seedAccounts('move-agent');
    repository.insert({ agent: 'move-agent', kind: 'key-file', keyFilePath: path.join(root, 'key.env') });
    register();
    runStartupPass();
    expect(lastWatchedSet()).toEqual(expect.arrayContaining([
      { accountId: own.id, filePath: 'default-home/.login' },
      { accountId: second.id, filePath: path.join(second.folderPath!, '.login') },
    ]));
    expect(lastWatchedSet()).toHaveLength(2);
  });

  it('skips a folder row with no path', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { loginFiles }) };
    const { own } = seedAccounts('move-agent');
    repository.insert({ agent: 'move-agent', kind: 'folder' });
    register();
    runStartupPass();
    expect(lastWatchedSet().map((file) => file.accountId)).toEqual(expect.arrayContaining([own.id]));
    expect(lastWatchedSet()).toHaveLength(2);
  });

  it('lists nothing for an agent with one account or an adapter that names no login file', () => {
    hoisted.adapters = {
      'solo-agent': adapterFor('solo-agent', { loginFiles }),
      'move-agent': adapterFor('move-agent'),
    };
    repository.insert({ agent: 'solo-agent', kind: 'default' });
    seedAccounts('move-agent');
    register();
    runStartupPass();
    expect(lastWatchedSet()).toEqual([]);
  });

  it('lists again when the accounts change', () => {
    hoisted.adapters = { 'move-agent': adapterFor('move-agent', { loginFiles }) };
    seedAccounts('move-agent');
    register();
    runStartupPass();
    expect(lastWatchedSet()).toHaveLength(2);
    repository.insert({ agent: 'move-agent', kind: 'folder', folderPath: path.join(root, 'accounts', 'move-agent', '3') });
    noteAccountsConfigChanged();
    expect(lastWatchedSet()).toHaveLength(3);
  });
});

// Task #1200: the handler decides where a running session stands (`quickSafePoint`, `safePoint`,
// `stillAt`) and wires the session manager's events to the mover. The mover itself is pinned in
// account-session-move.test.ts; these pin what only the handler's wiring does.
describe('moving running sessions: the handler wiring', () => {
  const WORK_DIRECTORY = 'work-directory';

  /** An adapter that can say whether a transcript holds a call's results. */
  function seedMidTurnAgent(withTranscriptRead = true): { own: AgentAccount; second: AgentAccount } {
    hoisted.adapters = {
      'move-agent': {
        ...(adapterFor('move-agent') as Record<string, unknown>),
        ...(withTranscriptRead ? { transcriptToolResultsWritten: async () => true } : {}),
      },
    };
    return seedAccounts('move-agent');
  }

  /** A working task session on the agent's own login, with the fields the transcript read sends. */
  function addWorkingSession(accountId: string, sessionId = 's1', taskId = 't1'): void {
    addSession({ id: sessionId, taskId, agentName: 'move-agent', accountId, agentSessionId: 'conversation-1', cwd: WORK_DIRECTORY });
    hoisted.activity[sessionId] = 'thinking';
  }

  function toolEnded(sessionId: string, toolId?: string, subagentId?: string): void {
    sessionManager.emit('event', sessionId, { type: EventType.ToolEnd, toolId, subagentId });
  }

  async function letTimersAndImmediatesRun(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  describe('what leaves a session waiting before any transcript read', () => {
    it.each([
      ['an automated-keys blocker names a reason', () => { hoisted.keysBlocker = 'a prompt is open'; }],
      ['a background shell is open', () => { hoisted.openWork = { toolCalls: [], backgroundShells: [{ id: 'shell-1' }], backgroundSubagents: [] }; }],
      ['a background subagent is open', () => { hoisted.openWork = { toolCalls: [], backgroundShells: [], backgroundSubagents: [{ id: 'subagent-1' }] }; }],
      ['the activity engine counts a subagent running', () => { hoisted.activityStats = { subagentDepth: 1 }; }],
    ])('keeps an idle session pending while %s', async (_label, arrange) => {
      const { own, second } = seedMidTurnAgent();
      register();
      addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
      arrange();

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
      expect(result).toMatchObject({ ok: true, moved: 0, pending: 1, failed: 0 });
      expect(hoisted.restart).not.toHaveBeenCalled();
    });
  });

  describe('mid-turn, between two tool calls', () => {
    it('restarts with the continue prompt once the worker says the results are written, asking with the session\'s own details', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      hoisted.cliTarget = { kind: 'remote-target-marker' };
      toolEnded('s1', 'toolu_a');

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ ok: true, moved: 1, pending: 0, failed: 0 });
      expect(hoisted.retrievalCall).toHaveBeenCalledWith('transcript.toolResultsWritten', {
        agentName: 'move-agent',
        transcriptPath: null,
        agentSessionId: 'conversation-1',
        cwd: WORK_DIRECTORY,
        cliTarget: { kind: 'remote-target-marker' },
        toolUseId: 'toolu_a',
      }, { timeoutMs: 5000 });
      expect(hoisted.restart).toHaveBeenCalledTimes(1);
      expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ accountId: second.id, resumePrompt: CONTINUE_PROMPT });
    });

    it('reads the transcript once for a call, across the mover\'s two looks of one attempt', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_a');

      await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(hoisted.restart).toHaveBeenCalledTimes(1);
      expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['says the results are not written', () => hoisted.retrievalCall.mockResolvedValue(false)],
      ['cannot read the transcript', () => hoisted.retrievalCall.mockResolvedValue(null)],
      ['fails', () => hoisted.retrievalCall.mockRejectedValue(new Error('worker down'))],
    ])('keeps the session pending, with no restart, when the worker %s', async (_label, arrange) => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_a');
      arrange();

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ ok: true, moved: 0, pending: 1, failed: 0 });
      expect(hoisted.retrievalCall).toHaveBeenCalled();
      expect(hoisted.restart).not.toHaveBeenCalled();
    });

    it('waits for the turn end, reading nothing, for an adapter that cannot say whether results are written', async () => {
      const { own, second } = seedMidTurnAgent(false);
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_a');

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ moved: 0, pending: 1 });
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
      expect(hoisted.restart).not.toHaveBeenCalled();
    });

    it('ignores a tool end that came from a subagent: nothing is read and the session waits', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_sub', 'subagent-1');

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ moved: 0, pending: 1 });
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    });

    it('has nothing to check for a tool end with no id, even after one with an id', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_a');
      toolEnded('s1', undefined);

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ moved: 0, pending: 1 });
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    });

    it('drops the recorded call when a tool starts after it', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      toolEnded('s1', 'toolu_a');
      sessionManager.emit('event', 's1', { type: EventType.ToolStart, toolId: 'toolu_b' });

      const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      expect(result).toMatchObject({ moved: 0, pending: 1 });
      expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    });
  });

  describe('the check made again just before the stop', () => {
    it('hands a Command Terminal and a workflow agent a check that holds while idle and fails once it works or has a draft', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addSession({ id: 'terminal', taskId: 'tag-1', agentName: 'move-agent', accountId: own.id, transient: true });
      addSession({ id: 'planner', taskId: 'workflow-1', agentName: 'move-agent', accountId: own.id, transient: true, workflowId: 'workflow-1' });

      await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

      const checks = [
        { sessionId: 'terminal', stillSafe: hoisted.restartTerminal.mock.calls[0].at(-1) as () => boolean },
        { sessionId: 'planner', stillSafe: hoisted.restartWorkflow.mock.calls[0].at(-1) as () => boolean },
      ];
      for (const { sessionId, stillSafe } of checks) {
        expect(stillSafe(), `${sessionId} idle`).toBe(true);
        hoisted.activity[sessionId] = 'thinking';
        expect(stillSafe(), `${sessionId} working`).toBe(false);
        hoisted.activity[sessionId] = 'idle';
        expect(stillSafe(), `${sessionId} idle again`).toBe(true);
        hoisted.drafts[sessionId] = 'half a thought';
        expect(stillSafe(), `${sessionId} with a draft`).toBe(false);
      }
    });

    it('does not restart a task session that stopped being idle while it waited for its task lock', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
      let releaseLock: () => void = () => undefined;
      const held = withTaskLock('t1', () => new Promise<void>((resolve) => { releaseLock = resolve; }));

      const switching = invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
      // Two reads: the mover's two looks have passed and its restart now waits behind the held lock.
      await expect.poll(() => hoisted.activityReads).toBeGreaterThanOrEqual(2);
      hoisted.activity.s1 = 'thinking';
      releaseLock();
      await held;

      expect(await switching).toMatchObject({ ok: true, moved: 0, pending: 1, failed: 0 });
      expect(hoisted.restart).not.toHaveBeenCalled();
    });
  });

  describe('the session manager events', () => {
    it('drops a pending session when it is removed: a later idle moves nothing', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      expect(await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id)).toMatchObject({ pending: 1 });

      sessionManager.emit('session-removed', 's1');
      hoisted.activity.s1 = 'idle';
      sessionManager.emit('activity', 's1', 'idle');
      await letTimersAndImmediatesRun();

      expect(hoisted.restart).not.toHaveBeenCalled();
    });

    it('releases a pending session that is now idle on an event alone', async () => {
      const { own, second } = seedMidTurnAgent();
      register();
      addWorkingSession(own.id);
      expect(await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id)).toMatchObject({ pending: 1 });

      hoisted.activity.s1 = 'idle';
      sessionManager.emit('event', 's1', { type: EventType.ToolStart, toolId: 'toolu_b' });

      await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
      // Its turn was over: nothing is sent.
      expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ accountId: second.id, resumePrompt: undefined });
    });
  });

  it('moves neither a suspended nor a queued session of the agent, and counts neither as pending', async () => {
    const { own, second } = seedMidTurnAgent();
    register();
    addSession({ id: 's-run', taskId: 't-run', agentName: 'move-agent', accountId: own.id });
    addSession({ id: 's-suspended', taskId: 't-suspended', agentName: 'move-agent', accountId: own.id, status: 'suspended' });
    addSession({ id: 's-queued', taskId: 't-queued', agentName: 'move-agent', accountId: own.id, status: 'queued' });

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);

    expect(result).toMatchObject({ ok: true, moved: 1, pending: 0, failed: 0 });
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(hoisted.restart.mock.calls[0][3]).toBe('t-run');
  });

  it('leaves a session the usage-limit continuation is deciding pending on Switch to', async () => {
    hoisted.adapters = {
      'move-agent': adapterFor('move-agent', { isUsageLimitFailure: () => true }),
    };
    const { own, second } = seedAccounts('move-agent');
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: own.id });
    // The continuation's read of the account never settles, so it keeps deciding the session.
    let finishRead: () => void = () => undefined;
    hoisted.refresher.refreshAccount.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishRead = () => resolve(undefined); }));
    fail('s1', 'usage limit reached');
    await expect.poll(() => hoisted.refresher.refreshAccount.mock.calls.length).toBe(1);

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, second.id);
    expect(result).toMatchObject({ ok: true, moved: 0, pending: 1, failed: 0 });
    expect(hoisted.restart).not.toHaveBeenCalled();
    finishRead();
  });
});

describe('moving running sessions: following Automatic order', () => {
  const OWN_EMAIL = 'own@example.test';

  function followingPushes(): unknown[][] {
    return vi.mocked(sendToRenderer).mock.calls.filter((call) => call[1] === IPC.ACCOUNTS_FOLLOWING);
  }

  /** Two accounts under Automatic, the agent's own login's week resetting first; a working session on the other. */
  function seedFollowingWorkingSession(): { own: AgentAccount; second: AgentAccount } {
    hoisted.adapters = { 'move-agent': { ...(adapterFor('move-agent') as object), reportsRateLimits: true } };
    hoisted.accountsConfig = { orderMode: 'automatic', autoSwitchAtLimit: true };
    const accounts = seedAccounts('move-agent');
    repository.updateIdentity(accounts.own.id, { email: OWN_EMAIL, orgId: null, plan: null, status: 'ok' });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const weekly = (resetsInSeconds: number, usedPercentage: number) => ({
      id: 'seven-day', label: '7d weekly', iconKind: 'period' as const, usedPercentage, resetsAt: nowSeconds + resetsInSeconds, windowDurationSeconds: 604_800,
    });
    repository.updateUsage(accounts.own.id, [weekly(86_400, 86)]);
    repository.updateUsage(accounts.second.id, [weekly(6 * 86_400, 5)]);
    vi.mocked(sendToRenderer).mockClear();
    register();
    addSession({ id: 's1', taskId: 't1', agentName: 'move-agent', accountId: accounts.second.id });
    hoisted.activity.s1 = 'thinking';
    return accounts;
  }

  function readSettled(): () => void {
    const options = vi.mocked(AccountUsageRefresher).mock.calls.at(-1)?.[1] as { onReadSettled?: () => void } | undefined;
    if (!options?.onReadSettled) throw new Error('registration gave the refresher no onReadSettled');
    return options.onReadSettled;
  }

  it('pushes exactly the agent and the account\'s name when the top account changes', async () => {
    seedFollowingWorkingSession();

    readSettled()();

    await vi.waitFor(() => expect(followingPushes()).toHaveLength(1));
    expect(followingPushes()[0][2]).toEqual({ agent: 'move-agent', accountName: OWN_EMAIL });
  });

  it('sends no following push for a Switch to that leaves sessions pending', async () => {
    const { own } = seedFollowingWorkingSession();

    const result = await invoke(IPC.ACCOUNTS_SWITCH_TO, own.id);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ ok: true, pending: 1 });
    expect(followingPushes()).toHaveLength(0);
  });

  it('cancels the move Automatic asked for when the order goes to Manual: the session stays put when it goes idle', async () => {
    seedFollowingWorkingSession();
    readSettled()();
    await vi.waitFor(() => expect(followingPushes()).toHaveLength(1));

    hoisted.accountsConfig = { orderMode: 'manual', autoSwitchAtLimit: true };
    noteAccountsConfigChanged();
    hoisted.activity.s1 = 'idle';
    sessionManager.emit('activity', 's1', 'idle');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  it('keeps the move Switch to asked for when the order goes to Manual: the session moves when it goes idle', async () => {
    const { own } = seedFollowingWorkingSession();
    readSettled()();
    await vi.waitFor(() => expect(followingPushes()).toHaveLength(1));
    // Switch to names the same account, so the pending move now belongs to it, not to Automatic.
    expect(await invoke(IPC.ACCOUNTS_SWITCH_TO, own.id)).toMatchObject({ pending: 1 });

    hoisted.accountsConfig = { orderMode: 'manual', autoSwitchAtLimit: true };
    noteAccountsConfigChanged();
    hoisted.activity.s1 = 'idle';
    sessionManager.emit('activity', 's1', 'idle');

    await vi.waitFor(() => expect(hoisted.restart).toHaveBeenCalledTimes(1));
    expect(hoisted.restart.mock.calls[0][4]).toMatchObject({ accountId: own.id });
  });
});
