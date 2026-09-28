import type Database from 'better-sqlite3';

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

  write(entry: { taskId: string; digest: string; inputHash: string; agent: string; model: string | null; createdAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO memory_task_digests (task_id, digest, input_hash, agent, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           digest = excluded.digest,
           input_hash = excluded.input_hash,
           agent = excluded.agent,
           model = excluded.model,
           created_at = excluded.created_at`,
      )
      .run(entry.taskId, entry.digest, entry.inputHash, entry.agent, entry.model, entry.createdAt);
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
}
