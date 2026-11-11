import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountService, resumeAccountMatch } from '../../src/main/accounts/account-service';
import { buildSessionEnv } from '../../src/main/accounts/account-env';
import type { FolderAccountSupport, KeyFileAccountSupport } from '../../src/main/accounts/account-support';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';
import type { AgentAccountsConfig } from '../../src/shared/agent-accounts';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

/**
 * The `resume_account` tag: a resume on another account than its conversation's
 * looks in the wrong config folder and finds no conversation (DESKTOP-2M's open cause).
 */
describe('resumeAccountMatch', () => {
  it.each([
    ['a record from before accounts on the agent\'s own login', null, { id: 'default-claude', kind: 'default' as const }, 'same'],
    ['a record from before accounts moved onto a folder account', null, { id: 'account-2', kind: 'folder' as const }, 'changed'],
    ['the conversation\'s own account', 'account-2', { id: 'account-2', kind: 'folder' as const }, 'same'],
    ['another account', 'account-1', { id: 'account-2', kind: 'folder' as const }, 'changed'],
    ['nothing resumed', undefined, { id: 'account-2', kind: 'folder' as const }, 'none'],
    ['an agent with no accounts', 'account-1', null, 'none'],
  ])('reads %s', (_label, conversationAccountId, resolved, expected) => {
    expect(resumeAccountMatch(conversationAccountId, resolved)).toBe(expected);
  });
});

let root: string;
let home: string;
let repository: AgentAccountRepository;
let config: AgentAccountsConfig;

function folderSupport(): FolderAccountSupport {
  return {
    kind: 'folder',
    accountEnv: (accountFolder) => ({ TEST_AGENT_HOME: accountFolder }),
    defaultHome: () => home,
    loginArgs: ['login'],
    sharedEntries: [{ name: 'projects', how: 'link-dir', conversationBearing: true }],
    identify: async () => ({ signedIn: true, email: null, plan: null, hasSubscription: null }),
    overridingCredentialEnvVars: [],
  };
}

function adapterWith(accounts: FolderAccountSupport | KeyFileAccountSupport): AgentAdapter {
  return { name: 'test-agent', accounts } as unknown as AgentAdapter;
}

