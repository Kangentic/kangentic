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
   * A project's `status` or `skipped` count changed. The map's Index panel
   * reads both from its snapshot, which it re-reads only when told to, and a
   * pass that ends having written nothing has no `onWritten` to tell it.
   */
  onStatusChanged?: (projectId: string) => void;
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
  /** `writing` while its pass runs, is queued, or waits out the gap before the
   *  next one; `retrying` while a failed call waits out its backoff. */
  state: 'idle' | 'writing' | 'retrying';
  /** When a failed call is tried again, epoch ms. Set only while `retrying`. */
  retryAtMs: number | null;
}

export interface SummaryScheduler<Context> {
  /** Ask for a pass over a project; one already running takes it next. */
  request: (context: Context, projectId: string) => void;
  /** How many tasks the agent passed over in this project, this run of the app. */
  skipped: (projectId: string) => number;
  /** What the scheduler is doing for a project, for the map's Index panel and the Settings card. */
  status: (projectId: string) => SummarySchedulerStatus;
  /**
   * Summaries the app's current run writes a minute, on wall time from its first
   * pass (the gaps between passes, and other projects' passes, included), or
   * null before a pass of the run has written any. One run spans every project,
   * since one pass runs at a time for the whole app. It ends when a pass's call
   * fails with no batch answered (every project then waits), or when a pass
   * leaves no project queued or waiting out the gap before its next pass. One
   * project's failed read, failed save, or failed call beside one that answered
   * does not end it: the other projects go on writing.
   */
  writtenPerMinute: () => number | null;
  /**
   * Forget that a project is caught up, so its next request runs a pass even
   * though nothing on the board moved. For a change the fingerprint cannot
   * see: summaries marked for rewriting. Also asks again about the tasks the
   * agent passed over, and ends a failure backoff, since the user asked for it.
   */
  invalidate: (projectId: string) => void;
  /**
   * End a project's failure backoff, and the app-wide one after a failed call,
   * so the next request runs at once. For a settings change, which may be what
   * fixes the failed call.
   */
  endBackoff: (projectId: string) => void;
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
  /** Each project's next-pass timer: the gap, or the wait after a failure. */
  const timers = new Map<string, { cancel: () => void }>();
  /**
   * When each project's failed pass is tried again, while one is waiting: a
   * failed read or save, or one call failing beside another that answered. Kept
   * per project: one database that cannot be read, or one batch the agent
   * fails on, must not hold up every other project's summaries.
   */
  const retryAtByProject = new Map<string, number>();
  /**
   * A pass whose agent call failed with no batch answered holds up every
   * project, not only its own: the agent is the same for all of them, so asking every project would
   * turn one broken agent into a failing call per project every backoff. Other
   * projects' requests wait in `pending`, and the failed project's timer starts
   * the queue again, with the failed project at its back.
   */
  let callBackoff: { projectId: string; context: Context; retryAt: number } | null = null;
  /** Tasks the agent was asked about and did not answer for, this run of the app. */
  const skipByProject = new Map<string, Set<string>>();
  /**
   * The fingerprint each project's last pass caught up at: nothing remaining,
   * no failed call. Kept in memory only, so the first request after a launch
   * always runs a pass, which is also what asks again about skipped tasks.
   */
  const caughtUpAt = new Map<string, string>();
  /** The app's run of passes toward catching up: when its first pass started,
   *  and how many summaries it has written. */
  let rateRun: { startedAt: number; written: number } | null = null;
  /** What `onStatusChanged` last reported for each project. */
  const reported = new Map<string, string>();

  const fingerprintOf = async (context: Context, projectId: string): Promise<string | null> => {
    if (!deps.readFingerprint) return null;
    try {
      return await deps.readFingerprint(context, projectId);
    } catch {
      return null;
    }
  };

  /** Waiting out its own failed pass: only its own retry timer runs the next pass. */
  const backingOff = (projectId: string): boolean => {
    const retryAt = retryAtByProject.get(projectId);
    return retryAt !== undefined && retryAt > now();
  };

  /** Waiting out a pass whose call failed with no batch answered: no project's pass starts. */
  const callBackingOff = (): boolean => callBackoff !== null && callBackoff.retryAt > now();

  /** Waiting for its next pass after the gap (not after a failure). */
  const hasGapTimer = (projectId: string): boolean => (
    timers.has(projectId) && !retryAtByProject.has(projectId) && callBackoff?.projectId !== projectId
  );

  const status = (projectId: string): SummarySchedulerStatus => {
    if (running && runningProjectId === projectId) return { state: 'writing', retryAtMs: null };
    const retryAt = retryAtByProject.get(projectId);
    if (retryAt !== undefined) return { state: 'retrying', retryAtMs: retryAt };
    if (callBackoff && (callBackoff.projectId === projectId || pending.has(projectId))) {
      return { state: 'retrying', retryAtMs: callBackoff.retryAt };
    }
    // Queued, or between two passes of a backfill: what is left will be written,
    // so the line keeps its track rather than flickering to "N of M".
    if (pending.has(projectId) || hasGapTimer(projectId)) return { state: 'writing', retryAtMs: null };
    return { state: 'idle', retryAtMs: null };
  };

