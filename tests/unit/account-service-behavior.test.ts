/**
 * AccountService behaviors that each have a way to go wrong silently: the sign-in outcomes, the
 * status a refresh reaches, the folder a new account gets, what is stored of a key file, the order
 * a switch keeps, what a card says, how a spawn passes over an account it cannot prepare, and what
 * counts as a usage change. Real in-memory SQLite and real temp folders, a stub adapter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountService, type AccountServiceDependencies } from '../../src/main/accounts/account-service';
import {
  UnreadableUsageError,
  type AccountIdentity,
  type FolderAccountSupport,
  type KeyFileAccountSupport,
} from '../../src/main/accounts/account-support';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';
import type { AgentAccountsConfig } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const AGENT = 'test-agent';
const SIGNED_OUT: AccountIdentity = { signedIn: false, email: null, plan: 'free', hasSubscription: null };

type ReportArguments = Parameters<NonNullable<AccountServiceDependencies['reportProblem']>>;

let root: string;
let home: string;
let database: Database.Database;
let repository: AgentAccountRepository;
let config: AgentAccountsConfig;
let configWrites: AgentAccountsConfig[];
let changeCount: number;
let reports: ReportArguments[];
let identity: AccountIdentity;
let identifyCalls: Array<string | null>;
let defaultHomeCalls: number;
let folderCounter: number;

function folderSupport(overrides: Partial<FolderAccountSupport> = {}): FolderAccountSupport {
  return {
    kind: 'folder',
    accountEnv: (accountFolder) => ({ TEST_AGENT_HOME: accountFolder }),
    defaultHome: () => {
      defaultHomeCalls += 1;
      return home;
    },
    loginArgs: ['login'],
    sharedEntries: [{ name: 'projects', how: 'link-dir', conversationBearing: true }],
    identify: async (_cliPath, folder) => {
      identifyCalls.push(folder);
      return identity;
    },
    overridingCredentialEnvVars: [],
    ...overrides,
  };
}

function keyFileSupport(): KeyFileAccountSupport {
  return { kind: 'key-file', keyEnvVars: ['OPENROUTER_API_KEY'], overridingCredentialEnvVars: [] };
}

function adapterOf(name: string, accounts?: FolderAccountSupport | KeyFileAccountSupport, extra: object = {}): AgentAdapter {
  return { name, accounts, ...extra } as unknown as AgentAdapter;
}

function makeService(adapters: Record<string, AgentAdapter>, overrides: Partial<AccountServiceDependencies> = {}): AccountService {
  return new AccountService({
    repository,
    getAdapter: (agent) => adapters[agent],
    listAdapters: () => Object.values(adapters),
    configDir: path.join(root, 'config'),
    readConfig: () => config,
    writeConfig: (next) => {
      config = next;
      configWrites.push(next);
    },
    onChanged: () => {
      changeCount += 1;
    },
    reportProblem: (...reportArguments) => {
      reports.push(reportArguments);
    },
    resolveCliPath: async () => '/usr/bin/test-cli',
    now: () => NOW_MS,
    ...overrides,
  });
}

function folderService(support: FolderAccountSupport = folderSupport(), overrides: Partial<AccountServiceDependencies> = {}): AccountService {
  return makeService({ [AGENT]: adapterOf(AGENT, support) }, overrides);
}

/** A folder account row whose folder is outside the default home. */
function insertFolderAccount(status: 'ok' | 'signed-out' | 'link-failed' = 'ok', email: string | null = null, plan: string | null = null) {
  folderCounter += 1;
  return repository.insert({
    agent: AGENT,
    kind: 'folder',
    folderPath: path.join(root, 'config', 'accounts', AGENT, `row-${folderCounter}`),
    status,
    email,
    plan,
  });
}

