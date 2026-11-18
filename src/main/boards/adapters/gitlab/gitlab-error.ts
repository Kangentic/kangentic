/**
 * A GitLab API call that came back with an error status. `providerMessage` is
 * GitLab's own text, shown to people as sent: `401 Unauthorized` for a wrong or
 * revoked token, the `invalid_token` description for an expired one, the
 * `insufficient_scope` description for a token without `read_api`.
 */
export class GitLabHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string | undefined,
    /** A 429's `Retry-After`, in milliseconds. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(providerMessage ? `GitLab ${status}: ${providerMessage}` : `GitLab request failed (${status})`);
    this.name = 'GitLabHttpError';
  }
}

/** True for a refusal of the credential itself, not of one resource. */
export function isAuthRefusal(error: unknown): error is GitLabHttpError {
  return error instanceof GitLabHttpError && error.status === 401;
}

/**
 * GitLab's own message from an error body. Its API answers in three shapes:
 * `{"message":"401 Unauthorized"}`, `{"message":{"field":["is invalid"]}}`, and
 * OAuth's `{"error":"invalid_token","error_description":"Token is expired. ..."}`.
 */
export function gitLabMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as { message?: unknown; error?: unknown; error_description?: unknown };
  if (typeof record.error_description === 'string' && record.error_description.length > 0) return record.error_description;
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  if (record.message !== null && typeof record.message === 'object') {
    const parts = Object.entries(record.message as Record<string, unknown>).map(([field, value]) =>
      `${field} ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    if (parts.length > 0) return parts.join('; ');
  }
  if (typeof record.error === 'string' && record.error.length > 0) return record.error;
  return undefined;
}
