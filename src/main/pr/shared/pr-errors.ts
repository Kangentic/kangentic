/**
 * PR resolver errors. Kept in a leaf module (no imports of the registry or any
 * connector) so both the registry and individual provider adapters can import the
 * error class as a value without forming a circular dependency.
 */

/**
 * Thrown by a connector's resolve methods when the platform resolver cannot run
 * at all - the CLI is missing/unauthenticated, or no connector matches the
 * remote. Platform-agnostic so `pr-linking.ts` can catch it without importing
 * any provider-specific error (e.g. GitHub's GhUnavailableError, which connectors
 * translate into this).
 */
export class PRResolverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PRResolverUnavailableError';
  }
}

/**
 * Thrown when resolution failed transiently (network / platform 5xx / rate-limit
 * / timeout) rather than because there is no PR. Callers preserve the existing
 * link and report a distinct status instead of "not found".
 */
export class PRResolverTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PRResolverTransientError';
  }
}
