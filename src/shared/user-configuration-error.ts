/**
 * An error caused by the user's environment or configuration, not by a defect
 * in Kangentic. A missing CLI on PATH is the canonical case: nothing we ship
 * can fix it, so reporting it as a crash burns error-report volume on a
 * condition no code change resolves.
 *
 * Errors of this class are deliberately NOT forwarded to Sentry
 * (`reportHandledError` early-returns on them). They are still counted in
 * Aptabase and still surfaced to the user, which is the split that keeps the
 * "how often are users hitting this" signal without the un-actionable issue.
 *
 * Extend this rather than adding a message pattern to a filter list: a new
 * user-config error opts itself out by its type, so the exclusion cannot drift
 * away from the throw site.
 */
export class UserConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConfigurationError';
  }
}

/**
 * Type guard for errors that describe user configuration rather than a bug.
 * Mirrors `isAbortError` in abort-utils.ts: used in catch blocks and in the
 * error-reporting funnel to decide what is worth reporting.
 *
 *   catch (error) {
 *     if (isUserConfigurationError(error)) { notifyUser(error); return; }
 *     reportHandledError(error);
 *   }
 */
export function isUserConfigurationError(error: unknown): boolean {
  return error instanceof UserConfigurationError;
}
