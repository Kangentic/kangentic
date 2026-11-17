/**
 * Shared throttle + exponential backoff utilities for board adapters.
 *
 * The CLI-based adapters (`gh`, `az`) leave rate limits to their CLI. The
 * HTTP-based ones (Asana, Linear) retry through `withBackoff`.
 */

export interface BackoffOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * The wait the server asked for before the next attempt (a 429's `Retry-After`),
   * or undefined to use the exponential delay. Capped at `maxDelayMs`.
   */
  retryAfterMs?: (error: unknown) => number | undefined;
}

/** Sleep for a given number of milliseconds. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Run a function with exponential backoff on retryable errors. */
export async function withBackoff<T>(
  work: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts || !shouldRetry(error, attempt)) break;
      const requestedDelay = options.retryAfterMs?.(error);
      const delay = Math.min(maxDelayMs, requestedDelay ?? initialDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError;
}