function sevenDay(usedPercentage: number, resetsAt: number): RateLimitWindow {
  return { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt, windowDurationSeconds: 604_800 };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-behavior-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
  config = { orderMode: 'manual', autoSwitchAtLimit: true };
  configWrites = [];
  changeCount = 0;
  reports = [];
  identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: true };
  identifyCalls = [];
  defaultHomeCalls = 0;
  folderCounter = 0;
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AccountService.completeLogin', () => {
  it('deletes a row that never had an email when the sign-in ended signed out', async () => {
    identity = SIGNED_OUT;
    const accountService = folderService();
    const created = await accountService.createFolderAccount(AGENT);
    const result = await accountService.completeLogin(created!.id);
    expect(result).toEqual({ account: null, duplicateOf: null });
    expect(repository.getById(created!.id)).toBeNull();
    expect(repository.listForAgent(AGENT).map((account) => account.kind)).toEqual(['default']);
  });

  it('keeps a row that had an email when its sign-in ended signed out', async () => {
    identity = SIGNED_OUT;
    const row = insertFolderAccount('ok', 'dev@example.com', 'pro');
    const result = await folderService().completeLogin(row.id);
    expect(result.duplicateOf).toBeNull();
    expect(result.account?.id).toBe(row.id);
    expect(result.account?.status).toBe('signed-out');
    expect(repository.getById(row.id)).not.toBeNull();
  });

  it('deletes the new row and names the existing one when the email matches another row, ignoring case', async () => {
    const existing = insertFolderAccount('ok', 'Dev@Example.com', 'pro');
    const accountService = folderService();
    const created = await accountService.createFolderAccount(AGENT);
    identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: true };
    const result = await accountService.completeLogin(created!.id);
    expect(result.account).toBeNull();
    expect(result.duplicateOf?.id).toBe(existing.id);
    expect(repository.getById(created!.id)).toBeNull();
    expect(repository.getById(existing.id)).not.toBeNull();
  });

  it('keeps a row that already had an email even when another row shares it', async () => {
    const first = insertFolderAccount('ok', 'dev@example.com', 'pro');
    const second = insertFolderAccount('ok', 'dev@example.com', 'pro');
    const result = await folderService().completeLogin(second.id);
    expect(result.account?.id).toBe(second.id);
    expect(result.duplicateOf).toBeNull();
    expect(repository.getById(second.id)).not.toBeNull();
    expect(repository.getById(first.id)).not.toBeNull();
  });
});

describe('AccountService.refreshIdentity', () => {
  it('reports link-failed even when the CLI says the account is signed in', async () => {
    const row = insertFolderAccount('ok');
    fs.mkdirSync(row.folderPath!, { recursive: true });
    fs.writeFileSync(path.join(row.folderPath!, 'projects'), 'a file where the link must go');
    const refreshed = await folderService().refreshIdentity(row.id);
    expect(refreshed?.status).toBe('link-failed');
  });

  it('is signed-out when the CLI says so, and keeps the email and plan the row had', async () => {
    identity = SIGNED_OUT;
    const row = insertFolderAccount('ok', 'dev@example.com', 'pro');
    const refreshed = await folderService().refreshIdentity(row.id);
    expect(refreshed).toMatchObject({ status: 'signed-out', email: 'dev@example.com', plan: 'pro' });
  });

  it('is no-subscription only when the CLI says there is none, and ok when it says yes or cannot tell', async () => {
    const row = insertFolderAccount('signed-out');
    const accountService = folderService();
    identity = { signedIn: true, email: 'dev@example.com', plan: null, hasSubscription: false };
    expect((await accountService.refreshIdentity(row.id))?.status).toBe('no-subscription');
    identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: true };
    expect((await accountService.refreshIdentity(row.id))?.status).toBe('ok');
    identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: null };
    expect((await accountService.refreshIdentity(row.id))?.status).toBe('ok');
  });

  it('stores the email and plan a signed-in answer carries', async () => {
    const row = insertFolderAccount('signed-out');
    identity = { signedIn: true, email: 'new@example.com', plan: 'max', hasSubscription: true };
    expect(await folderService().refreshIdentity(row.id)).toMatchObject({ email: 'new@example.com', plan: 'max', status: 'ok' });
  });

  it('identifies the default account with no folder path and never refreshes a folder for it', async () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const refreshed = await accountService.refreshIdentity(own.id);
    expect(identifyCalls).toEqual([null]);
    // A folder refresh on a row with no folder fails, so an ok status shows it never ran.
    expect(refreshed?.status).toBe('ok');
    expect(defaultHomeCalls).toBe(0);
  });

  it('leaves a folder account alone, and never asks the CLI, when the CLI runs on a remote target', async () => {
    const row = insertFolderAccount('signed-out', 'dev@example.com', 'pro');
    const accountService = folderService(folderSupport(), { usesRemoteTarget: async () => true });
    const refreshed = await accountService.refreshIdentity(row.id);
    expect(identifyCalls).toEqual([]);
    expect(refreshed).toEqual(row);
    expect(changeCount).toBe(0);
  });
});

