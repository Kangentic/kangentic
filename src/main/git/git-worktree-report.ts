/**
 * The git and worktree failures that are caught where they happen and would
 * otherwise only be logged.
 *
 * A worktree that fails to be CREATED is thrown to its caller, which reports it
 * (`reportPreflightFailure`, the IPC wrap). A worktree that fails to be REMOVED
 * reports through `worktreeRemovalReporter` (`worktree-manager.ts`). What is left
 * is the work around them that a caller never sees fail: writing a worktree's
 * base branch, renaming its branch, linking shared folders into it, the
 * background deleter of removed worktrees, a spare worktree's upkeep, the
 * process walk behind a removal's reap, a listener of worktree events, the line
 * count of an untracked file. Each leaves a worktree that works worse and says
 * nothing: a merge-back onto the wrong base, a build with no `node_modules`, a
 * disk that fills, a Changes panel that lists a file as empty.
 *
 * Every site names its step in `stage`, a fixed word. A failed git command
 * carries what git refused on as `git_cause`, and a failed child process its
 * `exit_code`, `exit_signal` and `timed_out`, all added by the shared send
 * (`handled-report.ts`). No path, branch name or folder name rides a tag: a
 * worktree's folder and branch are named after its task's title.
 *
 * A leaf module, so any file under `src/main/git` can import it with no cycle.
 * Worker entries (`line-count-worker.ts`, `worktree-copy-worker.ts`) never
 * import it: a worker cannot report, and main reports what a worker returned.
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const gitWorktreeReporter: ChokepointReporter = createChokepointReporter('git_worktree');
