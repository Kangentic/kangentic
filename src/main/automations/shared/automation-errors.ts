/**
 * Errors an adapter raises to tell the runner how to treat a failure.
 *
 * The runner owns retry policy (it reads `manifest.retry`), but only the
 * adapter knows whether a given failure is worth retrying: a 500 is, a 404 is
 * not, and re-sending a request that already created something downstream is
 * the bug retries are famous for. So the adapter classifies and the runner
 * decides.
 */

/**
 * A failure the runner MAY retry, if the adapter's manifest declares a retry
 * policy. Raise it only for a failure that is genuinely transient and whose
 * side effect either did not happen or is idempotent.
 */
export class AutomationRetryableError extends Error {
  /** Seconds the server asked us to wait, from `Retry-After`, when it said so. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'AutomationRetryableError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A failure the runner must never retry, whatever the manifest says. */
export class AutomationPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationPermanentError';
  }
}

/** The adapter's declared budget elapsed. Never retried: the work may still be running. */
export class AutomationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationTimeoutError';
  }
}

export function isRetryableAutomationError(error: unknown): error is AutomationRetryableError {
  return error instanceof AutomationRetryableError;
}
