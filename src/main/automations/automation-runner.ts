import { randomUUID } from 'node:crypto';
import { canColumnRun, EXIT_GROUP_BUDGET_MS } from '../../shared/automation-manifest';
import { englishText } from '../../shared/i18n/english';
import { matchFinalLine, type FinalLineMatch } from '../../shared/final-line-match';
import type { AutomationRunStatus, ColumnAutomation, Swimlane } from '../../shared/types';
import type { AutomationRunRepository, RunConditionAnswer } from '../db/repositories/automation-run-repository';
import { automationRegistry, type AutomationRegistry } from './automation-registry';
import type { ConditionCheckLimits } from './condition-check/condition-check';
import { interpolateAutomationConfig } from './interpolate-config';
import { hasCondition, hasFinalLine, hasFrequencyLimit } from './row-guards';
import type { AutomationContext } from './shared/automation-adapter';
import {
  AutomationTimeoutError,
  isRetryableAutomationError,
} from './shared/automation-errors';

/**
 * Run one column's automations for one trigger.
 *
 * This is where every reliability promise actually lives, and each one exists
 * because its absence was a live defect in the action system this replaces:
 *
 * - **Every row is isolated.** One throw used to abort the rest of the list
 *   (`transition-engine.ts`'s loop had no inner try), and the throw was then
 *   swallowed while the move still reported success. Now a failure is recorded
 *   and the next row runs. The rows are independent side effects; aborting
 *   means a webhook blip silently skips the agent message.
 * - **Every row is bounded.** Nothing timed out: `withTaskLock` is a PQueue
 *   with no timeout and the move's Phase 3 holds it across the whole list, so
 *   one hung webhook wedged every later operation on that task until a restart.
 * - **Every row is recorded.** There was no run table at all, so "did my
 *   automation run" had no answer.
 *
 * The runner never throws for an automation's sake. It rethrows exactly one
 * thing: an abort of the move itself, which is the caller's business.
 */

export interface AutomationRunOutcome {
  /** The `automation_runs` row this execution wrote. */
  runId: string;
  automationId: string;
  name: string;
  columnName: string;
  status: AutomationRunStatus;
  detail: string | null;
}

export interface AutomationRunSummary {
  outcomes: AutomationRunOutcome[];
  failures: AutomationRunOutcome[];
  /** True when this run started the agent, so the caller can skip its fallback spawn. */
  startedAgent: boolean;
  /** True when a row that ends its group (Move to column) ran and stopped the list. */
  endedGroup?: boolean;
}

/**
 * The run log's detail for a row the move typed itself (`alreadyDelivered`).
 * Shared with the engine's held group, which records such a row the same way.
 */
export const SENT_WITH_THE_MOVE = 'Sent with the move.';

/** What starting the agent reports back to the run. */
export interface AgentStartReport {
  /**
   * Set when the agent started but this run must not message it: a resume
   * whose conversation the agent deleted started a new one from a recap of the
   * task, which asks the agent to summarize where the work stands and wait. A
   * column's command would act on a task nobody has looked at since. Every
   * row that messages the agent, the one whose message took the spawn's prompt
   * slot included, records this as its skip reason.
   */
  withholdMessages?: string;
}

