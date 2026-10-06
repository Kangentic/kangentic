import { trackEvent } from '../analytics/analytics';
import { reportHandledError } from '../analytics/error-reporting';
import { summarizeStderrTail, type StderrSource } from './stderr-tail';

/**
 * Restart policy shared by the utility processes we own
 * (`kangentic-embeddings`, `kangentic-line-count`, `kangentic-dictation`,
 * `kangentic-retrieval`, `kangentic-pty-host`).
 *
 * The first two clients used to re-fork immediately on the next request, bounded only by
 * a crash cap. A worker that dies on startup therefore burned its whole cap in
 * a few milliseconds: three exits inside four seconds, then the subsystem was
 * permanently dead for the rest of the app run, silently. That signature is
 * exactly what arrived in error reporting as three un-attributable
 * `'Utility' process exited with 'abnormal-exit'` events.
 *
 * This policy fixes both halves:
 *
 * - **Backoff.** A crash makes the next spawn attempt wait, so a crash-looping
 *   worker cannot burn its cap in one burst. Callers degrade during the wait
 *   exactly as they already do when the worker is absent (semantic search falls
 *   back to lexical; line counts fall back to inline), so backing off costs
 *   correctness nothing.
 * - **Decay.** The cap is checked against a WINDOW, not the app's lifetime: if
 *   nothing has crashed for `decayMs`, the count resets and the subsystem gets
 *   another chance. Without this, one transient burst disables a feature until
 *   the app restarts, which matters most for the line-count client, a module
 *   singleton nothing ever replaces.
 *
 * The decay is deliberately checked on the next SPAWN ATTEMPT rather than on a
 * successful run: once the cap is reached the client short-circuits and never
 * calls the worker again, so a success-triggered reset could never fire and
 * would be dead code.
 *
 * Telemetry follows the same volume/diagnostic split the spawn paths use, with
 * the Aptabase side shaped as at most two events per service per app run: one
 * on the FIRST crash (how many installs hit this) and one when the cap
 * latches (how many installs' subsystem gave up), each carrying `phase`. It
 * used to tick on every crash, which with three crashes per five-minute decay
 * window read as "71 crashes a day" when it was a handful of installs looping,
 * and could not tell those two apart. The single Sentry report at the latch
 * answers "which service died, why each crash in the window happened, and what
 * it printed before dying". A crash the policy recovers from is not reported
 * as an issue, because it is not actionable on its own; its stderr still goes
 * to the main console (and so to the project log) so a local trail exists
 * either way.
 */
export interface UtilityRestartPolicyOptions {
  /** The `serviceName` passed to `utilityProcess.fork`, reused as the tag. */
  service: string;
  /** Crashes within the decay window before the subsystem gives up. */
  maxCrashes?: number;
  /** Delay before the Nth retry. The last value repeats if the cap is higher. */
  backoffMs?: readonly number[];
  /** Quiet period after which the crash count resets. */
  decayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_MAX_CRASHES = 3;
/**
 * Chosen so the cap cannot be burned inside the four-second window the real
 * incident showed: the third crash cannot occur before t+6s. A shorter first
 * delay (250ms was tried) still let three crashes land inside four seconds,
 * which would have left the reported signature intact while looking fixed.
 * The cost of waiting is only that the caller degrades a little longer, which
 * it already does whenever the worker is absent.
 */
const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 5_000, 15_000];
const DEFAULT_DECAY_MS = 5 * 60_000;
/**
 * How long a crash's log line and latch report wait for the dying worker's
 * stderr pipe to end. Electron 44.5.0 drains a utility process's output after
 * `exit`, so the exception text that explains the crash can arrive just after
 * it is recorded; measured on 44.5.1, `end` follows `exit` by about 3 ms. The
 * bound is only for a pipe that never ends.
 */
export const STDERR_DRAIN_BOUND_MS = 500;

type CrashPhase = 'first' | 'latched';

/**
 * Why a worker counted as crashed. Only `exit` is a process exit; the other
 * three are a fork that threw, a worker that never said ready, and a worker
 * the client killed for not answering a request. Sentry DESKTOP-1Q latched on
 * "exit code unknown" and could not say which of those three it was.
 */
