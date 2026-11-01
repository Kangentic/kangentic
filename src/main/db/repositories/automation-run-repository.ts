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
import { NEVER_AUTO_SPAWN_ROLES } from '../../../shared/types';
import { isAutomationTrigger } from '../../../shared/automation-manifest';
import { MOVED_BY_A_PERSON } from '../../../shared/task-move-origin';

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
 * and its Frequency counts those runs across every visit since a person last
 * moved the task, or it last left Done. A skipped run (a Condition that
 * answered no, an agent that was not running) is never counted, so it is
 * checked again at the next turn end.
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
  final_line_met: number | null;
  final_line_reason: string | null;
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
  /** Set when the row has a Text match: what it decided and the line it read. */
  finalLine?: { met: boolean; reason: string };
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

/**
 * The origins of a person's move (`MOVED_BY_A_PERSON`). One of those, to
 * another column, starts a row's Frequency over (`countRuns`). The board's own
 * movers never do, so a review loop keeps its round-trip limit and an agent
 * cannot reset its own with `kangentic_move_task`. A restore from the
 * Completed list is a person's too, but it always leaves Done, which starts
 * the count over by itself.
 */
const PERSON_MOVE_ORIGINS_SQL = Object.entries(MOVED_BY_A_PERSON)
  .filter(([, byPerson]) => byPerson)
  .map(([origin]) => `'${origin}'`)
  .join(', ');

/**
 * The rows a workflow writes for itself: step answers, recovery attempts, and
 * the latches recovery rebuilds from after a restart (`workflow-recovery.ts`).
 */
const WORKFLOW_RUN_TYPES_SQL = "type IN ('workflow_step', 'workflow_recovery', 'workflow_stalled', 'workflow_waiting', "
  + "'workflow_recovery_start', 'workflow_interrupt')";

/** The column roles that never start an agent, from the one list the startup pass also reads. */
const NEVER_AUTO_SPAWN_ROLES_SQL = [...NEVER_AUTO_SPAWN_ROLES].map((role) => `'${role}'`).join(', ');

export class AutomationRunRepository {
  constructor(private db: Database.Database) {}

  /** Record the attempt before making it, so a crash mid-run leaves a trace. */
  start(input: StartRunInput): void {
    this.db
      .prepare(`
        INSERT INTO automation_runs
          (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
           started_at, finished_at, condition_met, condition_reason, background_call_id, final_line_met, final_line_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL, ?, ?, ?, ?, ?)
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
        input.finalLine ? (input.finalLine.met ? 1 : 0) : null,
        input.finalLine?.reason ?? null,
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
   *
   * A check that could not answer is recorded too, with `met` null: `failed`
   * when the call failed (it is tried again), `skipped` when no Automation
   * agent can run one (`unjudgedStatus`). Its `condition_met` stays NULL, so it
   * never counts as the reply having been judged (`hasWorkflowStepSince`).
   */
  recordWorkflowStep(input: {
    taskId: string;
    swimlaneId: string;
    workflowId: string;
    met: boolean | null;
    reason: string | null;
    detail: string;
    /** The background call that answered the step check, when one was recorded. */
    backgroundCallId?: string | null;
    /** The status of a check that could not answer (`met` null). */
    unjudgedStatus?: Extract<AutomationRunStatus, 'failed' | 'skipped'>;
  }): void {
    const now = new Date().toISOString();
    const status = input.met === null ? (input.unjudgedStatus ?? 'failed') : input.met ? 'succeeded' : 'skipped';
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
      status,
      input.detail,
      now,
      now,
      input.met === null ? null : input.met ? 1 : 0,
      input.reason,
      input.backgroundCallId ?? null,
    );
  }

  /**
   * Has a workflow step check answered for this task in this column since
   * `since`? A check writes its row once it has answered, after the reply it
   * judged, so a reply older than the newest row has been judged. A check that
   * could not answer judged nothing, so its row does not count.
   */
  hasWorkflowStepSince(taskId: string, swimlaneId: string, since: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM automation_runs WHERE type = 'workflow_step' AND task_id = ? AND swimlane_id = ? AND condition_met IS NOT NULL AND started_at >= ? LIMIT 1`)
      .get(taskId, swimlaneId, since);
    return row !== undefined;
  }

