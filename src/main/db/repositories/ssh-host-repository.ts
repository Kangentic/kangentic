import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb } from '../database';
import type { SshHost, SshHostCreateInput } from '../../../shared/types';
import { writeTransaction } from '../transaction';

/** An `ssh_hosts` row as stored: SQLite has no boolean, so a created key is 0 or 1. */
interface SshHostRow extends Omit<SshHost, 'key_created'> {
  key_created: number;
}

function toHost(row: SshHostRow): SshHost {
  return { ...row, key_created: row.key_created === 1 };
}

/**
 * The SSH hosts a user has added (#913), in the global database: a host serves every project and
 * must be addable with no project open. A row is a destination and, at most, a key file's path.
 * It never holds a password or key material.
 */
export class SshHostRepository {
  list(): SshHost[] {
    const db = getGlobalDb();
    return (db.prepare('SELECT * FROM ssh_hosts ORDER BY created_at ASC').all() as SshHostRow[]).map(toHost);
  }

  getById(id: string): SshHost | undefined {
    const row = getGlobalDb().prepare('SELECT * FROM ssh_hosts WHERE id = ?').get(id) as SshHostRow | undefined;
    return row ? toHost(row) : undefined;
  }

  create(input: SshHostCreateInput): SshHost {
    const host: SshHost = {
      id: uuidv4(),
      name: input.name,
      destination: input.destination,
      key_path: input.key_path ?? null,
      key_created: input.key_created === true,
      created_at: new Date().toISOString(),
    };
    getGlobalDb().prepare(
      'INSERT INTO ssh_hosts (id, name, destination, key_path, key_created, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(host.id, host.name, host.destination, host.key_path, host.key_created ? 1 : 0, host.created_at);
    return host;
  }

  rename(id: string, name: string): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET name = ? WHERE id = ?').run(name, id);
    return this.getById(id);
  }

  /** Remove the host. Its projects are taken out of Kangentic in the same transaction, and stay on the host. */
  delete(id: string): void {
    const db = getGlobalDb();
    writeTransaction(db, () => {
      db.prepare('DELETE FROM projects WHERE remote_host_id = ?').run(id);
      db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id);
      const remaining = db.prepare('SELECT id FROM projects ORDER BY position ASC').all() as Array<{ id: string }>;
      const reposition = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
      remaining.forEach((row, index) => reposition.run(index, row.id));
    })();
  }
}
