/**
 * The one directory every task worktree leaves out through sparse-checkout.
 * Claude Code finds commands by walking up from the worktree to the main
 * checkout's `.claude/commands/`, so a second copy in the worktree would list
 * every command twice. Skills and agents do not walk up, so they stay.
 *
 * Its own module so code that must honor the exclusion (creating a worktree,
 * carrying changes into one) reads the same value without importing the
 * worktree manager.
 */
export const WORKTREE_EXCLUDED_DIRECTORY = '.claude/commands/';

/** Non-cone sparse-checkout patterns: keep everything except WORKTREE_EXCLUDED_DIRECTORY. */
export const WORKTREE_SPARSE_PATTERNS = ['/*', `!/${WORKTREE_EXCLUDED_DIRECTORY}`];
