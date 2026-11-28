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
import { accountsReporter } from '../../src/main/accounts/account-report';
import { AccountService, type AccountServiceDependencies } from '../../src/main/accounts/account-service';
import {
  EmptyUsageReadError,
  IdentityReadError,
  UnreadableUsageError,
  type AccountIdentity,
  type FolderAccountSupport,
  type KeyFileAccountSupport,
} from '../../src/main/accounts/account-support';
import { dropInheritedAccountHomes, resetInheritedAccountHomes } from '../../src/main/accounts/inherited-home-env';
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
    homeEnvVars: ['TEST_AGENT_HOME'],
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

  // The incident: one `auth status` run that timed out on a busy machine marked the agent's own
  // login signed out, Automatic put it last, and no scheduled pass set it back for two days.
  it('keeps the status, email and plan when the CLI gives no answer', async () => {
    const accountService = folderService(folderSupport({
      identify: async () => { throw new IdentityReadError('run-failed'); },
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    repository.updateIdentity(own.id, { email: 'dev@example.com', plan: 'pro', status: 'ok' });
    const refreshed = await accountService.refreshIdentity(own.id);
    expect(refreshed).toMatchObject({ status: 'ok', email: 'dev@example.com', plan: 'pro' });
  });

  // Sentry DESKTOP-60: one `auth status` run that timed out on a host out of memory was reported
  // as a defect, with nothing to say how the run ended. A usage read's failed run already waits
  // for a second in a row; a sign-in read now does too, and says how it ended.
  describe('reporting a sign-in read that gave no answer', () => {
    const timedOut = (): IdentityReadError => new IdentityReadError('run-failed', {
      cause: Object.assign(new Error('Command failed'), { killed: true }),
      runFailure: { kind: 'timeout', exitCode: null },
    });

    function serviceWith(identify: FolderAccountSupport['identify']): AccountService {
      return folderService(folderSupport({ identify }), { resolveCliVersion: async () => '2.1.300' });
    }

    it('sends nothing for one failed run, and from the second in a row says how it ended', async () => {
      const accountService = serviceWith(async () => { throw timedOut(); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      expect(reports).toEqual([]);
      await accountService.refreshIdentity(own.id);
      expect(reports).toHaveLength(1);
      const [problem, agent, facts, error, tags] = reports[0];
      expect([problem, agent, facts]).toEqual(['identity-read-failed', AGENT, { kind: 'default', reason: 'run-failed' }]);
      // The run's own rejection, so the report's cause context gets its class and errno.
      expect(error).toBeInstanceOf(Error);
      expect((error as { killed?: unknown }).killed).toBe(true);
      expect(tags).toEqual({ run_failure: 'timeout', agent_cli_version: '2.1.300' });
    });

    it('starts the count again after a read that answers', async () => {
      let fails = true;
      const accountService = serviceWith(async () => {
        if (fails) throw timedOut();
        return identity;
      });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      fails = false;
      await accountService.refreshIdentity(own.id);
      fails = true;
      await accountService.refreshIdentity(own.id);
      expect(reports.filter(([problem]) => problem === 'identity-read-failed')).toEqual([]);
    });

    it('names the exit code of a run that exited with no answer', async () => {
      const accountService = serviceWith(async () => {
        throw new IdentityReadError('run-failed', { runFailure: { kind: 'exit_code', exitCode: 127 } });
      });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      expect(reports.map((entry) => entry[4])).toEqual([{ run_failure: 'exit_code', run_exit: '127', agent_cli_version: '2.1.300' }]);
    });

    // A CLI that printed something we cannot parse changed its format: that is a defect at once.
    it('reports an unreadable answer on the first read', async () => {
      const accountService = serviceWith(async () => { throw new IdentityReadError('unreadable'); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['identity-read-failed', AGENT, { kind: 'default', reason: 'unreadable' }]]);
      // A format change has no run to describe: no error and no run tags.
      expect(reports[0][3]).toBeUndefined();
      expect(reports[0][4]).toBeUndefined();
    });

    it('starts the count again after an unreadable read between two failed runs', async () => {
      const outcomes: Array<'run-failed' | 'unreadable'> = ['run-failed', 'unreadable', 'run-failed'];
      const accountService = serviceWith(async () => { throw new IdentityReadError(outcomes.shift()!); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      expect(reports.map((entry) => entry[2])).toEqual([{ kind: 'default', reason: 'unreadable' }]);
    });

    it('counts the streak per account', async () => {
      const accountService = serviceWith(async () => { throw timedOut(); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      const folder = insertFolderAccount('ok');
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(folder.id);
      expect(reports).toEqual([]);
      await accountService.refreshIdentity(folder.id);
      expect(reports.map((entry) => entry[2])).toEqual([{ kind: 'folder', reason: 'run-failed' }]);
    });

    it('reports every failed run from the second in a row on, not only the second', async () => {
      const accountService = serviceWith(async () => { throw timedOut(); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      expect(reports.filter(([problem]) => problem === 'identity-read-failed')).toHaveLength(2);
    });

    it('reports a failed run that carries no detail with unknown as how it ended', async () => {
      const bare = new IdentityReadError('run-failed');
      expect(bare.runFailure).toBeNull();
      expect(bare.cause).toBeUndefined();
      const accountService = serviceWith(async () => { throw new IdentityReadError('run-failed'); });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshIdentity(own.id);
      await accountService.refreshIdentity(own.id);
      expect(reports).toHaveLength(1);
      expect(reports[0][3]).toBeUndefined();
      expect(reports[0][4]).toEqual({ run_failure: 'unknown', agent_cli_version: '2.1.300' });
    });

    // The sign-in streak and the usage streak are separate counts. A failed usage run does not add
    // to the sign-in count, a usage read that answers does not start it again, and a failed sign-in
    // run does not add to the usage count.
    it('counts sign-in reads apart from the usage reads between them', async () => {
      const usageOutcomes: Array<'answers' | 'run-failed'> = ['run-failed', 'answers', 'run-failed'];
      const accountService = folderService(folderSupport({
        identify: async () => { throw timedOut(); },
        readIdleUsage: async () => {
          if (usageOutcomes.shift() === 'answers') return [sevenDay(1, NOW + 86_400)];
          throw new EmptyUsageReadError('run-failed', { runFailure: { kind: 'timeout', exitCode: null } });
        },
      }), { resolveCliVersion: async () => '2.1.300' });
      const own = accountService.ensureDefaultAccount(AGENT)!;
      await accountService.refreshUsage(own.id);
      await accountService.refreshIdentity(own.id);
      expect(reports).toEqual([]);
      await accountService.refreshUsage(own.id);
      await accountService.refreshIdentity(own.id);
      await accountService.refreshUsage(own.id);
      expect(usageOutcomes).toEqual([]);
      expect(reports.map(([problem, , facts]) => [problem, facts])).toEqual([
        ['identity-read-failed', { kind: 'default', reason: 'run-failed' }],
      ]);
    });

    it('counts two reads that ran at the same time as one failure', async () => {
      const pending: Array<{ reject: (error: Error) => void }> = [];
      const accountService = serviceWith(() => new Promise<AccountIdentity>((_resolve, reject) => { pending.push({ reject }); }));
      const own = accountService.ensureDefaultAccount(AGENT)!;
      const first = accountService.refreshIdentity(own.id);
      const second = accountService.refreshIdentity(own.id);
      await expect.poll(() => pending.length).toBe(2);
      pending.forEach((read) => read.reject(timedOut()));
      await Promise.all([first, second]);
      expect(reports).toEqual([]);
      const third = accountService.refreshIdentity(own.id);
      await expect.poll(() => pending.length).toBe(3);
      pending[2].reject(timedOut());
      await third;
      expect(reports).toHaveLength(1);
    });
  });

  it('still throws an identify failure it does not know', async () => {
    const accountService = folderService(folderSupport({
      identify: async () => { throw new TypeError('broken adapter'); },
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    await expect(accountService.refreshIdentity(own.id)).rejects.toThrow('broken adapter');
    expect(repository.getById(own.id)?.status).toBe('ok');
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

// Sentry DESKTOP-4S sent only the entry's name, so it could not say whether a file or a link stood
// there, where the link pointed, or which default home the run used. The new facts are fixed words.
describe('what a folder problem report carries', () => {
  const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
  /** A fact a report may carry: a flag, a count, or one token with no path separator in it. */
  const FIXED_TOKEN = /^[A-Za-z0-9._-]+$/;

  afterEach(() => {
    resetInheritedAccountHomes();
  });

  function folderProblemFacts(): Record<string, unknown> {
    const report = reports.find(([problem]) => problem === 'folder-entry-user-owned');
    expect(report).toBeDefined();
    return (report?.[2] ?? {}) as Record<string, unknown>;
  }

  function expectNoPath(facts: Record<string, unknown>): void {
    for (const value of Object.values(facts)) {
      if (typeof value === 'boolean' || typeof value === 'number') continue;
      expect(typeof value).toBe('string');
      expect(value).toMatch(FIXED_TOKEN);
    }
    expect(JSON.stringify(reports)).not.toContain(path.basename(root));
  }

  it('names a link that points elsewhere, its target as a class, and the built-in default home', async () => {
    const row = insertFolderAccount('ok');
    const elsewhere = path.join(root, 'elsewhere', 'projects');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(row.folderPath!, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(row.folderPath!, 'projects'), linkKind);
    await folderService(folderSupport(), { environment: () => ({}) }).refreshIdentity(row.id);
    const facts = folderProblemFacts();
    expect(facts).toEqual({
      entry: 'projects',
      blocksAccount: true,
      reason: 'link-elsewhere',
      shape: 'link-elsewhere',
      link_target: 'other',
      default_home: 'builtin',
    });
    expectNoPath(facts);
  });

  it('names a file where a folder goes, and a default home the agent inherited', async () => {
    const row = insertFolderAccount('ok');
    fs.mkdirSync(row.folderPath!, { recursive: true });
    fs.writeFileSync(path.join(row.folderPath!, 'projects'), 'a file where the link must go');
    const environment = { TEST_AGENT_HOME: path.join(root, 'my-own-home') };
    await folderService(folderSupport(), { environment: () => environment }).refreshIdentity(row.id);
    const facts = folderProblemFacts();
    expect(facts).toMatchObject({ entry: 'projects', reason: 'file', shape: 'file', default_home: 'inherited' });
    expect(facts.link_target).toBeUndefined();
    expectNoPath(facts);
  });

  it('says a home inherited from a Kangentic account folder was ignored, on the identity report too', async () => {
    const environment: NodeJS.ProcessEnv = { TEST_AGENT_HOME: path.join(root, 'config', 'accounts', AGENT, '2') };
    const accountService = folderService(folderSupport(), { environment: () => environment });
    expect(dropInheritedAccountHomes(environment, path.join(root, 'config', 'accounts'), [{ name: AGENT, accounts: folderSupport() }])).toEqual(['TEST_AGENT_HOME']);
    const own = accountService.ensureDefaultAccount(AGENT)!;
    repository.updateIdentity(own.id, { email: 'own@example.com', plan: 'pro', status: 'ok' });
    insertFolderAccount('ok', 'dev@example.com', 'pro');
    // The default home holds a login a folder account names: the shape of DESKTOP-4R.
    identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: true };
    await accountService.refreshIdentity(own.id);
    const changed = reports.find(([problem]) => problem === 'identity-changed');
    expect(changed?.[2]).toMatchObject({ kind: 'default', default_home: 'inherited-ignored' });
    expectNoPath((changed?.[2] ?? {}) as Record<string, unknown>);
  });
});

describe('what the service hands the folder as the homes a link may have come from', () => {
  const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

  it.each([
    ['the built-in home the adapter names', () => path.join(root, 'builtin', 'projects')],
    ['another Kangentic account folder of the config directory', () => path.join(root, 'config', 'accounts', AGENT, '9', 'projects')],
  ])('relinks a projects link into %s at the default home, with no user-owned report', async (_label, targetOf) => {
    const builtin = path.join(root, 'builtin');
    const row = insertFolderAccount('ok');
    const target = targetOf();
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(row.folderPath!, { recursive: true });
    fs.symlinkSync(target, path.join(row.folderPath!, 'projects'), linkKind);
    const support = folderSupport({ builtinHome: () => builtin });
    const refreshed = await folderService(support, { environment: () => ({}) }).refreshIdentity(row.id);
    expect(reports.filter(([problem]) => problem === 'folder-entry-user-owned')).toEqual([]);
    expect(refreshed?.status).toBe('ok');
    expect(fs.realpathSync.native(path.join(row.folderPath!, 'projects'))).toBe(fs.realpathSync.native(path.join(home, 'projects')));
    expect(fs.existsSync(target)).toBe(true);
  });

  it('carries the default home origin on the report of a re-point that threw', async () => {
    const accountService = folderService(folderSupport(), {
      environment: () => ({}),
      repointSessions: () => { throw new Error('repoint failed'); },
    });
    const own = accountService.ensureDefaultAccount(AGENT)!;
    repository.updateIdentity(own.id, { email: 'own@example.com', plan: 'pro', status: 'ok' });
    insertFolderAccount('ok', 'dev@example.com', 'pro');
    identity = { signedIn: true, email: 'dev@example.com', plan: 'pro', hasSubscription: true };
    await accountService.refreshIdentity(own.id);
    const repointReports = reports.filter(([problem, , facts]) => problem === 'identity-changed' && facts?.stage === 'repoint');
    expect(repointReports).toHaveLength(1);
    expect(repointReports[0][2]).toEqual({ stage: 'repoint', default_home: 'builtin' });
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
  /** A folder agent that reports usage (idle reads), so its list follows the global order mode. */
  function usageFolderService(): AccountService {
    return folderService(folderSupport({ readIdleUsage: async () => [] }));
  }

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
    const accountService = usageFolderService();
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
    const accountService = usageFolderService();
    // On screen: soonest reset first, an account with no reading last.
    expect(accountService.ordered(AGENT).map((account) => account.id)).toEqual([stored3.id, stored1.id, stored2.id]);
    expect(accountService.switchTo(stored2.id)).toBe(true);
    expect(repository.listForAgent(AGENT).map((account) => account.id)).toEqual([stored2.id, stored3.id, stored1.id]);
    expect(configWrites).toEqual([{ orderMode: 'manual', autoSwitchAtLimit: true }]);
  });

  describe('an agent that reports no usage', () => {
    const KEY_FILE_AGENT = 'key-file-agent';

    function keyFileAgentService(): AccountService {
      return makeService({
        [AGENT]: adapterOf(AGENT, folderSupport({ readIdleUsage: async () => [] })),
        [KEY_FILE_AGENT]: adapterOf(KEY_FILE_AGENT, keyFileSupport()),
      });
    }

    function insertKeyFileAccount(status: 'ok' | 'not-found' = 'ok') {
      folderCounter += 1;
      return repository.insert({
        agent: KEY_FILE_AGENT,
        kind: 'key-file',
        keyFilePath: path.join(root, `keys-${folderCounter}.env`),
        keyNames: ['OPENROUTER_API_KEY'],
        status,
      });
    }

    it('keeps the saved order under Automatic, even past an account that is not ok', () => {
      config = { orderMode: 'automatic', autoSwitchAtLimit: true };
      const first = insertKeyFileAccount();
      const missing = insertKeyFileAccount('not-found');
      const third = insertKeyFileAccount();
      expect(keyFileAgentService().ordered(KEY_FILE_AGENT).map((account) => account.id)).toEqual([first.id, missing.id, third.id]);
    });

    it('does not set Manual on a drag or a switch', () => {
      config = { orderMode: 'automatic', autoSwitchAtLimit: true };
      const first = insertKeyFileAccount();
      const second = insertKeyFileAccount();
      const accountService = keyFileAgentService();
      accountService.reorder(KEY_FILE_AGENT, [second.id, first.id]);
      expect(repository.listForAgent(KEY_FILE_AGENT).map((account) => account.id)).toEqual([second.id, first.id]);
      expect(accountService.switchTo(first.id)).toBe(true);
      expect(repository.listForAgent(KEY_FILE_AGENT).map((account) => account.id)).toEqual([first.id, second.id]);
      expect(configWrites).toEqual([]);
      expect(config.orderMode).toBe('automatic');
    });

    it('still sets Manual on a drag for an agent that reports usage', () => {
      config = { orderMode: 'automatic', autoSwitchAtLimit: true };
      const first = insertFolderAccount();
      const second = insertFolderAccount();
      keyFileAgentService().reorder(AGENT, [second.id, first.id]);
      expect(configWrites).toEqual([{ orderMode: 'manual', autoSwitchAtLimit: true }]);
    });
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
        usageWindows: [{ id: 'short', label: '5h session', iconKind: 'session', windowDurationSeconds: 5 * 3600 }],
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
      // The windows the adapter says the agent always has, for the rows' Not started lines.
      usageWindows: [{ id: 'short', label: '5h session', iconKind: 'session', windowDurationSeconds: 5 * 3600 }],
    });
    // An adapter that declares none gives an empty list, never undefined.
    expect(cards[1].usageWindows).toEqual([]);
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

  // At a launch the cards may be answered from an earlier launch's detection, so listing them
  // starts no CLI. That lookup is the cards' alone: everything that runs the CLI asks the live one.
  it('asks the list-only lookup for each CLI, all at once, and never the live one', async () => {
    const adapters: Record<string, AgentAdapter> = {
      first: adapterOf('first', folderSupport()),
      second: adapterOf('second', folderSupport()),
      'in-a-distro': adapterOf('in-a-distro', folderSupport()),
    };
    const asked: string[] = [];
    const answers = new Map<string, (cliPath: string | null) => void>();
    const resolveCliPath = vi.fn(async () => '/usr/bin/live-cli');
    const remoteTargetAsked: Array<[string, string | undefined]> = [];
    const accountService = makeService(adapters, {
      resolveCliPath,
      listCliPath: (agent) => new Promise<string | null>((resolve) => {
        asked.push(agent);
        answers.set(agent, resolve);
      }),
      usesRemoteTarget: async (agent, knownCliPath) => {
        remoteTargetAsked.push([agent, knownCliPath]);
        return agent === 'in-a-distro';
      },
    });

    const pending = accountService.cards();
    // Every agent was asked before any answered: one slow CLI does not hold the others.
    expect(asked).toEqual(['first', 'second', 'in-a-distro']);
    // Answered out of order, and the cards still come out in adapter order.
    answers.get('in-a-distro')?.('/usr/bin/distro-cli');
    answers.get('second')?.('/usr/bin/second-cli');
    answers.get('first')?.(null);
    const cards = await pending;

    expect(cards.map((card) => [card.agent, card.unsupportedTarget])).toEqual([['second', false], ['in-a-distro', true]]);
    expect(resolveCliPath).not.toHaveBeenCalled();
    // Where the CLI runs is read off the path the list already holds, not detected again.
    expect(remoteTargetAsked).toEqual([['in-a-distro', '/usr/bin/distro-cli'], ['second', '/usr/bin/second-cli']]);
  });
});

// After a restart, detecting every agent's CLI took 12 s and Settings > Accounts was blank for all
// of it (task #1202). The tab's list answers at once from what the last checked list held.
describe('AccountService.listForTab', () => {
  /** A list-only CLI lookup that answers only when the test says so. */
  function heldLookup() {
    const answers: Array<() => void> = [];
    return {
      listCliPath: (agent: string) => new Promise<string | null>((resolve) => {
        answers.push(() => resolve(agent === 'gone' ? null : `/usr/bin/${agent}`));
      }),
      land: () => answers.splice(0).forEach((answer) => answer()),
      asked: () => answers.length,
    };
  }

  it('answers at once from the saved list and saved rows, unchecked, while the CLI check runs', async () => {
    const lookup = heldLookup();
    const accountService = makeService({ [AGENT]: adapterOf(AGENT, folderSupport()) }, {
      listCliPath: lookup.listCliPath,
      readListedAgents: () => [{ agent: AGENT, unsupportedTarget: true }],
    });
    const own = accountService.ensureDefaultAccount(AGENT)!;
    repository.updateUsage(own.id, [sevenDay(40, NOW + 3600)]);

    const answer = await accountService.listForTab();

    expect(answer.checked).toBe(false);
    expect(answer.cards.map((card) => card.agent)).toEqual([AGENT]);
    // The saved WSL answer keeps Add account hidden until the check says otherwise.
    expect(answer.cards[0].unsupportedTarget).toBe(true);
    expect(answer.cards[0].accounts[0].lastUsage?.[0].usedPercentage).toBe(40);
    // The check started, and is still waiting on the CLI.
    expect(lookup.asked()).toBe(1);
  });

  it('saves the checked list, pushes a change, and answers checked from then on', async () => {
    const lookup = heldLookup();
    const saved: unknown[] = [];
    const accountService = makeService({
      [AGENT]: adapterOf(AGENT, folderSupport()),
      gone: adapterOf('gone', folderSupport()),
    }, {
      listCliPath: lookup.listCliPath,
      usesRemoteTarget: async () => false,
      readListedAgents: () => null,
      saveListedAgents: (agents) => { saved.push(agents); return true; },
    });

    const first = await accountService.listForTab();
    expect(first).toEqual({ cards: [], checked: false });
    expect(changeCount).toBe(0);

    lookup.land();
    await vi.waitFor(() => expect(changeCount).toBe(1));
    expect(saved).toEqual([[{ agent: AGENT, unsupportedTarget: false }]]);

    const next = accountService.listForTab();
    lookup.land();
    const answer = await next;
    expect(answer.checked).toBe(true);
    expect(answer.cards.map((card) => card.agent)).toEqual([AGENT]);
    // The same agents again: nothing new to save.
    expect(saved).toHaveLength(1);
  });

  it('starts one check however many opens arrive before it lands', async () => {
    const lookup = heldLookup();
    const accountService = folderService(folderSupport(), { listCliPath: lookup.listCliPath, readListedAgents: () => null });
    await Promise.all([accountService.listForTab(), accountService.listForTab(), accountService.listForTab()]);
    expect(lookup.asked()).toBe(1);
  });

  it('skips a saved agent with no rows, or whose adapter no longer declares accounts', async () => {
    const accountService = makeService({
      [AGENT]: adapterOf(AGENT, folderSupport()),
      'no-rows': adapterOf('no-rows', folderSupport()),
      'no-accounts': adapterOf('no-accounts'),
    }, {
      listCliPath: heldLookup().listCliPath,
      readListedAgents: () => [
        { agent: 'no-rows', unsupportedTarget: false },
        { agent: 'no-accounts', unsupportedTarget: false },
        { agent: 'not-registered', unsupportedTarget: false },
        { agent: AGENT, unsupportedTarget: false },
      ],
    });
    accountService.ensureDefaultAccount(AGENT);
    repository.insert({ agent: 'no-accounts', kind: 'default' });

    const answer = await accountService.listForTab();
    expect(answer.cards.map((card) => card.agent)).toEqual([AGENT]);
    // The saved answer writes no row.
    expect(repository.listForAgent('no-rows')).toEqual([]);
  });

  it('keeps the saved answer and checks again on the next open when the check fails', async () => {
    const accountService = folderService(folderSupport(), {
      listCliPath: async () => '/usr/bin/test-cli',
      usesRemoteTarget: async () => false,
      readListedAgents: () => null,
    });
    // `cards()` catches each lookup's own failure, so fail the check itself, once.
    const cardsSpy = vi.spyOn(accountService, 'cards').mockRejectedValueOnce(new Error('check failed'));
    const reportSpy = vi.spyOn(accountsReporter, 'report').mockImplementation(() => undefined);

    await accountService.listForTab();
    await vi.waitFor(() => expect(cardsSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(changeCount).toBe(0);
    // The failure is reported, tagged with the stage, not swallowed.
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'check failed' }), { tags: { stage: 'tab_list_check' } });

    // The failed check left the run unchecked, so this open starts another, which lands.
    expect((await accountService.listForTab()).checked).toBe(false);
    await vi.waitFor(() => expect(changeCount).toBe(1));
    expect((await accountService.listForTab()).checked).toBe(true);
  });

  it('saves the list again when the agents or a card unsupportedTarget changed', async () => {
    const saved: unknown[] = [];
    let remote = false;
    const accountService = makeService({
      [AGENT]: adapterOf(AGENT, folderSupport()),
      second: adapterOf('second', folderSupport()),
    }, {
      listCliPath: async (agent) => (agent === 'second' && !secondInstalled ? null : `/usr/bin/${agent}`),
      usesRemoteTarget: async () => remote,
      readListedAgents: () => null,
      saveListedAgents: (agents) => { saved.push(agents); return true; },
    });
    let secondInstalled = false;

    await accountService.cards();
    expect(saved).toEqual([[{ agent: AGENT, unsupportedTarget: false }]]);

    // A same list is not saved again.
    await accountService.cards();
    expect(saved).toHaveLength(1);

    // A new agent.
    secondInstalled = true;
    await accountService.cards();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual([
      { agent: AGENT, unsupportedTarget: false },
      { agent: 'second', unsupportedTarget: false },
    ]);

    // The same agents, one now on an unsupported target.
    remote = true;
    await accountService.cards();
    expect(saved).toHaveLength(3);
    expect(saved[2]).toEqual([
      { agent: AGENT, unsupportedTarget: true },
      { agent: 'second', unsupportedTarget: true },
    ]);
  });

  it('retries a save that failed on the next check, then stops once it lands', async () => {
    const attempts: unknown[] = [];
    const results = [false, true];
    const accountService = folderService(folderSupport(), {
      listCliPath: async () => '/usr/bin/test-cli',
      usesRemoteTarget: async () => false,
      readListedAgents: () => null,
      saveListedAgents: (agents) => { attempts.push(agents); return results.shift() ?? true; },
    });

    await accountService.cards();
    expect(attempts).toHaveLength(1);
    await accountService.cards();
    expect(attempts).toHaveLength(2);
    await accountService.cards();
    expect(attempts).toHaveLength(2);
  });
});

describe('AccountService.resolveForSpawn under Automatic', () => {
  /**
   * The incident's three accounts: the agent's own login resets soonest but its stored reading ran
   * out, a full-ish folder account resets next, and a fresh one resets last.
   */
  function seedIncident() {
    const accountService = folderService(folderSupport({ readIdleUsage: async () => null }), {
      readBeforeRanking: async (accounts) => {
        readAsked.push(accounts.map((account) => account.id));
        // The read lands: the own login now has a live window that resets soonest.
        repository.updateUsage(own.id, [sevenDay(1, NOW + 86_400)]);
      },
    });
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const busy = insertFolderAccount();
    const fresh = insertFolderAccount();
    repository.reorder(AGENT, [busy.id, own.id, fresh.id]);
    repository.updateUsage(own.id, [sevenDay(1, NOW - 60)]);
    repository.updateUsage(busy.id, [sevenDay(90, NOW + 5 * 86_400)]);
    repository.updateUsage(fresh.id, [sevenDay(0, NOW + 6 * 86_400)]);
    return { accountService, own, busy, fresh };
  }

  let readAsked: string[][];
  beforeEach(() => {
    readAsked = [];
    config = { orderMode: 'automatic', autoSwitchAtLimit: true };
  });

  it('reads before it ranks, so the account whose reading ran out is ranked on a new one', async () => {
    const { accountService, own } = seedIncident();
    const resolved = await accountService.resolveForSpawn(AGENT);
    expect(readAsked).toHaveLength(1);
    expect(resolved?.id).toBe(own.id);
  });

  it('reads nothing for a named account', async () => {
    const { accountService, busy } = seedIncident();
    expect((await accountService.resolveForSpawn(AGENT, busy.id))?.id).toBe(busy.id);
    expect(readAsked).toEqual([]);
  });

  // Task #1147: Manual skips a full account, and a reading from before it filled says it has room.
  it('reads before Manual chooses too', async () => {
    const { accountService } = seedIncident();
    config = { orderMode: 'manual', autoSwitchAtLimit: true };
    await accountService.resolveForSpawn(AGENT);
    expect(readAsked).toHaveLength(1);
  });

  describe('asks the reader for nothing when there is nothing to read', () => {
    const readBeforeRanking = vi.fn(async (_accounts: readonly unknown[]) => undefined);

    function twoFolderAccounts(): void {
      insertFolderAccount();
      insertFolderAccount();
    }

    function twoKeyFileAccounts(): void {
      for (const name of ['one.env', 'two.env']) {
        repository.insert({ agent: AGENT, kind: 'key-file', keyFilePath: path.join(root, name), keyNames: ['OPENROUTER_API_KEY'] });
      }
    }

    beforeEach(() => {
      readBeforeRanking.mockClear();
    });

    it.each<[string, () => AccountService, () => void, number]>([
      // The control: two folder accounts of an agent whose usage can be read idle.
      ['two readable folder accounts (control)', () => makeService({ [AGENT]: adapterOf(AGENT, folderSupport({ readIdleUsage: async () => null })) }, { readBeforeRanking }), twoFolderAccounts, 1],
      // A spawn adds the agent's own login row itself, so no seeded row leaves exactly one account.
      ['an agent with a single account', () => makeService({ [AGENT]: adapterOf(AGENT, folderSupport({ readIdleUsage: async () => null })) }, { readBeforeRanking }), () => undefined, 0],
      ['a folder adapter without readIdleUsage', () => makeService({ [AGENT]: adapterOf(AGENT, folderSupport(), { reportsRateLimits: true }) }, { readBeforeRanking }), twoFolderAccounts, 0],
      ['key-file accounts', () => makeService({ [AGENT]: adapterOf(AGENT, keyFileSupport(), { reportsRateLimits: true }) }, { readBeforeRanking }), twoKeyFileAccounts, 0],
      ['an adapter that reports no usage', () => makeService({ [AGENT]: adapterOf(AGENT, folderSupport()) }, { readBeforeRanking }), twoFolderAccounts, 0],
    ])('%s', async (_name, buildService, seed, expectedCalls) => {
      const accountService = buildService();
      seed();
      await accountService.resolveForSpawn(AGENT);
      expect(readBeforeRanking).toHaveBeenCalledTimes(expectedCalls);
    });
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

  // Task #1070: a resume's plan file can sit in any account's own `plans` folder.
  it('hands a resume to the adapter carry with the chosen home and every home, once the folder is ready, and never fails the spawn on it', async () => {
    const carried: Array<{ toHome: string; homes: readonly string[]; agentSessionId: string; cwd: string; folderReady: boolean }> = [];
    const accountService = folderService(folderSupport({
      carryConversation: async (input) => {
        carried.push({
          toHome: input.toHome,
          homes: input.homes,
          agentSessionId: input.agentSessionId,
          cwd: input.cwd,
          folderReady: fs.existsSync(path.join(input.toHome, 'projects')),
        });
        throw new Error('disk full');
      },
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const first = insertFolderAccount();
    const second = insertFolderAccount();
    repository.reorder(AGENT, [second.id, first.id, own.id]);

    const resolved = await accountService.resolveForSpawn(AGENT, undefined, first.id, { agentSessionId: 'conversation-1', cwd: '/mock/project' });

    expect(resolved?.id).toBe(second.id);
    expect(carried).toEqual([{
      toHome: second.folderPath,
      homes: [home, second.folderPath, first.folderPath],
      agentSessionId: 'conversation-1',
      cwd: '/mock/project',
      folderReady: true,
    }]);
    // A fresh start carries nothing.
    await accountService.resolveForSpawn(AGENT);
    expect(carried).toHaveLength(1);
  });

  // Pins carryConversation's `account.kind === 'folder' ? folderPath : defaultHome`.
  it('carries into the default home when the chosen account is the agent\'s own login', async () => {
    const carried: Array<{ toHome: string; homes: readonly string[] }> = [];
    const accountService = folderService(folderSupport({
      carryConversation: async (input) => {
        carried.push({ toHome: input.toHome, homes: input.homes });
      },
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const other = insertFolderAccount();
    repository.reorder(AGENT, [own.id, other.id]);

    const resolved = await accountService.resolveForSpawn(AGENT, undefined, undefined, { agentSessionId: 'conversation-2', cwd: '/mock/project' });

    expect(resolved).toEqual({ id: own.id, agent: AGENT, kind: 'default', env: {} });
    expect(carried).toEqual([{ toHome: home, homes: [home, other.folderPath] }]);
  });

  // Pins the fallback call: the own-login row still receives the resumed conversation's files.
  it('carries into the default home on the fallback path, when no account could be prepared', async () => {
    const carried: Array<{ toHome: string; homes: readonly string[]; agentSessionId: string }> = [];
    const accountService = folderService(folderSupport({
      carryConversation: async (input) => {
        carried.push({ toHome: input.toHome, homes: input.homes, agentSessionId: input.agentSessionId });
      },
    }));
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const signedOut = insertFolderAccount('signed-out');

    const resolved = await accountService.resolveForSpawn(AGENT, signedOut.id, undefined, { agentSessionId: 'conversation-3', cwd: '/mock/project' });

    expect(resolved).toEqual({ id: own.id, agent: AGENT, kind: 'default', env: {} });
    expect(carried).toEqual([{ toHome: home, homes: [home, signedOut.folderPath], agentSessionId: 'conversation-3' }]);
  });

  it('resolves the same account for a resume when the adapter has no carry hook', async () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    const second = insertFolderAccount();
    repository.reorder(AGENT, [second.id, own.id]);

    const withResume = await accountService.resolveForSpawn(AGENT, undefined, undefined, { agentSessionId: 'conversation-4', cwd: '/mock/project' });
    const fresh = await accountService.resolveForSpawn(AGENT);

    expect(withResume).toEqual({ id: second.id, agent: AGENT, kind: 'folder', env: { TEST_AGENT_HOME: second.folderPath } });
    expect(fresh).toEqual(withResume);
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
  it('brings back a window the idle read named absent once a live report shows it, and never marks one absent', () => {
    const accountService = folderService();
    const own = accountService.ensureDefaultAccount(AGENT)!;
    repository.updateUsage(own.id, [sevenDay(40, NOW + 86_400)], ['five-hour']);
    // A report with only the weekly window says nothing about the 5h one.
    accountService.recordUsage([{ ...sevenDay(41, NOW + 86_400), accountId: own.id }]);
    expect(repository.getById(own.id)?.absentWindowIds).toEqual(['five-hour']);
    // The plan has a 5h window now: the live report shows it.
    const fiveHour: RateLimitWindow = { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 3, resetsAt: NOW + 3600, windowDurationSeconds: 18_000 };
    expect(accountService.recordUsage([{ ...fiveHour, accountId: own.id }])).toEqual([own.id]);
    expect(repository.getById(own.id)?.absentWindowIds).toEqual([]);
  });

  it('stores the windows an idle read names absent', async () => {
    const support = folderSupport({ readIdleUsage: async () => ({ windows: [sevenDay(20, NOW + 86_400)], absentWindowIds: ['five-hour'] }) });
    const accountService = folderService(support);
    const own = accountService.ensureDefaultAccount(AGENT)!;
    expect(await accountService.refreshUsage(own.id)).toBe(true);
    expect(repository.getById(own.id)?.absentWindowIds).toEqual(['five-hour']);
  });

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

  describe('a read that gives no windows', () => {
    const GOOD = [sevenDay(1, NOW + 86_400)];
    const READ_AT = '2026-11-18T05:19:00.000Z';

    it.each<[string, () => Promise<RateLimitWindow[] | null>, string]>([
      ['null', async () => null, 'no-answer'],
      ['an empty list', async () => [], 'no-windows'],
      ['a thrown empty read', async () => { throw new EmptyUsageReadError('state-unreadable'); }, 'state-unreadable'],
    ])('keeps the stored windows and their read time on %s, and reports why', async (_name, readIdleUsage, reason) => {
      const accountService = folderService(folderSupport({ readIdleUsage }));
      const own = accountService.ensureDefaultAccount(AGENT)!;
      database.prepare('UPDATE agent_accounts SET last_usage_json = ?, last_usage_at = ? WHERE id = ?').run(JSON.stringify(GOOD), READ_AT, own.id);

      expect(await accountService.refreshUsage(own.id)).toBe(false);
      expect(repository.getById(own.id)?.lastUsage).toEqual(GOOD);
      expect(repository.getById(own.id)?.lastUsageAt).toBe(READ_AT);
      expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['usage-read-empty', AGENT, { kind: 'default', reason }]]);
      expect(changeCount).toBe(0);
    });

    // Sentry DESKTOP-4E on 0.61.0: a fresh cache with no readable window, reported with no CLI
    // version, so a plan whose windows are all null could not be told from a renamed field.
    it('puts the CLI version on a no-windows report', async () => {
      const accountService = folderService(
        folderSupport({ readIdleUsage: async () => { throw new EmptyUsageReadError('no-windows'); } }),
        { resolveCliVersion: async () => '2.1.319 (Claude Code)' },
      );
      const own = accountService.ensureDefaultAccount(AGENT)!;

      expect(await accountService.refreshUsage(own.id)).toBe(false);
      expect(reports).toHaveLength(1);
      const [problem, agent, facts, , tags] = reports[0];
      expect([problem, agent, facts]).toEqual(['usage-read-empty', AGENT, { kind: 'default', reason: 'no-windows' }]);
      expect(tags).toEqual({ agent_cli_version: '2.1.319' });
    });

    // These reasons name their own cause, so they carry no tags and must not pay for a version probe.
    it.each<[string, () => Promise<RateLimitWindow[] | null>]>([
      ['state-unreadable', async () => { throw new EmptyUsageReadError('state-unreadable'); }],
      ['state-not-record', async () => { throw new EmptyUsageReadError('state-not-record'); }],
      ['no-answer', async () => null],
    ])('reports %s with no tags and never resolves the CLI version', async (reason, readIdleUsage) => {
      const resolveCliVersion = vi.fn(async () => '2.1.319 (Claude Code)');
      const accountService = folderService(folderSupport({ readIdleUsage }), { resolveCliVersion });
      const own = accountService.ensureDefaultAccount(AGENT)!;

      expect(await accountService.refreshUsage(own.id)).toBe(false);
      expect(reports).toHaveLength(1);
      const [problem, agent, facts, , tags] = reports[0];
      expect([problem, agent, facts]).toEqual(['usage-read-empty', AGENT, { kind: 'default', reason }]);
      expect(tags).toEqual({});
      expect(resolveCliVersion).not.toHaveBeenCalled();
    });

    // Sentry DESKTOP-4E on 0.62.0: a home before the CLI's first usage fetch holds no cache, and
    // was reported on every launch. Only an account that had a reading and lost it is a fault.
    describe('whose state holds no usage cache', () => {
      const noCache = async (): Promise<RateLimitWindow[] | null> => { throw new EmptyUsageReadError('no-cache'); };

      it('sends nothing for an account that never stored a reading', async () => {
        const accountService = folderService(folderSupport({ readIdleUsage: noCache }));
        const own = accountService.ensureDefaultAccount(AGENT)!;

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports).toEqual([]);
      });

      it('reports no-cache once the account had a reading', async () => {
        const accountService = folderService(folderSupport({ readIdleUsage: noCache }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        database.prepare('UPDATE agent_accounts SET last_usage_json = ?, last_usage_at = ? WHERE id = ?').run(JSON.stringify(GOOD), READ_AT, own.id);

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports.map((entry) => entry.slice(0, 3))).toEqual([['usage-read-empty', AGENT, { kind: 'default', reason: 'no-cache' }]]);
        expect(repository.getById(own.id)?.lastUsage).toEqual(GOOD);
      });
    });

    it('never reads an account whose sign-in says it has no subscription', async () => {
      const readIdleUsage = vi.fn(async (): Promise<RateLimitWindow[] | null> => { throw new EmptyUsageReadError('no-cache'); });
      const accountService = folderService(folderSupport({ readIdleUsage }));
      const own = accountService.ensureDefaultAccount(AGENT)!;
      repository.updateIdentity(own.id, { email: 'own@example.com', plan: null, status: 'no-subscription' });

      expect(await accountService.refreshUsage(own.id)).toBe(false);
      expect(readIdleUsage).not.toHaveBeenCalled();
      expect(reports).toEqual([]);
    });

    // Sentry DESKTOP-4E: one failed `claude -p /usage` run was reported with nothing to say why.
    // A timeout, an offline moment and a flag the CLI does not know all looked the same.
    describe('whose CLI run failed', () => {
      const timedOut = Object.assign(new Error('Command failed: /usr/bin/test-cli -p /usage'), { killed: true, signal: 'SIGTERM' });
      const runFailed = (): EmptyUsageReadError => new EmptyUsageReadError('run-failed', {
        cause: timedOut,
        runFailure: { kind: 'timeout', exitCode: null },
      });

      it('sends nothing for one failed run, and reports the second in a row with how it failed and the CLI version', async () => {
        const accountService = folderService(
          folderSupport({ readIdleUsage: async () => { throw runFailed(); } }),
          { resolveCliVersion: async () => '2.1.319 (Claude Code)' },
        );
        const own = accountService.ensureDefaultAccount(AGENT)!;

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports).toEqual([]);

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports).toHaveLength(1);
        const [problem, agent, facts, cause, tags] = reports[0];
        expect([problem, agent, facts]).toEqual(['usage-read-empty', AGENT, { kind: 'default', reason: 'run-failed' }]);
        expect(cause).toBe(timedOut);
        expect(tags).toEqual({ run_failure: 'timeout', agent_cli_version: '2.1.319' });
      });

      it('sends the exit code of a run that exited, and unknown for a version it cannot read', async () => {
        const accountService = folderService(folderSupport({
          readIdleUsage: async () => { throw new EmptyUsageReadError('run-failed', { runFailure: { kind: 'exit_code', exitCode: 1 } }); },
        }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        await accountService.refreshUsage(own.id);
        await accountService.refreshUsage(own.id);

        expect(reports.map((entry) => entry[4])).toEqual([{ run_failure: 'exit_code', run_exit: '1', agent_cli_version: 'unknown' }]);
      });

      it('starts the count again after a good read, and after a read whose run worked', async () => {
        const reads: Array<() => Promise<RateLimitWindow[] | null>> = [
          async () => { throw runFailed(); },
          async () => [sevenDay(5, NOW + 3600)],
          async () => { throw runFailed(); },
          async () => { throw new EmptyUsageReadError('cache-stale'); },
          async () => { throw runFailed(); },
        ];
        const accountService = folderService(folderSupport({ readIdleUsage: async () => reads.shift()!() }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        for (let read = 0; read < 5; read += 1) await accountService.refreshUsage(own.id);

        // Three failed runs and a stale read, none of them two in a row.
        expect(reports).toEqual([]);
      });

      it('starts the count again after a read the CLI answered in a shape it does not know', async () => {
        const reads: Array<() => Promise<RateLimitWindow[] | null>> = [
          async () => { throw runFailed(); },
          async () => { throw new UnreadableUsageError('alpha'); },
          async () => { throw runFailed(); },
        ];
        const accountService = folderService(folderSupport({ readIdleUsage: async () => reads.shift()!() }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        for (let read = 0; read < 3; read += 1) await accountService.refreshUsage(own.id);

        // Only the unreadable answer reports: the two failed runs are not in a row.
        expect(reports.map((entry) => entry[0])).toEqual(['usage-read-unreadable']);
      });

      it.each<[string, number, string]>([
        ['zero', 0, '0'],
        ['the top of the shell range', 255, '255'],
        ['one past the shell range', 256, 'other'],
        ['a negative code', -1, 'other'],
        ['a Windows status code', 3221225781, 'other'],
      ])('tags an exit code of %s as run_exit %s', async (_name, exitCode, expectedTag) => {
        const accountService = folderService(folderSupport({
          readIdleUsage: async () => { throw new EmptyUsageReadError('run-failed', { runFailure: { kind: 'exit_code', exitCode } }); },
        }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        await accountService.refreshUsage(own.id);
        await accountService.refreshUsage(own.id);

        expect(reports).toHaveLength(1);
        expect(reports[0][4]).toMatchObject({ run_failure: 'exit_code', run_exit: expectedTag });
      });

      it('carries no run_exit tag for a run that did not exit', async () => {
        const accountService = folderService(folderSupport({ readIdleUsage: async () => { throw runFailed(); } }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        await accountService.refreshUsage(own.id);
        await accountService.refreshUsage(own.id);

        expect(reports).toHaveLength(1);
        expect(reports[0][4]).not.toHaveProperty('run_exit');
      });

      it('still reports, with an unknown version, when the version lookup throws', async () => {
        const accountService = folderService(
          folderSupport({ readIdleUsage: async () => { throw runFailed(); } }),
          { resolveCliVersion: async () => { throw new Error('detection broke'); } },
        );
        const own = accountService.ensureDefaultAccount(AGENT)!;
        expect(await accountService.refreshUsage(own.id)).toBe(false);
        await expect(accountService.refreshUsage(own.id)).resolves.toBe(false);

        expect(reports).toHaveLength(1);
        expect(reports[0][4]).toMatchObject({ run_failure: 'timeout', agent_cli_version: 'unknown' });
      });

      it('tags run_failure unknown when the failed run says nothing about how it failed', async () => {
        const accountService = folderService(folderSupport({
          readIdleUsage: async () => { throw new EmptyUsageReadError('run-failed'); },
        }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        await accountService.refreshUsage(own.id);
        await accountService.refreshUsage(own.id);

        expect(reports).toHaveLength(1);
        expect(reports[0][2]).toEqual({ kind: 'default', reason: 'run-failed' });
        expect(reports[0][4]).toMatchObject({ run_failure: 'unknown' });
        expect(reports[0][4]).not.toHaveProperty('run_exit');
      });

      it('counts failed runs for each account on its own', async () => {
        const accountService = folderService(folderSupport({ readIdleUsage: async () => { throw runFailed(); } }));
        const accountOne = insertFolderAccount('ok');
        const accountTwo = insertFolderAccount('ok');

        await accountService.refreshUsage(accountOne.id);
        await accountService.refreshUsage(accountTwo.id);
        expect(reports).toEqual([]);

        await accountService.refreshUsage(accountOne.id);
        expect(reports).toHaveLength(1);
      });
    });

    // Sentry DESKTOP-4E on 0.62.0: one stale read was reported at once. A network drop, a refused
    // fetch and a sign-in that needs renewing all leave one, as a failed run does.
    describe('whose CLI run left its cache stale', () => {
      const stale = (cacheAge?: 'under_1h' | '1h_to_1d' | 'over_1d') => async (): Promise<RateLimitWindow[] | null> => {
        throw new EmptyUsageReadError('cache-stale', { cacheAge });
      };
      const runFailed = async (): Promise<RateLimitWindow[] | null> => { throw new EmptyUsageReadError('run-failed'); };
      const goodRead = async (): Promise<RateLimitWindow[] | null> => [sevenDay(5, NOW + 3600)];

      /** One account's reads in order, each from `reads`. */
      async function readInOrder(reads: Array<() => Promise<RateLimitWindow[] | null>>): Promise<void> {
        const accountService = folderService(folderSupport({ readIdleUsage: async () => reads.shift()!() }));
        const own = accountService.ensureDefaultAccount(AGENT)!;
        while (reads.length > 0) await accountService.refreshUsage(own.id);
      }

      it('sends nothing for one, and reports the second in a row with the cache\'s age and the CLI version', async () => {
        const resolveCliVersion = vi.fn(async () => '2.1.319 (Claude Code)');
        const accountService = folderService(folderSupport({ readIdleUsage: stale('1h_to_1d') }), { resolveCliVersion });
        const own = accountService.ensureDefaultAccount(AGENT)!;

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports).toEqual([]);
        expect(resolveCliVersion).not.toHaveBeenCalled();

        expect(await accountService.refreshUsage(own.id)).toBe(false);
        expect(reports).toHaveLength(1);
        const [problem, agent, facts, , tags] = reports[0];
        expect([problem, agent, facts]).toEqual(['usage-read-empty', AGENT, { kind: 'default', reason: 'cache-stale' }]);
        expect(tags).toEqual({ cache_age: '1h_to_1d', agent_cli_version: '2.1.319' });
      });

      // The once-per-run latch is downstream of this service, so each read past the second must report.
      it('reports each stale read after the second too, not only the second', async () => {
        await readInOrder([stale('under_1h'), stale('under_1h'), stale('under_1h')]);
        expect(reports.map((entry) => entry[0])).toEqual(['usage-read-empty', 'usage-read-empty']);
      });

      // A run that worked ends the streak even when its reading is set aside because the home now
      // holds another login. Without this, a stale read after it would report as a second in a row.
      it('starts the count again after a good read whose home holds another login', async () => {
        const reads = [stale('under_1h'), goodRead, stale('under_1h')];
        const readIdleUsage = vi.fn(async () => reads.shift()!());
        const accountService = folderService(folderSupport({
          readIdleUsage,
          readHomeIdentity: async () => ({ email: 'other@example.com', orgId: null }),
        }));
        const row = insertFolderAccount('ok', 'dev@example.com', 'pro');

        expect(await accountService.refreshUsage(row.id)).toBe(false);
        // The good read reaches the login mismatch, so its reading is not stored.
        expect(await accountService.refreshUsage(row.id)).toBe(false);
        expect(await accountService.refreshUsage(row.id)).toBe(false);

        expect(readIdleUsage).toHaveBeenCalledTimes(3);
        expect(reports.filter(([problem]) => problem === 'usage-read-empty')).toEqual([]);
      });

      it('tags the age unknown when the adapter gave none', async () => {
        await readInOrder([stale(), stale()]);
        expect(reports.map((entry) => entry[4])).toEqual([{ cache_age: 'unknown', agent_cli_version: 'unknown' }]);
      });

      it('sends nothing when a good read comes between two', async () => {
        await readInOrder([stale('under_1h'), goodRead, stale('under_1h')]);
        expect(reports).toEqual([]);
      });

      it('counts stale reads and failed runs apart: each restarts the other', async () => {
        await readInOrder([stale('under_1h'), runFailed, stale('under_1h'), runFailed]);
        expect(reports).toEqual([]);
      });

      it('starts the count again after a read the CLI answered in a shape it does not know', async () => {
        await readInOrder([stale('under_1h'), async () => { throw new UnreadableUsageError('alpha'); }, stale('under_1h')]);
        expect(reports.map((entry) => entry[0])).toEqual(['usage-read-unreadable']);
      });

      it('counts stale reads for each account on its own', async () => {
        const accountService = folderService(folderSupport({ readIdleUsage: stale('under_1h') }));
        const accountOne = insertFolderAccount('ok');
        const accountTwo = insertFolderAccount('ok');

        await accountService.refreshUsage(accountOne.id);
        await accountService.refreshUsage(accountTwo.id);
        expect(reports).toEqual([]);

        await accountService.refreshUsage(accountOne.id);
        expect(reports).toHaveLength(1);
      });
    });

    it('logs a repeat of the same reason once, and again once it changes', async () => {
      const reasons: Array<'cache-stale' | 'run-failed'> = ['cache-stale', 'cache-stale', 'run-failed'];
      const accountService = folderService(folderSupport({
        readIdleUsage: async () => { throw new EmptyUsageReadError(reasons.shift()!); },
      }));
      const own = accountService.ensureDefaultAccount(AGENT)!;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        for (let read = 0; read < 3; read += 1) await accountService.refreshUsage(own.id);
        const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('gave no windows'));
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('run-failed');
      } finally {
        warn.mockRestore();
      }
    });

    it('logs the same reason again after a good read in between', async () => {
      const reads: Array<() => Promise<RateLimitWindow[] | null>> = [
        async () => { throw new EmptyUsageReadError('cache-stale'); },
        async () => [sevenDay(5, NOW + 3600)],
        async () => { throw new EmptyUsageReadError('cache-stale'); },
      ];
      const accountService = folderService(folderSupport({ readIdleUsage: async () => reads.shift()!() }));
      const own = accountService.ensureDefaultAccount(AGENT)!;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const outcomes: boolean[] = [];
        for (let read = 0; read < 3; read += 1) outcomes.push(await accountService.refreshUsage(own.id));
        expect(outcomes).toEqual([false, true, false]);
        const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('gave no windows'));
        expect(lines).toHaveLength(2);
        expect(lines.every((line) => line.includes('cache-stale'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
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