  /**
   * Has a workflow step row with exactly this detail been written for this
   * task in this column since `since`? Lets a step with no Automation agent
   * say so once a visit rather than at every turn end of a long chat.
   */
  hasWorkflowStepDetailSince(taskId: string, swimlaneId: string, since: string | null, detail: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM automation_runs WHERE type = 'workflow_step' AND task_id = ? AND swimlane_id = ? AND detail = ? AND started_at >= ? LIMIT 1`)
      .get(taskId, swimlaneId, detail, since ?? '');
    return row !== undefined;
  }

  /**
   * Record one attempt of a workflow task's recovery (`workflow-recovery.ts`):
   * a nudge sent (`succeeded`), one held off while the user was there
   * (`skipped`), or one that did nothing (`failed`: the nudge was not
   * delivered, or its turn failed). Returns the row's id, so a nudge whose turn
   * later fails can be marked so (`finish`). Type `workflow_recovery`, which
   * names no column automation; the trigger is `turn_end`, as the step's is.
   */
  recordWorkflowRecovery(input: {
    taskId: string;
    swimlaneId: string;
    workflowId: string;
    status: Extract<AutomationRunStatus, 'succeeded' | 'skipped' | 'failed'>;
    detail: string;
  }): string {
    return this.insertWorkflowRow({
      type: 'workflow_recovery',
      name: 'Workflow recovery',
      automationId: `workflow-recovery:${input.workflowId}`,
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      status: input.status,
      detail: input.detail,
      attempts: 1,
    });
  }

  /**
   * Record that a workflow task's hung turn was interrupted
   * (`workflow-hang-check.ts`): its agent showed working and wrote nothing for
   * longer than a healthy turn goes quiet. Its own type, so it is never counted
   * as a recovery attempt; recovery takes the interrupted turn from there.
   */
  recordWorkflowInterrupt(input: { taskId: string; swimlaneId: string; workflowId: string; detail: string }): void {
    this.insertWorkflowRow({
      type: 'workflow_interrupt',
      name: 'Workflow recovery',
      automationId: `workflow-recovery:${input.workflowId}`,
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      status: 'succeeded',
      detail: input.detail,
      attempts: 1,
    });
  }

  /**
   * Record that a workflow task stalled: its recovery ran out, or a pause
   * stopped it. The row is the one notice's latch and the task's "Stalled"
   * mark (`listStalledTasks`), so both survive a restart. `reason` is what the
   * notice and the mark say. `countedNudges` (the nudges that had run by then)
   * rides in `attempts`, so a restart knows how much of the budget is spent.
   */
  recordWorkflowStall(input: { taskId: string; swimlaneId: string; workflowId: string; reason: string; countedNudges: number }): void {
    this.insertWorkflowRow({
      type: 'workflow_stalled',
      name: 'Workflow stalled',
      automationId: `workflow-stalled:${input.workflowId}`,
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      status: 'skipped',
      detail: `Stalled: ${input.reason}`,
      attempts: input.countedNudges,
      conditionReason: input.reason,
    });
  }

  /**
   * Record that a workflow task's agent waits on the user, and that the user
   * was told: its step check said so, or no Automation agent can judge it. The
   * row starts a fresh recovery (the user answers, and the next stall is a new
   * one), and says the task waits on the user until a later turn is judged
   * (`isWaitingOnUser`).
   */
  recordWorkflowWaiting(input: { taskId: string; swimlaneId: string; workflowId: string; reason: string }): void {
    this.insertWorkflowRow({
      type: 'workflow_waiting',
      name: 'Waiting on you',
      automationId: `workflow-waiting:${input.workflowId}`,
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      status: 'skipped',
      detail: `Waiting on you: ${input.reason}`,
      attempts: 0,
      conditionReason: input.reason,
    });
  }

  /**
   * Record that a workflow task's recovery starts over: after a stall, a turn
   * recovery did not start stopped again, or the hang check ended a hung turn,
   * so what comes next is a new stall with its own nudges and its own notice.
   * The row is where the next rebuild counts from, inclusively, so `at` puts it
   * after a stall row written the same moment.
   */
  recordWorkflowRecoveryStart(input: { taskId: string; swimlaneId: string; workflowId: string; at?: Date; detail?: string }): void {
    this.insertWorkflowRow({
      type: 'workflow_recovery_start',
      name: 'Workflow recovery',
      automationId: `workflow-recovery:${input.workflowId}`,
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      status: 'skipped',
      detail: input.detail ?? 'Recovery starts over: the agent stopped again on a turn recovery did not start.',
      attempts: 0,
      at: input.at,
    });
  }

  /**
   * One row a workflow writes for itself beside its step answers, finished as
   * it is written. Its automation id names the workflow, never a column
   * automation, and its trigger is `turn_end`, as the step's is. `at` defaults
   * to now; it is a `Date` so the stored text is always the ISO form the
   * boundary queries compare. Returns the row's id.
   */
  private insertWorkflowRow(row: {
    type: 'workflow_recovery' | 'workflow_interrupt' | 'workflow_stalled' | 'workflow_waiting' | 'workflow_recovery_start';
    name: string;
    automationId: string;
    taskId: string;
    swimlaneId: string;
    status: AutomationRunStatus;
    detail: string;
    attempts: number;
    conditionReason?: string;
    at?: Date;
  }): string {
    const id = uuidv4();
    const at = (row.at ?? new Date()).toISOString();
    this.db.prepare(`
      INSERT INTO automation_runs
        (id, automation_id, automation_name, type, task_id, swimlane_id, trigger, status, detail, attempts,
         started_at, finished_at, condition_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'turn_end', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      row.automationId,
      row.name,
      row.type,
      row.taskId,
      row.swimlaneId,
      row.status,
      row.detail,
      row.attempts,
      at,
      at,
      row.conditionReason ?? null,
    );
    return id;
  }

