import type Database from 'better-sqlite3';
import type { DigestChoiceCount } from '../../../shared/types';

/** The `memory_task_digests` table: one digest per finished task. */
export class DigestStore {
  constructor(private readonly db: Database.Database) {}

  /** What each task's digest was written from, by task id. */
  inputHashes(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT task_id AS taskId, input_hash AS inputHash FROM memory_task_digests')
      .all() as Array<{ taskId: string; inputHash: string }>;
    return new Map(rows.map((row) => [row.taskId, row.inputHash]));
  }

  /** The digests of some tasks, by task id. A task with none is absent. */
  digestsFor(taskIds: ReadonlyArray<string>): Map<string, string> {
    const digests = new Map<string, string>();
    if (taskIds.length === 0) return digests;
    const statement = this.db.prepare('SELECT digest FROM memory_task_digests WHERE task_id = ?');
    for (const taskId of taskIds) {
      const row = statement.get(taskId) as { digest: string } | undefined;
      if (row) digests.set(taskId, row.digest);
    }
    return digests;
  }

  /** Every digest with when it was written, for the task records that carry them. */
  all(): Map<string, { digest: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT task_id AS taskId, digest, created_at AS createdAt FROM memory_task_digests')
      .all() as Array<{ taskId: string; digest: string; createdAt: string }>;
    return new Map(rows.map((row) => [row.taskId, { digest: row.digest, createdAt: row.createdAt }]));
  }

  write(entry: {
    taskId: string;
    digest: string;
    inputHash: string;
    agent: string;
    model: string | null;
    effort: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_task_digests (task_id, digest, input_hash, agent, model, effort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           digest = excluded.digest,
           input_hash = excluded.input_hash,
           agent = excluded.agent,
           model = excluded.model,
           effort = excluded.effort,
           created_at = excluded.created_at`,
      )
      .run(entry.taskId, entry.digest, entry.inputHash, entry.agent, entry.model, entry.effort, entry.createdAt);
  }

  /**
   * The finished tasks' digests counted by what wrote them (agent, model,
   * effort), most first. What Settings names in "written with", and what a
   * rewrite compares against. A digest outlives its task leaving Done, so only
   * tasks back in a Done column count.
   */
  writtenWith(): DigestChoiceCount[] {
    return this.db
      .prepare(
        `SELECT d.agent AS agent, d.model AS model, d.effort AS effort, COUNT(*) AS count
         FROM memory_task_digests d
         JOIN tasks t ON t.id = d.task_id JOIN swimlanes w ON w.id = t.swimlane_id
         WHERE w.role = 'done'
         GROUP BY d.agent, d.model, d.effort
         ORDER BY count DESC`,
      )
      .all() as DigestChoiceCount[];
  }

  /**
   * Mark every finished task's digest NOT written with `choice` for rewriting,
   * by clearing what it was written from, so the next pass takes it as out of
   * date. The digest itself stays, and stays searchable, until its new one is
   * written over it. Returns how many were marked.
   */
  markForRewrite(choice: { agent: string; model: string | null; effort: string | null }): number {
    return this.db
      .prepare(
        `UPDATE memory_task_digests SET input_hash = ''
         WHERE task_id IN (SELECT t.id FROM tasks t JOIN swimlanes w ON w.id = t.swimlane_id WHERE w.role = 'done')
           AND NOT (agent = ? AND model IS ? AND effort IS ?)`,
      )
      .run(choice.agent, choice.model, choice.effort).changes;
  }

  /** Finished tasks' digests marked for rewriting and not rewritten yet. */
  awaitingRewrite(): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_task_digests d
         JOIN tasks t ON t.id = d.task_id JOIN swimlanes w ON w.id = t.swimlane_id
         WHERE w.role = 'done' AND d.input_hash = ''`,
      )
      .get() as { count: number }).count;
  }

  /** Remove the digests of tasks that no longer exist. */
  removeOrphans(): number {
    return this.db
      .prepare('DELETE FROM memory_task_digests WHERE task_id NOT IN (SELECT id FROM tasks)')
      .run().changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM memory_task_digests').get() as { count: number }).count;
  }

  /**
   * What the digests are, in a few characters: how many, and the latest write.
   * A new digest, a rewrite (which stamps `created_at`) and a removal each move
   * it. The map's region names are kept against it, so they are made again
   * only when a digest they read has changed.
   */
  fingerprint(): string {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM memory_task_digests')
      .get() as { count: number; latest: string | null };
    return `${row.count}:${row.latest ?? ''}`;
  }
}