export type UtilityCrashCause = 'exit' | 'fork_failed' | 'ready_timeout' | 'request_timeout';

/** What a client knows about a crash beyond its exit code. */
export interface UtilityCrashDetail {
  cause: UtilityCrashCause;
  /** The request a `request_timeout` was waiting on. A fixed method name from
   *  the worker's protocol, never content: it goes into the report. */
  method?: string;
  /** The other requests pending at that moment, fixed method names, repeats
   *  kept so the report can count them. */
  pendingMethods?: readonly string[];
}

interface UtilityCrashRecord extends UtilityCrashDetail {
  exitCode: number | null;
}

/**
 * The Aptabase phases already sent this app run, keyed by service. Module
 * scope rather than a field on the policy, deliberately: the embed client
 * builds a fresh policy in its constructor and the engine rebuilds that client
 * on every model or acceleration change and whenever warm-hold drops (a
 * project switch, semantic search turned off), so a per-instance latch would
 * re-fire "first crash" on every switch. The cap the event promises is two per
 * service per RUN, and a run is the process. `reportedLatch` stays per
 * instance and re-arms per decay window, since Sentry dedups on its side.
 */
const trackedCrashPhases = new Map<string, Set<CrashPhase>>();

/** Forget the per-run phase latches (vitest shares module instances). */
export function resetUtilityCrashTelemetryForTests(): void {
  trackedCrashPhases.clear();
}

export class UtilityRestartPolicy {
  private readonly service: string;
  private readonly maxCrashes: number;
  private readonly backoffMs: readonly number[];
  private readonly decayMs: number;
  private readonly now: () => number;

  private crashCount = 0;
  private lastCrashAt: number | null = null;
  /** The stderr of each crash in the current window, oldest first, bounded to
   *  the cap. Held by reference and read lazily (`latestStderr`): the pipe can
   *  still be draining when the `exit` that recorded a crash fires, and the
   *  latch report comes two backoffs after the first crash, by which time the
   *  text has long since landed. */
  private stderrSources: StderrSource[] = [];
  /** Why each crash in the current window happened, oldest first, bounded to
   *  the cap like `stderrSources`. */
  private crashRecords: UtilityCrashRecord[] = [];
  /** One Sentry report per latch, not one per crash after the latch. */
  private reportedLatch = false;

