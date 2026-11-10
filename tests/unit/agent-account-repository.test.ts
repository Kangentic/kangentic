import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';

let database: Database.Database;
let repository: AgentAccountRepository;

beforeEach(() => {
  database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
});

describe('AgentAccountRepository', () => {
  it('adds each account at the bottom of its own agent list', () => {
    const first = repository.insert({ agent: 'claude', kind: 'default', email: 'dev@example.com', plan: 'Ultra' });
    const second = repository.insert({ agent: 'claude', kind: 'folder', folderPath: '/accounts/claude/2' });
    const codex = repository.insert({ agent: 'codex', kind: 'default' });
    expect([first.position, second.position, codex.position]).toEqual([1, 2, 1]);
    expect(repository.listForAgent('claude').map((account) => account.id)).toEqual([first.id, second.id]);
  });

  it('reorders one agent and keeps unlisted accounts after the listed ones', () => {
    const accounts = ['a', 'b', 'c'].map((name) => repository.insert({ agent: 'claude', kind: 'folder', email: `${name}@example.com` }));
    repository.reorder('claude', [accounts[2].id]);
    expect(repository.listForAgent('claude').map((account) => account.email)).toEqual(['c@example.com', 'a@example.com', 'b@example.com']);
  });

  it('stores usage and key names as data and reads them back', () => {
    const account = repository.insert({ agent: 'aider', kind: 'key-file', keyFilePath: '/keys/work.env', keyNames: ['OPENROUTER_API_KEY'] });
    repository.updateUsage(account.id, [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 42, resetsAt: 1_800_000_000, windowDurationSeconds: 604_800 },
    ]);
    const stored = repository.getById(account.id);
    expect(stored?.keyNames).toEqual(['OPENROUTER_API_KEY']);
    expect(stored?.lastUsage?.[0].usedPercentage).toBe(42);
    expect(stored?.lastUsageAt).toMatch(/Z$/);
  });

  it('closes the gap a removed account leaves', () => {
    const accounts = ['a', 'b', 'c'].map((name) => repository.insert({ agent: 'claude', kind: 'folder', email: `${name}@example.com` }));
    repository.delete(accounts[0].id);
    expect(repository.listForAgent('claude').map((account) => account.position)).toEqual([1, 2]);
    expect(repository.getById(accounts[0].id)).toBeNull();
  });

  it('refuses an unknown account kind', () => {
    expect(() =>
      database
        .prepare("INSERT INTO agent_accounts (id, agent, kind, position, created_at) VALUES ('x', 'claude', 'swap', 1, '2026-11-09T00:00:00.000Z')")
        .run(),
    ).toThrow();
  });
});
