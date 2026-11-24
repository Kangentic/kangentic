/**
 * The one notice the user gets after Kangentic crashed: on the launch after the
 * app died ("Kangentic crashed"), or after the main window's renderer crashed and
 * reloaded itself in the same run ("The window crashed and reloaded"). The
 * renderer titles it and draws the toast's "This issue has been automatically
 * reported to Kangentic" line; main only records the fact (toast-shape.md).
 *
 * It is gated on a SENT crash report, never on the previous run's exit alone:
 * run-uptime's `abrupt` also covers a kill, an OS shutdown and a power loss, and
 * the toast would then claim a crash and a report that never happened. So it
 * comes from Sentry's `afterSendEvent` hook (wired in `error-reporting.ts`) for a
 * `fatal` native crash event the transport accepted:
 *
 * - `app`: a dump found at startup (`native_crash.found_at_startup`) from a run
 *   that ended abruptly (`previous_run_exit: 'abrupt'`). A GPU or helper dump left
 *   by a run that quit cleanly shows nothing.
 * - `window`: a live renderer crash sent within `WINDOW_RELOAD_ARM_MS` of the main
 *   window's reload gate arming the notice (`armWindowReload`, called from the
 *   `render-process-gone` handler).
 *
 * A foreign process's dump is demoted to a `warning` and never uploads, so it
 * never qualifies. With error reporting off nothing is sent, so nothing shows.
 * At most one notice per launch.
 *
 * Delivery: the notice waits here until the main window takes it
 * (`IPC.CRASH_NOTICE_TAKE`), on mount and whenever main pings that one is
 * waiting (`IPC.CRASH_NOTICE_READY`, which carries nothing). A dump uploads
 * seconds after startup, before or after the window loads, and a ping can reach
 * a page that has not subscribed yet, so the take is the only way a notice
 * leaves: a lost ping costs nothing.
 */

import type { CrashNotice } from '../../shared/types';

/**
 * How long after the main window's reload a sent renderer crash still counts as
 * that window's. A live dump uploads within seconds, so a renderer crash sent
 * later belongs to another window (a pop-out), or to a main-window crash whose
 * own report never went out, and must not read as "The window crashed".
 */
export const WINDOW_RELOAD_ARM_MS = 60_000;

/** The parts of a Sentry event this reads. */
export interface SentEventLike {
  level?: string;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
}

/** The part of the transport's answer this reads. */
export interface SendResponseLike {
  statusCode?: number;
}

interface NativeCrashContext {
  crash_time?: unknown;
  found_at_startup?: unknown;
  previous_run_exit?: unknown;
}

function nativeCrashContextOf(event: SentEventLike): NativeCrashContext | null {
  const context = event.contexts?.native_crash;
  return context !== null && typeof context === 'object' ? (context as NativeCrashContext) : null;
}

function wasAccepted(response: SendResponseLike | undefined): boolean {
  const statusCode = response?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300;
}

function isRendererEvent(event: SentEventLike): boolean {
  return event.tags?.['event.process'] === 'renderer';
}

/**
 * The notice a sent event earns, or null. Pure: whether the window's reload armed
 * the notice comes in as `windowReloadPending`.
 */
export function crashNoticeFromSentEvent(
  event: SentEventLike,
  response: SendResponseLike | undefined,
  state: { windowReloadPending: boolean },
): CrashNotice | null {
  if (!wasAccepted(response)) return null;
  if (event.level !== 'fatal') return null;
  const nativeCrash = nativeCrashContextOf(event);
  if (!nativeCrash) return null;
  const crashedAt = typeof nativeCrash.crash_time === 'string' ? nativeCrash.crash_time : null;
  if (nativeCrash.found_at_startup === true) {
    return nativeCrash.previous_run_exit === 'abrupt' ? { kind: 'app', crashedAt } : null;
  }
  if (state.windowReloadPending && isRendererEvent(event)) return { kind: 'window', crashedAt };
  return null;
}

export interface CrashNoticeHolder {
  /**
   * The main window's renderer died and is reloading: a renderer crash sent
   * within `WINDOW_RELOAD_ARM_MS` may now earn the notice.
   */
  armWindowReload(): void;
  /** Sentry's `afterSendEvent`. */
  onSentEvent(event: SentEventLike, response: SendResponseLike | undefined): void;
  /** The main window's read: the waiting notice, cleared, or null. */
  take(): CrashNotice | null;
  /** Called once when a notice starts waiting, so main can ping the main window. */
  setOnWaiting(onWaiting: () => void): void;
}

/** `now` is injectable so a test can step past the arm window. */
export function createCrashNoticeHolder(now: () => number = Date.now): CrashNoticeHolder {
  let windowReloadArmedAt: number | null = null;
  let waiting: CrashNotice | null = null;
  let earned = false;
  let onWaiting: (() => void) | null = null;

  return {
    armWindowReload() {
      windowReloadArmedAt = now();
    },
    onSentEvent(event, response) {
      if (earned) return;
      const windowReloadPending = windowReloadArmedAt !== null && now() - windowReloadArmedAt <= WINDOW_RELOAD_ARM_MS;
      const notice = crashNoticeFromSentEvent(event, response, { windowReloadPending });
      if (!notice) return;
      if (notice.kind === 'window') windowReloadArmedAt = null;
      earned = true;
      waiting = notice;
      onWaiting?.();
    },
    take() {
      const notice = waiting;
      waiting = null;
      return notice;
    },
    setOnWaiting(next) {
      onWaiting = next;
    },
  };
}

/** The one holder for this process. */
export const crashNoticeHolder: CrashNoticeHolder = createCrashNoticeHolder();