function service(adapter: AgentAdapter): AccountService {
  return new AccountService({
    repository,
    getAdapter: (agent) => (agent === 'test-agent' ? adapter : undefined),
    configDir: path.join(root, 'config'),
    readConfig: () => config,
    now: () => NOW_MS,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-service-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  const database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
  config = { orderMode: 'manual', autoSwitchAtLimit: true };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AccountService.resolveForSpawn', () => {
  it('records the agent own login as account #1 and sets no env for it', async () => {
    const accountService = service(adapterWith(folderSupport()));
    const resolved = await accountService.resolveForSpawn('test-agent');
    expect(resolved?.kind).toBe('default');
    expect(resolved?.env).toEqual({});
    expect(repository.listForAgent('test-agent')).toHaveLength(1);
  });

  it('runs on the top account with room, through its home variable, after linking its folder', async () => {
    const accountService = service(adapterWith(folderSupport()));
    const own = accountService.ensureDefaultAccount('test-agent');
    const folder = accountService.nextFolderPath('test-agent');
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: folder });
    repository.updateUsage(own!.id, [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt: NOW + 3600, windowDurationSeconds: 604_800 },
    ]);
    const resolved = await accountService.resolveForSpawn('test-agent');
    expect(resolved).toEqual({ id: second.id, agent: 'test-agent', kind: 'folder', env: { TEST_AGENT_HOME: folder } });
    expect(fs.lstatSync(path.join(folder, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('runs on the account the continuation names', async () => {
    const accountService = service(adapterWith(folderSupport()));
    accountService.ensureDefaultAccount('test-agent');
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    const own = repository.listForAgent('test-agent')[0];
    expect((await accountService.resolveForSpawn('test-agent', own.id))?.id).toBe(own.id);
    expect((await accountService.resolveForSpawn('test-agent', second.id))?.id).toBe(second.id);
  });

  it('resumes a conversation on the account that wrote it, for an agent whose conversations stay put', async () => {
    const accountService = service(adapterWith({ ...folderSupport(), conversationsStayOnAccount: true }));
    const own = accountService.ensureDefaultAccount('test-agent');
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    // The agent's own login is first in the list and has room, so a fresh start takes it.
    expect((await accountService.resolveForSpawn('test-agent'))?.id).toBe(own!.id);
    // A resume of what the second account wrote goes back to it, and stays even when it is full.
    expect((await accountService.resolveForSpawn('test-agent', undefined, second.id))?.id).toBe(second.id);
    repository.updateUsage(second.id, [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 100, resetsAt: NOW + 3600, windowDurationSeconds: 604_800 },
    ]);
    expect((await accountService.resolveForSpawn('test-agent', undefined, second.id))?.id).toBe(second.id);
    // A conversation from the agent's own login (no account on its record) goes back there.
    repository.reorder('test-agent', [second.id, own!.id]);
    repository.updateUsage(second.id, []);
    expect((await accountService.resolveForSpawn('test-agent', undefined, null))?.id).toBe(own!.id);
    // An account that is signed out cannot take it, so the list decides.
    repository.updateStatus(second.id, 'signed-out');
    expect((await accountService.resolveForSpawn('test-agent', undefined, second.id))?.id).toBe(own!.id);
  });

  it('lets the list decide a resume for an agent that resumes anywhere', async () => {
    const accountService = service(adapterWith(folderSupport()));
    const own = accountService.ensureDefaultAccount('test-agent');
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    expect((await accountService.resolveForSpawn('test-agent', undefined, second.id))?.id).toBe(own!.id);
  });

  it('skips an account whose conversation link cannot be made, and marks it', async () => {
    const accountService = service(adapterWith(folderSupport()));
    const folder = accountService.nextFolderPath('test-agent');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'projects'), 'a file where the link must go');
    const broken = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: folder });
    const healthy = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    expect((await accountService.resolveForSpawn('test-agent'))?.id).toBe(healthy.id);
    expect(repository.getById(broken.id)?.status).toBe('link-failed');
  });

  it('puts only the agent key names from a key file into the env', async () => {
    const keyFile = path.join(root, 'work.env');
    fs.writeFileSync(keyFile, 'export OPENROUTER_API_KEY="sk-test"\nUNRELATED=1\n');
    const accountService = service(adapterWith({ kind: 'key-file', keyEnvVars: ['OPENROUTER_API_KEY'], overridingCredentialEnvVars: [] }));
    repository.insert({ agent: 'test-agent', kind: 'key-file', keyFilePath: keyFile, keyNames: ['OPENROUTER_API_KEY'] });
    repository.insert({ agent: 'test-agent', kind: 'key-file', keyFilePath: path.join(root, 'gone.env') });
    expect((await accountService.resolveForSpawn('test-agent'))?.env).toEqual({ OPENROUTER_API_KEY: 'sk-test' });
  });

  it('names the key file in the CLI\'s env-file variable, so a project .env cannot replace its keys', async () => {
    const keyFile = path.join(root, 'work.env');
    fs.writeFileSync(keyFile, 'OPENROUTER_API_KEY=sk-test\n');
    const accountService = service(adapterWith({ kind: 'key-file', keyEnvVars: ['OPENROUTER_API_KEY'], envFileVar: 'TEST_ENV_FILE', overridingCredentialEnvVars: [] }));
    repository.insert({ agent: 'test-agent', kind: 'key-file', keyFilePath: keyFile, keyNames: ['OPENROUTER_API_KEY'] });
    expect((await accountService.resolveForSpawn('test-agent'))?.env).toEqual({ OPENROUTER_API_KEY: 'sk-test', TEST_ENV_FILE: keyFile });
  });

  it('orders by the soonest reset under Automatic', async () => {
    config = { orderMode: 'automatic', autoSwitchAtLimit: true };
    // Its sessions report usage, so Automatic has resets to sort by. An agent that reports none
    // keeps its saved order (account-service-behavior.test.ts).
    const accountService = service({ ...adapterWith(folderSupport()), reportsRateLimits: true } as AgentAdapter);
    const later = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    const sooner = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'config', 'accounts', 'test-agent', '9') });
    repository.updateUsage(later.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 10, resetsAt: NOW + 5 * 86_400, windowDurationSeconds: 604_800 }]);
    repository.updateUsage(sooner.id, [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 10, resetsAt: NOW + 86_400, windowDurationSeconds: 604_800 }]);
    expect(accountService.ordered('test-agent').map((account) => account.id)).toEqual([sooner.id, later.id]);
  });
});

