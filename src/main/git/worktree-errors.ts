/**
 * What a git step can fail with before an agent starts, typed at the throw site
 * so a launch report can tell a bug from the state of someone's repository
 * without reading text that holds their branch names.
 */

import { UserConfigurationError } from '../../shared/user-configuration-error';

/**
 * A git step refused because of the repository's own state: the user's to
 * resolve, and nothing a release can fix, so it stays out of Sentry
 * (`user-configuration-error.ts`). The message is unchanged. It reads as it did.
 */
export class GitUserStateError extends UserConfigurationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'GitUserStateError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * An entry of the copy list is over the fixed limit. The folder is the user's
 * and so is the setting, so it fails the start and stays out of Sentry.
 */
export class WorktreeCopyLimitError extends UserConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeCopyLimitError';
  }
}

/**
 * A worktree's folder could not be cleared. Usually something outside Kangentic
 * holds it, but it can be a process of ours, so this one is reported.
 */
export class StaleWorktreeDirectoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaleWorktreeDirectoryError';
  }
}

/**
 * git's own words for the one refusal that is the repository's state: the branch
 * sits in another worktree. A branch or folder that already exists is not here.
 * The worktree folder is Kangentic's own, so one left behind is likely our
 * leftover, and a branch we were about to create means our check was wrong.
 */
const REPOSITORY_STATE_REFUSALS: readonly RegExp[] = [
  /is already (?:checked out|used by worktree) at\b/i,
];

/** True for a `git worktree add` failure that is the repository's own state. */
export function isRepositoryStateRefusal(message: string): boolean {
  return REPOSITORY_STATE_REFUSALS.some((refusal) => refusal.test(message));
}
