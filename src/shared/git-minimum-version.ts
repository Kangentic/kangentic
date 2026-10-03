/**
 * The oldest git Kangentic fully supports: worktrees with the `.claude/commands/`
 * sparse-checkout exclusion. git 2.25.0 has `sparse-checkout` but cannot use it
 * in a linked worktree, because it does not create the worktree's `info/`
 * directory; 2.26.0 fixed that, and 2.25.1 did not carry the fix.
 *
 * Shared so the main process's check (GitDetector) and the Welcome screen's
 * warning cannot name different versions again.
 */
export const MINIMUM_GIT_VERSION = '2.26.0';

/** The minimum as shown to people, e.g. "2.26". */
export const MINIMUM_GIT_VERSION_DISPLAY = MINIMUM_GIT_VERSION.split('.').slice(0, 2).join('.');
