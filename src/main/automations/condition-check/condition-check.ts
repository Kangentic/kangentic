import { ensureAnswerHomeDirectory, withAnswerRunDirectory } from '../../agent/shared/answer-run-directory';
import { startRecordedCall, type BackgroundCallSink } from '../../background-calls/record-background-call';
import {
  resetAutomationAgentCacheForTests,
  resolveAutomationAgent,
  type AutomationAgentDeps,
  type AutomationAgentGapCause,
  type ResolvedAutomationAgent,
} from '../automation-agent';
import { buildConditionPrompt, parseConditionReply, type ConditionAnswer, type ConditionPromptInput } from './condition-prompt';

/**
 * Answer a column's pending Conditions with one headless call on the
 * Automation agent (`AppConfig.automation`).
 *
 * The answer path is #529's (`answerFromContext`, in the shared answer home,
 * each run in a directory of its own), resolved the way the Knowledge Graph
 * resolves its agent but from the Automation agent's own choice, with no
 * fallback: a check never spends on an agent nobody chose.
 *
 * Two costs are held down because a check runs at turn ends, which a busy
 * board produces many of:
 * - the CLI's detection and effort levels are cached for a few minutes rather
 *   than probed on every check (`automation-agent.ts`; `resolveAnswerRun`
 *   probes per call, which suits a question a person asked, not a background
 *   check);
 * - at most `MAX_CONCURRENT_CHECKS` run at once, each a CLI started in the pty
 *   host, so a workflow ending many turns together queues its checks instead
 *   of starting them all.
 */

/**
 * What a check answered, or why it did not. `callId` names the background
 * call (`background_calls.id`) whenever a CLI actually ran, a failed or
 * abandoned one included, since it was still paid for; null or absent when
 * none did.
 */
export type ConditionCheckOutcome =
  | { ok: true; answers: Map<string, ConditionAnswer>; agentName: string; callId: string | null }
  | { ok: false; reason: string; cause: ConditionCheckGapCause; callId?: string | null };

/**
 * Why a check did not answer, typed so a caller never matches its sentence:
 * `'unavailable'` is a setup gap a person fixes in Settings, `'failed'` a call
 * that threw, timed out or could not be set up, which a later try may pass,
 * and `'stopped'` a caller that stopped waiting (its task moved on).
 */
export type ConditionCheckGapCause = AutomationAgentGapCause | 'stopped';

/** The dependencies a check needs, so the module tests without Electron. */
export interface ConditionCheckDeps extends AutomationAgentDeps {
  /** Where the check's call is recorded; absent records nothing. */
  recordCall?: BackgroundCallSink;
}

/** Whose check this is, for its record: the project's ledger, the task and the column. */
export interface ConditionCheckCall {
  projectId: string | null;
  taskId: string | null;
  swimlaneId: string | null;
  /** A column's Conditions, or a workflow task's own step check. */
  job: 'condition_check' | 'workflow_step';
}

const MAX_CONCURRENT_CHECKS = 2;

let runningChecks = 0;
const waitingChecks: Array<() => void> = [];

/**
 * Take a check slot, or give up when `signal` aborts first. A waiter that gives
 * up leaves the queue, so it never takes a slot nobody will release.
 */
function acquireCheckSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (runningChecks < MAX_CONCURRENT_CHECKS) {
    runningChecks += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      const index = waitingChecks.indexOf(waiter);
      if (index >= 0) waitingChecks.splice(index, 1);
      resolve(false);
    };
    const waiter = (): void => {
      signal.removeEventListener('abort', onAbort);
      runningChecks += 1;
      resolve(true);
    };
    waitingChecks.push(waiter);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long a caller waits for a check. Enter and exit groups run inside the
 * move's task lock, so their check is bounded: a queue of turn-end checks ahead
 * of it, or a slow CLI, must not hold that task's lock for minutes.
 */
export interface ConditionCheckLimits {
  /** The caller moved on (its move was superseded): stop waiting. */
  signal?: AbortSignal;
  /** The longest the caller waits, the slot queue included. */
  timeoutMs?: number;
}

