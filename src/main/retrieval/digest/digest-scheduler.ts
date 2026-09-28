import { runDigestPass, type DigestPassResult, type DigestWriter } from './digest-pass';

/**
 * When task digests are written: one pass at a time for the whole app, a few
 * batches per pass, and another pass after a short gap while any finished task
 * is still without a current digest. A board's first backfill therefore runs
 * in the background at one call every few seconds instead of as one burst, and
 * a pass whose call failed backs off rather than retrying at once.
 *
 * Measured on a real board: a batch of ten tasks at Sonnet cost $0.046 and
 * took 9.3 s, so a 673-task backfill is about 68 calls and $3.
 */

/** Batches (of ten tasks) per pass. */
const PASS_BATCHES = 3;
/** Gap before the next pass while work remains. */
const PASS_GAP_MS = 15_000;
/** Gap after a pass whose call failed. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

export interface DigestSchedulerDeps<Context> {
  /** Digests are wanted: indexing and semantic search on, and digests not turned off. */
  isEnabled: (context: Context) => boolean;
  /** The answering agent's read-only run, or null while none is chosen. */
  resolveWriter: (context: Context, projectId: string) => Promise<DigestWriter | null>;
  /** After a pass that wrote digests: re-read the task records that carry them. */
  onWritten: (context: Context, projectId: string) => void;
  /**
   * Before a pass reads its tasks: bring what a digest is written from up to
   * date. A digest's hash covers the files its task changed, so a pass that
   * ran ahead of the change sweep would write digests without them and then
   * rewrite every one once the changes landed, paying the backfill twice.
   */
  beforePass?: (context: Context, projectId: string) => Promise<void>;
  runPass?: typeof runDigestPass;
  setTimer?: (callback: () => void, delayMs: number) => { cancel: () => void };
}

export interface DigestScheduler<Context> {
  /** Ask for a pass over a project; one already running takes it next. */
  request: (context: Context, projectId: string) => void;
  dispose: () => void;
  /** True while a pass is running (for tests). */
  readonly busy: boolean;
}

function defaultTimer(callback: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export function createDigestScheduler<Context>(deps: DigestSchedulerDeps<Context>): DigestScheduler<Context> {
  const runPass = deps.runPass ?? runDigestPass;
  const setTimer = deps.setTimer ?? defaultTimer;
  let disposed = false;
  let running = false;
  const pending = new Map<string, Context>();
  const timers = new Map<string, { cancel: () => void }>();
  /** Tasks the agent was asked about and did not answer for, this run of the app. */
  const skipByProject = new Map<string, Set<string>>();

  const scheduleAgain = (context: Context, projectId: string, delayMs: number): void => {
    timers.get(projectId)?.cancel();
    timers.set(projectId, setTimer(() => {
      timers.delete(projectId);
      request(context, projectId);
    }, delayMs));
  };

  const run = async (context: Context, projectId: string): Promise<void> => {
    running = true;
    let result: DigestPassResult | null = null;
    try {
      const writer = await deps.resolveWriter(context, projectId);
      if (writer && !disposed && deps.isEnabled(context)) {
        await deps.beforePass?.(context, projectId);
        const skip = skipByProject.get(projectId) ?? new Set<string>();
        skipByProject.set(projectId, skip);
        result = await runPass(projectId, writer, {
          maxBatches: PASS_BATCHES,
          shouldContinue: () => !disposed && deps.isEnabled(context),
          skip,
        });
        for (const taskId of result.unanswered) skip.add(taskId);
        // One line a pass, so a backfill's progress and any task the agent
        // passed over can be read back from the log.
        console.log(`[retrieval] digests project=${projectId} written=${result.written} remaining=${result.remaining} unanswered=${result.unanswered.length}${result.failed ? ' failed' : ''}`);
        if (result.written > 0) deps.onWritten(context, projectId);
      }
    } catch (error) {
      console.warn('[retrieval] digest pass failed:', error);
    } finally {
      running = false;
    }
    if (disposed) return;
    const next = pending.entries().next();
    if (!next.done) {
      const [nextProjectId, nextContext] = next.value;
      pending.delete(nextProjectId);
      void run(nextContext, nextProjectId);
    }
    if (result && result.remaining > 0) scheduleAgain(context, projectId, result.failed ? FAILURE_BACKOFF_MS : PASS_GAP_MS);
    else if (result?.failed) scheduleAgain(context, projectId, FAILURE_BACKOFF_MS);
  };

  const request = (context: Context, projectId: string): void => {
    if (disposed || !deps.isEnabled(context)) return;
    if (running) {
      pending.set(projectId, context);
      return;
    }
    void run(context, projectId);
  };

  return {
    request,
    dispose: () => {
      disposed = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      pending.clear();
    },
    get busy() {
      return running;
    },
  };
}
