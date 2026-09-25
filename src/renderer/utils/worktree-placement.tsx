import type { ReactNode } from 'react';

/**
 * ONE vocabulary for "where will this agent work": the branch hint under the
 * New Task / edit-form Branch row, a prediction made before the spawn decides,
 * and the reason the Worktree option is unavailable when the project cannot
 * have one. Pure functions only: this module is consumed inside
 * `dialogs/task-detail/**`, which the host-decoupling scan forbids from reading
 * the project or board stores, so every input is handed in by the caller.
 *
 * Every string here says WHERE and stops. The hint mirrors the existing
 * worktree-on lines word for word, with "in the project folder" in place of
 * "in a new worktree", so there is one sentence shape to learn. Reasons live
 * in tooltips as short fragments. A first cut explained the sharing
 * consequence with a warning icon and read as a lecture on every dialog open.
 *
 * The recorded fact (`Task.worktree_skip_reason`, written by the main process
 * after the spawn) has no renderer reader yet: a 12px card glyph that drew it
 * was reviewed out as too small to tell apart. A richer card row (branch name
 * plus a larger glyph) is the likely home when it returns.
 */

/**
 * A structural reason the project cannot have a worktree, decidable in the
 * renderer before any spawn. Mirrors the order the main process checks them:
 * `ensureTaskWorktree` skips a remote agent first, then
 * `WorktreeManager.ensureWorktree` guards not-a-repo, nested-worktree, and the
 * unborn HEAD. `'disabled'` is not a blocker: it is the toggle's own state.
 */
export type WorktreeBlocker = 'not-a-repo' | 'nested-worktree' | 'no-commits' | 'remote-agent';

export interface WorktreeBlockerInput {
  /** Null until the path probe answers; the hint then trusts the toggle alone. */
  probe: { isGitRepo: boolean; isInsideWorktree: boolean; hasCommits: boolean } | null;
  /** The resolved agent runs against a server-side directory. */
  remoteAgent: boolean;
}

export function resolveWorktreeBlocker({ probe, remoteAgent }: WorktreeBlockerInput): WorktreeBlocker | null {
  if (remoteAgent) return 'remote-agent';
  if (!probe) return null;
  if (!probe.isGitRepo) return 'not-a-repo';
  if (probe.isInsideWorktree) return 'nested-worktree';
  if (!probe.hasCommits) return 'no-commits';
  return null;
}

/** The disabled Worktree option's tooltip: the reason, as a fragment. */
export function describeWorktreeBlocker(blocker: WorktreeBlocker): string {
  switch (blocker) {
    case 'not-a-repo':
      return 'Not a git repository';
    case 'nested-worktree':
      return 'The project folder is itself a git worktree';
    case 'no-commits':
      return 'No commits yet';
    case 'remote-agent':
      return 'The agent runs on a remote server';
  }
}

export interface BranchHintInput {
  customBranchName: string;
  /** The custom branch already exists in the repo. */
  branchExists: boolean;
  effectiveWorktree: boolean;
  effectiveBaseBranch: string;
  /**
   * The user picked a base branch explicitly. Without a worktree, a pinned base
   * is CHECKED OUT in the project folder (`ensureTaskBranchCheckout`), while an
   * unpinned one leaves the folder on whatever branch it has.
   */
  baseBranchPinned: boolean;
  /** The project folder's checked-out branch, once the probe has answered. */
  currentBranch: string | null;
  blocker: WorktreeBlocker | null;
}

function pill(text: string): ReactNode {
  return <span className="whitespace-nowrap font-mono text-fg-faint">{text}</span>;
}

/**
 * The one-line statement under the Branch row. The worktree-on auto-branch
 * string is pinned by `tests/ui/new-task-dialog.spec.ts` and must keep its
 * opening words; the off lines are the same sentences with the place swapped.
 */
export function computeBranchHint(input: BranchHintInput): ReactNode {
  const { blocker, currentBranch } = input;
  const branch = input.customBranchName.trim();
  const base = input.effectiveBaseBranch;

  if (blocker === 'remote-agent') return <>Runs on the remote server</>;
  if (blocker) return <>Runs in the project folder</>;

  const place = input.effectiveWorktree ? 'in a new worktree' : 'in the project folder';
  if (branch) {
    if (input.branchExists) {
      return currentBranch === branch && !input.effectiveWorktree
        ? <>Runs in the project folder on {pill(branch)}</>
        : <>{pill(branch)} exists and will be checked out {place}</>;
    }
    return <>{pill(branch)} will be created from {pill(base)} {place}</>;
  }
  if (input.effectiveWorktree) {
    return <>Auto-generated branch will be created from {pill(base)} in a new worktree</>;
  }
  if (input.baseBranchPinned && currentBranch !== base) {
    return <>{pill(base)} will be checked out in the project folder</>;
  }
  return currentBranch
    ? <>Runs in the project folder on {pill(currentBranch)}</>
    : <>Runs in the project folder</>;
}
