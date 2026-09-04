/**
 * PR URL parsing shared by the renderer and the main process.
 *
 * Lives in `src/shared/` rather than inside a PR connector because both sides
 * need it and the renderer cannot import `src/main/pr/pr-registry` - that would
 * drag `p-queue`, `which`, and `node:child_process` into the renderer bundle.
 * Routing a pure regex through IPC would mean a whole 7-layer endpoint
 * (.claude/rules/ipc-7-layer-parity.md) for a string operation.
 */

/**
 * The pull-request number a hosting-provider PR URL names, or null when it
 * carries none.
 *
 * Covers GitHub / GitLab (`/pull/<n>`) and Azure DevOps, whose PR URLs are
 * `/_git/<repo>/pullrequest/<n>`. Keeping both shapes here is what lets a
 * pasted Azure PR URL land a `pr_number`; without it the linker's Tier 1 could
 * never anchor that link and `pr_url` / `pr_number` would disagree.
 *
 * Deliberately does NOT match `git push`'s `/pull/new/<branch>` output, which
 * names no PR: the digits must follow the segment immediately.
 */
export function prNumberFromUrl(prUrl: string): number | null {
  const match = prUrl.match(/\/pull(?:request)?\/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}
