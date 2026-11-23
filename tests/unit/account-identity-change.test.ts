/**
 * A login replaced in an account's home (task #1113), through the real AccountService on an
 * in-memory database with a stub adapter whose homes each hold a login the test sets. A `/login`
 * in a session on the agent's own home replaced its login with one a folder account held; the next
 * sign-in read rewrote the row's email, so the tab listed one login twice and the replaced login
 * was listed nowhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountService, type AccountServiceDependencies } from '../../src/main/accounts/account-service';
import { IdentityReadError, type AccountIdentity, type FolderAccountSupport } from '../../src/main/accounts/account-support';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';
import type { AgentAccount } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const AGENT = 'test-agent';
const NOW_MS = 1_800_000_000_000;

type ReportArguments = Parameters<NonNullable<AccountServiceDependencies['reportProblem']>>;

let root: string;
let database: Database.Database;
let repository: AgentAccountRepository;
let reports: ReportArguments[];
let repoints: Array<[string, string]>;
/** What each home holds, keyed by folder path, `own` for the agent's own home. */
let homes: Map<string, AccountIdentity | 'no-answer'>;
let identifyCalls: number;
let idleWindows: RateLimitWindow[];
/** True when the agent's CLI runs somewhere account folders do not reach (a WSL distro). */
let remoteTarget: boolean;
/** When set, every `identify` waits on it after taking its answer, so a test holds reads in flight. */
let identifyGate: Promise<void> | null;
/** True when the sessions' re-point handler throws. */
let repointThrows: boolean;

function loginOf(email: string, orgId: string | null = null): AccountIdentity {
  return { signedIn: true, email, orgId, plan: 'Ultra', hasSubscription: true };
}

function sevenDay(usedPercentage: number): RateLimitWindow {
  return { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt: NOW_MS / 1000 + 3600, windowDurationSeconds: 604_800 };
}

function homeOf(folder: string | null): AccountIdentity | 'no-answer' | undefined {
  return homes.get(folder ?? 'own');
}

function support(): FolderAccountSupport {
  return {
    kind: 'folder',
    accountEnv: (accountFolder) => ({ TEST_AGENT_HOME: accountFolder }),
    homeEnvVars: ['TEST_AGENT_HOME'],
    defaultHome: () => path.join(root, 'home'),
    loginArgs: ['login'],
    loginEmailArgs: (email) => ['--email', email],
    sharedEntries: [],
    identify: async (_cliPath, folder) => {
      identifyCalls += 1;
      const held = homeOf(folder);
      if (identifyGate) await identifyGate;
      if (held === 'no-answer') throw new IdentityReadError('run-failed');
      return held ??{ signedIn: false, email: null, plan: null, hasSubscription: null };
    },
    readHomeIdentity: async (folder) => {
      const held = homeOf(folder);
      return held && held !== 'no-answer' && held.email ? { email: held.email, orgId: held.orgId ?? null } : null;
    },
    readIdleUsage: async () => idleWindows,
    overridingCredentialEnvVars: [],
  };
}

function service(): AccountService {
  const adapter = { name: AGENT, accounts: support() } as unknown as AgentAdapter;
  return new AccountService({
    repository,
    getAdapter: (agent) => (agent === AGENT ? adapter : undefined),
    configDir: path.join(root, 'config'),
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
    resolveCliPath: async () => '/usr/bin/test-cli',
    reportProblem: (...reportArguments) => { reports.push(reportArguments); },
    usesRemoteTarget: async () => remoteTarget,
    repointSessions: (homeAccountId, toAccountId) => {
      if (repointThrows) throw new Error('repoint failed');
      repoints.push([homeAccountId, toAccountId]);
    },
    now: () => NOW_MS,
  });
}

/** The agent's own home holding `email`, and a folder account holding `folderEmail`. */
function ownAndFolder(email: string, folderEmail: string): { own: AgentAccount; folder: AgentAccount } {
  const own = repository.insert({ agent: AGENT, kind: 'default', email, plan: 'Ultra' });
  const folderPath = path.join(root, 'config', 'accounts', AGENT, '2');
  fs.mkdirSync(folderPath, { recursive: true });
  const folder = repository.insert({ agent: AGENT, kind: 'folder', folderPath, email: folderEmail, plan: 'Ultra' });
  homes.set('own', loginOf(email));
  homes.set(folderPath, loginOf(folderEmail));
  repository.updateUsage(own.id, [sevenDay(40)]);
  repository.updateUsage(folder.id, [sevenDay(99)]);
  return { own, folder };
}

