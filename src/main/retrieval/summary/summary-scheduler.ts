import { runSummaryPass, type SummaryPassResult, type SummaryWriter } from './summary-pass';

/**
 * When task summaries are written: one pass at a time for the whole app, three
 * calls of ten tasks per pass running side by side, and the next pass straight
 * after while any finished task is still without a current summary. A pass
 * whose call failed backs off rather than retrying at once.
 *
 * Every board change asks for a pass, so a caught-up board must answer cheaply:
 * a request whose fingerprint matches the last caught-up pass skips everything.
 *
 * Measured on a real board (Sonnet 5.5, low effort): a call of ten tasks costs
 * $0.020 and takes 6.6 s, and three side by side take 7.7 s. A 673-task
 * backfill is 68 calls and about $1.40, in about three minutes; one call at a
 * time with a 15 s pause between passes took 11.5.
 */

/** Batches (of ten tasks) per pass, all running at once. */
const PASS_BATCHES = 3;
/** Pause before the next pass while work remains: a yield, not pacing. */
const PASS_GAP_MS = 1_000;
/** Gap after a pass whose call failed. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

export interface SummarySchedulerDeps<Context> {
  /** Summaries are wanted: switched on, with indexing and semantic search on. */
  isEnabled: (context: Context) => boolean;
  /**
   * A cheap summary of what every finished task's summary is written from
   * (`readSummaryFingerprint`). A request whose fingerprint matches the one a
   * pass last caught up at is skipped before anything else runs: no writer, no
   * change sweep, no input read. Omitted, every request runs a pass.
   */
  readFingerprint?: (context: Context, projectId: string) => Promise<string | null> | string | null;
  /** The Knowledge Graph agent's read-only summary run, or null while none is chosen. */
  resolveWriter: (context: Context, projectId: string) => Promise<SummaryWriter | null>;
  /**
   * After a pass that wrote summaries: re-read the task records that carry them,
   * and rename the map's regions. `caughtUp` when nothing remains to write.
   */
  onWritten: (context: Context, projectId: string, caughtUp: boolean) => void;
  /**
   * Before a pass reads its tasks: bring what a summary is written from up to
   * date. A summary's hash covers the files its task changed, so a pass that
   * ran ahead of the change sweep would write summaries without them and then
   * rewrite every one once the changes landed, paying the backfill twice.
   */
  beforePass?: (context: Context, projectId: string) => Promise<void>;
  runPass?: typeof runSummaryPass;
  setTimer?: (callback: () => void, delayMs: number) => { cancel: () => void };
  /** Epoch ms, for when a failed call is tried again. Injected for tests. */
  now?: () => number;
}

export interface SummarySchedulerStatus {
  state: 'idle' | 'writing' | 'retrying';
  /** When a failed call is tried again, epoch ms. Set only while `retrying`. */
  retryAtMs: number | null;
}

export interface SummaryScheduler<Context> {
  /** Ask for a pass over a project; one already running takes it next. */
  request: (context: Context, projectId: string) => void;
  /** How many tasks the agent passed over in this project, this run of the app. */
  skipped: (projectId: string) => number;
  /** What the scheduler is doing for a project, for the Index card's Task summaries line. */
  status: (projectId: string) => SummarySchedulerStatus;
  /**
   * Summaries this project's current run writes a minute, on wall time from its
   * first pass (the gaps between passes included), or null before a pass of
   * the run has written any. A run ends when it catches up or a call fails.
   */
  writtenPerMinute: (projectId: string) => number | null;
  /**
   * Forget that a project is caught up, so its next request runs a pass even
   * though nothing on the board moved. For a change the fingerprint cannot
   * see: summaries marked for rewriting.
   */
  invalidate: (projectId: string) => void;
  dispose: () => void;
  /** True while a pass is running (for tests). */
  readonly busy: boolean;
}

