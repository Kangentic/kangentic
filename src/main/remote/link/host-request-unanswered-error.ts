/**
 * A request to a host that got no answer: the host took longer than the request's wait, or the link
 * was stopped with the request still out.
 *
 * A dropped link does not fail a pending request at once. The request waits for the link to come back
 * and rejects only when its wait runs out, or when the link is stopped. Both used to reject with a plain
 * `Error`, which nothing could tell from a defect, so a reporter on any remote path would have filed
 * every drop as one. A drop is a state, never a failure (`.claude/rules/ssh-remote.md`): this name is
 * what lets `isExpectedFailure` skip it (`EXPECTED_FAILURE_NAMES` in `handled-report.ts`).
 *
 * Its own module with no imports, like `host-unreachable-error.ts`, so main can match the name without
 * bundling the link. The name is set explicitly because it is what survives the pty host's transport,
 * where the error crosses as a plain `Error` carrying only its name and message.
 */
export const HOST_REQUEST_UNANSWERED_ERROR_NAME = 'HostRequestUnansweredError';

export class HostRequestUnansweredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostRequestUnansweredError';
  }
}
