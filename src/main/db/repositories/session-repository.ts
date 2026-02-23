import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { SessionRecord, SessionRecordStatus } from '../../../shared/types';

export class SessionRepository {
  constructor(private db: Database.Database) {}

  insert(record: Omit<SessionRecord, 'id'>): SessionRecord {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, claude_session_id, command, cwd, permission_mode, prompt, status, exit_code, started_at, suspended_at, exited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.task_id,
      record.session_type,
      record.claude_session_id,
      record.command,
      record.cwd,
      record.permission_mode,
      record.prompt,
      record.status,
      record.exit_code,
      record.started_at,
      record.suspended_at,
      record.exited_at,
    );
    return { id, ...record };
  }

  updateStatus(
    id: string,
    status: SessionRecordStatus,
    extra?: { exit_code?: number; suspended_at?: string; exited_at?: string },
  ): void {
    const sets = ['status = ?'];
    const params: unknown[] = [status];

    if (extra?.exit_code !== undefined) {
      sets.push('exit_code = ?');
      params.push(extra.exit_code);
    }
    if (extra?.suspended_at !== undefined) {
      sets.push('suspended_at = ?');
      params.push(extra.suspended_at);
    }
    if (extra?.exited_at !== undefined) {
      sets.push('exited_at = ?');
      params.push(extra.exited_at);
    }

    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** Get suspended claude_agent sessions that can be resumed */
  getResumable(): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE status = 'suspended' AND session_type = 'claude_agent'`
    ).all() as SessionRecord[];
  }

  /** Mark all currently 'running' sessions as 'orphaned' (crash recovery) */
  markAllRunningAsOrphaned(): void {
    this.db.prepare(
      `UPDATE sessions SET status = 'orphaned' WHERE status = 'running'`
    ).run();
  }

  /** Get orphaned claude_agent sessions */
  getOrphaned(): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE status = 'orphaned' AND session_type = 'claude_agent'`
    ).all() as SessionRecord[];
  }

  /** Delete all session records for a given task */
  deleteByTaskId(taskId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE task_id = ?').run(taskId);
  }

  /** Find the latest session record for a given task */
  getLatestForTask(taskId: string): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(taskId) as SessionRecord | undefined;
  }
}
