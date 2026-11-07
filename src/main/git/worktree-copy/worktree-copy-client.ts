import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { UtilityRestartPolicy } from '../../utility-process/restart-policy';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr } from '../../utility-process/stderr-tail';
import { unpacked } from '../../utility-process/paths';
import { WorktreeCopyLimitError } from '../worktree-errors';
import { copyEntries, type CopyEntriesRequest, type CopyEntriesResult } from './copy-entries';
import type { WorktreeCopyAnswer } from './worktree-copy-worker';

const SERVICE_NAME = 'kangentic-worktree-copy';
/**
 * A backstop for a disk that stopped answering. The limits in `copy-entries.ts`
 * bound a healthy copy to seconds, so this is far past any of them.
 */
const COPY_TIMEOUT_MS = 120_000;
/** How long an abort waits for the killed worker's exit. As `TREE_EXIT_WAIT_MS` does for a script's tree. */
const EXIT_WAIT_MS = 5_000;
/** After this many crashes inside the policy's decay window, copies run on main until it decays. */
const MAX_CRASHES = 3;
const STOPPED_FOR_QUIT = 'The worktree copy stopped for the quit';

function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The copy was stopped', 'AbortError');
}

/**
 * Runs a folder or glob copy in a utility process of its own. One per request:
 * an abort is a kill, which must not reach another task's copy, and with no
 * process kept between copies there is no idle state to hold.
 *
 * A fork that fails, or a worker that dies with no answer, falls back to
 * `copyEntries` on main, which is async and bounded by the same limits, and
 * goes through the restart policy, so it is reported and a worker that keeps
 * dying stops being forked. An answer of failure is the copy's own and rejects.
 * An abort kills the worker and rejects once it has exited, so a removal or a
 * new creation never lands while it still writes. After a quit's `dispose` a
 * copy rejects: nothing could kill one that ran on main.
 */
export class WorktreeCopyClient {
  private readonly children = new Set<UtilityProcess>();
  private readonly restartPolicy: UtilityRestartPolicy;
  private disposed = false;

  constructor(restartPolicy?: UtilityRestartPolicy) {
    this.restartPolicy = restartPolicy
      ?? new UtilityRestartPolicy({ service: SERVICE_NAME, maxCrashes: MAX_CRASHES });
  }

  async copy(request: CopyEntriesRequest, signal?: AbortSignal): Promise<CopyEntriesResult> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error(STOPPED_FOR_QUIT);
    const stderrTail = new StderrTail();
    const child = this.fork(stderrTail);
    if (!child) return copyEntries(request, signal);
    const answer = await this.run(child, request, stderrTail, signal);
    if (answer === null) {
      signal?.throwIfAborted();
      if (this.disposed) throw new Error(STOPPED_FOR_QUIT);
      console.warn('[WORKTREE] The copy worker exited with no answer; copying in the main process');
      return copyEntries(request, signal);
    }
    if (answer.type === 'result') return answer.result;
    throw answer.overLimit ? new WorktreeCopyLimitError(answer.message) : new Error(answer.message);
  }

  private fork(stderrTail: StderrTail): UtilityProcess | null {
    if (!this.restartPolicy.maySpawn()) return null;
    let child: UtilityProcess;
    try {
      const workerPath = unpacked(path.join(__dirname, 'worktree-copy-worker.js'));
      child = utilityProcess.fork(workerPath, [], { serviceName: SERVICE_NAME, stdio: UTILITY_PROCESS_STDIO });
    } catch (error) {
      console.warn('[WORKTREE] Could not start the copy worker; copying in the main process:', error);
      this.restartPolicy.recordCrash(null, undefined, { cause: 'fork_failed' });
      return null;
    }
    // Drained from the first tick: an undrained pipe blocks the worker.
    captureWorkerStderr(child, stderrTail, !app.isPackaged);
    this.children.add(child);
    child.on('exit', () => this.children.delete(child));
    return child;
  }

  /** The worker's answer, or null when it exited without one. */
  private run(child: UtilityProcess, request: CopyEntriesRequest, stderrTail: StderrTail, signal?: AbortSignal): Promise<WorktreeCopyAnswer | null> {
    return new Promise<WorktreeCopyAnswer | null>((resolve, reject) => {
      let stopping: Error | null = null;
      let exitWait: NodeJS.Timeout | null = null;
      let exited = false;
      let answered = false;

      const settle = (finish: () => void): void => {
        clearTimeout(timeout);
        if (exitWait) clearTimeout(exitWait);
        signal?.removeEventListener('abort', onAbort);
        finish();
      };
      const stop = (reason: Error): void => {
        if (stopping) return;
        stopping = reason;
        child.kill();
        if (exited) { settle(() => reject(reason)); return; }
        exitWait = setTimeout(() => settle(() => reject(reason)), EXIT_WAIT_MS);
        exitWait.unref();
      };
      const onAbort = (): void => {
        if (signal) stop(abortErrorOf(signal));
      };
      const timeout = setTimeout(() => stop(new Error('The worktree copy timed out')), COPY_TIMEOUT_MS);
      timeout.unref();

      child.on('message', (message: unknown) => {
        if (stopping) return;
        const answer = message as WorktreeCopyAnswer | null;
        if (answer?.type !== 'result' && answer?.type !== 'failed') return;
        // The work is done, so nothing the kill interrupts can matter, and the
        // exit it causes is no crash.
        answered = true;
        child.kill();
        settle(() => resolve(answer));
      });
      child.on('exit', (code: number) => {
        exited = true;
        if (answered) return;
        if (stopping) { const reason = stopping; settle(() => reject(reason)); return; }
        if (!this.disposed) this.restartPolicy.recordCrash(code, stderrTail);
        settle(() => resolve(null));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      child.postMessage({ type: 'copy', request });
    });
  }

  /** Synchronous, for the quit path. A copy in flight rejects, so its worktree is never recorded. */
  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}

export const worktreeCopyClient = new WorktreeCopyClient();
