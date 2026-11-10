/**
 * What reaches error reporting about accounts, and what never does. Most agents' account support
 * was built with no second account to run it on, so these reports are how a wrong guess is found.
 * What a user loses if they go: a broken account nobody hears about, or a path or address of
 * theirs sent off the machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubFailureDetail, type AccountProblem, type AccountProblemFacts } from '../../src/main/accounts/account-report';
import { AccountService } from '../../src/main/accounts/account-service';
import { UnreadableUsageError, type FolderAccountSupport } from '../../src/main/accounts/account-support';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { CODEX_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/codex/accounts';
import { GROK_ACCOUNT_SUPPORT, parseGrokBilling } from '../../src/main/agent/adapters/grok/accounts';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';

let root: string;
let home: string;
let repository: AgentAccountRepository;
let reports: Array<{ problem: AccountProblem; agent: string; facts?: AccountProblemFacts }>;

function folderSupport(overrides: Partial<FolderAccountSupport> = {}): FolderAccountSupport {
  return {
    kind: 'folder',
    accountEnv: (accountFolder) => ({ TEST_AGENT_HOME: accountFolder }),
    defaultHome: () => home,
    loginArgs: ['login'],
    sharedEntries: [{ name: 'projects', how: 'link-dir', conversationBearing: true }],
    identify: async () => ({ signedIn: true, email: null, plan: null, hasSubscription: null }),
    overridingCredentialEnvVars: [],
    ...overrides,
  };
}

function service(support: FolderAccountSupport): AccountService {
  const adapter = { name: 'test-agent', accounts: support } as unknown as AgentAdapter;
  return new AccountService({
    repository,
    getAdapter: (agent) => (agent === 'test-agent' ? adapter : undefined),
    configDir: path.join(root, 'config'),
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
    reportProblem: (problem, agent, facts) => { reports.push({ problem, agent, facts }); },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-report-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  const database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
  reports = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what the account service reports', () => {
  it('names the entry of a link it could not make, never a path', async () => {
    const accountService = service(folderSupport());
    accountService.ensureDefaultAccount('test-agent');
    const folder = accountService.nextFolderPath('test-agent');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'projects'), 'a file where the link goes');
    const account = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: folder });
    expect(await accountService.refreshFolder(account)).toBe(false);
    expect(reports).toEqual([{ problem: 'folder-entry-user-owned', agent: 'test-agent', facts: { entry: 'projects', blocksAccount: true } }]);
    expect(JSON.stringify(reports)).not.toContain(root);
  });

  it('says when a spawn had accounts and none could be prepared', async () => {
    const accountService = service(folderSupport());
    accountService.ensureDefaultAccount('test-agent');
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'gone', '2'), status: 'signed-out' });
    const own = repository.listForAgent('test-agent')[0];
    repository.updateStatus(own.id, 'signed-out');
    // The spawn still runs, on the agent's own login, and is recorded against that row.
    expect(await accountService.resolveForSpawn('test-agent')).toEqual({ id: own.id, agent: 'test-agent', kind: 'default', env: {} });
    expect(reports.map((report) => report.problem)).toEqual(['spawn-account-unresolved']);
    expect(repository.getById(second.id)?.status).toBe('signed-out');
  });

  it('reports a usage answer the adapter could not read, by its field names, and keeps the last values', async () => {
    const unreadable = folderSupport({ readIdleUsage: async () => { throw new UnreadableUsageError('subscription_tier'); } });
    const adapter = { name: 'test-agent', accounts: unreadable } as unknown as AgentAdapter;
    const accountService = new AccountService({
      repository,
      getAdapter: () => adapter,
      configDir: path.join(root, 'config'),
      readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
      resolveCliPath: async () => '/usr/bin/test-agent',
      reportProblem: (problem, agent, facts) => { reports.push({ problem, agent, facts }); },
    });
    const account = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'u') });
    expect(await accountService.refreshUsage(account.id)).toBe(false);
    expect(reports).toEqual([{ problem: 'usage-read-unreadable', agent: 'test-agent', facts: { keys: 'subscription_tier' } }]);
  });

  it('marks an account signed out when its session starts signed out, and reports it only where unproven', () => {
    const proven = service(folderSupport());
    const first = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'a') });
    proven.noteSessionNotSignedIn(first.id);
    expect(repository.getById(first.id)?.status).toBe('signed-out');
    expect(reports).toEqual([]);

    const unproven = service(folderSupport({ unproven: true }));
    const second = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'b') });
    unproven.noteSessionNotSignedIn(second.id);
    expect(repository.getById(second.id)?.status).toBe('signed-out');
    expect(reports).toEqual([{ problem: 'session-not-signed-in', agent: 'test-agent', facts: undefined }]);
    // Already signed out: nothing more to say.
    unproven.noteSessionNotSignedIn(second.id);
    expect(reports).toHaveLength(1);
  });
});

describe('scrubFailureDetail', () => {
  it('cuts addresses, home folders and long ids out of a provider error, and keeps its words', () => {
    const detail = 'Encrypted content organization_id did not match for dev@example.com at C:\\Users\\dev\\repo using org-AbCdEfGhIjKlMnOpQrStUvWxYz0123';
    const scrubbed = scrubFailureDetail(detail);
    expect(scrubbed).toContain('organization_id did not match');
    expect(scrubbed).not.toContain('dev@example.com');
    expect(scrubbed).not.toContain('Users\\dev');
    expect(scrubbed).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123');
  });

  it('keeps it to one short line', () => {
    expect(scrubFailureDetail(`first\n${'word '.repeat(200)}`).length).toBeLessThanOrEqual(200);
    expect(scrubFailureDetail('a\n\n  b')).toBe('a b');
  });
});

describe('the adapters\' own words', () => {
  it('Codex names a conversation another login\'s reasoning belongs to', () => {
    expect(CODEX_ACCOUNT_SUPPORT.isConversationRefusal?.('The encrypted content could not be verified. Reason: Encrypted content organization_id did not match the target organization.')).toBe(true);
    expect(CODEX_ACCOUNT_SUPPORT.isConversationRefusal?.('stream disconnected before completion')).toBe(false);
  });

  it('Grok reads a spent plan in either class its hook gives, and not an ordinary failure', () => {
    expect(GROK_ACCOUNT_SUPPORT.isUsageLimitFailure?.('invalid_request')).toBe(true);
    expect(GROK_ACCOUNT_SUPPORT.isUsageLimitFailure?.('rate_limit')).toBe(true);
    expect(GROK_ACCOUNT_SUPPORT.isUsageLimitFailure?.('You ran out of credits. [WKE=personal-team-blocked:spending-limit]')).toBe(true);
    expect(GROK_ACCOUNT_SUPPORT.isUsageLimitFailure?.('server_error')).toBe(false);
  });
});

describe('parseGrokBilling', () => {
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-03T00:00:00Z', end: '2026-11-10T00:00:00Z' };

  it('reads the share of the period used and when it resets', () => {
    expect(parseGrokBilling({ config: { creditUsagePercent: 62.5, currentPeriod: period } })).toEqual([{
      id: 'grok-credits',
      label: '7d weekly',
      iconKind: 'period',
      usedPercentage: 62.5,
      resetsAt: Date.parse('2026-11-10T00:00:00Z') / 1000,
      windowDurationSeconds: 7 * 86_400,
    }]);
  });

  it('reads a missing percent as none used, the shape an unused account answered with', () => {
    const windows = parseGrokBilling({ config: { currentPeriod: period, onDemandUsed: { val: 0 }, isUnifiedBillingUser: true } });
    expect(windows?.[0].usedPercentage).toBe(0);
  });

  it('is null for an answer with no config, which is reported', () => {
    expect(parseGrokBilling({ subscription_tier: 'x' })).toBeNull();
    expect(parseGrokBilling(null)).toBeNull();
  });
});
