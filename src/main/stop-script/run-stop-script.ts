/**
 * Run a project's Stop script: the one way it starts.
 *
 * A paused task keeps everything its agent started, and only the project knows
 * how to stop its stack cleanly. So a project names a command (`stopScript` in
 * `kangentic.json`), and Kangentic runs it in the task's worktree, or the project
 * folder for a task with none, after an idle pause (`parked-stop.ts`) and before
 * a terminal transition's reap (`terminal-stop.ts`).
 *
 * It runs through the platform shell by `spawnWithAbort`, as the Post-Worktree
 * Script does, but not through `runInitScript`, whose counter holds back
 * removed-worktree deletes: this script is no install racing a disk.
 *
 * The script gets no task tag. Only `performSpawn` sets `KANGENTIC_TASK_ID`, and
 * main carries a task's tag when Kangentic runs from a task's terminal, so it is
 * removed here: a script that reads as the task's would be its own leftover.
 *
 * It never throws and never blocks anything: a failure is an outcome, and the
 * caller logs it and goes on. One run per task at a time, so a move to Done
 * during a pause's stop waits for that stop and does not start a second one. When
 * that move's bound or signal ends the wait it ends the run too: the reap and the
 * worktree removal come next, and the script has no tag for the reap to find.
 *
 * A Stop script runs a third-party tool that can reach past its own tree. Test
 * with a stub, never a real stack on the machine running Kangentic.
 */

import fsPromises from 'node:fs/promises';
import { spawnWithAbort } from '../git/spawn-with-abort';
import { childProcessEnv } from '../shared/child-env';
import { TASK_PROCESS_TAG_ENV } from '../pty/process-tag/task-process-tag';
import type { StopScriptFailure } from '../../shared/types';

/** A pause's budget. Nothing waits on it, so it can cover a real stop. */
export const STOP_SCRIPT_PAUSE_TIMEOUT_MS = 120_000;
/**
 * A terminal transition's budget, for one call however many tasks it covers. It
 * runs inside the task lock, ahead of the reap, so it is the shortest bound that
 * still lets a stack stop by itself. The reap ends what is left.
 */
export const STOP_SCRIPT_TERMINAL_TIMEOUT_MS = 30_000;
/** How much of a failed script's last line reaches the toast. */
const MAX_FAILURE_DETAIL_CHARS = 300;

const LABEL = 'stop script';

export type StopScriptOutcome =
  | { status: 'ok' }
  /** Cancelled, or a joined run outlasted this caller's bound. Neither is the script's failure. */
  | { status: 'aborted' }
  | { status: 'failed'; failure: StopScriptFailure };

export interface RunStopScriptInput {
  taskId: string;
  script: string;
  cwd: string;
  timeoutMs: number;
  /** A superseding move: ends the script's tree at once. */
  signal?: AbortSignal;
}

interface StopScriptRun {
  outcome: Promise<StopScriptOutcome>;
  /** Ends the script's tree, for a caller that joined this run. */
  stop: AbortController;
}

/** Runs in flight, by task. Exported state is `isStopScriptRunning`. */
const runs = new Map<string, StopScriptRun>();

export function isStopScriptRunning(taskId: string): boolean {
  return runs.has(taskId);
}

/** Where a task's script runs: its worktree while that exists, else the project folder. */
export async function stopScriptFolder(worktreePath: string | null, projectPath: string): Promise<string> {
  if (!worktreePath) return projectPath;
  return fsPromises.access(worktreePath).then(() => worktreePath, () => projectPath);
}

/** The last non-empty line of what the script printed, for a one-line toast. */
function lastLineOf(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return (lines[lines.length - 1] ?? '').slice(0, MAX_FAILURE_DETAIL_CHARS);
}

/** Read `spawnWithAbort`'s rejection, whose wording is fixed by the label passed to it. */
export function classifyStopScriptError(error: unknown, timeoutMs: number, signal: AbortSignal | undefined): StopScriptOutcome {
  if (signal?.aborted) return { status: 'aborted' };
  const message = error instanceof Error ? error.message : String(error);
  const exit = /^stop script exited with code (-?\d+):\s*([\s\S]*)$/.exec(message);
  if (exit) return { status: 'failed', failure: { kind: 'exit-code', exitCode: Number(exit[1]), detail: lastLineOf(exit[2]) } };
  if (message.includes('timeout after')) return { status: 'failed', failure: { kind: 'timeout', timeoutMs } };
  return { status: 'failed', failure: { kind: 'error', detail: message.slice(0, MAX_FAILURE_DETAIL_CHARS) } };
}

/** Wait for a run another caller started, and end it when this caller can wait no longer. */
function joinRun(run: StopScriptRun, timeoutMs: number, signal: AbortSignal | undefined): Promise<StopScriptOutcome> {
  return new Promise((resolve) => {
    const settle = (outcome: StopScriptOutcome): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      run.stop.abort();
      settle({ status: 'aborted' });
    };
    const timer = setTimeout(onAbort, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    void run.outcome.then(settle);
  });
}

export function runStopScript(input: RunStopScriptInput): Promise<StopScriptOutcome> {
  const inFlight = runs.get(input.taskId);
  if (inFlight) return joinRun(inFlight, input.timeoutMs, input.signal);
  const startedAt = Date.now();
  const stop = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  const outcome = spawnWithAbort(
    { command: input.script, cwd: input.cwd, label: LABEL, signalKillAssertsTimeout: false },
    {
      timeoutMs: input.timeoutMs,
      signal,
      env: childProcessEnv({ [TASK_PROCESS_TAG_ENV]: undefined }),
    },
  ).then(
    (): StopScriptOutcome => {
      console.log(`[STOP-SCRIPT] task ${input.taskId.slice(0, 8)}: finished in ${Date.now() - startedAt} ms`);
      return { status: 'ok' };
    },
    (error: unknown): StopScriptOutcome => {
      const classified = classifyStopScriptError(error, input.timeoutMs, signal);
      if (classified.status === 'failed') {
        console.warn(`[STOP-SCRIPT] task ${input.taskId.slice(0, 8)}: failed after ${Date.now() - startedAt} ms:`, classified.failure);
      } else {
        console.log(`[STOP-SCRIPT] task ${input.taskId.slice(0, 8)}: cancelled after ${Date.now() - startedAt} ms`);
      }
      return classified;
    },
  ).finally(() => {
    runs.delete(input.taskId);
  });
  runs.set(input.taskId, { outcome, stop });
  return outcome;
}
