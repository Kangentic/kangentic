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
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { hoisted.handlers.set(channel, handler); }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { hoisted.handlers.set(channel, handler); }),
  },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../src/main/db/database', () => ({ getGlobalDb: () => hoisted.database }));
vi.mock('../../src/main/config/paths', () => ({ PATHS: { get configDir() { return hoisted.configDir; } } }));
vi.mock('../../src/main/accounts/account-report', () => ({
  reportAccountProblem: hoisted.report,
  scrubFailureDetail: (detail: string) => detail,
}));
vi.mock('../../src/main/accounts/account-login', () => ({ AccountLoginRunner: vi.fn(function () { return hoisted.runner; }) }));
vi.mock('../../src/main/accounts/account-usage', () => ({ AccountUsageRefresher: vi.fn(function () { return hoisted.refresher; }) }));
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
const { setAccountService } = await import('../../src/main/accounts/account-service');
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
  });
});

function register(): void {
  const context = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    sessionManager,
    projectRepo: { getById: () => ({ path: path.join(root, 'project') }) },
    configManager: {
      load: () => ({ agent: { accounts: hoisted.accountsConfig, cliPaths: {} } }),
      save: (patch: { agent: { accounts: typeof hoisted.accountsConfig } }) => { hoisted.accountsConfig = patch.agent.accounts; },
    },
  } as unknown as IpcContext;
  registerAccountHandlers(context);
}

afterEach(() => {
  vi.useRealTimers();
  stopAccounts();
  setAccountService(null);
  hoisted.database?.close();
  fs.rmSync(root, { recursive: true, force: true });
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
    expect(hoisted.report).toHaveBeenCalledWith('turn-failed-after-move', 'move-agent', { detail: 'something broke' }, undefined);
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
    expect(hoisted.report).toHaveBeenCalledWith('conversation-refused', 'move-agent', { detail: 'conversation refused for this account' }, undefined);
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
});