describe('AccountService.createFolderAccount', () => {
  it('inserts a signed-out folder row at the bottom and makes sure the default row exists', async () => {
    const created = await folderService().createFolderAccount(AGENT);
    expect(created).toMatchObject({ kind: 'folder', status: 'signed-out' });
    expect(fs.statSync(created!.folderPath!).isDirectory()).toBe(true);
    const rows = repository.listForAgent(AGENT);
    expect(rows.map((account) => account.kind)).toEqual(['default', 'folder']);
    expect(rows[1].id).toBe(created!.id);
  });

  it('gives two overlapping calls two different folders', async () => {
    const accountService = folderService();
    const [first, second] = await Promise.all([accountService.createFolderAccount(AGENT), accountService.createFolderAccount(AGENT)]);
    expect(first!.folderPath).not.toBe(second!.folderPath);
    expect(repository.listForAgent(AGENT).filter((account) => account.kind === 'folder')).toHaveLength(2);
  });
});

describe('AccountService.addKeyFileAccount', () => {
  const secret = 'sk-live-secret-value';

  function keyFileService(): AccountService {
    return makeService({ [AGENT]: adapterOf(AGENT, keyFileSupport()) });
  }

  it('refuses an agent whose accounts are folders', () => {
    expect(folderService().addKeyFileAccount(AGENT, path.join(root, 'work.env'))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses a file that cannot be read', () => {
    expect(keyFileService().addKeyFileAccount(AGENT, path.join(root, 'gone.env'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('stores the key names and never a value', () => {
    const keyFile = path.join(root, 'work.env');
    fs.writeFileSync(keyFile, `export OPENROUTER_API_KEY="${secret}"\nUNRELATED=1\n`);
    const result = keyFileService().addKeyFileAccount(AGENT, keyFile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.keyNames).toEqual(['OPENROUTER_API_KEY']);
    expect(result.account.keyFilePath).toBe(path.resolve(keyFile));
    expect(JSON.stringify(database.prepare('SELECT * FROM agent_accounts').all())).not.toContain(secret);
    expect(changeCount).toBe(1);
  });

  it('refuses the same file a second time, by resolved path', () => {
    const keyFile = path.join(root, 'work.env');
    fs.writeFileSync(keyFile, `OPENROUTER_API_KEY=${secret}\n`);
    fs.mkdirSync(path.join(root, 'nested'));
    const accountService = keyFileService();
    expect(accountService.addKeyFileAccount(AGENT, keyFile).ok).toBe(true);
    const sameFile = `${root}${path.sep}nested${path.sep}..${path.sep}work.env`;
    expect(accountService.addKeyFileAccount(AGENT, sameFile)).toEqual({ ok: false, reason: 'duplicate' });
    expect(repository.listForAgent(AGENT)).toHaveLength(1);
  });
});

describe('AccountService.remove, reorder and switchTo', () => {
  it('refuses to remove the default row', () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    expect(accountService.remove(own.id)).toBe(false);
    expect(repository.getById(own.id)).not.toBeNull();
    expect(changeCount).toBe(0);
  });

  it('removes a folder account row and leaves its folder on disk', async () => {
    const accountService = folderService();
    const created = await accountService.createFolderAccount(AGENT);
    expect(accountService.remove(created!.id)).toBe(true);
    expect(repository.getById(created!.id)).toBeNull();
    expect(fs.existsSync(created!.folderPath!)).toBe(true);
  });

  it('sets the config to Manual on a drag, writing once, and keeps the other setting', () => {
    config = { orderMode: 'automatic', autoSwitchAtLimit: false };
    const first = insertFolderAccount();
    const second = insertFolderAccount();
    const accountService = folderService();
    accountService.reorder(AGENT, [second.id, first.id]);
    expect(repository.listForAgent(AGENT).map((account) => account.id)).toEqual([second.id, first.id]);
    expect(configWrites).toEqual([{ orderMode: 'manual', autoSwitchAtLimit: false }]);
    accountService.reorder(AGENT, [first.id, second.id]);
    expect(configWrites).toHaveLength(1);
  });

  it('switches from the order on screen under Automatic, and sets Manual', () => {
    config = { orderMode: 'automatic', autoSwitchAtLimit: true };
    const stored1 = insertFolderAccount();
    const stored2 = insertFolderAccount();
    const stored3 = insertFolderAccount();
    repository.updateUsage(stored1.id, [sevenDay(10, NOW + 5 * 86_400)]);
    repository.updateUsage(stored3.id, [sevenDay(10, NOW + 86_400)]);
    const accountService = folderService();
    // On screen: soonest reset first, an account with no reading last.
    expect(accountService.ordered(AGENT).map((account) => account.id)).toEqual([stored3.id, stored1.id, stored2.id]);
    expect(accountService.switchTo(stored2.id)).toBe(true);
    expect(repository.listForAgent(AGENT).map((account) => account.id)).toEqual([stored2.id, stored3.id, stored1.id]);
    expect(configWrites).toEqual([{ orderMode: 'manual', autoSwitchAtLimit: true }]);
  });

  it('refuses to switch to an account whose status is not ok', () => {
    const first = insertFolderAccount();
    const signedOut = insertFolderAccount('signed-out');
    expect(folderService().switchTo(signedOut.id)).toBe(false);
    expect(repository.listForAgent(AGENT).map((account) => account.id)).toEqual([first.id, signedOut.id]);
    expect(configWrites).toEqual([]);
    expect(changeCount).toBe(0);
  });
});

describe('AccountService.cards', () => {
  it('builds one card per installed agent that declares accounts, with the flags the tab reads', async () => {
    const adapters: Record<string, AgentAdapter> = {
      'folder-full': adapterOf('folder-full', folderSupport({
        readIdleUsage: async () => null,
        loginIsInteractive: true,
        conversationsStayOnAccount: true,
        overridingCredentialEnvVars: ['TEST_TOKEN', 'TEST_BLANK', 'TEST_UNSET'],
      })),
      'folder-plain': adapterOf('folder-plain', folderSupport()),
      'key-file-agent': adapterOf('key-file-agent', keyFileSupport(), { reportsRateLimits: true }),
      'no-accounts': adapterOf('no-accounts'),
      'not-installed': adapterOf('not-installed', folderSupport()),
    };
    const accountService = makeService(adapters, {
      resolveCliPath: async (agent) => (agent === 'not-installed' ? null : '/usr/bin/test-cli'),
      usesRemoteTarget: async (agent) => agent === 'folder-plain',
      environment: () => ({ TEST_TOKEN: 'abc', TEST_BLANK: '   ' }),
    });
    // The plain agent's own login is full, so the card's active account is its second one.
    const plainOwn = accountService.ensureDefaultAccount('folder-plain')!;
    repository.updateUsage(plainOwn.id, [sevenDay(100, NOW + 3600)]);
    const plainSecond = repository.insert({ agent: 'folder-plain', kind: 'folder', folderPath: path.join(root, 'plain-2') });

    const cards = await accountService.cards();
    expect(cards.map((card) => card.agent)).toEqual(['folder-full', 'folder-plain', 'key-file-agent']);
    const [full, plain, keyFile] = cards;

    expect(full).toMatchObject({
      kind: 'folder',
      reportsUsage: true,
      signInIsInteractive: true,
      switchMovesSessions: false,
      overrides: [{ variable: 'TEST_TOKEN', source: 'environment' }],
      unsupportedTarget: false,
    });
    expect(plain).toMatchObject({
      reportsUsage: false,
      signInIsInteractive: false,
      switchMovesSessions: true,
      overrides: [],
      unsupportedTarget: true,
      activeAccountId: plainSecond.id,
    });
    expect(keyFile).toMatchObject({ kind: 'key-file', reportsUsage: true, signInIsInteractive: false, switchMovesSessions: true });
    // The agent whose CLI is not found gets no card and no default row.
    expect(repository.listForAgent('not-installed')).toEqual([]);
  });
});

describe('AccountService.resolveForSpawn', () => {
  it('refreshes an account named by the conversation, the top and the ok list once', async () => {
    let provisions = 0;
    const accountService = folderService(folderSupport({
      conversationsStayOnAccount: true,
      sharedEntries: [
        { name: 'projects', how: 'link-dir', conversationBearing: true },
        // Runs once per provision of a folder account, which makes provisions countable.
        { name: 'probe', how: 'text', text: () => { provisions += 1; return null; } },
      ],
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const second = insertFolderAccount();
    fs.mkdirSync(second.folderPath!, { recursive: true });
    fs.writeFileSync(path.join(second.folderPath!, 'projects'), 'a file where the link must go');
    repository.reorder(AGENT, [second.id, own.id]);

    const resolved = await accountService.resolveForSpawn(AGENT, undefined, second.id);
    expect(resolved).toEqual({ id: own.id, agent: AGENT, kind: 'default', env: {} });
    expect(provisions).toBe(1);
    expect(repository.getById(second.id)?.status).toBe('link-failed');
  });

  it('passes over a candidate whose folder refresh throws and takes the next account', async () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    // Inside the default home, which provisioning refuses.
    const bad = repository.insert({ agent: AGENT, kind: 'folder', folderPath: path.join(home, 'bad-account') });
    const good = insertFolderAccount();
    repository.reorder(AGENT, [bad.id, good.id, own.id]);

    const resolved = await accountService.resolveForSpawn(AGENT);
    expect(resolved).toEqual({ id: good.id, agent: AGENT, kind: 'folder', env: { TEST_AGENT_HOME: good.folderPath } });
    expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['spawn-account-unresolved', AGENT, { threw: true, kind: 'folder' }]]);
  });

  it('resolves to the default row with an empty env, and reports, when the named account is signed out', async () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const signedOut = insertFolderAccount('signed-out');
    const resolved = await accountService.resolveForSpawn(AGENT, signedOut.id);
    expect(resolved).toEqual({ id: own.id, agent: AGENT, kind: 'default', env: {} });
    expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['spawn-account-unresolved', AGENT, { accounts: 2, named: true }]]);
  });

  it('resolves to the default row with an empty env, and reports, when the named account cannot be prepared', async () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const broken = insertFolderAccount();
    fs.mkdirSync(broken.folderPath!, { recursive: true });
    fs.writeFileSync(path.join(broken.folderPath!, 'projects'), 'a file where the link must go');
    const resolved = await accountService.resolveForSpawn(AGENT, broken.id);
    expect(resolved).toEqual({ id: own.id, agent: AGENT, kind: 'default', env: {} });
    // The folder's own problem is reported too; the unresolved spawn is the last report.
    expect(reports.map((entry) => entry.slice(0, 3)).at(-1)).toEqual(['spawn-account-unresolved', AGENT, { accounts: 2, named: true }]);
  });
});

describe('AccountService.recordUsage', () => {
  it('writes only when the whole percent, the full state or the reset changes', () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const report = (usedPercentage: number, resetsAt = NOW + 86_400): string[] =>
      accountService.recordUsage([{ ...sevenDay(usedPercentage, resetsAt), accountId: own.id }]);
    const stored = (): number | undefined => repository.getById(own.id)?.lastUsage?.[0].usedPercentage;

    expect(report(40.2)).toEqual([own.id]);
    expect(changeCount).toBe(1);

    // A fraction of a percent: no write, no change.
    expect(report(40.4)).toEqual([]);
    expect(stored()).toBe(40.2);
    expect(changeCount).toBe(1);

    // The whole percent moves.
    expect(report(40.6)).toEqual([own.id]);
    expect(stored()).toBe(40.6);
    expect(changeCount).toBe(2);

    // Rounds to 100 both times and neither is full: nothing.
    expect(report(99.6)).toEqual([own.id]);
    expect(report(99.8)).toEqual([]);
    expect(stored()).toBe(99.6);

    // Crossing 100 keeps the rounded percent the same and still writes.
    expect(report(100)).toEqual([own.id]);
    expect(stored()).toBe(100);

    // The same percent with a new reset time.
    expect(report(100, NOW + 90_000)).toEqual([own.id]);
    expect(repository.getById(own.id)?.lastUsage?.[0].resetsAt).toBe(NOW + 90_000);
  });
});

