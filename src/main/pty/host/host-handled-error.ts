import { toPtyHostError, type PtyHostEvent, type PtyHostHandledErrorCode } from './protocol';

/**
 * Tell main of a failure the pty host handled, once per code per host run. The
 * host cannot import Sentry (`pty-host-boundary.test.ts`), so the core relays a
 * fixed code and the error's shape as a `handledError` event, and main reports it
 * (`pty-host-report.ts`). The in-process core emits through the same `emit`, so
 * the fallback after five crashes reports the same way. Pure: no `electron`, no
 * analytics, safe to bundle into the host.
 */
export class HostHandledErrors {
  private readonly sent = new Set<PtyHostHandledErrorCode>();

  constructor(private readonly emit: (event: PtyHostEvent) => void) {}

  report(code: PtyHostHandledErrorCode, error: unknown): void {
    if (this.sent.has(code)) return;
    this.sent.add(code);
    try {
      this.emit({ type: 'handledError', code, error: toPtyHostError(error) });
    } catch {
      // report-ok: this is the relay; its own throw must not replace the failure it relays.
    }
  }
}
