import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { AgentAccountRepository } from '../../src/main/db/repositories/agent-account-repository';

let database: Database.Database;
let repository: AgentAccountRepository;

function addThree(agent = 'claude') {
  return ['a', 'b', 'c'].map((name) => repository.insert({ agent, kind: 'folder', email: `${name}@example.com` }));
}

beforeEach(() => {
  database = new Database(':memory:');
  runGlobalMigrations(database);
  repository = new AgentAccountRepository(() => database);
});

describe('AgentAccountRepository writes and reads', () => {
  it('updateIdentity writes email, plan and status', () => {
    const account = repository.insert({ agent: 'claude', kind: 'folder' });
    repository.updateIdentity(account.id, { email: 'dev@example.com', plan: 'Max 20x', status: 'signed-out' });
    const stored = repository.getById(account.id);
    expect([stored?.email, stored?.plan, stored?.status]).toEqual(['dev@example.com', 'Max 20x', 'signed-out']);
  });

  it('setHistoryPrivate round-trips to historyPrivate', () => {
    const account = repository.insert({ agent: 'claude', kind: 'folder' });
    expect(account.historyPrivate).toBe(false);
    repository.setHistoryPrivate(account.id, true);
    expect(repository.getById(account.id)?.historyPrivate).toBe(true);
    repository.setHistoryPrivate(account.id, false);
    expect(repository.getById(account.id)?.historyPrivate).toBe(false);
  });

  it('reads corrupt key_names as [] and corrupt last_usage_json as null', () => {
    const account = repository.insert({ agent: 'aider', kind: 'key-file', keyNames: ['A_KEY'] });
    database.prepare("UPDATE agent_accounts SET key_names = '{not json', last_usage_json = '[oops' WHERE id = ?").run(account.id);
    const stored = repository.getById(account.id);
    expect(stored?.keyNames).toEqual([]);
    expect(stored?.lastUsage).toBeNull();
  });
});

describe('AgentAccountRepository ordering', () => {
  it('reorder with a repeated id leaves dense positions 1..n', () => {
    const [first, second, third] = addThree();
    repository.reorder('claude', [second.id, second.id, first.id]);
    const stored = repository.listForAgent('claude');
    expect(stored.map((account) => account.id)).toEqual([second.id, first.id, third.id]);
    expect(stored.map((account) => account.position)).toEqual([1, 2, 3]);
  });

  it('reorder ignores an id of another agent', () => {
    const [first, second, third] = addThree();
    const codex = repository.insert({ agent: 'codex', kind: 'folder' });
    repository.reorder('claude', [codex.id, second.id]);
    const stored = repository.listForAgent('claude');
    expect(stored.map((account) => account.id)).toEqual([second.id, first.id, third.id]);
    expect(stored.map((account) => account.position)).toEqual([1, 2, 3]);
    expect(repository.getById(codex.id)?.position).toBe(1);
  });

  it('delete of a middle account closes the gap and leaves the others in order', () => {
    const [first, second, third] = addThree();
    repository.delete(second.id);
    const stored = repository.listForAgent('claude');
    expect(stored.map((account) => account.id)).toEqual([first.id, third.id]);
    expect(stored.map((account) => account.position)).toEqual([1, 2]);
  });
});
