import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getGlobalDb } from '../database';
import { writeTransaction } from '../transaction';
import type { AgentAccount, AgentAccountKind, AgentAccountStatus } from '../../../shared/agent-accounts';
import type { RateLimitWindow } from '../../../shared/types';

interface AgentAccountRow {
  id: string;
  agent: string;
  kind: AgentAccountKind;
  folder_path: string | null;
  key_file_path: string | null;
  key_names: string;
  email: string | null;
  plan: string | null;
  status: AgentAccountStatus;
  position: number;
  history_private: number;
  last_usage_json: string | null;
  last_usage_at: string | null;
  created_at: string;
}

function parseJsonArray<T>(text: string | null): T[] | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function toAccount(row: AgentAccountRow): AgentAccount {
  return {
    id: row.id,
    agent: row.agent,
    kind: row.kind,
    folderPath: row.folder_path,
    keyFilePath: row.key_file_path,
    keyNames: parseJsonArray<string>(row.key_names) ?? [],
    email: row.email,
    plan: row.plan,
    status: row.status,
    position: row.position,
    historyPrivate: row.history_private === 1,
    lastUsage: parseJsonArray<RateLimitWindow>(row.last_usage_json),
    lastUsageAt: row.last_usage_at,
    createdAt: row.created_at,
  };
}

export interface AgentAccountInsert {
  agent: string;
  kind: AgentAccountKind;
  folderPath?: string | null;
  keyFilePath?: string | null;
  keyNames?: string[];
  email?: string | null;
  plan?: string | null;
  status?: AgentAccountStatus;
}

/**
 * Accounts live in the global database (`index.db`): a login is machine-wide, shared by every
 * project. The database is injectable so unit tests run on an in-memory one.
 */
export class AgentAccountRepository {
  // Lazy: the global database is opened on first use, never by constructing the repository.
  constructor(private readonly database: () => Database.Database = () => getGlobalDb()) {}

  list(): AgentAccount[] {
    const rows = this.database()
      .prepare('SELECT * FROM agent_accounts ORDER BY agent ASC, position ASC')
      .all() as AgentAccountRow[];
    return rows.map(toAccount);
  }

  listForAgent(agent: string): AgentAccount[] {
    const rows = this.database()
      .prepare('SELECT * FROM agent_accounts WHERE agent = ? ORDER BY position ASC')
      .all(agent) as AgentAccountRow[];
    return rows.map(toAccount);
  }

  getById(id: string): AgentAccount | null {
    const row = this.database().prepare('SELECT * FROM agent_accounts WHERE id = ?').get(id) as AgentAccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  /** Adds an account at the bottom of its agent's list. */
  insert(input: AgentAccountInsert): AgentAccount {
    const database = this.database();
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const { next } = database
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM agent_accounts WHERE agent = ?')
      .get(input.agent) as { next: number };
    database
      .prepare(`
        INSERT INTO agent_accounts (id, agent, kind, folder_path, key_file_path, key_names, email, plan, status, position, history_private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(
        id,
        input.agent,
        input.kind,
        input.folderPath ?? null,
        input.keyFilePath ?? null,
        JSON.stringify(input.keyNames ?? []),
        input.email ?? null,
        input.plan ?? null,
        input.status ?? 'ok',
        next,
        createdAt,
      );
    const account = this.getById(id);
    if (!account) throw new Error(`Account ${id} was not saved`);
    return account;
  }

  updateIdentity(id: string, identity: { email: string | null; plan: string | null; status: AgentAccountStatus }): void {
    this.database()
      .prepare('UPDATE agent_accounts SET email = ?, plan = ?, status = ? WHERE id = ?')
      .run(identity.email, identity.plan, identity.status, id);
  }

  updateStatus(id: string, status: AgentAccountStatus): void {
    this.database().prepare('UPDATE agent_accounts SET status = ? WHERE id = ?').run(status, id);
  }

  setHistoryPrivate(id: string, historyPrivate: boolean): void {
    this.database().prepare('UPDATE agent_accounts SET history_private = ? WHERE id = ?').run(historyPrivate ? 1 : 0, id);
  }

  updateUsage(id: string, windows: RateLimitWindow[]): void {
    this.database()
      .prepare('UPDATE agent_accounts SET last_usage_json = ?, last_usage_at = ? WHERE id = ?')
      .run(JSON.stringify(windows), new Date().toISOString(), id);
  }

  /** Rewrites one agent's positions to the given id order (1-based). Ids not listed keep theirs after. */
  reorder(agent: string, orderedIds: readonly string[]): void {
    const database = this.database();
    const current = this.listForAgent(agent);
    const known = new Set(current.map((account) => account.id));
    // Each id once, so a repeated id cannot leave a place unused.
    const listed = [...new Set(orderedIds)].filter((id) => known.has(id));
    const listedIds = new Set(listed);
    const order = [...listed, ...current.map((account) => account.id).filter((id) => !listedIds.has(id))];
    const update = database.prepare('UPDATE agent_accounts SET position = ? WHERE id = ? AND agent = ?');
    writeTransaction(database, () => {
      order.forEach((id, index) => update.run(index + 1, id, agent));
    })();
  }

  /**
   * Removes the row only, and closes the gap it leaves, in one transaction. The folder and its
   * login stay on disk, so removing an account never signs anyone out.
   */
  delete(id: string): void {
    const database = this.database();
    const account = this.getById(id);
    if (!account) return;
    // The reorder inside is a transaction of its own, which nests as a savepoint.
    writeTransaction(database, () => {
      database.prepare('DELETE FROM agent_accounts WHERE id = ?').run(id);
      this.reorder(account.agent, this.listForAgent(account.agent).map((remaining) => remaining.id));
    })();
  }
}
