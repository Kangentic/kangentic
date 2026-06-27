/**
 * Classifier for transient stdio write errors that the app already survives
 * and that must not pollute crash records or `app_error` telemetry.
 *
 * On Windows `npm start`, main-process `console.*` writes to an async TTY
 * whose kernel buffer can fill, surfacing as an uncaught
 * `write EAGAIN at WriteWrap.onWriteComplete`. EPIPE is the peer-closed
 * variant. These are dev-only artifacts (a packaged build has no console TTY)
 * but they recur during NORMAL operation, so the suppression cannot be gated
 * on shutdown alone - it would otherwise write a crash-record JSON and fire an
 * `app_error` event on every burst, and the uncaught handler's own
 * `console.error` echo (via the log mirror) amplifies the burst into the
 * observed "batches of 2-3".
 *
 * Scoped to `syscall === 'write'` so unrelated EAGAIN/EPIPE (a real socket or
 * file descriptor under genuine fault) still report normally.
 */
export function isBenignStreamWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const streamError = error as NodeJS.ErrnoException & { syscall?: string };
  if (streamError.syscall !== 'write') return false;
  return streamError.code === 'EAGAIN' || streamError.code === 'EPIPE';
}