/** Settles with the work's result, or with null once `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<{ value: T } | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function releaseCheckSlot(): void {
  runningChecks -= 1;
  const next = waitingChecks.shift();
  if (next) next();
}

/** Why the Automation agent cannot run a check right now, or null when it can. */
export async function automationAgentUnavailableReason(deps: ConditionCheckDeps): Promise<string | null> {
  const resolved = await resolveCheckAgent(deps);
  return resolved.ok ? null : resolved.reason;
}

/** Which agent answers, and with what. */
function resolveCheckAgent(deps: ConditionCheckDeps): Promise<ResolvedAutomationAgent> {
  return resolveAutomationAgent(deps, 'check');
}

/**
 * Answer every Condition in `input.rows` with one call. A Condition the reply
 * did not answer (skipped, or written twice) is asked once more, alone with
 * any others the reply missed; left unanswered again, it comes back not met
 * with the reason saying so, never as a guess. Each answer names the call
 * that gave it, so a retried row links to the retry.
 *
 * A check that could not run at all returns `ok: false` with why, and the
 * caller skips those rows (a skip is not a run, so the next trigger checks
 * them again). So does one the caller stopped waiting for (`limits`); its CLI
 * run finishes in the background and frees its slot then. A retry the caller
 * stopped waiting for keeps the first call's answers instead.
 */
