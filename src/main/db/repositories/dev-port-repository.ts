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
}

function rowToLease(row: DevPortRow): DevPortLease {
  return {
    port: row.port,
    projectId: row.project_id,
    taskId: row.task_id,
    allocatedAt: row.allocated_at,
  };
}

/**
 * Deliberately narrow. Every method here has a live caller; a read this table
 * could support but nothing asks for (list-everything, list-by-project) is left
 * unwritten rather than kept warm for a hypothetical Settings panel.
 */
export class DevPortRepository {
  /** Every port this task holds, lowest first. A task may hold several. */
  listForTask(taskId: string): DevPortLease[] {
    const db = getGlobalDb();
    const rows = db
      .prepare('SELECT * FROM dev_ports WHERE task_id = ? ORDER BY port ASC')
      .all(taskId) as DevPortRow[];
    return rows.map(rowToLease);
  }

  /** The task's lowest-numbered reservation, or null. */
  getByTaskId(taskId: string): DevPortLease | null {
    return this.listForTask(taskId)[0] ?? null;
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
   * `INSERT OR IGNORE` turns the `port` primary-key collision into that false.
   * A task may hold several ports, so only the PORT is unique here.
   */
  claim(port: number, projectId: string, taskId: string): boolean {
    const db = getGlobalDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO dev_ports (port, project_id, task_id, allocated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(port, projectId, taskId, new Date().toISOString());
    return result.changes > 0;
  }

  releaseByTaskId(taskId: string): void {
    const db = getGlobalDb();
    db.prepare('DELETE FROM dev_ports WHERE task_id = ?').run(taskId);
  }
}

/**
 * Project removal releases that project's ports too, but it does so with raw
 * SQL inside ProjectRepository.delete's transaction - both tables live in the
 * global database, and the delete has to be atomic with it. So there is no
 * `releaseForProject` here: a second, non-transactional way to do it would only
 * be a way to do it wrong.
 */

export const devPortRepository = new DevPortRepository();
