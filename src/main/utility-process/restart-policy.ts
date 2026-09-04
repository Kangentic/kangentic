import { trackEvent } from '../analytics/analytics';
import { reportHandledError } from '../analytics/error-reporting';

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
 * Telemetry follows the same volume/diagnostic split the spawn paths use: an
 * Aptabase counter on every crash answers "how often does this happen", and a
 * single Sentry report when the cap is reached answers "which service died, and
 * with what exit code". A crash the policy recovers from is not reported as an
 * issue, because it is not actionable on its own.
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

export class UtilityRestartPolicy {
  private readonly service: string;
  private readonly maxCrashes: number;
  private readonly backoffMs: readonly number[];
  private readonly decayMs: number;
  private readonly now: () => number;

  private crashCount = 0;
  private lastCrashAt: number | null = null;
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
  recordCrash(exitCode: number | null | undefined): void {
    this.decayIfQuiet();
    this.crashCount += 1;
    this.lastCrashAt = this.now();

    trackEvent('utility_worker_crashed', {
      service: this.service,
      exitCode: exitCode ?? -1,
    });

    if (this.crashCount >= this.maxCrashes && !this.reportedLatch) {
      this.reportedLatch = true;
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
      );
    }
  }

  /** Forget the crash history. Called internally by `decayIfQuiet` once the
   *  window has passed, and by tests. No client calls it directly today; it is
   *  public so a client that gains a deliberate "try again now" control can
   *  clear the latch without reaching into private state. */
  reset(): void {
    this.crashCount = 0;
    this.lastCrashAt = null;
    this.reportedLatch = false;
  }

  private decayIfQuiet(): void {
    if (this.crashCount === 0 || this.lastCrashAt === null) return;
    if (this.now() - this.lastCrashAt < this.decayMs) return;
    this.reset();
  }
}