  constructor(options: UtilityRestartPolicyOptions) {
    this.service = options.service;
    this.maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.decayMs = options.decayMs ?? DEFAULT_DECAY_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * True when the subsystem has given up and callers should stop trying. Reads
   * the decay window, so a client that polls this after a quiet period sees it
   * clear itself rather than staying latched for the app's lifetime.
   */
  get exhausted(): boolean {
    this.decayIfQuiet();
    return this.crashCount >= this.maxCrashes;
  }

  /**
   * Whether a fork may be attempted right now. False while the subsystem is
   * exhausted, and false during the backoff window after a crash.
   */
  maySpawn(): boolean {
    if (this.exhausted) return false;
    if (this.crashCount === 0 || this.lastCrashAt === null) return true;
    const backoffIndex = Math.min(this.crashCount, this.backoffMs.length) - 1;
    const waitMs = this.backoffMs[backoffIndex] ?? 0;
    return this.now() - this.lastCrashAt >= waitMs;
  }

  /**
   * Record an unexpected worker exit. Intentional teardowns (idle recycle,
   * dispose, quit) must NOT be passed here - a recycle is not a crash, and
   * counting one would latch a perfectly healthy subsystem.
   *
   * `detail` says why. Without it, a numeric code is an `exit` and a null one
   * is a `fork_failed`, the convention every client that passes no detail
   * follows: their only null call is the catch around `utilityProcess.fork`.
   */
  recordCrash(exitCode: number | null | undefined, stderr?: StderrSource, detail?: UtilityCrashDetail): void {
    this.decayIfQuiet();
    this.crashCount += 1;
    this.lastCrashAt = this.now();
    if (stderr) {
      this.stderrSources.push(stderr);
      while (this.stderrSources.length > this.maxCrashes) this.stderrSources.shift();
    }
    const cause = detail?.cause ?? (exitCode == null ? 'fork_failed' : 'exit');
    const record: UtilityCrashRecord = {
      cause,
      exitCode: exitCode ?? null,
      method: detail?.method,
      pendingMethods: detail?.pendingMethods,
    };
    this.crashRecords.push(record);
    while (this.crashRecords.length > this.maxCrashes) this.crashRecords.shift();

    // Everything that decides the subsystem's state stays synchronous: the
    // count and backoff above, the telemetry, and whether this crash latches.
    // Only the two places that PRINT the stderr wait for it (below).
    const crashNumber = this.crashCount;
    this.trackCrashOnce('first', record);

    const latchesNow = this.crashCount >= this.maxCrashes && !this.reportedLatch;
    // Copied now, like `crashNumber`: the report can wait on the stderr drain,
    // and a crash recorded meanwhile would shift the bounded list.
    const crashesAtLatch = latchesNow ? [...this.crashRecords] : [];
    if (latchesNow) {
      this.reportedLatch = true;
      // The same moment as the Sentry report is decided, so the two surfaces
      // stay aligned on when a subsystem gave up.
      this.trackCrashOnce('latched', record);
    }

    const emit = (): void => {
      this.logCrash(record, crashNumber);
      if (latchesNow) this.reportLatch(record, crashNumber, crashesAtLatch);
    };

    // The dying worker's stderr can still be arriving (see
    // STDERR_DRAIN_BOUND_MS), so the log line and the report wait for the pipe
    // to end, bounded. A source with nothing pending answers null and both run
    // now. A report deferred by the bound is lost if the app quits inside those
    // 500 ms; that is acceptable, because intentional exits (quit, dispose, an
    // idle recycle) never reach recordCrash, so the only loss is a crash that
    // happens to coincide with the user quitting.
    const drained = stderr?.whenDrained?.(STDERR_DRAIN_BOUND_MS) ?? null;
    if (drained === null) {
      emit();
      return;
    }
    void drained.then(emit).catch((error: unknown) => {
      console.error('[utility-process] could not log a worker crash:', error);
    });
  }

  /** Every crash leaves its stderr in the main console, which the log mirror
   *  persists (warn is never gated) to <project>/.kangentic/logs/<date>.log,
   *  so the text survives locally even with error reporting off. The line
   *  uses the in-app signal's words, so a worker that hung reads as one
   *  rather than as an exit with code unknown. Every cause ends in the same
   *  `(crash N of M)`, which the package smoke matches. */
  private logCrash(record: UtilityCrashRecord, crashNumber: number): void {
    const tail = this.latestStderr();
    console.warn(
      `[utility-process] ${this.service} ${describeCrashForPeople(record)} (crash ${crashNumber} of ${this.maxCrashes})`,
      tail ? `\n${tail}` : '(no stderr captured)',
    );
  }

  /** Reported from here rather than from the SDK's app-level
   *  `child-process-gone` listener because only this side knows the service
   *  name, why each crash happened, and that it was unintentional. The SDK's
   *  own utility-process event is filtered out in error-reporting.ts precisely
   *  because it can carry none of that. */
  private reportLatch(
    { exitCode, cause }: UtilityCrashRecord,
    crashNumber: number,
    crashes: readonly UtilityCrashRecord[],
  ): void {
    reportHandledError(
      // The message is the issue's grouping key, so it stays "exited" for every
      // cause. The cause tag and the crash list say what happened.
      new Error(`${this.service} worker exited repeatedly (exit code ${exitCode ?? 'unknown'})`),
      {
        source: 'utility_process',
        service: this.service,
        exitCode: String(exitCode ?? 'unknown'),
        crashCount: String(crashNumber),
        // A fixed vocabulary, not content, so it is safe as a tag.
        cause,
      },
      // The stderr is content, so it goes in a context, never a tag or the
      // message: a tag would fragment grouping and a varying message would
      // split the issue. This is what turns "exit code 1" into the module
      // name or stack that explains it.
      {
        utility_process: {
          service: this.service,
          exitCode: exitCode ?? null,
          crashCount: crashNumber,
          stderrTail: this.latestStderr() ?? '(no stderr captured)',
          // One line per crash, not one object: Sentry normalizes contexts to
          // depth 3, which turns an object inside this list into "[Object]".
          crashes: crashes.map(describeCrashRecord),
        },
      },
    );
  }

  /** Send the Aptabase event for `phase` once per service per app run. The
   *  exit code rides along, -1 when there is none, and so does the cause,
   *  because -1 alone cannot tell a fork that threw from a worker that hung.
   *  The crash count does not, because it is a constant per phase (1 on
   *  `first`, the cap on `latched`) and already lives on the Sentry tag. */
  private trackCrashOnce(phase: CrashPhase, { exitCode, cause }: UtilityCrashRecord): void {
    let phases = trackedCrashPhases.get(this.service);
    if (!phases) {
      phases = new Set<CrashPhase>();
      trackedCrashPhases.set(this.service, phases);
    }
    if (phases.has(phase)) return;
    phases.add(phase);
    trackEvent('utility_worker_crashed', {
      service: this.service,
      exitCode: exitCode ?? -1,
      cause,
      phase,
    });
  }

  /** The newest crash's stderr that is non-empty at read time, or null. */
  latestStderr(): string | null {
    for (let index = this.stderrSources.length - 1; index >= 0; index -= 1) {
      const snapshot = this.stderrSources[index].snapshot();
      if (snapshot.length > 0) return snapshot;
    }
    return null;
  }

  /** One line describing the newest crash in the window, for the in-app
   *  signal: `exited with code 1: Error: Cannot find module 'sharp'`, or
   *  `did not answer projects.summaries in time` for a worker that hung. Null
   *  when nothing has crashed, or once the window has decayed. */
  get lastCrashDescription(): string | null {
    this.decayIfQuiet();
    const newest = this.crashRecords[this.crashRecords.length - 1];
    if (this.crashCount === 0 || !newest) return null;
    const whatHappened = describeCrashForPeople(newest);
    const summary = summarizeStderrTail(this.latestStderr() ?? '');
    return summary ? `${whatHappened}: ${summary}` : whatHappened;
  }

  /** Forget the crash history. Called internally by `decayIfQuiet` once the
   *  window has passed, and by tests. No client calls it directly today; it is
   *  public so a client that gains a deliberate "try again now" control can
   *  clear the latch without reaching into private state. */
  reset(): void {
    this.crashCount = 0;
    this.lastCrashAt = null;
    this.stderrSources = [];
    this.crashRecords = [];
    this.reportedLatch = false;
  }

  private decayIfQuiet(): void {
    if (this.crashCount === 0 || this.lastCrashAt === null) return;
    if (this.now() - this.lastCrashAt < this.decayMs) return;
    this.reset();
  }
}

/** One crash in the words the in-app signal uses. Only an `exit` has a code;
 *  the rest say what the worker failed to do. */
function describeCrashForPeople(record: UtilityCrashRecord): string {
  switch (record.cause) {
    case 'exit':
      return `exited with code ${record.exitCode ?? 'unknown'}`;
    case 'fork_failed':
      return 'failed to start';
    case 'ready_timeout':
      return 'did not start in time';
    case 'request_timeout':
      return record.method ? `did not answer ${record.method} in time` : 'did not answer in time';
  }
}

/** One crash as a fixed-format line for the latch report:
 *  `exit code=1`, `ready_timeout`, or
 *  `request_timeout method=projects.summaries pending=transcript.usage(12),index.rebuild`.
 *  Pending names keep their first-seen order, with a count once one repeats. */
function describeCrashRecord(record: UtilityCrashRecord): string {
  const parts: string[] = [record.cause];
  if (record.exitCode !== null) parts.push(`code=${record.exitCode}`);
  if (record.method) parts.push(`method=${record.method}`);
  if (record.pendingMethods && record.pendingMethods.length > 0) {
    const counts = new Map<string, number>();
    for (const method of record.pendingMethods) counts.set(method, (counts.get(method) ?? 0) + 1);
    const pending = [...counts].map(([method, count]) => (count > 1 ? `${method}(${count})` : method));
    parts.push(`pending=${pending.join(',')}`);
  }
  return parts.join(' ');
}