export async function checkAutomationConditions(
  deps: ConditionCheckDeps,
  input: ConditionPromptInput,
  limits: ConditionCheckLimits = {},
  callContext: ConditionCheckCall = { projectId: null, taskId: null, swimlaneId: null, job: 'condition_check' },
): Promise<ConditionCheckOutcome> {
  if (input.rows.length === 0) return { ok: true, answers: new Map(), agentName: '', callId: null };
  const stop = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => stop.abort();
  if (limits.signal?.aborted) stop.abort();
  limits.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = limits.timeoutMs !== undefined
    ? setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, Math.max(0, limits.timeoutMs))
    : null;
  // A time limit that ran out is the agent's failure, a caller that moved on is not.
  const stopped = (callId?: string | null): Extract<ConditionCheckOutcome, { ok: false }> => ({
    ok: false,
    reason: timedOut
      ? 'The Automation agent did not answer in time, so the condition was not checked.'
      : 'The condition check was stopped because the task moved on.',
    cause: timedOut ? 'failed' : 'stopped',
    ...(callId === undefined || callId === null ? {} : { callId }),
  });

  try {
    // Inside the bound too: finding the agent can probe its CLI, and a probe
    // that hangs must not hold the move's task lock past the limit.
    const settledAgent = await untilAborted(resolveCheckAgent(deps), stop.signal);
    if (!settledAgent) return stopped();
    const resolved = settledAgent.value;
    if (!resolved.ok) return resolved;
    if (stop.signal.aborted) return stopped();

    /** One call on the agent, inside the caller's bound, with a slot of its own. */
    const ask = async (prompt: string): Promise<AskResult> => {
      if (!(await acquireCheckSlot(stop.signal))) return { kind: 'stopped', callId: null };
      // Recorded when the CLI settles, not when this returns: a caller that
      // stops waiting leaves the run going, and it is still paid for.
      const recorded = startRecordedCall(deps.recordCall, {
        projectId: callContext.projectId,
        job: callContext.job,
        taskId: callContext.taskId,
        swimlaneId: callContext.swimlaneId,
        agent: resolved.agentName,
        requestedModel: resolved.model,
        effort: resolved.effort,
      }, async (onUsage) => {
        try {
          const answerHome = await ensureAnswerHomeDirectory();
          return await withAnswerRunDirectory((runDirectory) => resolved.adapter.answerFromContext!(
            prompt,
            resolved.cliPath,
            answerHome,
            resolved.model,
            { effort: resolved.effort, runDirectory, onUsage },
          ));
        } finally {
          releaseCheckSlot();
        }
      });
      const answering = recorded.done;
      // A caller that stopped waiting leaves this run to finish on its own.
      answering.catch(() => undefined);
      try {
        const settled = await untilAborted(answering, stop.signal);
        return settled ? { kind: 'reply', reply: settled.value, callId: recorded.callId } : { kind: 'stopped', callId: recorded.callId };
      } catch (error) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error), callId: recorded.callId };
      }
    };

    const first = await ask(buildConditionPrompt(input));
    if (first.kind === 'stopped') return stopped(first.callId);
    if (first.kind === 'failed') {
      return { ok: false, reason: `The Automation agent could not check the condition: ${first.detail}`, cause: 'failed', callId: first.callId };
    }
    const { answers, unanswered } = answersFrom(first.reply, input.rows, first.callId);
    if (unanswered.length === 0) return { ok: true, answers, agentName: resolved.agentName, callId: first.callId };

    // Ask once more for just the rows the reply left unanswered, before any
    // counts as not met. A retry that is stopped or fails keeps the first
    // answers, which is the outcome a check had before it retried.
    warnUnanswered(unanswered.map(labelOf), first.callId, first.reply, 'so it is asked once more');
    const retryRows = unanswered.map((position) => input.rows[position]);
    const retry = await ask(buildConditionPrompt({ ...input, rows: retryRows }, { retry: true }));
    if (retry.kind === 'reply') {
      const retried = answersFrom(retry.reply, retryRows, retry.callId);
      for (const [automationId, answer] of retried.answers) answers.set(automationId, answer);
      if (retried.unanswered.length > 0) {
        // The retry numbered its rows from C1, so a position in it maps back
        // through `unanswered` to the first prompt's label.
        const stillUnanswered = retried.unanswered.map((positionInRetry) => labelOf(unanswered[positionInRetry]));
        warnUnanswered(stillUnanswered, retry.callId, retry.reply, 'again, so it counts as not met');
      }
    }
    return { ok: true, answers, agentName: resolved.agentName, callId: first.callId };
  } finally {
    if (timer) clearTimeout(timer);
    limits.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** One call on the agent: its reply, or why there is none. `callId` is null
 *  only when no CLI ran. */
type AskResult =
  | { kind: 'reply'; reply: string; callId: string }
  | { kind: 'stopped'; callId: string | null }
  | { kind: 'failed'; detail: string; callId: string };

/** How many characters of a trimmed reply the warning keeps. A well-formed reply
 *  is one short line per condition, so this is plenty to see how a malformed one
 *  went wrong. */
const UNANSWERED_REPLY_LOG_CHARS = 1_000;

const UNANSWERED_REASON = 'The Automation agent did not answer this condition.';

/** A row's label in the first prompt, which the warnings use for every ask. */
function labelOf(position: number): string {
  return `C${position + 1}`;
}

/**
 * One warning for a reply that left conditions unanswered: which labels, the
 * call (`background_calls.id`), what happens next, and the trimmed reply cut
 * to `UNANSWERED_REPLY_LOG_CHARS`. A warning because only warnings and errors
 * reach the log file without Persist Console Logs. `[automations]` is not a
 * Sentry breadcrumb tag (`shared/sentry-breadcrumbs.ts`), so the reply's text,
 * written from the task's own, stays in the local log.
 */
function warnUnanswered(labels: ReadonlyArray<string>, callId: string, reply: string, consequence: string): void {
  const trimmed = reply.trim();
  const clipped = trimmed.slice(0, UNANSWERED_REPLY_LOG_CHARS);
  const leftOut = trimmed.length - clipped.length;
  const more = leftOut > 0 ? ` (${leftOut} more characters)` : '';
  console.warn(`[automations] The Automation agent left ${labels.join(', ')} unanswered ${consequence} (call ${callId}). Its reply: ${JSON.stringify(clipped)}${more}`);
}

/** Every row's answer from the reply, each naming the call that gave it, and
 *  the positions of the rows the reply skipped. A skipped row is not met, and
 *  says so. */
function answersFrom(
  reply: string,
  rows: ConditionPromptInput['rows'],
  callId: string,
): { answers: Map<string, ConditionAnswer>; unanswered: number[] } {
  const parsed = parseConditionReply(reply, rows.length);
  const answers = new Map<string, ConditionAnswer>();
  const unanswered: number[] = [];
  rows.forEach((row, index) => {
    const parsedAnswer = parsed.get(index);
    if (!parsedAnswer) unanswered.push(index);
    answers.set(row.automationId, { ...(parsedAnswer ?? { met: false, reason: UNANSWERED_REASON }), callId });
  });
  return { answers, unanswered };
}

/** For tests: forget cached CLI detections. */
export function resetConditionCheckCacheForTests(): void {
  resetAutomationAgentCacheForTests();
}