  /**
   * The newest point this task's recovery in this column counts from since
   * `since`: a wait on the user it was told of, or a recovery that started
   * over. Null when there is neither.
   */
  latestWorkflowRecoveryBoundaryAt(taskId: string, swimlaneId: string, since: string | null): string | null {
    const row = this.db
      .prepare(`
        SELECT MAX(started_at) AS at FROM automation_runs
        WHERE type IN ('workflow_waiting', 'workflow_recovery_start') AND task_id = ? AND swimlane_id = ? AND started_at >= ?
      `)
      .get(taskId, swimlaneId, since ?? '') as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /** The newest waiting row for this task in this column since `since`, or null. */
  latestWorkflowWaitingAt(taskId: string, swimlaneId: string, since: string | null): string | null {
    const row = this.db
      .prepare(`SELECT MAX(started_at) AS at FROM automation_runs WHERE type = 'workflow_waiting' AND task_id = ? AND swimlane_id = ? AND started_at >= ?`)
      .get(taskId, swimlaneId, since ?? '') as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /**
   * Does this task's agent wait on the user, as its newest judged turn left it?
   * True while a waiting row is newer than every step check that judged a turn
   * since `since`: the user was told, and no turn has ended since.
   */
  isWaitingOnUser(taskId: string, swimlaneId: string, since: string | null): boolean {
    const waitingAt = this.latestWorkflowWaitingAt(taskId, swimlaneId, since);
    if (waitingAt === null) return false;
    const judged = this.db
      .prepare(`SELECT 1 FROM automation_runs WHERE type = 'workflow_step' AND task_id = ? AND swimlane_id = ? AND condition_met IS NOT NULL AND started_at > ? LIMIT 1`)
      .get(taskId, swimlaneId, waitingAt);
    return judged === undefined;
  }

  /**
   * A workflow task's recovery in this column since `since` (its visit's
   * start), so a restart picks it up where it stopped:
   * - `lastStall`: the newest stall row, with the nudges that had run by then;
   * - `attempts` and `countedNudges`: the attempts after that row (after
   *   `since` when there is none), and the nudges among them that ran;
   * - `firstAt`: when this recovery began, the oldest attempt since `since`,
   *   or null.
   */
  workflowRecoverySince(taskId: string, swimlaneId: string, since: string | null): {
    lastStall: { at: string; countedNudges: number } | null;
    attempts: number;
    countedNudges: number;
    firstAt: string | null;
  } {
    const stall = this.db
      .prepare(`
        SELECT started_at AS at, attempts FROM automation_runs
        WHERE type = 'workflow_stalled' AND task_id = ? AND swimlane_id = ? AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1
      `)
      .get(taskId, swimlaneId, since ?? '') as { at: string; attempts: number } | undefined;
    // Strictly after the stall row: the nudge that spent the budget can share
    // its millisecond, and the row's own count already holds it.
    const afterOperator = stall ? '>' : '>=';
    const row = this.db.prepare(`
      SELECT COUNT(*) AS attempts, COALESCE(SUM(status = 'succeeded'), 0) AS counted
      FROM automation_runs
      WHERE type = 'workflow_recovery' AND task_id = ? AND swimlane_id = ? AND started_at ${afterOperator} ?
    `).get(taskId, swimlaneId, stall ? stall.at : since ?? '') as { attempts: number; counted: number } | undefined;
    // When this recovery began: its oldest attempt in the visit, stall or not.
    const first = this.db
      .prepare(`SELECT MIN(started_at) AS at FROM automation_runs WHERE type = 'workflow_recovery' AND task_id = ? AND swimlane_id = ? AND started_at >= ?`)
      .get(taskId, swimlaneId, since ?? '') as { at: string | null } | undefined;
    return {
      lastStall: stall ? { at: stall.at, countedNudges: stall.attempts } : null,
      attempts: row?.attempts ?? 0,
      countedNudges: row?.counted ?? 0,
      firstAt: first?.at ?? stall?.at ?? null,
    };
  }

  /**
   * The workflow tasks on this board that are stalled now, with what their
   * notice said. A task is stalled while its newest stall row is in its current
   * visit to the column it is in, and nothing has moved it on since: no step
   * check has judged a turn and no nudge has run after it. One read per board.
   */
  listStalledTasks(): Map<string, string> {
    const rows = this.db.prepare(`
      SELECT stall.task_id AS task_id, stall.condition_reason AS reason
      FROM automation_runs stall
      JOIN tasks task ON task.id = stall.task_id AND task.swimlane_id = stall.swimlane_id
      WHERE stall.type = 'workflow_stalled'
        AND task.archived_at IS NULL
        AND stall.started_at = (
          SELECT MAX(newest.started_at) FROM automation_runs newest
          WHERE newest.type = 'workflow_stalled' AND newest.task_id = stall.task_id AND newest.swimlane_id = stall.swimlane_id
        )
        AND stall.started_at >= COALESCE((
          SELECT MAX(moves.at) FROM task_moves moves WHERE moves.task_id = stall.task_id AND moves.to_swimlane_id = stall.swimlane_id
        ), '')
        AND NOT EXISTS (
          SELECT 1 FROM automation_runs later
          WHERE later.task_id = stall.task_id AND later.swimlane_id = stall.swimlane_id AND later.started_at > stall.started_at
            AND ((later.type = 'workflow_step' AND later.condition_met IS NOT NULL)
              OR (later.type = 'workflow_recovery' AND later.status = 'succeeded'))
        )
    `).all() as Array<{ task_id: string; reason: string | null }>;
    return new Map(rows.map((row) => [row.task_id, row.reason ?? 'its step did not finish']));
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
   * Has any of this column's enter automations recorded a run on this task
   * since `since` (the task's entry into the column), whatever its outcome? A
   * skip counts too: the enter group ran. Null `since` counts every run, as in
   * `hasRunSince`. The startup pass reads it to tell a move that stopped before
   * its enter group from one whose agent failed to start after it.
   */
  hasEnterRunSince(taskId: string, swimlaneId: string, since: string | null): boolean {
    const row = since === null
      ? this.db
        .prepare("SELECT 1 FROM automation_runs WHERE task_id = ? AND swimlane_id = ? AND trigger = 'enter' LIMIT 1")
        .get(taskId, swimlaneId)
      : this.db
        .prepare("SELECT 1 FROM automation_runs WHERE task_id = ? AND swimlane_id = ? AND trigger = 'enter' AND started_at >= ? LIMIT 1")
        .get(taskId, swimlaneId, since);
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
   * since the newer of two moves: the last a person made to another column
   * (`MOVED_BY_A_PERSON`), and the last out of Done, by anyone. A person who
   * sends a card back for another pass means it to go through those columns
   * again, so its earlier runs no longer spend the limit. A task taken back out
   * of Done goes through the board again as if for the first time. A rollback
   * out of Done is not a return: it undoes a move into Done that failed, and
   * the task never finished. When that failed move was a person's drag, its
   * own row already started the count over. A row born into a column (no
   * `from`) and a reorder inside one are not moves.
   *
   * The move is written before the groups it fires run, so a person's move
   * starts the count of the column it leaves (exit rows) and the column it
   * enters (enter rows) at zero. On those triggers Frequency limits only the
   * moves the board makes itself.
   *
   * One aggregate over the moves of either kind, never a two-argument `MAX()`.
   * SQLite's returns NULL when either side is NULL, which would count every run.
   */
  countRuns(automationId: string, taskId: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS runs FROM automation_runs
        WHERE automation_id = ? AND task_id = ? AND ${EXECUTED_STATUSES_SQL}
          AND started_at >= COALESCE((
            SELECT MAX(moves.at) FROM task_moves moves
            WHERE moves.task_id = ?
              AND (
                (moves.origin != 'rollback' AND moves.from_swimlane_id IN (SELECT id FROM swimlanes WHERE role = 'done'))
                OR (moves.origin IN (${PERSON_MOVE_ORIGINS_SQL}) AND moves.from_swimlane_id != moves.to_swimlane_id)
              )
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
   *
   * And a workflow task's own rows in the column it is in now. The prune runs
   * on project open, which is a restart, which is when recovery rebuilds a
   * parked task from them: a pruned stall row would drop the card's mark and
   * start a second recovery with a second notice, and a pruned wait on the
   * user would tell the user again. One board wrote 136 to 169 rows a day,
   * so the newest 200 can be a single night. Only the current column's rows
   * are read, so those are all that is kept; they go once the task moves on
   * or is archived.
   *
   * And the newest enter run of a task that never had an agent, in the column
   * it is in now, when that column can start one. The startup pass reads it
   * (`hasEnterRunSince`) to tell a move a quit cut short before its enter group
   * from one whose agent failed to start after it, and the prune runs on that
   * same project open, unawaited, beside the pass. Pruned, the task's enter
   * automations would run again at the next launch. One row per such task; it
   * goes once the task has a session record, moves on, or is archived.
   *
   * And every run of a task in one of `keepWorkflowIds`: a workflow still going,
   * or done for less than a day (`workflowIdsKeepingRuns`, task #952), so the
   * night a workflow ran can still be read the morning after.
   */
  pruneTo(limit = AUTOMATION_RUN_RETENTION, keepWorkflowIds: readonly string[] = []): number {
    const result = this.db
      .prepare(`
        DELETE FROM automation_runs
        WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY started_at DESC LIMIT ?)
          AND NOT (
            automation_runs.task_id IN (
              SELECT id FROM tasks WHERE workflow_id IN (SELECT value FROM json_each(?))
            )
          )
          AND NOT (
            ${EXECUTED_STATUSES_SQL}
            AND automation_id IN (SELECT id FROM column_automations WHERE max_runs IS NOT NULL)
            AND task_id IN (SELECT id FROM tasks WHERE archived_at IS NULL)
          )
          AND NOT (
            ${WORKFLOW_RUN_TYPES_SQL}
            AND EXISTS (
              SELECT 1 FROM tasks task
              WHERE task.id = automation_runs.task_id
                AND task.archived_at IS NULL
                AND task.workflow_id IS NOT NULL
                AND task.swimlane_id = automation_runs.swimlane_id
            )
          )
          AND id IS NOT (
            SELECT newest.id FROM automation_runs newest
            JOIN tasks task ON task.id = newest.task_id
            JOIN swimlanes lane ON lane.id = task.swimlane_id
            WHERE newest.task_id = automation_runs.task_id
              AND newest.swimlane_id = task.swimlane_id
              AND newest.trigger = 'enter'
              AND task.archived_at IS NULL
              AND (lane.role IS NULL OR lane.role NOT IN (${NEVER_AUTO_SPAWN_ROLES_SQL}))
              AND NOT EXISTS (SELECT 1 FROM sessions record WHERE record.task_id = task.id)
            ORDER BY newest.started_at DESC, newest.rowid DESC
            LIMIT 1
          )
      `)
      .run(limit, JSON.stringify(keepWorkflowIds));
    return Number(result.changes ?? 0);
  }

  /**
   * The workflows whose tasks' runs the prune keeps whole (task #952): one
   * still going (running or paused), or done for less than
   * `WORKFLOW_RUNS_KEPT_AFTER_DONE_MS`. Overnight, the newest 200 rows were a
   * few hours of one workflow, and the morning's investigation found the night
   * pruned. A workflow lives in its home project's database: one homed here is
   * read from this one, and one homed elsewhere is asked of `keptElsewhere`.
   */
  workflowIdsKeepingRuns(now: number, keptElsewhere: (homeProjectId: string, workflowId: string) => boolean): string[] {
    const members = this.db.prepare(`
      SELECT DISTINCT task.workflow_id AS workflow_id, task.workflow_project_id AS home_project_id,
             workflow.state AS state, workflow.finished_at AS finished_at
        FROM tasks task
        LEFT JOIN workflows workflow ON workflow.id = task.workflow_id
       WHERE task.workflow_id IS NOT NULL
    `).all() as Array<{ workflow_id: string; home_project_id: string | null; state: string | null; finished_at: string | null }>;
    const kept = new Set<string>();
    for (const member of members) {
      const keeps = member.state !== null
        ? workflowKeepsRuns(member.state, member.finished_at, now)
        : member.home_project_id !== null && keptElsewhere(member.home_project_id, member.workflow_id);
      if (keeps) kept.add(member.workflow_id);
    }
    return [...kept];
  }
}

/** How long a done workflow's tasks keep all their runs (task #952). */
export const WORKFLOW_RUNS_KEPT_AFTER_DONE_MS = 24 * 60 * 60_000;

/** Whether a workflow in this state still keeps its tasks' runs whole. */
export function workflowKeepsRuns(state: string, finishedAt: string | null, now: number): boolean {
  if (state !== 'done') return true;
  const finishedMs = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  return !Number.isFinite(finishedMs) || now - finishedMs < WORKFLOW_RUNS_KEPT_AFTER_DONE_MS;
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
      // Not always one of the registry's types: a workflow writes its own rows
      // (`workflow_step`, `workflow_recovery`, ...), so a reader that looks a
      // run's type up in the manifest guards the lookup.
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
      final_line_met: row.final_line_met === null ? null : row.final_line_met === 1,
      final_line_reason: row.final_line_reason,
      check: checkOf(row),
    });
  }
  return runs;
}
