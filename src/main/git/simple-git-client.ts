import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * The ambient git variables simple-git 4 is told to keep. It removes every
 * inherited `GIT_*` key, plus `EDITOR`, `VISUAL`, `PAGER`, `PREFIX` and
 * `SSH_ASKPASS`, unless `allowEnvironment` names it.
 *
 * `GIT_CEILING_DIRECTORIES` stays because a dev preview sets it
 * (scripts/dev.js, scripts/preview-isolation.js): the preview's projects live
 * inside the worktree, and without the ceiling a git command run in one whose
 * `.git` is missing acts on the worktree above it. That once wiped a worktree's
 * uncommitted changes, and `writeWorktreeBaseBranch` writes config through this
 * client. `gitAt` and `spawnWithAbort` keep the variable, so these calls must
 * too. It is not an unsafe key, so allowing it needs no `unsafe` flag. A value
 * a user exports themselves passes the same way.
 */
export const SIMPLE_GIT_ALLOWED_ENVIRONMENT: readonly string[] = ['GIT_CEILING_DIRECTORIES'];

/**
 * A simple-git client for `directory`. Every simple-git call in the app opens
 * its client here, so the allowance above applies to all of them.
 */
export function openSimpleGit(directory: string): SimpleGit {
  return simpleGit(directory, { allowEnvironment: SIMPLE_GIT_ALLOWED_ENVIRONMENT });
}