describe('AccountService.refreshUsage', () => {
  it('returns false and reports when the CLI answered in a shape the adapter does not know', async () => {
    const readIdleUsage = vi.fn(async (): Promise<RateLimitWindow[] | null> => { throw new UnreadableUsageError('alpha,beta'); });
    const accountService = folderService(folderSupport({ readIdleUsage }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    expect(await accountService.refreshUsage(own.id)).toBe(false);
    expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['usage-read-unreadable', AGENT, { keys: 'alpha,beta' }]]);
    expect(repository.getById(own.id)?.lastUsage).toBeNull();
  });

  it('stores the windows a good read returns', async () => {
    const readIdleUsage = vi.fn(async (): Promise<RateLimitWindow[] | null> => [sevenDay(12, NOW + 3600)]);
    const accountService = folderService(folderSupport({ readIdleUsage }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    expect(await accountService.refreshUsage(own.id)).toBe(true);
    expect(repository.getById(own.id)?.lastUsage?.[0].usedPercentage).toBe(12);
  });

  it('does nothing for a key-file, signed-out or not-found account, or an unknown id', async () => {
    const readIdleUsage = vi.fn(async (): Promise<RateLimitWindow[] | null> => [sevenDay(1, NOW + 3600)]);
    const accountService = folderService(folderSupport({ readIdleUsage }));
    const keyFile = repository.insert({ agent: AGENT, kind: 'key-file', keyFilePath: path.join(root, 'work.env') });
    const signedOut = insertFolderAccount('signed-out');
    const notFound = insertFolderAccount('ok');
    repository.updateStatus(notFound.id, 'not-found');
    for (const id of [keyFile.id, signedOut.id, notFound.id, 'no-such-account']) {
      expect(await accountService.refreshUsage(id)).toBe(false);
    }
    expect(readIdleUsage).not.toHaveBeenCalled();
  });

  it('returns false without reading when the CLI runs on a remote target', async () => {
    const readIdleUsage = vi.fn(async (): Promise<RateLimitWindow[] | null> => [sevenDay(1, NOW + 3600)]);
    const row = insertFolderAccount('ok');
    const accountService = folderService(folderSupport({ readIdleUsage }), { usesRemoteTarget: async () => true });
    expect(await accountService.refreshUsage(row.id)).toBe(false);
    expect(readIdleUsage).not.toHaveBeenCalled();
  });
});

describe('AccountService.envsForBackgroundStop', () => {
  it('puts the agent own login first for an unknown account even when no default row exists', () => {
    const row = insertFolderAccount();
    const accountService = folderService();
    expect(accountService.envsForBackgroundStop(AGENT, 'gone')).toEqual([undefined, { TEST_AGENT_HOME: row.folderPath }]);
  });

  it('skips an account whose env cannot be built', () => {
    const accountService = makeService({ [AGENT]: adapterOf(AGENT, keyFileSupport()) });
    const keyFile = path.join(root, 'work.env');
    fs.writeFileSync(keyFile, 'OPENROUTER_API_KEY=sk-test\n');
    repository.insert({ agent: AGENT, kind: 'key-file', keyFilePath: keyFile, keyNames: ['OPENROUTER_API_KEY'] });
    repository.insert({ agent: AGENT, kind: 'key-file', keyFilePath: path.join(root, 'gone.env') });
    expect(accountService.envsForBackgroundStop(AGENT, null)).toEqual([undefined, { OPENROUTER_API_KEY: 'sk-test' }]);
  });
});
