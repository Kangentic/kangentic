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
const { EventType } = await import('../../src/shared/types');

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
  hoisted.restart.mockReset();
  hoisted.restart.mockImplementation(async (_context: unknown, _projectId: string, _path: string, taskId: string, options: { accountId: string }) => {
    const live = hoisted.sessions.find((session) => session.taskId === taskId && session.status === 'running' && !session.transient);
    if (live) live.accountId = options.accountId;
    return { ok: true };
  });
  sessionManager = Object.assign(new EventEmitter(), {
    listSessions: () => hoisted.sessions,
    getSessionAgentName: (sessionId: string) => hoisted.sessions.find((session) => session.id === sessionId)?.agentName,
    getActivityCache: () => ({}),
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
