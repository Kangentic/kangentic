/**
 * What the machine and the app's window were doing when an event was sent, as
 * five fixed-enum tags `beforeSendEvent` puts on every event that is not a
 * native crash (`error-reporting.ts`).
 *
 * Sentry DESKTOP-46 took three releases to learn three of these for one report:
 * `since_wake`, then the host window, then `cpu_speed_limit`. Each was added to
 * that reporter after an event came back unable to say whether the machine had
 * just woken, the window was covered, or the CPU was held down. Here they ride
 * every event, so the next timeout, stall or missing frame says so the first time.
 *
 * - `since_wake`: how long since the last unlock or resume this run.
 * - `cpu_speed_limit`: the latest limit the OS advertised (`unknown` on Linux).
 * - `run_uptime`: how long this run has been up.
 * - `main_window`: `visible`, `minimized`, `hidden`, `none` (no window yet, or
 *   it was destroyed), or `unknown` (nothing registered a window to read).
 * - `app_focused`: whether any Kangentic window holds the OS focus.
 *
 * No electron import: `src/main/index.ts` registers the window reads, as it
 * stamps the wake clock. Every value is a fixed word, never a title or a path.
 */

import { cpuSpeedLimitBucket } from '../browser/cpu-speed-limit';
import { sinceWakeBucket } from '../browser/wake-clock';
import { currentRunUptimeBucket } from './run-uptime';

export type MainWindowState = 'visible' | 'minimized' | 'hidden' | 'none' | 'unknown';

/** The part of a `BrowserWindow` a state read needs. */
export interface WindowStateReadable {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
}

export interface RunStateSource {
  /** The main window, or null before it exists and after it closes. */
  mainWindow(): WindowStateReadable | null;
  /** Whether any of the app's windows is the OS's focused window. */
  appFocused(): boolean;
}

let source: RunStateSource | null = null;

/** Register the window reads. Called once from `src/main/index.ts`. */
export function setRunStateSource(next: RunStateSource | null): void {
  source = next;
}

function readMainWindowState(): MainWindowState {
  if (!source) return 'unknown';
  try {
    const window = source.mainWindow();
    if (!window || window.isDestroyed()) return 'none';
    if (window.isMinimized()) return 'minimized';
    return window.isVisible() ? 'visible' : 'hidden';
  } catch {
    // report-ok: a window torn down mid-read; the tag reads unknown and the event still goes.
    return 'unknown';
  }
}

function readAppFocused(): 'yes' | 'no' | 'unknown' {
  if (!source) return 'unknown';
  try {
    return source.appFocused() ? 'yes' : 'no';
  } catch {
    // report-ok: a window torn down mid-read; the tag reads unknown and the event still goes.
    return 'unknown';
  }
}

/** The five tags, read now. Never throws. */
export function runStateTags(now: number = Date.now()): Record<string, string> {
  return {
    since_wake: sinceWakeBucket(now),
    cpu_speed_limit: cpuSpeedLimitBucket(),
    run_uptime: currentRunUptimeBucket(now),
    main_window: readMainWindowState(),
    app_focused: readAppFocused(),
  };
}
