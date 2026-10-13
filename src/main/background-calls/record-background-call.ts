import { v4 as uuidv4 } from 'uuid';
import type { AgentCallUsage, BackgroundCallJob, BackgroundCallOutcome } from '../../shared/types';
import type { RecordBackgroundCallInput } from '../db/repositories/background-call-repository';

/**
 * Records one headless agent call in its project's `background_calls` ledger.
 *
 * The call's id exists BEFORE the CLI starts, so a caller can link rows to it
 * even when it stops waiting: a Condition check the move gave up on keeps
 * running in the background and is still paid for. The row is written when the
 * CLI SETTLES, not when the caller returns, for the same reason.
 *
 * What the CLI reported reaches the row through the `onUsage` sink handed to
 * `run`; an adapter that reports nothing never calls it, and the row's tokens
 * and cost stay null. A failed write is logged and never fails the call.
 */

/** What a background call is, before it runs. */
export interface BackgroundCallMeta {
  /** The project whose ledger records it, or null for none (nothing is written). */
  projectId: string | null;
  job: BackgroundCallJob;
  taskId: string | null;
  swimlaneId: string | null;
  agent: string;
  /** The model Kangentic asked for, or null for the agent's own default. */
  requestedModel: string | null;
  effort: string | null;
}

/** Where a finished call is written: a project's ledger, or a test double. */
export type BackgroundCallSink = (projectId: string, input: RecordBackgroundCallInput) => void;

export interface RecordedCall<T> {
  /** The call's id, known before the CLI starts. */
  callId: string;
  /** Settles with the run's own result. */
  done: Promise<T>;
}

/**
 * What the runners reject with when Kangentic's own timer stops a CLI:
 * `cli-print.ts`, the stdin answer session, and Antigravity's print runner.
 * Matched whole, so a CLI's own error that mentions a timeout ("API Error:
 * Request timed out") is recorded as a failure, not as our timeout.
 */
const RUNNER_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set(['the agent timed out', 'antigravity print run timed out']);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run's error, read as Kangentic's timeout or a failure. */
function outcomeOf(error: unknown): BackgroundCallOutcome {
  return RUNNER_TIMEOUT_MESSAGES.has(messageOf(error)) ? 'timed_out' : 'failed';
}

/**
 * Start `run` as a recorded call. `run` receives the usage sink to hand the
 * adapter. With no sink or no project, the call runs unrecorded and still gets
 * an id.
 */
export function startRecordedCall<T>(
  sink: BackgroundCallSink | undefined,
  meta: BackgroundCallMeta,
  run: (onUsage: (usage: AgentCallUsage) => void) => Promise<T>,
): RecordedCall<T> {
  const callId = uuidv4();
  const startedAt = new Date();
  let usage: AgentCallUsage | null = null;
  const done = run((reported) => { usage = reported; });

  const write = (outcome: BackgroundCallOutcome, detail: string | null): void => {
    if (!sink || !meta.projectId) return;
    try {
      sink(meta.projectId, {
        id: callId,
        job: meta.job,
        taskId: meta.taskId,
        swimlaneId: meta.swimlaneId,
        agent: meta.agent,
        requestedModel: meta.requestedModel,
        effort: meta.effort,
        usage,
        durationMs: Date.now() - startedAt.getTime(),
        outcome,
        detail,
        startedAt: startedAt.toISOString(),
      });
    } catch (error) {
      console.warn(`[BACKGROUND_CALLS] could not record a ${meta.job} call:`, error instanceof Error ? error.message : error);
    }
  };
  done.then(
    () => write('succeeded', null),
    (error: unknown) => write(outcomeOf(error), messageOf(error)),
  );
  return { callId, done };
}