function changeReports(): ReportArguments[] {
  return reports.filter(([problem]) => problem === 'identity-changed');
}

function listedEmails(): Array<string | null> {
  return repository.listForAgent(AGENT).map((account) => account.email);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-identity-change-'));
  database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
  reports = [];
  repoints = [];
  homes = new Map();
  identifyCalls = 0;
  idleWindows = [sevenDay(5)];
  remoteTarget = false;
  identifyGate = null;
  repointThrows = false;
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a home whose login was replaced by a listed one', () => {
  it('keeps the replaced login listed, lists the new one once, and moves the home\'s sessions to its row', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const after = await service().refreshIdentity(own.id);
    expect(after?.status).toBe('replaced');
    expect(after?.email).toBe('a@example.com');
    // The 40% read for the old login, and no row inherits the new login's reading.
    expect(after?.lastUsage).toBeNull();
    expect(repository.getById(folder.id)?.status).toBe('ok');
    expect(listedEmails().filter((email) => email === 'b@example.com')).toHaveLength(1);
    expect(repoints).toEqual([[own.id, folder.id]]);
    // `default_home` says whether the agent's own home was its built-in one (Sentry DESKTOP-4R).
    expect(changeReports().map(([problem, agent, facts]) => [problem, agent, facts])).toEqual([['identity-changed', AGENT, { kind: 'default', change: 'to-listed', default_home: 'builtin' }]]);
    // No email or path leaves in the report.
    expect(JSON.stringify(changeReports())).not.toContain('example.com');
  });

  it('reports and writes nothing again on the next read of the same home', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    await accountService.refreshIdentity(own.id);
    expect(changeReports()).toHaveLength(1);
    expect(repository.getById(own.id)?.status).toBe('replaced');
  });

  it('runs again once its home holds its own login', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    homes.set('own', loginOf('a@example.com'));
    expect((await accountService.refreshIdentity(own.id))?.status).toBe('ok');
    expect(repoints.at(-1)).toEqual([own.id, own.id]);
  });
});

describe('a home whose login was replaced by a new one', () => {
  it('lists the new login on the home\'s row and keeps the old one on a row of its own', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('c@example.com'));
    const after = await service().refreshIdentity(own.id);
    expect(after?.email).toBe('c@example.com');
    expect(after?.status).toBe('ok');
    expect(after?.lastUsage).toBeNull();
    const kept = repository.listForAgent(AGENT).find((account) => account.email === 'a@example.com');
    expect(kept?.status).toBe('replaced');
    expect(kept?.kind).toBe('folder');
    // A folder of its own, so its Sign in never replaces the login the home holds now.
    expect(kept?.folderPath).not.toBeNull();
    expect(kept?.folderPath).not.toBe(folder.folderPath);
    expect(listedEmails().sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(changeReports().map(([, , facts]) => facts?.change)).toEqual(['to-new']);
  });

  // A user with one account sees no change: their row is whatever their CLI is signed in to.
  it('adds no row for a user with one account', async () => {
    const own = repository.insert({ agent: AGENT, kind: 'default', email: 'a@example.com', plan: 'Ultra' });
    homes.set('own', loginOf('c@example.com'));
    await service().refreshIdentity(own.id);
    expect(listedEmails()).toEqual(['c@example.com']);
    expect(changeReports()).toEqual([]);
  });
});

describe('a read that is not a change', () => {
  it('leaves the row alone when the CLI gives no answer', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', 'no-answer');
    const after = await service().refreshIdentity(own.id);
    expect(after?.email).toBe('a@example.com');
    expect(after?.status).toBe('ok');
    expect(after?.lastUsage).not.toBeNull();
    expect(changeReports()).toEqual([]);
  });

  it('leaves the row\'s login alone when the CLI answers with no email', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', { signedIn: true, email: null, plan: 'Ultra', hasSubscription: true });
    expect((await service().refreshIdentity(own.id))?.email).toBe('a@example.com');
    expect(changeReports()).toEqual([]);
  });

  it('keeps one email in two organizations as two accounts', async () => {
    const own = repository.insert({ agent: AGENT, kind: 'default', email: 'a@example.com', orgId: 'org-a', plan: 'Ultra' });
    const folderPath = path.join(root, 'config', 'accounts', AGENT, '2');
    fs.mkdirSync(folderPath, { recursive: true });
    const folder = repository.insert({ agent: AGENT, kind: 'folder', folderPath, email: 'a@example.com', orgId: 'org-b', plan: 'Ultra' });
    homes.set('own', loginOf('a@example.com', 'org-a'));
    homes.set(folderPath, loginOf('a@example.com', 'org-b'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    await accountService.refreshIdentity(folder.id);
    expect(repository.listForAgent(AGENT).map((account) => account.status)).toEqual(['ok', 'ok']);
    expect(changeReports()).toEqual([]);
  });
});

