import { randomUUID } from 'node:crypto';
import { canColumnRun, EXIT_GROUP_BUDGET_MS } from '../../shared/automation-manifest';
import type { AutomationRunStatus, ColumnAutomation, Swimlane } from '../../shared/types';
import type { AutomationRunRepository } from '../db/repositories/automation-run-repository';
import { automationRegistry, type AutomationRegistry } from './automation-registry';
import { interpolateAutomationConfig } from './interpolate-config';
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
  startAgent?: (pendingPrompt?: string) => Promise<void>;
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
}

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
    // arrives separately on the task's own auto-command channel.
    if (options.alreadyDelivered?.has(automation.id)) {
      runs.recordDeliveredByCaller(started, "Sent with the move's own keystrokes.");
      record('succeeded', "Sent with the move's own keystrokes.");
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
      runs.recordSkipped(started, runnable.reason);
      record('skipped', runnable.reason);
      continue;
    }

    if (options.suppressAgentMessages && adapter.manifest.needs.includes('agent')) {
      const reason = 'Restoring a task from Done does not message the agent. The next move does.';
      runs.recordSkipped(started, reason);
      record('skipped', reason);
      continue;
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
        await options.startAgent(adapter.pendingPrompt?.(config));
        agentState = 'started';
        summary.startedAgent = true;
      } catch (error) {
        agentState = 'failed';
        agentFailure = `The agent could not be started: ${messageOf(error)}`;
        runs.recordSkipped(started, agentFailure);
        record('skipped', agentFailure);
        continue;
      }
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
      const timeout = new AbortController();
      const timer = budgetMs === null ? null : setTimeout(() => timeout.abort(), budgetMs);
      const combined = AbortSignal.any([signal, timeout.signal]);

      try {
        const config = interpolateAutomationConfig(automation.config, adapter.manifest.fields, context.templateVars);
        const outcome = await adapter.execute(config, { ...context, runId, signal: combined });
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
          lastError = new AutomationTimeoutError(`Gave up after ${Math.round((budgetMs ?? 0) / 1000)}s.`);
          break;
        }
        if (attempt >= attemptLimit || !isRetryableAutomationError(error)) break;
        await delayBeforeRetry(error.retryAfterSeconds, attempt, signal);
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