export interface RunAutomationsOptions {
  automations: ColumnAutomation[];
  column: Swimlane;
  /** Everything an adapter needs except the per-run `runId` and `signal`. */
  context: Omit<AutomationContext, 'runId' | 'signal'>;
  runs: AutomationRunRepository;
  /** The move's signal. Aborting it stops the list and rethrows. */
  signal: AbortSignal;
  /**
   * Start the agent, for the first row that needs one. Present only on enter:
   * an exit row cannot start an agent for a column the task is leaving.
   *
   * `pendingPrompt` is the text the row that triggered the start would rather
   * have as the agent's own starting prompt (see `AutomationAdapter.pendingPrompt`).
   * The caller decides whether the slot is free and reports back, so the row is
   * not then delivered a second time by keystroke.
   */
  startAgent?: (pendingPrompt?: string) => Promise<AgentStartReport | void>;
  /** Overrides the per-adapter budgets. Exit groups pass the short-lock cap. */
  groupBudgetMs?: number;
  /**
   * Rows this caller has already delivered itself, skipped WITHOUT a run record.
   *
   * One caller needs it: the warm live-injection path bundles the column's
   * first message into the same keystroke burst as a `/model` or `/effort`
   * change, because a live session should receive one burst rather than two.
   * It then runs the rest of the group through here, and this is what stops the
   * message going out a second time.
   *
   * No run row, deliberately. The row DID run, and the delivering caller
   * reports its real outcome on the auto-command channel; writing a second
   * record here would double-count it in the log the user reads.
   */
  alreadyDelivered?: ReadonlySet<string>;
  /**
   * A recovery move (out of Done) delivers nothing to the agent: restoring a
   * Done task is usually to inspect it, not to re-run the column's work, so
   * `spawnAgent`'s `suppressAutoCommand` makes `deliverToAgent` a no-op.
   *
   * The skip has to be decided HERE rather than left to that no-op, because a
   * silent `deliverToAgent` lets `send_message` return normally and the row
   * records `succeeded` / "Delivered" for a message nobody received. A run log
   * that says a thing ran when it did not is worse than no log, which is the
   * whole reason the table exists. Every other type still runs: the
   * suppression is about the agent's attention, not about the move.
   *
   * Passed by `spawnAgent` only, never by the warm path's
   * `armEnterAutomations`. That is correct rather than an omission: the Done
   * branch clears `task.session_id` on the way in, so a task coming back OUT
   * of Done has no live session and always lands on Priority 4.
   */
  suppressAgentMessages?: boolean;
  /**
   * The adapters to dispatch through. Defaults to the real singleton; a test
   * passes its own so it can drive the runner's guarantees (isolation, budget,
   * retry, the agent start) without a PTY or a network.
   */
  registry?: AutomationRegistry;
  /**
   * Condition answers the caller already has, keyed by automation id. The
   * turn-end group checks before it runs anything (it has to re-verify the
   * session afterwards), so it passes its answers in. A row with a Condition
   * and no answer here is checked by `checkConditions`, or skipped.
   */
  conditionAnswers?: ReadonlyMap<string, RunConditionAnswer>;
  /**
   * Answer the group's pending Conditions with one call, for a caller that has
   * not checked them itself (enter and exit). Absent, a row with a Condition is
   * skipped with `conditionUnavailableReason`.
   */
  checkConditions?: (rows: ColumnAutomation[], limits: ConditionCheckLimits) => Promise<ConditionCheckResult>;
  /** Why a Condition could not be checked, when neither of the above is given. */
  conditionUnavailableReason?: string;
  /** The call that ran without answering (a timeout), so the skips it caused
   *  link to it: it was still paid for. */
  conditionUnavailableCallId?: string | null;
  /**
   * Turn end only: the agent's final message, which a row's Text match is
   * checked against in code. Null when the read failed (the match then reads
   * as not met, with that reason). Undefined on enter and exit, which have no
   * final message; a Text match is never stored there, so none is checked.
   */
  agentReply?: string | null;
}

/**
 * The longest an enter or exit group waits for its Condition check when it has
 * no tighter budget of its own. The group runs inside the move's task lock; a
 * check that runs past this reads as not checked, and its rows skip.
 */
export const CONDITION_CHECK_WAIT_MS = 60_000;

/** What a Condition check hands the runner: answers by automation id, or why
 *  there are none and the call that ran without answering, if one did. */
export type ConditionCheckResult =
  | { ok: true; answers: ReadonlyMap<string, RunConditionAnswer> }
  | { ok: false; reason: string; callId?: string | null };

/** A row whose Frequency limit is spent on this task, with the reason, or null. */
export function frequencyLimitReason(automation: ColumnAutomation, runs: AutomationRunRepository, taskId: string): string | null {
  if (!hasFrequencyLimit(automation)) return null;
  const limit = automation.max_runs;
  if (runs.countRuns(automation.id, taskId) < limit) return null;
  return limit === 1
    ? 'Already ran once on this task, its limit.'
    : `Already ran ${limit} times on this task, its limit.`;
}

/** The run-log reason for a Condition that answered no. */
export function conditionNotMetReason(answer: RunConditionAnswer): string {
  return answer.reason ? `Condition not met: ${answer.reason}` : 'Condition not met.';
}

/** The run-log reason for a Text match that did not match. */
export function textMatchNotMetReason(match: FinalLineMatch): string {
  return `Text match not met: ${match.reason}`;
}

/** Why a Text match row was skipped when the caller had no final message to give it. */
export const TEXT_MATCH_NO_TURN_REASON = 'A text match is checked only at an agent turn end.';

