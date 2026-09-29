import type Database from 'better-sqlite3';
import type { SummaryChoiceCount } from '../../../shared/types';

/** The `memory_task_summaries` table: one summary per finished task. */
export class SummaryStore {
  constructor(private readonly db: Database.Database) {}

  /** What each task's summary was written from, by task id. */
  inputHashes(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT task_id AS taskId, input_hash AS inputHash FROM memory_task_summaries')
      .all() as Array<{ taskId: string; inputHash: string }>;
    return new Map(rows.map((row) => [row.taskId, row.inputHash]));
  }

  /** The summaries of some tasks, by task id. A task with none is absent. */
  summariesFor(taskIds: ReadonlyArray<string>): Map<string, string> {
    const summaries = new Map<string, string>();
    if (taskIds.length === 0) return summaries;
    const statement = this.db.prepare('SELECT summary FROM memory_task_summaries WHERE task_id = ?');
    for (const taskId of taskIds) {
      const row = statement.get(taskId) as { summary: string } | undefined;
      if (row) summaries.set(taskId, row.summary);
    }
    return summaries;
  }

  /** Every summary with when it was written, for the task records that carry them. */
  all(): Map<string, { summary: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT task_id AS taskId, summary, created_at AS createdAt FROM memory_task_summaries')
      .all() as Array<{ taskId: string; summary: string; createdAt: string }>;
    return new Map(rows.map((row) => [row.taskId, { summary: row.summary, createdAt: row.createdAt }]));
  }

  write(entry: {
    taskId: string;
    summary: string;
    inputHash: string;
    agent: string;
    model: string | null;
    effort: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_task_summaries (task_id, summary, input_hash, agent, model, effort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           summary = excluded.summary,
           input_hash = excluded.input_hash,
           agent = excluded.agent,
           model = excluded.model,
           effort = excluded.effort,
           created_at = excluded.created_at`,
      )
      .run(entry.taskId, entry.summary, entry.inputHash, entry.agent, entry.model, entry.effort, entry.createdAt);
  }

  /**
   * The finished tasks' summaries counted by what wrote them (agent, model,
   * effort), most first. What Settings names in "written with", and what a
   * rewrite compares against. A summary outlives its task leaving Done, so only
   * tasks back in a Done column count.
   */
  writtenWith(): SummaryChoiceCount[] {
    return this.db
      .prepare(
        `SELECT d.agent AS agent, d.model AS model, d.effort AS effort, COUNT(*) AS count
         FROM memory_task_summaries d
         JOIN tasks t ON t.id = d.task_id JOIN swimlanes w ON w.id = t.swimlane_id
         WHERE w.role = 'done'
         GROUP BY d.agent, d.model, d.effort
         ORDER BY count DESC`,
      )
      .all() as SummaryChoiceCount[];
  }

  /**
   * Mark every finished task's summary NOT written with `choice` for rewriting,
   * by clearing what it was written from, so the next pass takes it as out of
   * date. The summary itself stays, and stays searchable, until its new one is
   * written over it. Returns how many were marked.
   */
  markForRewrite(choice: { agent: string; model: string | null; effort: string | null }): number {
    return this.db
      .prepare(
        `UPDATE memory_task_summaries SET input_hash = ''
         WHERE task_id IN (SELECT t.id FROM tasks t JOIN swimlanes w ON w.id = t.swimlane_id WHERE w.role = 'done')
           AND NOT (agent = ? AND model IS ? AND effort IS ?)`,
      )
      .run(choice.agent, choice.model, choice.effort).changes;
  }

  /**
   * How many finished tasks' summaries `markForRewrite(choice)` would mark: the
   * same match, counted. What Rebuild's confirm names before it spends a call.
   */
  countNotWrittenWith(choice: { agent: string; model: string | null; effort: string | null }): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_task_summaries
         WHERE task_id IN (SELECT t.id FROM tasks t JOIN swimlanes w ON w.id = t.swimlane_id WHERE w.role = 'done')
           AND NOT (agent = ? AND model IS ? AND effort IS ?)`,
      )
      .get(choice.agent, choice.model, choice.effort) as { count: number }).count;
  }

  /** Finished tasks' summaries marked for rewriting and not rewritten yet. */
  awaitingRewrite(): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_task_summaries d
         JOIN tasks t ON t.id = d.task_id JOIN swimlanes w ON w.id = t.swimlane_id
         WHERE w.role = 'done' AND d.input_hash = ''`,
      )
      .get() as { count: number }).count;
  }

  /** Remove the summaries of tasks that no longer exist. */
  removeOrphans(): number {
    return this.db
      .prepare('DELETE FROM memory_task_summaries WHERE task_id NOT IN (SELECT id FROM tasks)')
      .run().changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM memory_task_summaries').get() as { count: number }).count;
  }

  /**
   * What the summaries are, in a few characters: how many, and the latest write.
   * A new summary, a rewrite (which stamps `created_at`) and a removal each move
   * it. The map's region names are kept against it, so they are made again
   * only when a summary they read has changed.
   */
  fingerprint(): string {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM memory_task_summaries')
      .get() as { count: number; latest: string | null };
    return `${row.count}:${row.latest ?? ''}`;
  }
}
