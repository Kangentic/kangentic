import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  AutomationRun,
  AutomationRunCheck,
  AutomationRunStatus,
  AutomationType,
  BackgroundCallOutcome,
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
 * and its Frequency counts those runs across every visit since the task last
 * left Done. A skipped run (a Condition that answered no, an agent that was
 * not running) is never counted, so it is checked again at the next turn end.
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
  /** The background call that answered it, when one was recorded. */
  callId?: string | null;
}

export interface StartRunInput {
  id: string;
  automation: Pick<ColumnAutomation, 'id' | 'name' | 'type' | 'swimlane_id' | 'trigger'>;
  taskId: string;
  /** Set when the row has a Condition and the Automation agent answered it. */
  condition?: RunConditionAnswer;
  /**
   * The background call this run is tied to when it has no answer of its own:
   * a check the caller stopped waiting for still ran, and was still paid for.
   * An answered run takes its answer's `callId` instead.
   */
  backgroundCallId?: string | null;
}

/** A run row with the background call that answered its Condition, when there is one. */
interface AutomationRunWithCheckRow extends AutomationRunRow {
  background_call_id: string | null;
  check_found: number | null;
  check_agent: string | null;
  check_model: string | null;
  check_requested_model: string | null;
  check_effort: string | null;
  check_input_tokens: number | null;
  check_cache_creation_input_tokens: number | null;
  check_cache_read_input_tokens: number | null;
  check_output_tokens: number | null;
  check_cost_usd: number | null;
  check_duration_ms: number | null;
  check_outcome: string | null;
  check_rows_answered: number | null;
}

/**
 * Runs with their check. One call can answer every row of a batched check, so
 * `check_rows_answered` counts the runs that share it. A call whose record is
 * gone (or a run from before calls were recorded) leaves the check columns null.
 */
const RUNS_WITH_CHECK_SQL = `
  SELECT ar.*,
    bc.id IS NOT NULL AS check_found,
    bc.agent AS check_agent,
    bc.model AS check_model,
    bc.requested_model AS check_requested_model,
    bc.effort AS check_effort,
    bc.input_tokens AS check_input_tokens,
    bc.cache_creation_input_tokens AS check_cache_creation_input_tokens,
    bc.cache_read_input_tokens AS check_cache_read_input_tokens,
    bc.output_tokens AS check_output_tokens,
    bc.cost_usd AS check_cost_usd,
    bc.duration_ms AS check_duration_ms,
    bc.outcome AS check_outcome,
    CASE WHEN ar.background_call_id IS NULL THEN NULL ELSE (
      SELECT COUNT(*) FROM automation_runs answered WHERE answered.background_call_id = ar.background_call_id
    ) END AS check_rows_answered
  FROM automation_runs ar
  LEFT JOIN background_calls bc ON bc.id = ar.background_call_id`;

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
           started_at, finished_at, condition_met, condition_reason, background_call_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL, ?, ?, ?)
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
        input.condition?.callId ?? input.backgroundCallId ?? null,
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
    /** The background call that answered the step check, when one was recorded. */
    backgroundCallId?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_runs
        (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
         started_at, finished_at, condition_met, condition_reason, background_call_id)
      VALUES (?, ?, 'Workflow step', 'workflow_step', ?, ?, 'turn_end', ?, ?, 1, ?, ?, ?, ?, ?)
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
      input.backgroundCallId ?? null,
    );
  }

  /**
   * Has a workflow step check answered for this task in this column since
   * `since`? A check writes its row once it has answered, after the reply it
   * judged, so a reply older than the newest row has been judged.
   */
  hasWorkflowStepSince(taskId: string, swimlaneId: string, since: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM automation_runs WHERE type = 'workflow_step' AND task_id = ? AND swimlane_id = ? AND started_at >= ? LIMIT 1`)
      .get(taskId, swimlaneId, since);
    return row !== undefined;
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

  /**
   * How many times this automation has run on this task, across every visit
   * since the task last left Done. A task taken back out of Done (a drag, or a
   * restore from the Completed list) goes through the board again as if for the
   * first time, so its earlier runs no longer spend the limit. A rollback is not
   * a return: it undoes a move into Done that failed, and the task never finished.
   * A Done column's own exit rows run after the move out of Done is written, so
   * every return starts their count at zero and their Frequency never stops them.
   */
  countRuns(automationId: string, taskId: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS runs FROM automation_runs
        WHERE automation_id = ? AND task_id = ? AND ${EXECUTED_STATUSES_SQL}
          AND started_at >= COALESCE((
            SELECT MAX(moves.at) FROM task_moves moves
            JOIN swimlanes lane ON lane.id = moves.from_swimlane_id
            WHERE moves.task_id = ? AND lane.role = 'done' AND moves.origin != 'rollback'
          ), '')
      `)
      .get(automationId, taskId, taskId) as { runs: number } | undefined;
    return row?.runs ?? 0;
  }

  listForTask(taskId: string, limit = 50): AutomationRun[] {
    const rows = this.db
      .prepare(`${RUNS_WITH_CHECK_SQL} WHERE ar.task_id = ? ORDER BY ar.started_at DESC LIMIT ?`)
      .all(taskId, limit) as AutomationRunWithCheckRow[];
    return mapRows(rows);
  }

  listForAutomation(automationId: string, limit = 20): AutomationRun[] {
    const rows = this.db
      .prepare(`${RUNS_WITH_CHECK_SQL} WHERE ar.automation_id = ? ORDER BY ar.started_at DESC LIMIT ?`)
      .all(automationId, limit) as AutomationRunWithCheckRow[];
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

/** A stored outcome this build does not know reads as failed, the way the
 *  dashboard's `outcome != 'succeeded'` count reads it, never as a success. */
function storedOutcome(value: string | null): BackgroundCallOutcome {
  return value === 'succeeded' || value === 'timed_out' ? value : 'failed';
}

/** The check a run's joined row carries, or null when it has none on record. */
function checkOf(row: AutomationRunWithCheckRow): AutomationRunCheck | null {
  if (!row.background_call_id || !row.check_found || row.check_agent === null) return null;
  return {
    callId: row.background_call_id,
    agent: row.check_agent,
    model: row.check_model ?? row.check_requested_model,
    modelReported: row.check_model !== null,
    effort: row.check_effort,
    inputTokens: row.check_input_tokens,
    cacheCreationInputTokens: row.check_cache_creation_input_tokens,
    cacheReadInputTokens: row.check_cache_read_input_tokens,
    outputTokens: row.check_output_tokens,
    costUsd: row.check_cost_usd,
    durationMs: row.check_duration_ms ?? 0,
    outcome: storedOutcome(row.check_outcome),
    rowsAnswered: row.check_rows_answered ?? 1,
  };
}

/** A run with a trigger this build does not know is left out, not read as another trigger. */
function mapRows(rows: AutomationRunWithCheckRow[]): AutomationRun[] {
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
      check: checkOf(row),
    });
  }
  return runs;
}