export async function runAutomations(options: RunAutomationsOptions): Promise<AutomationRunSummary> {
  const { automations, column, context, runs, signal } = options;
  const registry = options.registry ?? automationRegistry;
  const summary: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
  if (automations.length === 0) return summary;

  const groupBudgetMs = options.groupBudgetMs
    ?? (context.trigger === 'exit' ? EXIT_GROUP_BUDGET_MS : null);
  const groupStartedAt = Date.now();

  /**
   * Whether THIS run has already dealt with the agent.
   *
   * Tracked here rather than re-read from `context.task.session_id`, which is a
   * snapshot taken before the first row: after `startAgent()` spawns, the task
   * ROW has a session but this object still says null, so a second
   * agent-needing row in the same list would spawn a second agent. A failed
   * start is remembered too, so the rows behind it skip with the same reason
   * instead of each retrying a CLI that is not there.
   */
  let agentState: 'untouched' | 'started' | 'failed' = 'untouched';
  let agentFailure = '';
  /** Why this run sends the agent nothing, once its start said so (`AgentStartReport`). */
  let agentMessagesWithheld: string | null = null;

  // The group's Conditions, answered once for every row that could run. A row
  // the column cannot run, or whose Frequency is spent, is never asked about:
  // a check costs a model call.
  const conditionAnswers = new Map<string, RunConditionAnswer>(options.conditionAnswers ?? []);
  let conditionUnavailable = options.conditionUnavailableReason ?? 'The condition was not checked.';
  let conditionUnavailableCallId = options.conditionUnavailableCallId ?? null;
  const unanswered = automations.filter((automation) => hasCondition(automation)
    && !conditionAnswers.has(automation.id)
    && registry.get(automation.type) !== undefined
    && canColumnRun(automation.type, { autoSpawn: column.auto_spawn, role: column.role }, automation.trigger).ok
    && frequencyLimitReason(automation, runs, context.task.id) === null);
  if (unanswered.length > 0 && options.checkConditions) {
    // The check is bounded: enter and exit groups run inside the move's task
    // lock, so the group's own budget, else `CONDITION_CHECK_WAIT_MS`, caps it.
    const elapsedMs = Date.now() - groupStartedAt;
    const timeoutMs = groupBudgetMs !== null
      ? Math.max(0, Math.min(groupBudgetMs - elapsedMs, CONDITION_CHECK_WAIT_MS))
      : CONDITION_CHECK_WAIT_MS;
    const checked = await options.checkConditions(unanswered, { signal, timeoutMs });
    if (checked.ok) {
      for (const [automationId, answer] of checked.answers) conditionAnswers.set(automationId, answer);
    } else {
      conditionUnavailable = checked.reason;
      conditionUnavailableCallId = checked.callId ?? null;
    }
  }

  for (const automation of automations) {
    signal.throwIfAborted();

    const runId = randomUUID();
    const started: Parameters<AutomationRunRepository['start']>[0] = { id: runId, automation, taskId: context.task.id };
    const record = (status: AutomationRunStatus, detail: string | null): void => {
      const outcome: AutomationRunOutcome = {
        runId,
        automationId: automation.id,
        name: automation.name,
        columnName: column.name,
        status,
        detail,
      };
      summary.outcomes.push(outcome);
      if (status === 'failed') summary.failures.push(outcome);
    };

    // Delivered by the caller already: a column's first message rides the move's
    // own keystroke burst, so sending it here would send it twice. It is still
    // RECORDED, because "it ran" is precisely what the run log exists to say,
    // and this is the one automation most boards actually have.
    //
    // "Sent", not "Delivered", for the same reason every other enter message
    // says so: the burst was handed to the scheduler, and the confirmed outcome
    // arrives separately on the task's own auto-command channel. Not "with the
    // move's keystrokes" either: a message with line breaks rides the move as a
    // paste, and this runner cannot tell which the move used.
    if (options.alreadyDelivered?.has(automation.id)) {
      runs.recordDeliveredByCaller(started, SENT_WITH_THE_MOVE);
      record('succeeded', SENT_WITH_THE_MOVE);
      continue;
    }

    const adapter = registry.get(automation.type);
    if (!adapter) {
      // A type this build does not know. Recorded rather than thrown, matching
      // what the file reader does with a retired type: warn and skip.
      runs.recordSkipped(started, `Kangentic does not know the automation type "${automation.type}".`);
      record('skipped', `Unknown automation type "${automation.type}".`);
      continue;
    }

    const runnable = canColumnRun(automation.type, { autoSpawn: column.auto_spawn, role: column.role }, automation.trigger);
    if (!runnable.ok) {
      // Stored for kangentic_get_automation_runs, which an agent reads: English.
      const reason = englishText(runnable.reason);
      runs.recordSkipped(started, reason);
      record('skipped', reason);
      continue;
    }

    if (options.suppressAgentMessages && adapter.manifest.needs.includes('agent')) {
      const reason = 'Restoring a task from Done does not message the agent. The next move does.';
      runs.recordSkipped(started, reason);
      record('skipped', reason);
      continue;
    }

    // Frequency: a row that has run its limit on this task is skipped. A skip
    // is not a run, so it never counts toward the limit itself.
    const spent = frequencyLimitReason(automation, runs, context.task.id);
    if (spent) {
      runs.recordSkipped(started, spent);
      record('skipped', spent);
      continue;
    }

    // Text match: the Condition kind checked here, in code, against the agent's
    // last line. Free, so it comes before anything that costs: a miss never
    // reaches an Automation agent. Like a Condition's no, a miss is not a run,
    // and what was read rides the run row either way.
    if (hasFinalLine(automation)) {
      if (options.agentReply === undefined) {
        runs.recordSkipped(started, TEXT_MATCH_NO_TURN_REASON);
        record('skipped', TEXT_MATCH_NO_TURN_REASON);
        continue;
      }
      const match = matchFinalLine(automation.final_line, options.agentReply);
      started.finalLine = match;
      if (!match.met) {
        const reason = textMatchNotMetReason(match);
        runs.recordSkipped(started, reason);
        record('skipped', reason);
        continue;
      }
    }

    // Condition: a no is not a run. The answer, yes or no, rides the run row so
    // the log says why a row ran or did not.
    if (hasCondition(automation)) {
      const answer = conditionAnswers.get(automation.id);
      if (!answer) {
        started.backgroundCallId = conditionUnavailableCallId;
        runs.recordSkipped(started, conditionUnavailable);
        record('skipped', conditionUnavailable);
        continue;
      }
      started.condition = answer;
      if (!answer.met) {
        const reason = conditionNotMetReason(answer);
        runs.recordSkipped(started, reason);
        record('skipped', reason);
        continue;
      }
    }

    // The agent starts before the first row that needs it, not at a fixed point
    // in the list, which is what lets a script run BEFORE the agent sees the
    // worktree it prepared.
    if (adapter.manifest.needs.includes('agent') && context.task.session_id === null && agentState !== 'started') {
      if (agentState === 'failed') {
        runs.recordSkipped(started, agentFailure);
        record('skipped', agentFailure);
        continue;
      }
      if (!options.startAgent) {
        // Worded for the FACT, not for one caller. Two groups reach here with
        // no `startAgent`: an exit group (the task is leaving, so there is
        // nothing to start it for) and a re-run (which is not a move at all).
        // Naming the exit case, as this used to, read as plainly wrong on a
        // re-run of an On enter row, which is exactly where a user meets it.
        const reason = 'The agent is not running, and only a move into this column can start one.';
        runs.recordSkipped(started, reason);
        record('skipped', reason);
        continue;
      }
      try {
        // Hand the spawn this row's preferred prompt, so a message that starts
        // the agent arrives as its opening prompt rather than as keystrokes
        // typed at a CLI that has not spoken yet.
        const config = interpolateAutomationConfig(automation.config, adapter.manifest.fields, context.templateVars);
        const startReport = await options.startAgent(adapter.pendingPrompt?.(config));
        agentState = 'started';
        summary.startedAgent = true;
        if (startReport && startReport.withholdMessages) agentMessagesWithheld = startReport.withholdMessages;
      } catch (error) {
        agentState = 'failed';
        agentFailure = `The agent could not be started: ${messageOf(error)}`;
        runs.recordSkipped(started, agentFailure);
        record('skipped', agentFailure);
        continue;
      }
    }

    // The start said not to message the agent: the row that started it (whose
    // message the spawn did not send) and every message row after it.
    if (agentMessagesWithheld && adapter.manifest.needs.includes('agent')) {
      runs.recordSkipped(started, agentMessagesWithheld);
      record('skipped', agentMessagesWithheld);
      continue;
    }

    const budgetMs = remainingBudget(adapter.manifest.timeoutMs, groupBudgetMs, groupStartedAt);
    if (budgetMs !== null && budgetMs <= 0) {
      const reason = 'Exit automations are capped so the board stays responsive.';
      runs.recordSkipped(started, reason);
      record('skipped', reason);
      continue;
    }

    runs.start(started);
    // Name the running row on the card. This closes the gap where a column with
    // "Start an agent here" OFF and a slow webhook showed the user nothing at
    // all: no spawn means no phase label, so the card sat on its old state for
    // the whole 30 seconds. `createProgressCallback` passes an unrecognized
    // phase through verbatim, which is what makes an automation's own name a
    // legal label without teaching PHASE_LABELS about automations.
    context.onProgress?.(`Running "${automation.name}"...`);
    const attemptLimit = adapter.manifest.retry?.attempts ?? 1;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < attemptLimit) {
      attempt += 1;
      // Recomputed PER ATTEMPT, not reused from the pre-check above. Arming
      // every retry with the full budget meant a retrying row could outlast the
      // group cap it was measured against: three webhook attempts at 30s each,
      // plus backoff, against a 60s exit group. The cap is the point of the
      // exit group, so each attempt gets only what is left of it.
      const attemptBudgetMs = remainingBudget(adapter.manifest.timeoutMs, groupBudgetMs, groupStartedAt);
      if (attemptBudgetMs !== null && attemptBudgetMs <= 0) {
        lastError = new AutomationTimeoutError('Ran out of the group budget before the next attempt.');
        break;
      }
      const timeout = new AbortController();
      const timer = attemptBudgetMs === null ? null : setTimeout(() => timeout.abort(), attemptBudgetMs);
      const combined = AbortSignal.any([signal, timeout.signal]);

      try {
        const config = interpolateAutomationConfig(automation.config, adapter.manifest.fields, context.templateVars);
        const outcome = await adapter.execute(config, { ...context, runId, signal: combined, automationName: automation.name });
        runs.finish(runId, 'succeeded', outcome.detail, attempt);
        record('succeeded', outcome.detail);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        // The MOVE was aborted (superseded, or shutting down). That is not this
        // automation's failure and the caller has to see it.
        if (signal.aborted) {
          runs.finish(runId, 'interrupted', 'The move was superseded.', attempt);
          record('interrupted', 'The move was superseded.');
          throw error;
        }
        if (timeout.signal.aborted) {
          lastError = new AutomationTimeoutError(`Gave up after ${Math.round((attemptBudgetMs ?? 0) / 1000)}s.`);
          break;
        }
        if (attempt >= attemptLimit || !isRetryableAutomationError(error)) break;
        try {
          await delayBeforeRetry(error.retryAfterSeconds, attempt, signal);
        } catch (abortedDuringBackoff) {
          // `delayBeforeRetry` REJECTS when the move is superseded mid-backoff.
          // A throw from inside a catch block is not caught by its own try, so
          // this escaped the row loop and the function without ever closing the
          // run row that `runs.start` opened: the row sat at 'running' until the
          // next boot's sweep. Same close the abort branch above does.
          runs.finish(runId, 'interrupted', 'The move was superseded.', attempt);
          record('interrupted', 'The move was superseded.');
          throw abortedDuringBackoff;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (lastError !== null) {
      const detail = messageOf(lastError);
      runs.finish(runId, 'failed', detail, attempt);
      record('failed', detail);
      // And the loop continues. This is the isolate-and-continue rule.
      console.error(`[automations] "${automation.name}" on ${column.name} failed: ${detail}`);
      continue;
    }

    // A row that moved the task (Move to column) ends the group: the task has
    // left the column, so the rows below it no longer apply. Checked here,
    // before the next iteration's abort check, so the group's own move cannot
    // read as the move that superseded it.
    if (adapter.manifest.endsGroup) {
      summary.endedGroup = true;
      break;
    }
  }

  return summary;
}

/**
 * How long this row may take: its own budget, further capped by what is left of
 * the group's. Null means unbounded, which only the two adapters that cannot
 * hang ever get.
 */
function remainingBudget(adapterMs: number | null, groupMs: number | null, groupStartedAt: number): number | null {
  if (groupMs === null) return adapterMs;
  const left = groupMs - (Date.now() - groupStartedAt);
  if (adapterMs === null) return left;
  return Math.min(adapterMs, left);
}

/** Exponential backoff with the server's own answer preferred over ours. */
function delayBeforeRetry(retryAfterSeconds: number | null, attempt: number, signal: AbortSignal): Promise<void> {
  const backoffMs = retryAfterSeconds !== null
    ? Math.min(retryAfterSeconds * 1000, 30_000)
    : Math.min(500 * 2 ** (attempt - 1), 8_000);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, backoffMs);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
