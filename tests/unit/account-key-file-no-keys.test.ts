/**
 * Adding a key file that can be read but sets none of the agent's variables answers `no-keys`, so
 * the Accounts tab says the file holds no key the agent reads. It used to answer `unreadable`,
 * the answer for a file that is missing, because the reader returns nothing in both cases.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountService } from '../../src/main/accounts/account-service';
import type { KeyFileAccountSupport } from '../../src/main/accounts/account-support';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';

let root: string;
let database: Database.Database;
let accountService: AccountService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-key-file-reasons-'));
  database = new Database(':memory:');
  runGlobalMigrations(database);
  const support: KeyFileAccountSupport = { kind: 'key-file', overridingCredentialEnvVars: [], keyEnvVars: ['TEST_AGENT_API_KEY'] };
  const adapter = { name: 'test-agent', accounts: support } as unknown as AgentAdapter;
  accountService = new AccountService({
    repository: new AgentAccountRepository(() => database),
    getAdapter: (agent) => (agent === 'test-agent' ? adapter : undefined),
    configDir: path.join(root, 'config'),
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
  });
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AccountService.addKeyFileAccount', () => {
  it('answers no-keys for a readable file that sets none of the agent variables', () => {
    const keyFile = path.join(root, 'other.env');
    fs.writeFileSync(keyFile, 'SOME_OTHER_KEY=value\n');
    expect(accountService.addKeyFileAccount('test-agent', keyFile)).toEqual({ ok: false, reason: 'no-keys' });
  });

  it('answers unreadable for a file that is not there, and for a folder', () => {
    expect(accountService.addKeyFileAccount('test-agent', path.join(root, 'missing.env'))).toEqual({ ok: false, reason: 'unreadable' });
    expect(accountService.addKeyFileAccount('test-agent', root)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('adds the account when the file sets one', () => {
    const keyFile = path.join(root, 'agent.env');
    fs.writeFileSync(keyFile, 'TEST_AGENT_API_KEY=made-up-value\n');
    const added = accountService.addKeyFileAccount('test-agent', keyFile);
    expect(added.ok && added.account.keyNames).toEqual(['TEST_AGENT_API_KEY']);
  });
});
