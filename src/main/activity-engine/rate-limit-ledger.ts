import { RATE_LIMIT_RESET_EPSILON_SECONDS } from '../../shared/types';
import type { RateLimitWindow } from '../../shared/types';

/**
 * How far a fresh report must fall to count as a reset, in percentage points. A
 * free reset zeroes the window, so it drops by about the whole used share. Float
 * noise is around 1e-15 (a real status.json reads 14.000000000000002), and a boot
 * read can trail a climbing sibling by a point or two, so 5 sits well above both.
 * The cost: a reset taken at 5% or less goes unnoticed, and the bar overstates by
 * at most 5 points until real usage passes the old value.
 */
export const RATE_LIMIT_RESET_MIN_DROP_POINTS = 5;

interface SessionWindowReport {
  usedPercentage: number;
  resetsAt: number;
  generation: number;
}

interface WindowHighWater {
  usedPercentage: number;
  resetsAt: number;
}

/** True when both anchors are real (a missing `resets_at` parses to 0) and within the epsilon, so they name one fixed window. */
export function isSameRateLimitWindow(firstResetsAt: number, secondResetsAt: number): boolean {
  return firstResetsAt > 0
    && secondResetsAt > 0
    && Math.abs(firstResetsAt - secondResetsAt) <= RATE_LIMIT_RESET_EPSILON_SECONDS;
}

/**
 * Per-session history of rate-limit reports, used to stamp each window with a
 * reset `generation`. Pure logic, no timers, no I/O. Owned by `UsageAccumulator`,
 * next to the usage cache it stamps.
 *
 * Rate limits are account-wide, but each agent process refreshes them only from
 * its own API traffic (and once at launch, for a CLI that fetches them on
 * startup), and between fetches it repeats its last value on every status write.
 * So a sibling that has not called the API lately reports an old number. Within
 * one fixed window usage normally only rises, which is why the renderer keeps the
 * per-window maximum. A free usage reset breaks that: usage falls while
 * `resetsAt` stays put, and a maximum keeps the stale pre-reset number forever.
 * Telling the reset apart from a stale sibling needs to know WHICH session said
 * what, and only main sees every session's reports in order, so the history
 * lives here.
 *
 * Per window of a report:
 * - A repeat (the same `usedPercentage` as that session's previous report, in the
 *   same window) is never evidence; the session keeps its generation. One process
 *   re-emits one cached number, and the window comparison absorbs any jitter in
 *   the `resetsAt` it reports with it.
 * - A fresh report (the session's first, or any change from its own previous
 *   report) joins the current generation, unless it is reset evidence, which
 *   opens the next generation for this session alone. Every other session is then
 *   behind it until its own next fresh report, so its stale repeats lose.
 * - Reset evidence is a fresh report in the same window as what it is compared
 *   with, falling more than `RATE_LIMIT_RESET_MIN_DROP_POINTS`. A session in the
 *   current generation is compared with its own previous report. A session's
 *   first report is compared with the highest value the current generation has
 *   seen in that window, which covers a new process whose startup fetch already
 *   sees the reset, such as a brand-new Command Terminal. That highest value
 *   outlives the session that reported it, so the comparison still works after
 *   every earlier session is gone.
 * - A fresh report from a session behind the current generation catches up into
 *   it and is never a second reset. That also makes a false trigger heal itself:
 *   each sibling rejoins on its next change.
 * - A rollover or an older `resetsAt` is never evidence; the renderer's
 *   `resetsAt` comparison handles both.
 *
 * A session's history keeps what that session itself reported, even after
 * `UsageAccumulator` brings its cached window up to a reset. That is how its
 * next stale repeat is still recognized as a repeat.
 *
 * Three limits are left on purpose:
 * - A `resetsAt` that moves backward is not treated as a reset, so the renderer
 *   keeps ignoring that older window. One such move showed up at 0%, 35 hours
 *   earlier than the held anchor. On another day the anchor alternated between
 *   two values within hours, which looks like two accounts on one machine, and
 *   counting a backward anchor as a reset would bounce the bar between them.
 * - A reset taken at `RATE_LIMIT_RESET_MIN_DROP_POINTS` or less is not detected
 *   (see that constant).
 * - A false trigger (a drop past the threshold that was not a reset) understates
 *   until each sibling's next fresh report. A sibling that only repeats, such as
 *   a paused session, keeps the lowered value until then.
 */
export class RateLimitLedger {
  /** Current generation per window id. Account-wide, so it outlives every session. */
  private generationByWindow = new Map<string, number>();
  /**
   * Highest current-generation report per window id. Account-wide like the
   * generation, so a first report can be compared with it after its session is
   * removed.
   */
  private highestByWindow = new Map<string, WindowHighWater>();
  /** Last report per session, per window id. */
  private reportsBySession = new Map<string, Map<string, SessionWindowReport>>();

  /**
   * Record one report's windows for a session and return copies stamped with
   * their generation. Never mutates the input.
   */
  stamp(sessionId: string, windows: RateLimitWindow[]): RateLimitWindow[] {
    let sessionReports = this.reportsBySession.get(sessionId);
    if (!sessionReports) {
      sessionReports = new Map<string, SessionWindowReport>();
      this.reportsBySession.set(sessionId, sessionReports);
    }
    return windows.map((rateLimitWindow) => ({
      ...rateLimitWindow,
      generation: this.observe(sessionId, sessionReports, rateLimitWindow),
    }));
  }

