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

  it('keeps the windows an account does not have until an idle read replaces them or the usage is cleared', () => {
    const account = repository.insert({ agent: 'claude', kind: 'folder', folderPath: '/accounts/claude/2' });
    expect(repository.getById(account.id)?.absentWindowIds).toEqual([]);
    const weekly = { id: 'seven-day', label: '7d weekly', iconKind: 'period' as const, usedPercentage: 12, resetsAt: 1_800_000_000, windowDurationSeconds: 604_800 };
    repository.updateUsage(account.id, [weekly], ['five-hour']);
    expect(repository.getById(account.id)?.absentWindowIds).toEqual(['five-hour']);
    // A live report passes none, and keeps what the idle read said.
    repository.updateUsage(account.id, [{ ...weekly, usedPercentage: 13 }]);
    expect(repository.getById(account.id)?.absentWindowIds).toEqual(['five-hour']);
    repository.clearUsage(account.id);
    expect(repository.getById(account.id)?.absentWindowIds).toEqual([]);
  });

  describe('absent_windows_json', () => {
    function columnNames(): string[] {
      return (database.pragma('table_info(agent_accounts)') as Array<{ name: string }>).map((column) => column.name);
    }

    function absentIdsStoredAs(storedText: string | null): string[] | undefined {
      const account = repository.insert({ agent: 'claude', kind: 'folder' });
      database.prepare('UPDATE agent_accounts SET absent_windows_json = ? WHERE id = ?').run(storedText, account.id);
      return repository.getById(account.id)?.absentWindowIds;
    }

    it('is added to a table created without it, keeps its rows, and a second run is harmless', () => {
      database.exec('DROP INDEX IF EXISTS idx_agent_accounts_agent');
      database.exec('ALTER TABLE agent_accounts DROP COLUMN absent_windows_json');
      expect(columnNames()).not.toContain('absent_windows_json');
      database.prepare(
        "INSERT INTO agent_accounts (id, agent, kind, email, position, created_at) VALUES ('legacy', 'claude', 'folder', 'old@example.com', 1, '2026-01-01T00:00:00.000Z')",
      ).run();

      runGlobalMigrations(database);
      expect(columnNames()).toContain('absent_windows_json');
      expect(repository.getById('legacy')?.email).toBe('old@example.com');
      expect(repository.getById('legacy')?.absentWindowIds).toEqual([]);

      expect(() => runGlobalMigrations(database)).not.toThrow();
      expect(columnNames().filter((name) => name === 'absent_windows_json')).toHaveLength(1);
      expect(repository.getById('legacy')?.absentWindowIds).toEqual([]);
    });

    it('reads a stored list of ids as is', () => {
      expect(absentIdsStoredAs('["five-hour","seven-day"]')).toEqual(['five-hour', 'seven-day']);
    });

    it('reads null, an empty string, malformed JSON and a non-array as no absent windows', () => {
      expect(absentIdsStoredAs(null)).toEqual([]);
      expect(absentIdsStoredAs('')).toEqual([]);
      expect(absentIdsStoredAs('[not json')).toEqual([]);
      expect(absentIdsStoredAs('{"five-hour":true}')).toEqual([]);
      expect(absentIdsStoredAs('"five-hour"')).toEqual([]);
    });

    it('keeps only the string ids of an array that holds other values', () => {
      expect(absentIdsStoredAs('["five-hour", 7, null]')).toEqual(['five-hour']);
      expect(absentIdsStoredAs('[7, null, {"id":"x"}, ["y"]]')).toEqual([]);
    });
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