describe('a list that already names one login twice', () => {
  it('sets the agent\'s own home aside, with no email, on the next read', async () => {
    const { own, folder } = ownAndFolder('b@example.com', 'b@example.com');
    await service().refreshIdentity(folder.id);
    expect(repository.getById(own.id)?.status).toBe('replaced');
    expect(repository.getById(own.id)?.email).toBeNull();
    expect(repository.getById(folder.id)?.status).toBe('ok');
    expect(repoints).toContainEqual([own.id, folder.id]);
  });
});

describe('usage after a swap', () => {
  it('lands a live report on the row of the login the session now runs as, never on the replaced row', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    // A report stamped before the session was re-pointed, and one after.
    accountService.recordUsage([{ ...sevenDay(97), accountId: own.id }]);
    accountService.recordUsage([{ ...sevenDay(97), accountId: folder.id }]);
    expect(repository.getById(own.id)?.lastUsage).toBeNull();
    expect(repository.getById(folder.id)?.lastUsage?.[0]?.usedPercentage).toBe(97);
  });

  it('stores no idle reading on a row whose home holds another login, and reconciles the home instead', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    expect(await service().refreshUsage(own.id)).toBe(false);
    expect(repository.getById(own.id)?.lastUsage).toBeNull();
    expect(repository.getById(own.id)?.status).toBe('replaced');
  });
});

describe('the cheap check of a home', () => {
  it('runs no CLI when the home still holds the row\'s login', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    await service().checkHomeIdentity(own.id);
    expect(identifyCalls).toBe(0);
  });

  it('asks the CLI once the home records another login', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    await service().checkHomeIdentity(own.id);
    expect(identifyCalls).toBe(1);
    expect(repository.getById(own.id)?.status).toBe('replaced');
  });
});

describe('signing a replaced login in again through Add account', () => {
  // The incident's way back: the agent's own home lost A to a /login and holds B, which a folder
  // account holds. Add account signs A into a new folder.
  it('lists the agent\'s own home\'s old login on the new folder and each login once', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    const created = await accountService.createFolderAccount(AGENT);
    homes.set(created!.folderPath!, loginOf('a@example.com'));
    const result = await accountService.completeLogin(created!.id);
    expect(result.account?.id).toBe(created!.id);
    expect(result.account?.status).toBe('ok');
    expect(result.duplicateOf).toBeNull();
    expect(listedEmails().filter((email) => email === 'a@example.com')).toHaveLength(1);
    expect(listedEmails().filter((email) => email === 'b@example.com')).toHaveLength(1);
    expect(repository.getById(own.id)?.status).toBe('replaced');
    expect(repository.getById(folder.id)?.status).toBe('ok');
  });

  it('hands a replaced folder row the new folder that holds its login', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set(folder.folderPath!, loginOf('a@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(folder.id);
    expect(repository.getById(folder.id)?.status).toBe('replaced');
    const created = await accountService.createFolderAccount(AGENT);
    homes.set(created!.folderPath!, loginOf('b@example.com'));
    const repointsBefore = repoints.length;
    const identifyBefore = identifyCalls;
    const result = await accountService.completeLogin(created!.id);
    expect(result.account?.id).toBe(folder.id);
    expect(result.account?.status).toBe('ok');
    expect(repository.getById(created!.id)).toBeNull();
    expect(repository.getById(folder.id)?.folderPath).toBe(created!.folderPath);
    expect(repository.getById(folder.id)?.status).toBe('ok');
    expect(repository.getById(own.id)?.status).toBe('ok');
    // The sessions still running in the old folder hold another login: they are never re-pointed
    // to the row that now owns the new folder.
    expect(repoints.slice(repointsBefore)).not.toContainEqual([folder.id, folder.id]);
    // The one read completeLogin made is not repeated by a second pass through refreshIdentity.
    expect(identifyCalls - identifyBefore).toBe(1);
  });
});

