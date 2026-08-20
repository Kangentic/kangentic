import { getGlobalDb } from '../database';
import type { DevPortLease } from '../../../shared/types';

/**
 * Dev-server port leases, stored in the GLOBAL database.
 *
 * Ports are a machine-wide resource, so the lease table has to be machine-wide
 * too: a per-project table cannot see that another project already took 5173.
 *
 * A lease row is ADVISORY, not authoritative. The authority on "is this port
 * usable" is an actual bind probe (see `dev-port-allocator.ts`), which is what
 * makes an orphaned lease self-correcting rather than a permanently burned
 * port.
 */

interface DevPortRow {
  port: number;
  project_id: string;
  task_id: string;
  allocated_at: string;
  last_seen_at: string | null;
}

function rowToLease(row: DevPortRow): DevPortLease {
  return {
    port: row.port,
    projectId: row.project_id,
    taskId: row.task_id,
    allocatedAt: row.allocated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class DevPortRepository {
  /** Every lease on this machine, lowest port first. */
  list(): DevPortLease[] {
    const db = getGlobalDb();
    const rows = db
      .prepare('SELECT * FROM dev_ports ORDER BY port ASC')
      .all() as DevPortRow[];
    return rows.map(rowToLease);
  }

  listForProject(projectId: string): DevPortLease[] {
    const db = getGlobalDb();
    const rows = db
      .prepare('SELECT * FROM dev_ports WHERE project_id = ? ORDER BY port ASC')
      .all(projectId) as DevPortRow[];
    return rows.map(rowToLease);
  }

  /** The lease held by a task, or null. This is the read `{{port}}` resolves. */
  getByTaskId(taskId: string): DevPortLease | null {
    const db = getGlobalDb();
    const row = db
      .prepare('SELECT * FROM dev_ports WHERE task_id = ?')
      .get(taskId) as DevPortRow | undefined;
    return row ? rowToLease(row) : null;
  }

  getByPort(port: number): DevPortLease | null {
    const db = getGlobalDb();
    const row = db
      .prepare('SELECT * FROM dev_ports WHERE port = ?')
      .get(port) as DevPortRow | undefined;
    return row ? rowToLease(row) : null;
  }

  /**
   * Claim a port for a task. Returns false when the port was taken between the
   * caller's scan and this write, so a racing allocator retries the next
   * candidate rather than throwing.
   *
   * `INSERT OR IGNORE` covers both unique constraints at once: the `port`
   * primary key and the `task_id` unique index.
   */
  claim(port: number, projectId: string, taskId: string): boolean {
    const db = getGlobalDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO dev_ports (port, project_id, task_id, allocated_at, last_seen_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(port, projectId, taskId, new Date().toISOString());
    return result.changes > 0;
  }

  /** Record that something was observed listening on this lease's port. */
  markSeen(port: number): void {
    const db = getGlobalDb();
    db.prepare('UPDATE dev_ports SET last_seen_at = ? WHERE port = ?').run(
      new Date().toISOString(),
      port,
    );
  }

  releaseByTaskId(taskId: string): void {
    const db = getGlobalDb();
    db.prepare('DELETE FROM dev_ports WHERE task_id = ?').run(taskId);
  }

  releaseByPort(port: number): void {
    const db = getGlobalDb();
    db.prepare('DELETE FROM dev_ports WHERE port = ?').run(port);
  }

  releaseForProject(projectId: string): void {
    const db = getGlobalDb();
    db.prepare('DELETE FROM dev_ports WHERE project_id = ?').run(projectId);
  }
}

export const devPortRepository = new DevPortRepository();