function defaultTimer(callback: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export function createSummaryScheduler<Context>(deps: SummarySchedulerDeps<Context>): SummaryScheduler<Context> {
  const runPass = deps.runPass ?? runSummaryPass;
  const setTimer = deps.setTimer ?? defaultTimer;
  const now = deps.now ?? Date.now;
  let disposed = false;
  let running = false;
  let runningProjectId: string | null = null;
  const pending = new Map<string, Context>();
  const timers = new Map<string, { cancel: () => void }>();
  /** When each project's failed call is tried again, while one is waiting. */
  const retryAtByProject = new Map<string, number>();
  /** Tasks the agent was asked about and did not answer for, this run of the app. */
  const skipByProject = new Map<string, Set<string>>();
  /**
   * The fingerprint each project's last pass caught up at: nothing remaining,
   * no failed call. Kept in memory only, so the first request after a launch
   * always runs a pass.
   */
  const caughtUpAt = new Map<string, string>();
  /** Each project's run of passes toward catching up: when its first pass
   *  started, and how many summaries it has written. */
  const runs = new Map<string, { startedAt: number; written: number }>();

  const fingerprintOf = async (context: Context, projectId: string): Promise<string | null> => {
    if (!deps.readFingerprint) return null;
    try {
      return await deps.readFingerprint(context, projectId);
    } catch {
      return null;
    }
  };

  const scheduleAgain = (context: Context, projectId: string, delayMs: number, afterFailure: boolean): void => {
    timers.get(projectId)?.cancel();
    if (afterFailure) retryAtByProject.set(projectId, now() + delayMs);
    else retryAtByProject.delete(projectId);
    timers.set(projectId, setTimer(() => {
      timers.delete(projectId);
      retryAtByProject.delete(projectId);
      request(context, projectId);
    }, delayMs));
  };

  const run = async (context: Context, projectId: string): Promise<void> => {
    running = true;
    runningProjectId = projectId;
    const passStartedAt = now();
    let result: SummaryPassResult | null = null;
    try {
      // Nothing a summary reads has changed since this project last caught up:
      // skip the writer, the change sweep and the input read. This is what a
      // board change costs on a caught-up board, about 5 ms.
      const before = await fingerprintOf(context, projectId);
      const unchanged = before !== null && caughtUpAt.get(projectId) === before;
      const writer = unchanged ? null : await deps.resolveWriter(context, projectId);
      if (writer && !disposed && deps.isEnabled(context)) {
        await deps.beforePass?.(context, projectId);
        // Read again after the change sweep, and before the inputs are: a
        // change that lands while the pass runs then moves the fingerprint
        // past this one, so the next request does not skip it.
        const passFingerprint = await fingerprintOf(context, projectId);
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
        console.log(`[retrieval] summaries project=${projectId} written=${result.written} remaining=${result.remaining} unanswered=${result.unanswered.length}${result.failed ? ' failed' : ''}`);
        if (result.written > 0) deps.onWritten(context, projectId, !result.failed && result.remaining === 0);
        if (!result.failed && result.remaining === 0 && passFingerprint !== null) caughtUpAt.set(projectId, passFingerprint);
        else caughtUpAt.delete(projectId);
        if (result.failed || result.remaining === 0) {
          runs.delete(projectId);
        } else if (result.written > 0) {
          const current = runs.get(projectId) ?? { startedAt: passStartedAt, written: 0 };
          current.written += result.written;
          runs.set(projectId, current);
        }
      }
    } catch (error) {
      caughtUpAt.delete(projectId);
      console.warn('[retrieval] summary pass failed:', error);
    } finally {
      running = false;
      runningProjectId = null;
    }
    if (disposed) return;
    const next = pending.entries().next();
    if (!next.done) {
      const [nextProjectId, nextContext] = next.value;
      pending.delete(nextProjectId);
      void run(nextContext, nextProjectId);
    }
    if (result && result.remaining > 0) scheduleAgain(context, projectId, result.failed ? FAILURE_BACKOFF_MS : PASS_GAP_MS, result.failed);
    else if (result?.failed) scheduleAgain(context, projectId, FAILURE_BACKOFF_MS, true);
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
    skipped: (projectId) => skipByProject.get(projectId)?.size ?? 0,
    status: (projectId) => {
      if (running && runningProjectId === projectId) return { state: 'writing', retryAtMs: null };
      const retryAtMs = retryAtByProject.get(projectId);
      return retryAtMs === undefined ? { state: 'idle', retryAtMs: null } : { state: 'retrying', retryAtMs };
    },
    writtenPerMinute: (projectId) => {
      const current = runs.get(projectId);
      if (!current || current.written === 0) return null;
      return (current.written / Math.max(1, now() - current.startedAt)) * 60_000;
    },
    invalidate: (projectId) => {
      caughtUpAt.delete(projectId);
    },
    dispose: () => {
      disposed = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      retryAtByProject.clear();
      pending.clear();
      runs.clear();
    },
    get busy() {
      return running;
    },
  };
}