describe('signing in a row again', () => {
  it('never deletes the agent\'s own home when its sign-in ends signed out', async () => {
    const own = repository.insert({ agent: AGENT, kind: 'default', status: 'signed-out' });
    const result = await service().completeLogin(own.id);
    expect(repository.getById(own.id)).not.toBeNull();
    expect(result.account?.id).toBe(own.id);
  });

  it('signs the agent\'s own home in with no home variable and the row\'s email filled in', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    const command = await service().loginCommand(own.id);
    expect(command?.env).toEqual({});
    expect(command?.args).toEqual(['login', '--email', 'a@example.com']);
  });

  it('gives no sign-in command for the agent\'s own home when its CLI runs in a WSL distro', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    remoteTarget = true;
    expect(await service().loginCommand(own.id)).toBeNull();
  });

  it('ends a Sign in on a row that landed another listed login set aside, and names the row that holds it', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    // The browser held the login the agent's own home lists.
    homes.set(folder.folderPath!, loginOf('a@example.com'));
    const result = await service().completeLogin(folder.id);
    expect(result.account?.id).toBe(folder.id);
    expect(result.account?.status).toBe('replaced');
    expect(result.duplicateOf?.id).toBe(own.id);
  });
});

describe('two reads of one home that overlap', () => {
  it('lists the replaced login once, because the second read decides from the row the first wrote', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('c@example.com'));
    let release: () => void = () => {};
    identifyGate = new Promise<void>((resolve) => { release = resolve; });
    const accountService = service();
    const first = accountService.refreshIdentity(own.id);
    const second = accountService.refreshIdentity(own.id);
    // Both reads are in flight, each holding the row as it was before either applied.
    for (let attempt = 0; attempt < 100 && identifyCalls < 2; attempt += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect(identifyCalls).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(listedEmails().filter((email) => email === 'a@example.com')).toHaveLength(1);
    expect(repository.listForAgent(AGENT).filter((account) => account.status === 'replaced')).toHaveLength(1);
    expect(repository.listForAgent(AGENT)).toHaveLength(3);
    expect(repository.getById(own.id)?.email).toBe('c@example.com');
  });
});

describe('a home whose login a set-aside row already names', () => {
  it('hands that row the replaced login instead of adding one', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    const keptFolder = path.join(root, 'config', 'accounts', AGENT, '3');
    fs.mkdirSync(keptFolder, { recursive: true });
    const setAside = repository.insert({ agent: AGENT, kind: 'folder', folderPath: keptFolder, email: 'c@example.com', plan: 'Ultra', status: 'replaced' });
    repository.updateUsage(setAside.id, [sevenDay(70)]);
    homes.set('own', loginOf('c@example.com'));
    const after = await service().refreshIdentity(own.id);
    expect(repository.listForAgent(AGENT)).toHaveLength(3);
    expect(after?.email).toBe('c@example.com');
    expect(after?.status).toBe('ok');
    expect(after?.lastUsage).toBeNull();
    const handed = repository.getById(setAside.id);
    expect(handed?.email).toBe('a@example.com');
    expect(handed?.status).toBe('replaced');
    expect(handed?.lastUsage).toBeNull();
    expect(changeReports().map(([, , facts]) => facts?.change)).toEqual(['merged']);
  });
});

describe('a row with no email whose home holds a listed login', () => {
  it('is set aside with no email and its sessions move to the row that names the login', async () => {
    const own = repository.insert({ agent: AGENT, kind: 'default' });
    const folderPath = path.join(root, 'config', 'accounts', AGENT, '2');
    fs.mkdirSync(folderPath, { recursive: true });
    const folder = repository.insert({ agent: AGENT, kind: 'folder', folderPath, email: 'b@example.com', plan: 'Ultra' });
    homes.set('own', loginOf('b@example.com'));
    const after = await service().refreshIdentity(own.id);
    expect(after?.status).toBe('replaced');
    expect(after?.email).toBeNull();
    expect(repository.getById(folder.id)?.status).toBe('ok');
    expect(repoints).toEqual([[own.id, folder.id]]);
    expect(changeReports().map(([, , facts]) => facts?.change)).toEqual(['already-listed']);
  });
});

