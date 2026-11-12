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
 * A worktree's Post-Worktree Script failed. Typed at the throw so a launch report
 * can tell it from a git refusal: both leave only "a child exited with code 1"
 * behind, and the script's output is the user's, so it never leaves either.
 */
export class WorktreeSetupScriptError extends Error {
  /** The failure's exit code or errno, so the launch report's `errno` tag survives the wrap. */
  readonly code?: string | number;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorktreeSetupScriptError';
    const causeCode = (options?.cause as { code?: unknown } | null | undefined)?.code;
    if (typeof causeCode === 'string' || typeof causeCode === 'number') this.code = causeCode;
  }
}

/** git's words when the branch sits in another worktree. */
const BRANCH_IN_ANOTHER_WORKTREE = /is already (?:checked out|used by worktree) at\b/i;

/**
 * git's own words for the one refusal that is the repository's state: the branch
 * sits in another worktree. A branch or folder that already exists is not here.
 * The worktree folder is Kangentic's own, so one left behind is likely our
 * leftover, and a branch we were about to create means our check was wrong.
 */
const REPOSITORY_STATE_REFUSALS: readonly RegExp[] = [
  BRANCH_IN_ANOTHER_WORKTREE,
];

/** True for a `git worktree add` failure that is the repository's own state. */
export function isRepositoryStateRefusal(message: string): boolean {
  return REPOSITORY_STATE_REFUSALS.some((refusal) => refusal.test(message));
}

/** The fixed cause a launch report sends for a failed worktree step. */
export type WorktreeFailureCause =
  | 'stale_directory'
  | 'worktree_setup_script'
  | 'worktree_branch_checked_out'
  | 'worktree_branch_exists'
  | 'worktree_path_registered'
  | 'worktree_path_exists'
  | 'worktree_invalid_reference'
  | 'worktree_invalid_branch_name'
  | 'worktree_ref_lock'
  | 'worktree_not_a_repository'
  | 'worktree_permission'
  | 'worktree_no_space'
  | 'worktree_other';

/**
 * git's `fatal:` lines for each refusal, in the order they are tried. Each was
 * read off real git (`tests/unit/worktree-failure-cause-real-git.test.ts`
 * produces it), except `worktree_no_space`, which is the OS's ENOSPC text git
 * passes on: no test can fill a disk. Order matters where one line holds
 * another's words. A ref lock's line also says `Unable to create '...lock': File
 * exists`, and a missing worktree's says `already registered`, so both come
 * before the bare `already exists`.
 *
 * The phrases are git's English. A git that prints another language matches
 * none of them and sends `worktree_other`, so the report loses detail and
 * never misnames a cause. The tests pin `LC_ALL=C` for that reason.
 */
const WORKTREE_REFUSALS: ReadonlyArray<readonly [WorktreeFailureCause, RegExp]> = [
  ['worktree_branch_checked_out', BRANCH_IN_ANOTHER_WORKTREE],
  ['worktree_ref_lock', /^fatal: cannot lock ref\b/m],
  ['worktree_path_registered', /is a missing but already registered worktree/],
  ['worktree_branch_exists', /^fatal: a branch named '.*' already exists/m],
  ['worktree_path_exists', /^fatal: '.*' already exists/m],
  ['worktree_invalid_reference', /^fatal: invalid reference: /m],
  ['worktree_invalid_branch_name', /^fatal: '.*' is not a valid branch name/m],
  ['worktree_not_a_repository', /^fatal: not a git repository\b/m],
  ['worktree_permission', /Permission denied/],
  ['worktree_no_space', /No space left on device/],
];

/** How far down a `cause` chain `messagesOf` reads, so a cycle cannot loop. */
const MAX_CAUSE_DEPTH = 5;

/** Every message in an error's `cause` chain, outermost first. */
function messagesOf(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * What a worktree step failed on, as a fixed value. git writes branch names into
 * its errors, and a branch is named after a task, so its text never leaves main.
 * This reads git's own phrase there and sends only the class (Sentry DESKTOP-2S
 * said only `worktree`).
 */
export function worktreeFailureCause(error: unknown): WorktreeFailureCause {
  if (error instanceof StaleWorktreeDirectoryError) return 'stale_directory';
  if (error instanceof WorktreeSetupScriptError) return 'worktree_setup_script';
  const messages = messagesOf(error);
  for (const [cause, phrase] of WORKTREE_REFUSALS) {
    if (messages.some((message) => phrase.test(message))) return cause;
  }
  return 'worktree_other';
}
