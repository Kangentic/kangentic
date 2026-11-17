/**
 * A failure Linear reported: an HTTP status, a GraphQL `errors` entry, or a token
 * endpoint refusal. `message` is Linear's own text, shown to the user as sent.
 * Listed in `handled-report.ts`'s expected failures, like `AsanaError`: a refused
 * key or a rate limit is the remote's answer, not a defect.
 */
export class LinearError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Linear's `extensions.code` (`AUTHENTICATION_ERROR`, `RATELIMITED`) or the OAuth `error`. */
    public readonly code?: string,
    /** From a 429's `Retry-After` header. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}
