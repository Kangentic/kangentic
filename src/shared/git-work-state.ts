/**
 * A checkout's git work state: what is uncommitted, what is on no remote, and
 * where a push would go. The Changes button's badge, its tip, the Changes
 * panel's next-step line and the window menu all decide from the pure functions
 * here, so they can never disagree about the same checkout.
 */

import type { Task } from './types';

/**
 * The branch a task's work is measured against: the base the user chose, else the
 * one its worktree was cut from, else the project's default. Main and every
 * renderer surface ask this, so a badge and the action beside it count alike.
 */
export function taskGitBase(task: Pick<Task, 'base_branch' | 'resolved_base_branch'>, defaultBase: string): string {
  return task.base_branch || task.resolved_base_branch || defaultBase;
}

export interface GitWorkStateInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
  /** The branch the worktree was cut from, which it tracks even after its task's base changed. */
  cutFromBranch?: string | null;
  /** The branch the work was pushed to when that differs from the local name (`tasks.pushed_branch`). */
  pushedBranch?: string | null;
  /** The linked PR is merged: its commits can sit on no remote branch once the branch is deleted. */
  prMerged?: boolean;
}

export interface GitWorkState {
  /** Live HEAD branch, or null on a detached HEAD. */
  branch: string | null;
  /** The checkout is on its base branch, where there is no pull request to create. */
  onBaseBranch: boolean;
  /** Every changed file: staged, unstaged, untracked and conflicted. */
  uncommittedFileCount: number;
  /** Files with something staged. When any is, a commit takes only those. */
  stagedFileCount: number;
  /** Files with unresolved conflicts. A commit would mark them resolved. */
  conflictedFileCount: number;
  /** Commits on no remote-tracking branch, under any name. */
  unpushedCommitCount: number;
  /** Commits on HEAD and not on the base branch. */
  aheadOfBaseCount: number;
  /** The repository has a remote to push to. */
  hasRemote: boolean;
  /** The remote branch a push updates, or null when the branch was never published. */
  pushTarget: string | null;
  /** The repository's host can have a pull request created for it. */
  canCreatePullRequest: boolean;
}

/** What the Changes button's badge marks, most important first. */
export type GitWorkBadge = 'pr-problems' | 'uncommitted' | 'unpushed';

/** The one badge the Changes button shows, or null for none. */
export function gitWorkBadge(input: { prFixCount: number; state: GitWorkState | null }): GitWorkBadge | null {
  if (input.prFixCount > 0) return 'pr-problems';
  if (!input.state) return null;
  if (input.state.uncommittedFileCount > 0) return 'uncommitted';
  if (input.state.unpushedCommitCount > 0) return 'unpushed';
  return null;
}

/** Which git actions apply to a checkout right now, whatever the agent is doing. */
export interface GitActionsAvailable {
  commit: boolean;
  /** A push of commits that are on no remote. `publish` is the first push of the branch. */
  push: 'push' | 'publish' | null;
  createPullRequest: boolean;
}

const NO_ACTIONS: GitActionsAvailable = { commit: false, push: null, createPullRequest: false };

/** A detached HEAD offers nothing: there is no branch to commit to or push. */
export function availableGitActions(input: { state: GitWorkState | null; hasPullRequest: boolean }): GitActionsAvailable {
  const { state } = input;
  if (!state || state.branch === null) return NO_ACTIONS;
  const pushable = state.hasRemote && state.unpushedCommitCount > 0;
  return {
    commit: state.uncommittedFileCount > 0,
    push: !pushable ? null : state.pushTarget === null ? 'publish' : 'push',
    createPullRequest: state.canCreatePullRequest
      && !input.hasPullRequest
      && !state.onBaseBranch
      && state.aheadOfBaseCount > 0,
  };
}

/** The Changes panel line's next step: one at a time, in the order the work happens. */
export type GitNextStep = 'commit' | 'publish' | 'push' | 'create-pull-request';

export function gitNextStep(input: { state: GitWorkState | null; hasPullRequest: boolean }): GitNextStep | null {
  const available = availableGitActions(input);
  if (available.commit) return 'commit';
  if (available.push) return available.push;
  if (available.createPullRequest) return 'create-pull-request';
  return null;
}

/** How many files a commit takes: the staged ones when any are staged, else every change. */
export function commitFileCount(state: GitWorkState): number {
  return state.stagedFileCount > 0 ? state.stagedFileCount : state.uncommittedFileCount;
}

/** The checkout a git action runs in. Main resolves the folder; the renderer never names one. */
export type GitActionTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'terminal'; slot: string };

export interface GitCommitInput {
  message: string;
  pushAfter: boolean;
}

export interface GitCreatePullRequestInput {
  title: string;
  body: string;
  baseBranch: string;
  draft: boolean;
}

export type GitDraftKind = 'commit-message' | 'pull-request-description';

export interface GitDraftInput {
  kind: GitDraftKind;
  /** Ignore a draft already written for the same changes and write a new one. */
  force?: boolean;
  /** The branch a pull request goes into, for its description's diff. */
  baseBranch?: string;
}

/** `text` is the draft, or what stands in for one when no agent could write it. */
export interface GitDraftResult {
  text: string;
  drafted: boolean;
}

/**
 * How a git action ended. A failure an agent can fix goes to the agent by
 * itself: `sent-to-agent`, or `held` for the task's next one. `failed` is one
 * no agent can fix, with git's own line for the toast.
 */
export type GitActionResult =
  | { outcome: 'done'; pullRequest?: { number: number; url: string } }
  | { outcome: 'sent-to-agent' }
  | { outcome: 'held' }
  | { outcome: 'failed'; step: GitActionStep; message: string };

export type GitActionStep = 'commit' | 'push' | 'create-pull-request';