describe('AccountService.recordUsage', () => {
  it('keeps each account its own windows, keeps a window a report leaves out, and writes only on a change', () => {
    const accountService = service(adapterWith(folderSupport()));
    const own = accountService.ensureDefaultAccount('test-agent')!;
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: accountService.nextFolderPath('test-agent') });
    const fiveHour = { id: 'five-hour', label: '5h session', iconKind: 'session' as const, resetsAt: NOW + 3600, windowDurationSeconds: 18_000 };
    const sevenDay = { id: 'seven-day', label: '7d weekly', iconKind: 'period' as const, resetsAt: NOW + 86_400, windowDurationSeconds: 604_800 };

    expect(accountService.recordUsage([
      { ...fiveHour, usedPercentage: 40, accountId: own.id, agent: 'test-agent', generation: 0 },
      { ...sevenDay, usedPercentage: 70, accountId: own.id },
      { ...fiveHour, usedPercentage: 5, accountId: second.id },
      { ...fiveHour, usedPercentage: 99 },
    ])).toEqual([own.id, second.id]);
    expect(repository.getById(own.id)?.lastUsage).toEqual([
      { ...fiveHour, usedPercentage: 40 },
      { ...sevenDay, usedPercentage: 70 },
    ]);
    expect(repository.getById(second.id)?.lastUsage).toEqual([{ ...fiveHour, usedPercentage: 5 }]);

    expect(accountService.recordUsage([{ ...fiveHour, usedPercentage: 40, accountId: own.id }])).toEqual([]);
    expect(accountService.recordUsage([{ ...fiveHour, usedPercentage: 41, accountId: own.id }])).toEqual([own.id]);
    expect(repository.getById(own.id)?.lastUsage?.map((window) => window.usedPercentage)).toEqual([41, 70]);
  });
});

describe('AccountService.envsForBackgroundStop', () => {
  it('names only the session account when it is known, and every account, own login first, when not', () => {
    const accountService = service(adapterWith(folderSupport()));
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'two') });
    const own = accountService.ensureDefaultAccount('test-agent')!;
    expect(accountService.envsForBackgroundStop('test-agent', second.id)).toEqual([{ TEST_AGENT_HOME: path.join(root, 'two') }]);
    expect(accountService.envsForBackgroundStop('test-agent', own.id)).toEqual([undefined]);
    expect(accountService.envsForBackgroundStop('test-agent', null)).toEqual([undefined, { TEST_AGENT_HOME: path.join(root, 'two') }]);
    expect(accountService.envsForBackgroundStop('test-agent', 'gone')).toEqual([undefined, { TEST_AGENT_HOME: path.join(root, 'two') }]);
  });

  it('is the agent own login alone for an agent without accounts', () => {
    const accountService = service({ name: 'test-agent' } as unknown as AgentAdapter);
    expect(accountService.envsForBackgroundStop('test-agent', 'anything')).toEqual([undefined]);
  });
});

describe('buildSessionEnv', () => {
  it('adds the account env over the adapter env, and is unchanged with no account', () => {
    const adapter = { buildEnv: () => ({ FROM_ADAPTER: '1' }) } as unknown as AgentAdapter;
    const base = {} as SpawnCommandOptions;
    expect(buildSessionEnv(adapter, base)).toEqual({ FROM_ADAPTER: '1' });
    expect(buildSessionEnv(adapter, { ...base, account: { id: 'a', agent: 'x', kind: 'folder', env: { HOME_VAR: '/accounts/2' } } }))
      .toEqual({ FROM_ADAPTER: '1', HOME_VAR: '/accounts/2' });
    const quiet = {} as unknown as AgentAdapter;
    expect(buildSessionEnv(quiet, { ...base, account: { id: 'a', agent: 'x', kind: 'default', env: {} } })).toBeNull();
  });
});
