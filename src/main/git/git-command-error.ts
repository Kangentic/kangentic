/**
 * What a failed git command throws, and the one fixed word a report may send
 * about it.
 *
 * git writes paths, branch names and revisions into its errors, and a branch is
 * named after a task, so its text never leaves main. A handled report used to
 * carry only `Error` for any of these: Sentry DESKTOP-4A was `git:diffFiles`
 * failing with nothing to say why. The cause is read here from git's own
 * `fatal:` line and sent as the `git_cause` tag (`sendHandledFailure`, which
 * reads `gitCause` by shape and imports nothing from here).
 */

/**
 * git's words for a failure the environment causes. The worktree causes
 * (`worktree-errors.ts`) match the same lines, so each phrase is written once.
 */
export const GIT_NOT_A_REPOSITORY = /^fatal: not a git repository\b/m;
export const GIT_REF_LOCK = /^fatal: cannot lock ref\b/m;
/**
 * git's own line for a path it could not write: `fatal:` or `error:`, what it
 * was doing, then the OS's words at the end. Anchored to that shape because the
 * phrase alone names two other things: ssh prints "Permission denied
 * (publickey)" for a login the remote refused, and a `warning:` line says it
 * about a config file git only skipped.
 */
export const GIT_PERMISSION_DENIED = /^(?:fatal|error): .*: Permission denied$/m;
export const GIT_NO_SPACE = /No space left on device/;

/** The fixed cause a report sends for a failed git command. */
export type GitFailureCause =
  /** A revision that names nothing: an unborn HEAD, a branch that is gone. */
  | 'unknown_revision'
  /** A full hash whose object the repository no longer holds. */
  | 'missing_object'
  | 'not_a_repository'
  /** The folder belongs to another user and is not in `safe.directory`. */
  | 'dubious_ownership'
  | 'ref_lock'
  | 'index_lock'
  | 'corrupt_index'
  | 'permission'
  | 'no_space'
  | 'other';

/**
 * git's `fatal:` lines for each cause, in the order they are tried. Each was
 * read off real git (`tests/unit/git-failure-cause-real-git.test.ts` produces
 * it), except `no_space`, the OS's ENOSPC text git passes on: no test can fill
 * a disk. A ref lock's line also says `Unable to create '...lock': File
 * exists`, so it comes before the index lock, and the two phrases the OS wrote
 * come last.
 *
 * The phrases are git's English. A git that prints another language matches
 * none of them and reads `other`, so a report loses detail and never misnames
 * a cause. The tests pin `LC_ALL=C` for that reason.
 */
const GIT_REFUSALS: ReadonlyArray<readonly [GitFailureCause, RegExp]> = [
  ['unknown_revision', /^fatal: (?:ambiguous argument '.*': unknown revision or path not in the working tree|invalid object name '|Not a valid (?:object|commit) name |Needed a single revision)/m],
  ['missing_object', /^fatal: bad object /m],
  ['not_a_repository', GIT_NOT_A_REPOSITORY],
  ['dubious_ownership', /^fatal: detected dubious ownership in repository\b/m],
  ['ref_lock', GIT_REF_LOCK],
  ['index_lock', /^fatal: Unable to create '.*index\.lock': File exists/m],
  ['corrupt_index', /^fatal: .*index file (?:smaller than expected|corrupt)/m],
  ['permission', GIT_PERMISSION_DENIED],
  ['no_space', GIT_NO_SPACE],
];

/**
 * What git refused on, from what it wrote to stderr. Never stdout: a failed
 * `show` or `diff` can print file text first, and a file may say anything.
 */
export function gitFailureCause(stderr: string): GitFailureCause {
  for (const [cause, phrase] of GIT_REFUSALS) {
    if (phrase.test(stderr)) return cause;
  }
  return 'other';
}

/** How a git command ended, as `runGitCommand` read it. */
export interface GitCommandFailure {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A git command that exited non-zero and wrote to stderr. The message is
 * simple-git's, which callers read ("Worktree setup failed: <first line>", the
 * path-length hint, `worktreeFailureCause`): stdout then stderr, untrimmed. A
 * report sends the name and `gitCause`, never that text.
 */
export class GitCommandError extends Error {
  readonly gitCause: GitFailureCause;
  readonly exitCode: number;

  constructor(failure: GitCommandFailure, options?: ErrorOptions) {
    super(`${failure.stdout}${failure.stderr}`, options);
    this.name = 'GitCommandError';
    this.gitCause = gitFailureCause(failure.stderr);
    this.exitCode = failure.exitCode;
    // The throw site on top, not this constructor: a chokepoint latches on the
    // first frame, and it would otherwise be the same for every runner.
    Error.captureStackTrace?.(this, GitCommandError);
  }
}
