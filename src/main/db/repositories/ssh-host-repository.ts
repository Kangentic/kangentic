import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb } from '../database';
import type { SshHost, SshHostCreateInput } from '../../../shared/types';
import { writeTransaction } from '../transaction';
import { devPortRepository } from './dev-port-repository';

/** An `ssh_hosts` row as stored: SQLite has no boolean, so each of these is 0 or 1. */
interface SshHostRow extends Omit<SshHost, 'key_created' | 'reveal_pending'> {
  key_created: number;
  reveal_pending: number;
}

function toHost(row: SshHostRow): SshHost {
  return { ...row, key_created: row.key_created === 1, removed_at: row.removed_at ?? null, reveal_pending: row.reveal_pending === 1 };
}

/**
 * The SSH hosts a user has added (#913), in the global database: a host serves every project and
 * must be addable with no project open. A row is a destination and, at most, a key file's path.
 * It never holds a password or key material.
 *
 * A removed host keeps its row with `removed_at` set. `list()` leaves it out, so the settings tab, the
 * connection pass at startup and the status book never see it, while `getById` still finds it: its
 * projects are hidden, not deleted, and adding the same address again restores the row.
 */
export class SshHostRepository {
  /** The hosts in use. A removed host is not one. */
  list(): SshHost[] {
    const db = getGlobalDb();
    return (db.prepare('SELECT * FROM ssh_hosts WHERE removed_at IS NULL ORDER BY created_at ASC').all() as SshHostRow[]).map(toHost);
  }

  /** The hosts that were removed and kept, oldest first. */
  listRemoved(): SshHost[] {
    const db = getGlobalDb();
    return (db.prepare('SELECT * FROM ssh_hosts WHERE removed_at IS NOT NULL ORDER BY created_at ASC').all() as SshHostRow[]).map(toHost);
  }

  /** A host by id, removed or not. */
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
      removed_at: null,
      reveal_pending: false,
    };
    getGlobalDb().prepare(
      'INSERT INTO ssh_hosts (id, name, destination, key_path, key_created, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(host.id, host.name, host.destination, host.key_path, host.key_created ? 1 : 0, host.created_at);
    return host;
  }

  /** Record the key a host signs in with: a file in Kangentic's folder, and whether Kangentic made it. */
  setKey(id: string, keyPath: string | null, keyCreated: boolean): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET key_path = ?, key_created = ? WHERE id = ?').run(keyPath, keyCreated ? 1 : 0, id);
    return this.getById(id);
  }

  rename(id: string, name: string): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET name = ? WHERE id = ?').run(name, id);
    return this.getById(id);
  }

  /** Change where a host is reached. Its projects keep their host, so they keep their directories. */
  setDestination(id: string, destination: string): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET destination = ? WHERE id = ?').run(destination, id);
    return this.getById(id);
  }

  /**
   * Remove the host without deleting anything: the row stays with the time, its key is forgotten, and its
   * projects are hidden because their host is no longer in use. Their dev-server ports stay leased.
   */
  markRemoved(id: string): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET removed_at = ?, key_path = NULL, key_created = 0, reveal_pending = 0 WHERE id = ?').run(new Date().toISOString(), id);
    return this.getById(id);
  }

  /**
   * Bring a removed host back into use, under the name the user gives it now. Its projects are shown again, and
   * `reveal_pending` keeps them from starting until its first connection has ended what it still runs for them.
   */
  restore(id: string, name: string): SshHost | undefined {
    getGlobalDb().prepare('UPDATE ssh_hosts SET removed_at = NULL, name = ?, reveal_pending = 1 WHERE id = ?').run(name, id);
    return this.getById(id);
  }

  /** A restored host's projects are starting. */
  clearRevealPending(id: string): void {
    getGlobalDb().prepare('UPDATE ssh_hosts SET reveal_pending = 0 WHERE id = ?').run(id);
  }

  /** Delete the row and its projects' rows in one transaction. Only an add that failed partway ends here: a host that was in use is marked removed instead, so it can come back. */
  delete(id: string): void {
    const db = getGlobalDb();
    writeTransaction(db, () => {
      // Their dev-server ports go back to the pool first, as ProjectRepository.delete does for one
      // project: nothing sweeps a reservation whose project is gone.
      db.prepare('DELETE FROM dev_ports WHERE project_id IN (SELECT id FROM projects WHERE remote_host_id = ?)').run(id);
      db.prepare('DELETE FROM projects WHERE remote_host_id = ?').run(id);
      db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id);
      const remaining = db.prepare('SELECT id FROM projects ORDER BY position ASC').all() as Array<{ id: string }>;
      const reposition = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
      remaining.forEach((row, index) => reposition.run(index, row.id));
    })();
    devPortRepository.notifyChanged();
  }
}