describe('the cheap check of a set-aside row or a remote home', () => {
  it('runs no CLI for a replaced row whose home still holds the listed row\'s login', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    identifyCalls = 0;
    await accountService.checkHomeIdentity(own.id);
    expect(identifyCalls).toBe(0);
    expect(repository.getById(own.id)?.status).toBe('replaced');
  });

  it('runs the CLI once for a replaced row whose home holds its own login again, and it ends ok', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    homes.set('own', loginOf('a@example.com'));
    identifyCalls = 0;
    await accountService.checkHomeIdentity(own.id);
    expect(identifyCalls).toBe(1);
    expect(repository.getById(own.id)?.status).toBe('ok');
  });

  it('reads nothing and runs no CLI for any home when the CLI runs in a WSL distro', async () => {
    const { own, folder } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('c@example.com'));
    homes.set(folder.folderPath!, loginOf('d@example.com'));
    remoteTarget = true;
    const accountService = service();
    await accountService.checkHomeIdentity(own.id);
    await accountService.checkHomeIdentity(folder.id);
    expect(identifyCalls).toBe(0);
    expect(repository.getById(own.id)?.email).toBe('a@example.com');
    expect(repository.getById(folder.id)?.email).toBe('b@example.com');
    expect(changeReports()).toEqual([]);
  });
});

describe('an idle usage read of a set-aside row', () => {
  it('reads nothing and stores nothing, even when its home holds its own login', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    const accountService = service();
    await accountService.refreshIdentity(own.id);
    repository.updateUsage(own.id, [sevenDay(40)]);
    homes.set('own', loginOf('a@example.com'));
    idleWindows = [sevenDay(5)];
    identifyCalls = 0;
    expect(await accountService.refreshUsage(own.id)).toBe(false);
    expect(repository.getById(own.id)?.status).toBe('replaced');
    expect(repository.getById(own.id)?.lastUsage?.[0]?.usedPercentage).toBe(40);
    expect(identifyCalls).toBe(0);
  });
});

describe('the sign-in of a row made for it', () => {
  it('deletes the row and returns no account when the read is signed out', async () => {
    const accountService = service();
    const created = await accountService.createFolderAccount(AGENT);
    const result = await accountService.completeLogin(created!.id);
    expect(result.account).toBeNull();
    expect(result.duplicateOf).toBeNull();
    expect(repository.getById(created!.id)).toBeNull();
  });

  it('deletes the row and names the listed row when the read is a login already listed', async () => {
    const { folder } = ownAndFolder('a@example.com', 'b@example.com');
    const accountService = service();
    const created = await accountService.createFolderAccount(AGENT);
    homes.set(created!.folderPath!, loginOf('b@example.com'));
    const result = await accountService.completeLogin(created!.id);
    expect(result.account).toBeNull();
    expect(result.duplicateOf?.id).toBe(folder.id);
    expect(repository.getById(created!.id)).toBeNull();
    expect(listedEmails().filter((email) => email === 'b@example.com')).toHaveLength(1);
  });

  it('keeps the row ok with its email on a clean first login', async () => {
    const accountService = service();
    const created = await accountService.createFolderAccount(AGENT);
    homes.set(created!.folderPath!, loginOf('a@example.com'));
    const result = await accountService.completeLogin(created!.id);
    expect(result.duplicateOf).toBeNull();
    expect(result.account?.id).toBe(created!.id);
    expect(result.account?.status).toBe('ok');
    expect(result.account?.email).toBe('a@example.com');
  });
});

describe('a re-point that throws', () => {
  it('leaves the list right and reports the repoint stage', async () => {
    const { own } = ownAndFolder('a@example.com', 'b@example.com');
    homes.set('own', loginOf('b@example.com'));
    repointThrows = true;
    const after = await service().refreshIdentity(own.id);
    expect(after?.status).toBe('replaced');
    expect(after?.email).toBe('a@example.com');
    expect(listedEmails().filter((email) => email === 'b@example.com')).toHaveLength(1);
    const repointReports = reports.filter(([problem, , facts]) => problem === 'identity-changed' && facts?.stage === 'repoint');
    expect(repointReports).toHaveLength(1);
    expect(repointReports[0][1]).toBe(AGENT);
  });
});
