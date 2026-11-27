/**
 * Check whether the project path IS a Kangentic-managed worktree checkout.
 *
 * A preview project's path looks like `<parent>/.kangentic/worktrees/<slug>`.
 * We check that the immediate parent dir is `worktrees` and its parent is
 * `.kangentic`. This avoids false positives when the app itself runs from
 * inside a worktree (e.g. the CWD contains `.kangentic/worktrees/` early
 * in the path, but the project isn't itself a preview worktree).
 *
 * Its own module, with no imports, so `git-client` can read it without
 * loading `git-checks`, which many tests replace with a partial mock.
 * `git-checks` re-exports it for every other caller.
 */
export function isKangenticWorktree(projectPath: string): boolean {
  // Normalize all separators to forward slashes so the check works on any OS
  const normalized = projectPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 3) return false;
  const parentSegment = segments[segments.length - 2];
  const grandparentSegment = segments[segments.length - 3];
  return parentSegment === 'worktrees' && grandparentSegment === '.kangentic';
}
