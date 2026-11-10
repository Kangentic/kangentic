/**
 * A session that starts on an account of its own and whose CLI says it is not signed in marks
 * that account signed out, so the next spawn passes over it and its row offers Sign in. The exit
 * handler in `ipc/handlers/sessions.ts` asks `noteLaunchNotSignedIn`; this pins what it decides,
 * against the real service over a real (in-memory) accounts table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountService, noteLaunchNotSignedIn, setAccountService } from '../../src/main/accounts/account-service';
import type { FolderAccountSupport } from '../../src/main/accounts/account-support';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';

let root: string;
let database: Database.Database;
let repository: AgentAccountRepository;

function folderSupport(home: string): FolderAccountSupport {
  return {
    kind: 'folder',
    overridingCredentialEnvVars: [],
    defaultHome: () => home,
    loginArgs: ['login'],
    sharedEntries: [],
    accountEnv: (folder) => ({ TEST_AGENT_HOME: folder }),
    identify: async () => ({ signedIn: true, email: 'dev@example.com', plan: null }),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-launch-signed-out-'));
  database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
  const adapter = { name: 'test-agent', accounts: folderSupport(path.join(root, 'home')) } as unknown as AgentAdapter;
  setAccountService(new AccountService({
    repository,
    getAdapter: (agent) => (agent === 'test-agent' ? adapter : undefined),
    configDir: path.join(root, 'config'),
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
  }));
});

afterEach(() => {
  setAccountService(null);
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('noteLaunchNotSignedIn', () => {
  it('marks the account signed out when its session started not signed in', () => {
    const account = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'config', 'accounts', 'test-agent', '2') });
    noteLaunchNotSignedIn('login_required', account.id);
    expect(repository.getById(account.id)?.status).toBe('signed-out');
  });

  it('leaves the account alone for any other ending', () => {
    const account = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'config', 'accounts', 'test-agent', '2') });
    noteLaunchNotSignedIn('rate_limited', account.id);
    noteLaunchNotSignedIn(undefined, account.id);
    expect(repository.getById(account.id)?.status).toBe('ok');
  });

  it('does nothing for a session with no account, or with no service running', () => {
    expect(() => noteLaunchNotSignedIn('login_required', null)).not.toThrow();
    const account = repository.insert({ agent: 'test-agent', kind: 'folder', folderPath: path.join(root, 'config', 'accounts', 'test-agent', '2') });
    setAccountService(null);
    noteLaunchNotSignedIn('login_required', account.id);
    expect(repository.getById(account.id)?.status).toBe('ok');
  });
});