  /** Tell `onStatusChanged` about every project whose status or skipped count moved. */
  const reportChanges = (): void => {
    if (!deps.onStatusChanged || disposed) return;
    const projectIds = new Set<string>([
      ...reported.keys(), ...pending.keys(), ...timers.keys(), ...retryAtByProject.keys(), ...skipByProject.keys(),
    ]);
    if (runningProjectId) projectIds.add(runningProjectId);
    if (callBackoff) projectIds.add(callBackoff.projectId);
    for (const projectId of projectIds) {
      const current = status(projectId);
      const key = `${current.state}|${current.retryAtMs ?? ''}|${skipByProject.get(projectId)?.size ?? 0}`;
      if (reported.get(projectId) === key) continue;
      if (current.state === 'idle' && !skipByProject.has(projectId) && !reported.has(projectId)) continue;
      reported.set(projectId, key);
      deps.onStatusChanged(projectId);
    }
  };

  const endBackoff = (projectId: string): void => {
    if (retryAtByProject.has(projectId)) {
      timers.get(projectId)?.cancel();
      timers.delete(projectId);
      retryAtByProject.delete(projectId);
    }
    if (callBackoff) {
      const ended = callBackoff;
      timers.get(ended.projectId)?.cancel();
      timers.delete(ended.projectId);
      callBackoff = null;
      // Queued with the rest, and the queue started, so nothing reads as
      // writing while no pass will run.
      if (!pending.has(ended.projectId)) pending.set(ended.projectId, ended.context);
      if (!running) runNextPending();
    }
    reportChanges();
  };

  const scheduleAgain = (context: Context, projectId: string, delayMs: number, afterFailure: boolean): void => {
    timers.get(projectId)?.cancel();
    if (afterFailure) retryAtByProject.set(projectId, now() + delayMs);
    else retryAtByProject.delete(projectId);
    timers.set(projectId, setTimer(() => {
      timers.delete(projectId);
      retryAtByProject.delete(projectId);
      request(context, projectId);
      reportChanges();
    }, delayMs));
  };

  /**
   * A call failed with no batch answered: every project waits, and when the wait
   * ends the queue starts again with the failed project at its back. The next
   * pass is still the one call that tests the agent, so a broken agent costs one
   * failing call per backoff whichever project makes it. Put first instead, a
   * project whose own batch fails every time would hold every other project back
   * for good.
   */
  const startCallBackoff = (context: Context, projectId: string): void => {
    timers.get(projectId)?.cancel();
    retryAtByProject.delete(projectId);
    callBackoff = { projectId, context, retryAt: now() + FAILURE_BACKOFF_MS };
    timers.set(projectId, setTimer(() => {
      timers.delete(projectId);
      // Cleared first: `runNextPending` starts nothing while the backoff holds.
      if (callBackoff?.projectId === projectId) callBackoff = null;
      // Delete then set moves it to the back; a request queued during the wait
      // keeps its own context.
      const queuedContext = pending.get(projectId) ?? context;
      pending.delete(projectId);
      pending.set(projectId, queuedContext);
      // Switched off during the wait, this drops every queued project, so none
      // reads as writing with no pass coming.
      if (!running) runNextPending();
      reportChanges();
    }, FAILURE_BACKOFF_MS));
  };

  /** Start the first queued pass that may run, if any. */
  const runNextPending = (): void => {
    for (const [nextProjectId, nextContext] of pending) {
      if (callBackingOff()) return;
      pending.delete(nextProjectId);
      // Switched off while it waited: `request` would not start it now either.
      if (backingOff(nextProjectId) || !deps.isEnabled(nextContext)) continue;
      void run(nextContext, nextProjectId);
      return;
    }
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
        // Only a failure that holds every project back ends the run. One project
        // backing off alone leaves the rest writing at the measured rate, and the
        // check below ends the run once only backoffs are left.
        if (result.callFailed) {
          rateRun = null;
        } else if (result.written > 0) {
          rateRun = rateRun ?? { startedAt: passStartedAt, written: 0 };
          rateRun.written += result.written;
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
    // The backoff first, so a request this project queued while its pass ran
    // waits it out instead of running the failed call again at once.
    if (result?.callFailed) startCallBackoff(context, projectId);
    else if (result && result.remaining > 0) scheduleAgain(context, projectId, result.failed ? FAILURE_BACKOFF_MS : PASS_GAP_MS, result.failed);
    else if (result?.failed) scheduleAgain(context, projectId, FAILURE_BACKOFF_MS, true);
    runNextPending();
    // The run ends once nothing is left to write anywhere: no pass running or
    // queued, and none waiting out the gap before its next one.
    if (!running && pending.size === 0 && ![...timers.keys()].some(hasGapTimer)) rateRun = null;
    reportChanges();
  };

  const request = (context: Context, projectId: string): void => {
    if (disposed || !deps.isEnabled(context)) return;
    // A board change after a failed read must not run the pass again: the
    // retry timer requests this project once the backoff ends.
    if (backingOff(projectId)) return;
    if (running || callBackingOff()) {
      pending.set(projectId, context);
      reportChanges();
      return;
    }
    void run(context, projectId);
    reportChanges();
  };

  return {
    request,
    skipped: (projectId) => skipByProject.get(projectId)?.size ?? 0,
    status,
    writtenPerMinute: () => {
      if (!rateRun || rateRun.written === 0) return null;
      return (rateRun.written / Math.max(1, now() - rateRun.startedAt)) * 60_000;
    },
    invalidate: (projectId) => {
      caughtUpAt.delete(projectId);
      skipByProject.delete(projectId);
      endBackoff(projectId);
    },
    endBackoff,
    dispose: () => {
      disposed = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      retryAtByProject.clear();
      callBackoff = null;
      pending.clear();
      rateRun = null;
    },
    get busy() {
      return running;
    },
  };
}
