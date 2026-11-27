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
 * The two outcomes are not the same to a launch report (Sentry DESKTOP-4N). A stopped link is the
 * user's Remove, a quit or a reconnect, never a defect. A wait that ran out may be a host too slow for
 * the request's wait, which is ours to look at. `code` says which, as a fixed word: it is what crosses
 * the pty host's transport beside the name (`toPtyHostError`), so no reader needs the message.
 *
 * Its own module with no imports, like `host-unreachable-error.ts`, so main can match the name without
 * bundling the link. The name is set explicitly because it is what survives the pty host's transport,
 * where the error crosses as a plain `Error` carrying only its name, message and code.
 */
export const HOST_REQUEST_UNANSWERED_ERROR_NAME = 'HostRequestUnansweredError';

/** Why a host request got no answer. */
export type HostRequestUnansweredReason = 'link_stopped' | 'no_answer';

const CODE_OF_REASON: Readonly<Record<HostRequestUnansweredReason, string>> = {
  link_stopped: 'HOST_LINK_STOPPED',
  no_answer: 'HOST_NO_ANSWER',
};

export class HostRequestUnansweredError extends Error {
  readonly code: string;

  constructor(message: string, reason: HostRequestUnansweredReason, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostRequestUnansweredError';
    this.code = CODE_OF_REASON[reason];
  }
}

/**
 * True for a request rejected because its link was stopped, read by name and code so it holds for the
 * copy rebuilt on the far side of the pty host's transport. A wait that ran out is false.
 */
export function isHostLinkStoppedError(error: unknown): boolean {
  return error instanceof Error
    && error.name === HOST_REQUEST_UNANSWERED_ERROR_NAME
    && (error as { code?: unknown }).code === CODE_OF_REASON.link_stopped;
}

/** What main knew about an unanswered request when it was rejected: which helper call, and how long it waited. */
export interface HostRequestWait {
  /** A helper method's name (`HelperMethod`), a fixed word. */
  method: string;
  waitedMs: number;
}

const WAIT_FACTS = Symbol('hostRequestWait');

type WithWaitFacts = Error & { [WAIT_FACTS]?: HostRequestWait };

/**
 * Stamp an unanswered request's rejection with its method and wait, on main's side of the transport
 * (`RemoteHostService.sendHelper`), where both are known. The copy that crossed the wire has neither.
 */
export function noteHostRequestWait(error: unknown, wait: HostRequestWait): void {
  if (error instanceof Error && error.name === HOST_REQUEST_UNANSWERED_ERROR_NAME) (error as WithWaitFacts)[WAIT_FACTS] = wait;
}

/** The method and wait stamped on an unanswered request's rejection, or on its `cause` one level down. */
export function hostRequestWaitOf(error: unknown): HostRequestWait | null {
  for (const candidate of [error, (error as { cause?: unknown } | null | undefined)?.cause]) {
    if (candidate instanceof Error) {
      const wait = (candidate as WithWaitFacts)[WAIT_FACTS];
      if (wait) return wait;
    }
  }
  return null;
}
