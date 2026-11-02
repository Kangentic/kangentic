/**
 * Dev-only: resolve the ORIGINAL task's label (`#<display_id> - <title>`) for a
 * `/preview` window so the title bar and the OS taskbar can identify which task
 * the (otherwise indistinguishable "Project 1" / "Project 2") preview clones
 * belong to. The number alone was not enough - it still meant scanning the board
 * to find out which task it was.
 *
 * The preview clones run a fresh seeded board DB, so the original task is NOT in
 * any database the preview process opens. We recover it from the REAL
 * (non-ephemeral) parent project DB, and getPlatformConfigDir() points at the
 * real config dir even when KANGENTIC_DATA_DIR redirects everything else to the
 * ephemeral data dir.
 *
 * The lookup itself is product code (`src/main/worktree-task-lookup.ts`), shared
 * with the production window title: it reads the task by the row that records
 * the worktree's path, then by a numeric folder's display number, then by a
 * legacy `<slug>-<shortId>` folder's id prefix. The number always comes from
 * the row, so a worktree a task adopted as a spare (`spare_<8 hex>`) gets its
 * number too.
 *
 * Best-effort: any miss (no DB, no matching project/task, locked file) returns
 * null and the header simply falls back to "Project N".
 *
 * Build-excluded from production: imported only behind __KANGENTIC_DEV__ guards
 * (src/main/index.ts), so esbuild dead-code elimination drops this module from
 * prod bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import { getPlatformConfigDir } from '../../main/config/paths';
import { findTaskByWorktreePath } from '../../main/worktree-task-lookup';

/**
 * Resolve the original task's label for a preview worktree path, or null if it
 * cannot be determined. Reads the real parent project DB read-only.
 *
 * The label is `#<display_id> - <title>` (falling back to the bare title when a
 * legacy row has no display_id). Both consumers - the title-bar pill and the OS
 * window/taskbar title - render this single string, so the two can never drift
 * and the taskbar thumbnail carries the same "#N" the board shows.
 */
export function resolvePreviewTaskLabel(worktreePath: string): string | null {
  const task = findTaskByWorktreePath(getPlatformConfigDir(), worktreePath);
  if (!task) return null;
  // A legacy row can carry a NULL display_id, so degrade to the bare title
  // rather than rendering a meaningless "#null - " prefix.
  return typeof task.displayId === 'number'
    ? `#${task.displayId} - ${task.title}`
    : task.title;
}
