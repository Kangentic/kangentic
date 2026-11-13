/**
 * Main's half of the pty host's handled-failure relay. The host cannot import
 * Sentry (`pty-host-out-of-process.md`), so it sends a fixed code and the error's
 * shape (`handledError`, `host-handled-error.ts`), and this reports it. The
 * in-process fallback emits the same event through the same listener
 * (`SessionManager`), so it reports the same way.
 *
 * Also the heartbeat stall: a host that stops answering freezes every terminal,
 * and the transport only logged it.
 *
 * Main-only: imports analytics.
 */

import { createChokepointReporter, sendHandledFailure } from '../../analytics/handled-report';
import { fromPtyHostError, type PtyHostEvent } from './protocol';

const hostFailureReporter = createChokepointReporter('pty_host');

/** Report one `handledError` the host relayed. The host sends each code once per run already. */
export function reportPtyHostHandledError(event: Extract<PtyHostEvent, { type: 'handledError' }>): void {
  hostFailureReporter.report(fromPtyHostError(event.error), { tags: { code: event.code } });
}

let heartbeatStallReported = false;

/**
 * A heartbeat the host did not answer in time: its terminal thread is held, so
 * every terminal is frozen. Once per run, since a stuck host misses every beat.
 */
export function reportPtyHostHeartbeatStall(unansweredMs: number): void {
  if (heartbeatStallReported) return;
  heartbeatStallReported = true;
  const stall = new Error('The pty host did not answer a heartbeat');
  stall.name = 'PtyHostHeartbeatStallError';
  sendHandledFailure('pty_host', stall, { code: 'heartbeat_stall' }, { pty_host: { unansweredMs } }, ['pty-host', 'heartbeat-stall']);
}

/** Test-only: forget what this run reported. */
export function resetPtyHostReports(): void {
  hostFailureReporter.reset();
  heartbeatStallReported = false;
}
