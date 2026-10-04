import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationType,
  ColumnAutomation,
} from '../../../shared/types';
import { isAutomationTrigger } from '../../../shared/automation-manifest';

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
 *
 * It is also what the turn-end run rule counts: a row has "run this visit" when
 * a run that was not a skip exists for it after the task entered the column,
 * and its Frequency counts those runs across every visit. A skipped run (a
 * Condition that answered no, an agent that was not running) is never counted,
 * so it is checked again at the next turn end.
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
  condition_met: number | null;
  condition_reason: string | null;
}

/** The Automation agent's answer for a run's Condition, recorded on the run row. */
export interface RunConditionAnswer {
  met: boolean;
  reason: string | null;
}

export interface StartRunInput {
  id: string;
  automation: Pick<ColumnAutomation, 'id' | 'name' | 'type' | 'swimlane_id' | 'trigger'>;
  taskId: string;
  /** Set when the row has a Condition and the Automation agent answered it. */
  condition?: RunConditionAnswer;
}

/** How many runs a project keeps. Older rows are pruned on project open. */
export const AUTOMATION_RUN_RETENTION = 200;

/** A run that started, whatever its outcome. Skips never count as having run. */
const EXECUTED_STATUSES_SQL = "status IN ('running', 'succeeded', 'failed', 'interrupted')";

export class AutomationRunRepository {
  constructor(private db: Database.Database) {}

  /** Record the attempt before making it, so a crash mid-run leaves a trace. */
  start(input: StartRunInput): void {
    this.db
      .prepare(`
        INSERT INTO automation_runs
          (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
           started_at, finished_at, condition_met, condition_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL, ?, ?)
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
        input.condition ? (input.condition.met ? 1 : 0) : null,
        input.condition?.reason ?? null,
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
   * A column's first message rides the move's own keystroke burst (or, when
   * the move restarts the session, its resume prompt), which is why the runner
   * does not send it a second time. It used to record nothing at all on that
   * path, reasoning that there was nothing to tell the user because it ran. That is exactly backwards
   * for the most common automation anyone owns: the run log is where "did my
   * message fire" is answered, and the one row people actually have was the one
   * row with no entry, so `kangentic_get_automation_runs` returned nothing for it.
   */
  recordDeliveredByCaller(input: StartRunInput, detail: string): void {
    this.start(input);
    this.finish(input.id, 'succeeded', detail, 1);
  }

  /**
   * Record a workflow's own step check at a turn end, beside the column's runs,
   * so "why did the task not move on" has an answer in the same log. Its
   * automation id is `workflow-step:<workflowId>`, which names no column
   * automation, and its type `workflow_step` is none of the registry's: a reader
   * of the log shows it as written. A yes that moved the task is `succeeded`, a
   * no is `skipped` (as a Condition's no is), each with the answer's reason.
   */
  recordWorkflowStep(input: {
    taskId: string;
    swimlaneId: string;
    workflowId: string;
    met: boolean;
    reason: string | null;
    detail: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_runs
        (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
         started_at, finished_at, condition_met, condition_reason)
      VALUES (?, ?, 'Workflow step', 'workflow_step', ?, ?, 'turn_end', ?, ?, 1, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      `workflow-step:${input.workflowId}`,
      input.taskId,
      input.swimlaneId,
      input.met ? 'succeeded' : 'skipped',
      input.detail,
      now,
      now,
      input.met ? 1 : 0,
      input.reason,
    );
  }

  /**
   * Has this automation run on this task since `since` (the task's entry into
   * the column)? Null `since` means no visit boundary is known (a task that
   * entered before moves were recorded), so every run counts.
   */
  hasRunSince(automationId: string, taskId: string, since: string | null): boolean {
    const row = since === null
      ? this.db
        .prepare(`SELECT 1 FROM automation_runs WHERE automation_id = ? AND task_id = ? AND ${EXECUTED_STATUSES_SQL} LIMIT 1`)
        .get(automationId, taskId)
      : this.db
        .prepare(`SELECT 1 FROM automation_runs WHERE automation_id = ? AND task_id = ? AND ${EXECUTED_STATUSES_SQL} AND started_at >= ? LIMIT 1`)
        .get(automationId, taskId, since);
    return row !== undefined;
  }

  /**
   * Has this automation already been skipped on this task, for exactly this
   * reason, since `since`? Lets a turn-end group record "Set up an Automation
   * agent" once per visit rather than at every turn end of a long chat.
   */
  hasSkipSince(automationId: string, taskId: string, since: string | null, detail: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM automation_runs WHERE automation_id = ? AND task_id = ? AND status = 'skipped' AND detail = ? AND started_at >= ? LIMIT 1`)
      .get(automationId, taskId, detail, since ?? '');
    return row !== undefined;
  }

  /** How many times this automation has run on this task, across every visit. */
  countRuns(automationId: string, taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS runs FROM automation_runs WHERE automation_id = ? AND task_id = ? AND ${EXECUTED_STATUSES_SQL}`)
      .get(automationId, taskId) as { runs: number } | undefined;
    return row?.runs ?? 0;
  }

  listForTask(taskId: string, limit = 50): AutomationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(taskId, limit) as AutomationRunRow[];
    return mapRows(rows);
  }

  listForAutomation(automationId: string, limit = 20): AutomationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(automationId, limit) as AutomationRunRow[];
    return mapRows(rows);
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

  /**
   * Keep the newest `limit` rows. Nothing else bounds this table.
   *
   * Except the runs a Frequency limit is still counting: an executed run of an
   * automation with `max_runs`, on a task not yet archived. Turn-end Condition
   * checks record a skipped row at every turn end, so the newest 200 can be a
   * single busy afternoon, and pruning a review loop's earlier passes would
   * quietly reset its round-trip count. Those rows go once the task is done.
   */
  pruneTo(limit = AUTOMATION_RUN_RETENTION): number {
    const result = this.db
      .prepare(`
        DELETE FROM automation_runs
        WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY started_at DESC LIMIT ?)
          AND NOT (
            ${EXECUTED_STATUSES_SQL}
            AND automation_id IN (SELECT id FROM column_automations WHERE max_runs IS NOT NULL)
            AND task_id IN (SELECT id FROM tasks WHERE archived_at IS NULL)
          )
      `)
      .run(limit);
    return Number(result.changes ?? 0);
  }
}

/** A run with a trigger this build does not know is left out, not read as another trigger. */
function mapRows(rows: AutomationRunRow[]): AutomationRun[] {
  const runs: AutomationRun[] = [];
  for (const row of rows) {
    if (!isAutomationTrigger(row.trigger)) continue;
    runs.push({
      id: row.id,
      automation_id: row.automation_id,
      automation_name: row.automation_name,
      type: row.type as AutomationType,
      task_id: row.task_id,
      swimlane_id: row.swimlane_id,
      trigger: row.trigger,
      status: row.status as AutomationRunStatus,
      detail: row.detail,
      attempts: row.attempts,
      started_at: row.started_at,
      finished_at: row.finished_at,
      condition_met: row.condition_met === null ? null : row.condition_met === 1,
      condition_reason: row.condition_reason,
    });
  }
  return runs;
}
