import { trackEvent } from '../analytics/analytics';
import { reportHandledError } from '../analytics/error-reporting';
import { summarizeStderrTail, type StderrSource } from './stderr-tail';

/**
 * Restart policy shared by the utility processes we own
 * (`kangentic-embeddings`, `kangentic-line-count`).
 *
 * Both clients used to re-fork immediately on the next request, bounded only by
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
 * answers "which service died, with what exit code, and what it printed before
 * dying". A crash the policy recovers from is not reported as an issue,
 * because it is not actionable on its own; its stderr still goes to the main
 * console (and so to the project log) so a local trail exists either way.
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

type CrashPhase = 'first' | 'latched';

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
  private lastExitCode: number | null = null;
  /** The stderr of each crash in the current window, oldest first, bounded to
   *  the cap. Held by reference and read lazily (`latestStderr`): the pipe can
   *  still be draining when the `exit` that recorded a crash fires, and the
   *  latch report comes two backoffs after the first crash, by which time the
   *  text has long since landed. */
  private stderrSources: StderrSource[] = [];
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
   */
  recordCrash(exitCode: number | null | undefined, stderr?: StderrSource): void {
    this.decayIfQuiet();
    this.crashCount += 1;
    this.lastCrashAt = this.now();
    this.lastExitCode = exitCode ?? null;
    if (stderr) {
      this.stderrSources.push(stderr);
      while (this.stderrSources.length > this.maxCrashes) this.stderrSources.shift();
    }

    // Every crash leaves its stderr in the main console, which the log mirror
    // persists (warn is never gated) to <project>/.kangentic/logs/<date>.log,
    // so the text survives locally even with error reporting off.
    const tail = this.latestStderr();
    console.warn(
      `[utility-process] ${this.service} exited with code ${exitCode ?? 'unknown'} (crash ${this.crashCount} of ${this.maxCrashes})`,
      tail ? `\n${tail}` : '(no stderr captured)',
    );

    this.trackCrashOnce('first', exitCode);

    if (this.crashCount >= this.maxCrashes && !this.reportedLatch) {
      this.reportedLatch = true;
      // The same moment as the Sentry report, so the two surfaces stay aligned
      // on when a subsystem gave up.
      this.trackCrashOnce('latched', exitCode);
      // Reported from here rather than from the SDK's app-level
      // `child-process-gone` listener because only this side knows the service
      // name, the exit code, and that the exit was unintentional. The SDK's own
      // utility-process event is filtered out in error-reporting.ts precisely
      // because it can carry none of that.
      reportHandledError(
        new Error(`${this.service} worker exited repeatedly (exit code ${exitCode ?? 'unknown'})`),
        {
          source: 'utility_process',
          service: this.service,
          exitCode: String(exitCode ?? 'unknown'),
          crashCount: String(this.crashCount),
        },
        // The stderr is content, so it goes in a context, never a tag or the
        // message: a tag would fragment grouping and a varying message would
        // split the issue. This is what turns "exit code 1" into the module
        // name or stack that explains it.
        {
          utility_process: {
            service: this.service,
            exitCode: exitCode ?? null,
            crashCount: this.crashCount,
            stderrTail: this.latestStderr() ?? '(no stderr captured)',
          },
        },
      );
    }
  }

  /** Send the Aptabase event for `phase` once per service per app run. The
   *  exit code rides along (with -1 for a fork that threw, so no process ever
   *  started); the crash count does not, because it is a constant per phase
   *  (1 on `first`, the cap on `latched`) and already lives on the Sentry tag. */
  private trackCrashOnce(phase: CrashPhase, exitCode: number | null | undefined): void {
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
   *  signal: `exited with code 1: Error: Cannot find module 'sharp'`. Null
   *  when nothing has crashed, or once the window has decayed. */
  get lastCrashDescription(): string | null {
    this.decayIfQuiet();
    if (this.crashCount === 0) return null;
    const codeText = `exited with code ${this.lastExitCode ?? 'unknown'}`;
    const summary = summarizeStderrTail(this.latestStderr() ?? '');
    return summary ? `${codeText}: ${summary}` : codeText;
  }

  /** Forget the crash history. Called internally by `decayIfQuiet` once the
   *  window has passed, and by tests. No client calls it directly today; it is
   *  public so a client that gains a deliberate "try again now" control can
   *  clear the latch without reaching into private state. */
  reset(): void {
    this.crashCount = 0;
    this.lastCrashAt = null;
    this.lastExitCode = null;
    this.stderrSources = [];
    this.reportedLatch = false;
  }

  private decayIfQuiet(): void {
    if (this.crashCount === 0 || this.lastCrashAt === null) return;
    if (this.now() - this.lastCrashAt < this.decayMs) return;
    this.reset();
  }
}
