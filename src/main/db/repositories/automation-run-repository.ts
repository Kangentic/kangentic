import type Database from 'better-sqlite3';
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationType,
  ColumnAutomation,
} from '../../../shared/types';

/**
 * The durable half of "did my automation run".
 *
 * The pattern is `auto-command-outcome.ts`'s, which is the one place in this
 * codebase that already solved this problem: the DB row is the record, and the
 * push notification is a separate, rationed thing. Before that existed, every
 * failure in the injection path was a `console.warn` and there was no
 * difference, from the outside, between delivered and silently dropped. Every
 * automation had exactly that problem until this table.
 *
 * A row is written BEFORE the attempt, not after, which is what makes a crash
 * legible: the shutdown path is synchronous by rule, so an in-flight run cannot
 * be drained on quit, and a row left `running` is therefore a known orphan that
 * `markStaleRunsInterrupted` can name on the next open.
 */

interface AutomationRunRow {
  id: string;
  automation_id: string;
  automation_name: string;
  type: string;
  task_id: string;
  swimlane_id: string;
  trigger: string;
  status: string;
  detail: string | null;
  attempts: number;
  started_at: string;
  finished_at: string | null;
}

export interface StartRunInput {
  id: string;
  automation: Pick<ColumnAutomation, 'id' | 'name' | 'type' | 'swimlane_id' | 'trigger'>;
  taskId: string;
}

/** How many runs a project keeps. Older rows are pruned on project open. */
export const AUTOMATION_RUN_RETENTION = 200;

export class AutomationRunRepository {
  constructor(private db: Database.Database) {}

  /** Record the attempt before making it, so a crash mid-run leaves a trace. */
  start(input: StartRunInput): void {
    this.db
      .prepare(`
        INSERT INTO automation_runs
          (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL)
      `)
      .run(
        input.id,
        input.automation.id,
        // Denormalized, with no foreign key back to column_automations: a run
        // log that empties itself when you rename or delete the automation is
        // not a log.
        input.automation.name,
        input.automation.type,
        input.taskId,
        input.automation.swimlane_id,
        input.automation.trigger,
        new Date().toISOString(),
      );
  }

  finish(id: string, status: AutomationRunStatus, detail: string | null, attempts = 1): void {
    this.db
      .prepare('UPDATE automation_runs SET status = ?, detail = ?, attempts = ?, finished_at = ? WHERE id = ?')
      .run(status, detail, attempts, new Date().toISOString(), id);
  }

  /**
   * Record a run that never started, so a skip is as visible as a failure. A
   * row the column cannot run (the agent is off, an enter row on To Do) is
   * fixable on the column page, but only if the user can tell it was skipped.
   */
  recordSkipped(input: StartRunInput, reason: string): void {
    this.start(input);
    this.finish(input.id, 'skipped', reason, 0);
  }

  /**
   * Record a row the MOVE delivered itself, so it is as visible as every other.
   *
   * A column's first message rides the same keystroke burst as the move's own
   * `/model` or `/effort` change, which is why the runner does not send it a
   * second time. It used to record nothing at all on that path, reasoning that
   * there was nothing to tell the user because it ran. That is exactly backwards
   * for the most common automation anyone owns: the run log is where "did my
   * message fire" is answered, and the one row people actually have was the one
   * row with no entry, so `kangentic_get_automation_runs` returned nothing for it.
   */
  recordDeliveredByCaller(input: StartRunInput, detail: string): void {
    this.start(input);
    this.finish(input.id, 'succeeded', detail, 1);
  }

  listForTask(taskId: string, limit = 50): AutomationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(taskId, limit) as AutomationRunRow[];
    return rows.map(mapRow);
  }

  listForAutomation(automationId: string, limit = 20): AutomationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(automationId, limit) as AutomationRunRow[];
    return rows.map(mapRow);
  }

  /**
   * Close out every run a PREVIOUS app process was in the middle of.
   *
   * Called on project open. Without it, "these always run" is false on every
   * restart and nothing says so: a killed run would sit at `running` forever
   * and read as still in flight. Returns how many, so the caller can raise ONE
   * summary notice rather than one per row.
   *
   * `startedBefore` is what keeps that notice honest, and it is not optional.
   * Project open fires on a project SWITCH too, not only at boot, so an
   * unbounded sweep stamps a genuinely in-flight run `interrupted` the moment
   * the user looks at another board and comes back. The row then gets
   * overwritten with its real outcome when the script finishes, but the user
   * has already been told it did not finish. A run this process started is
   * either live or already closed; only one started before the process booted
   * can be an orphan.
   *
   * Deliberately does NOT retry them. A fired webhook and a half-run script are
   * not safe to repeat blind, and guessing wrong here is worse than the honest
   * report plus a Run again the user chooses.
   */
  markStaleRunsInterrupted(startedBefore: string): number {
    const result = this.db
      .prepare("UPDATE automation_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND started_at < ?")
      .run(new Date().toISOString(), startedBefore);
    return Number(result.changes ?? 0);
  }

  /** Keep the newest `limit` rows. Nothing else bounds this table. */
  pruneTo(limit = AUTOMATION_RUN_RETENTION): number {
    const result = this.db
      .prepare(`
        DELETE FROM automation_runs
        WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY started_at DESC LIMIT ?)
      `)
      .run(limit);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automation_id: row.automation_id,
    automation_name: row.automation_name,
    type: row.type as AutomationType,
    task_id: row.task_id,
    swimlane_id: row.swimlane_id,
    trigger: row.trigger === 'exit' ? 'exit' : 'enter',
    status: row.status as AutomationRunStatus,
    detail: row.detail,
    attempts: row.attempts,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}
