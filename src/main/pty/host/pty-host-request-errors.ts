/**
 * Why a request to the pty host got no answer, as a type, so a caller tells a
 * slow host from a lost one without reading the message
 * (`task-reap-failure-report.ts` maps them to `host_timeout` and
 * `host_exited`). An error the host sends back is neither: it arrives as a
 * plain `Error` rebuilt by `fromPtyHostError`.
 *
 * No imports, so a module that classifies these loads neither electron nor the
 * host core.
 */

/** A running host did not answer within the request's budget. */
export class PtyHostTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`The pty host did not answer ${method} in time`);
    this.name = 'PtyHostTimeoutError';
  }
}

/** The host exited before it answered, or was still down when the budget ran out. */
export class PtyHostExitedError extends Error {
  constructor(message = 'The pty host exited') {
    super(message);
    this.name = 'PtyHostExitedError';
  }
}