  /** The current generation of a window id, 0 before any reset. */
  currentGeneration(windowId: string): number {
    return this.generationByWindow.get(windowId) ?? 0;
  }

  /** Forget a session's history. Generation counters and high-water marks are kept because they are account-wide. */
  removeSession(sessionId: string): void {
    this.reportsBySession.delete(sessionId);
  }

  private observe(
    sessionId: string,
    sessionReports: Map<string, SessionWindowReport>,
    rateLimitWindow: RateLimitWindow,
  ): number {
    const currentGeneration = this.currentGeneration(rateLimitWindow.id);
    const previousReport = sessionReports.get(rateLimitWindow.id);

    let generation: number;
    if (previousReport && isRepeatReport(previousReport, rateLimitWindow)) {
      // The session re-sent its cached value, which carries no new information.
      generation = previousReport.generation;
    } else if (this.isResetEvidence(sessionId, previousReport, rateLimitWindow, currentGeneration)) {
      generation = currentGeneration + 1;
      this.generationByWindow.set(rateLimitWindow.id, generation);
    } else {
      generation = currentGeneration;
    }

    sessionReports.set(rateLimitWindow.id, {
      usedPercentage: rateLimitWindow.usedPercentage,
      resetsAt: rateLimitWindow.resetsAt,
      generation,
    });
    this.recordHighest(rateLimitWindow, generation, generation > currentGeneration);
    return generation;
  }

  /**
   * Keep the window's highest current-generation value. A report that opened a
   * generation replaces it, since the old value belongs to the generation before.
   * So does a later window (a rollover). A report from a session behind the
   * current generation, or for an older window, never touches it.
   */
  private recordHighest(rateLimitWindow: RateLimitWindow, generation: number, openedGeneration: boolean): void {
    if (rateLimitWindow.resetsAt <= 0 || generation !== this.currentGeneration(rateLimitWindow.id)) return;
    const highest = this.highestByWindow.get(rateLimitWindow.id);
    if (
      openedGeneration
      || highest === undefined
      || rateLimitWindow.resetsAt - highest.resetsAt > RATE_LIMIT_RESET_EPSILON_SECONDS
    ) {
      this.highestByWindow.set(rateLimitWindow.id, {
        usedPercentage: rateLimitWindow.usedPercentage,
        resetsAt: rateLimitWindow.resetsAt,
      });
      return;
    }
    if (
      isSameRateLimitWindow(highest.resetsAt, rateLimitWindow.resetsAt)
      && rateLimitWindow.usedPercentage > highest.usedPercentage
    ) {
      // Keep the first anchor, as the renderer does, so it cannot drift within a window.
      this.highestByWindow.set(rateLimitWindow.id, { usedPercentage: rateLimitWindow.usedPercentage, resetsAt: highest.resetsAt });
    }
  }

  private isResetEvidence(
    sessionId: string,
    previousReport: SessionWindowReport | undefined,
    rateLimitWindow: RateLimitWindow,
    currentGeneration: number,
  ): boolean {
    if (previousReport) {
      // Only a session in the current generation can show a NEW reset. One that
      // is behind it is catching up to a reset already counted.
      return previousReport.generation === currentGeneration
        && isSameRateLimitWindow(previousReport.resetsAt, rateLimitWindow.resetsAt)
        && previousReport.usedPercentage - rateLimitWindow.usedPercentage > RATE_LIMIT_RESET_MIN_DROP_POINTS;
    }

    // The session's first report: a new process's startup fetch. It is a reset
    // only when it sits clearly below what the current generation already holds
    // for the same window. Live siblings are read as well as the high-water mark,
    // because the mark follows the newest window and a sibling can still be on
    // an older one (two accounts on one machine).
    let highestCurrent: number | null = null;
    for (const [otherSessionId, otherReports] of this.reportsBySession) {
      if (otherSessionId === sessionId) continue;
      const otherReport = otherReports.get(rateLimitWindow.id);
      if (!otherReport || otherReport.generation !== currentGeneration) continue;
      if (!isSameRateLimitWindow(otherReport.resetsAt, rateLimitWindow.resetsAt)) continue;
      if (highestCurrent === null || otherReport.usedPercentage > highestCurrent) {
        highestCurrent = otherReport.usedPercentage;
      }
    }
    const highest = this.highestByWindow.get(rateLimitWindow.id);
    if (
      highest
      && isSameRateLimitWindow(highest.resetsAt, rateLimitWindow.resetsAt)
      && (highestCurrent === null || highest.usedPercentage > highestCurrent)
    ) {
      highestCurrent = highest.usedPercentage;
    }
    return highestCurrent !== null
      && highestCurrent - rateLimitWindow.usedPercentage > RATE_LIMIT_RESET_MIN_DROP_POINTS;
  }
}

/**
 * A report that repeats the session's previous one: the same value in the same
 * window. An exact match also counts, so a report with no `resetsAt` (0) still
 * repeats itself.
 */
function isRepeatReport(previousReport: SessionWindowReport, rateLimitWindow: RateLimitWindow): boolean {
  return previousReport.usedPercentage === rateLimitWindow.usedPercentage
    && (
      previousReport.resetsAt === rateLimitWindow.resetsAt
      || isSameRateLimitWindow(previousReport.resetsAt, rateLimitWindow.resetsAt)
    );
}
