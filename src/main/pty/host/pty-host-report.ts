/**
 * Main's half of the pty host's handled-failure relay. The host cannot import
 * Sentry (`pty-host-out-of-process.md`), so it sends a fixed code and the error's
 * shape (`handledError`, `host-handled-error.ts`), and this reports it. The
 * in-process fallback emits the same event through the same listener
 * (`SessionManager`), so it reports the same way.
 *
 * Also the heartbeat stall: a host that stops answering freezes every terminal,
 * and the transport only logged it. The transport says how the stall ended and
 * hands over the host's stderr; this redacts it and reads the watchdog's line.
 *
 * Main-only: imports analytics.
 */

import fs from 'node:fs';
import { createChokepointReporter, sendHandledFailure } from '../../analytics/handled-report';
import { atomicWriteJson } from '../../config/board-config/atomic-write';
import { redactEventText } from '../../analytics/redact-event-paths';
import { DEFAULT_STDERR_TAIL_BYTES, watchdogLine, watchdogLineCount } from '../../utility-process/stderr-tail';
import { fromPtyHostError, type PtyHostEvent } from './protocol';

const hostFailureReporter = createChokepointReporter('pty_host');

/** Report one `handledError` the host relayed. The host sends each code once per run already. */
export function reportPtyHostHandledError(event: Extract<PtyHostEvent, { type: 'handledError' }>): void {
  hostFailureReporter.report(fromPtyHostError(event.error), { tags: { code: event.code } });
}

let heartbeatStallReported = false;

/**
 * How a stalled heartbeat ended. `answered`: the host answered late.
 * `host_exited`: it exited before it answered, and a restart followed.
 * `no_answer`: it had not answered when the ping's request budget ran out,
 * and nothing restarted it. `shutdown`: the app quit while it was still
 * waiting, reported by the next launch (`recordPtyHostStallAtQuit`).
 */
export type PtyHostHeartbeatStallOutcome = 'answered' | 'host_exited' | 'no_answer' | 'shutdown';

export interface PtyHostHeartbeatStall {
  /** The threshold the ping passed. */
  unansweredMs: number;
  outcome: PtyHostHeartbeatStallOutcome;
  /** How long after it was sent the ping was answered, or null when it was not. */
  answeredAfterMs: number | null;
  /** How late main's own threshold timer fired. A late timer with no watchdog
   *  line in the host's stderr says main's loop was held, not the host's. */
  timerLateMs: number;
  /** The methods of the other requests waiting on the host, sorted. */
  inFlight: string[];
  /** The host's stderr tail, home-redacted at capture, or '' when there is none. */
  stderrTail: string;
  /** Watchdog lines the tail held when the beat was sent. The tail spans the
   *  host's life, so its newest line can be a hold long before this stall; it
   *  names this stall's step only when the count grew. */
  watchdogLinesBefore: number;
}

/**
 * A heartbeat the host did not answer in time: its terminal thread is held, so
 * every terminal is frozen. Once per run, since a stuck host misses every beat.
 * Sent when the stall ends, so it says how (Sentry DESKTOP-43 carried only the
 * threshold), with the host's stderr tail and the step its event-loop watchdog
 * named. The fingerprint stays fixed, so every outcome is one issue.
 */
export function reportPtyHostHeartbeatStall(stall: PtyHostHeartbeatStall): void {
  if (heartbeatStallReported) return;
  heartbeatStallReported = true;
  sendHeartbeatStall(stall);
}

function sendHeartbeatStall(stall: PtyHostHeartbeatStall): void {
  const error = new Error('The pty host did not answer a heartbeat');
  error.name = 'PtyHostHeartbeatStallError';
  // Free host stderr, home-redacted at capture only, so it can still hold
  // project roots and worktree slugs (task titles), as restart-policy.ts says.
  const stderrTail = redactEventText(stall.stderrTail);
  // No new line: main's own loop was held, or the host's watchdog never ran.
  const heldStep = watchdogLineCount(stderrTail) > stall.watchdogLinesBefore ? watchdogLine(stderrTail) : null;
  sendHandledFailure(
    'pty_host',
    error,
    { code: 'heartbeat_stall', outcome: stall.outcome },
    {
      // Flat values only: Sentry normalizes contexts to depth 3.
      pty_host: {
        unansweredMs: stall.unansweredMs,
        outcome: stall.outcome,
        answeredAfterMs: stall.answeredAfterMs,
        neverAnswered: stall.answeredAfterMs === null,
        timerLateMs: stall.timerLateMs,
        inFlight: stall.inFlight,
        heldStep,
      },
      // The shape every utility-process report carries its stderr in.
      utility_process: {
        service: 'kangentic-pty-host',
        stderrTail: stderrTail || '(no stderr captured)',
      },
    },
    ['pty-host', 'heartbeat-stall'],
  );
}

/** Where a stall the app quit on waits, under the config directory, for the next launch. */
export const PTY_HOST_STALL_AT_QUIT_FILE_NAME = 'pty-host-stall-at-quit.json';

/**
 * Write a stall the app is quitting on. A host that never answers usually ends
 * this way: a person quits a window of frozen terminals. Nothing sent from the
 * quit path lands (`synchronous-shutdown.md`, rule 3), so this follows
 * `abandoned-launches.ts`: one synchronous disk write on the way out, read and
 * reported by the next launch. A person who never opens the app again is not
 * reported, which is the cost of adding no wait to a quit.
 */
export function recordPtyHostStallAtQuit(filePath: string, stall: PtyHostHeartbeatStall): void {
  atomicWriteJson(filePath, stall);
}

/** Longest stderr tail a recorded stall carries back: twice the tail it was cut from. */
const MAX_RECORDED_STDERR_CHARS = 2 * DEFAULT_STDERR_TAIL_BYTES;
const MAX_RECORDED_IN_FLIGHT = 16;
const METHOD_NAME = /^[A-Za-z]{1,40}$/;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A recorded stall read back, or null for anything else: anything can edit a file on disk. */
function parseRecordedStall(value: unknown): PtyHostHeartbeatStall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.outcome !== 'shutdown' || record.answeredAfterMs !== null) return null;
  if (!isCount(record.unansweredMs) || !isCount(record.timerLateMs) || !isCount(record.watchdogLinesBefore)) return null;
  if (typeof record.stderrTail !== 'string' || !Array.isArray(record.inFlight)) return null;
  const inFlight = record.inFlight.filter((method): method is string => typeof method === 'string' && METHOD_NAME.test(method));
  return {
    unansweredMs: record.unansweredMs,
    outcome: 'shutdown',
    answeredAfterMs: null,
    timerLateMs: record.timerLateMs,
    inFlight: inFlight.slice(0, MAX_RECORDED_IN_FLIGHT),
    stderrTail: record.stderrTail.slice(-MAX_RECORDED_STDERR_CHARS),
    watchdogLinesBefore: record.watchdogLinesBefore,
  };
}

/**
 * Report the stall the last run quit on, then delete it. Deleted first, so a
 * report that throws cannot send the same stall on every start. It is the last
 * run's, so this run's once-per-run latch is left alone.
 */
export function reportPtyHostStallFromLastRun(filePath: string): void {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // report-ok: no file is the usual start, a last run that quit on no stall.
    return;
  }
  fs.rmSync(filePath, { force: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // report-ok: a file this app did not write whole holds nothing to report; it is deleted above.
    return;
  }
  const stall = parseRecordedStall(parsed);
  if (stall) sendHeartbeatStall(stall);
}

/** Test-only: forget what this run reported. */
export function resetPtyHostReports(): void {
  hostFailureReporter.reset();
  heartbeatStallReported = false;
}
