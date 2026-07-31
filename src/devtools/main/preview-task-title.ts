/**
 * Dev-only: resolve the ORIGINAL task's label (`#<display_id> - <title>`) for a
 * `/preview` window so the title bar and the OS taskbar can identify which task
 * the (otherwise indistinguishable "Project 1" / "Project 2") preview clones
 * belong to. The number alone was not enough - it still meant scanning the board
 * to find out which task it was.
 *
 * The preview clones run a fresh seeded board DB, so the original task is NOT in
 * any database the preview process opens. We recover it from the REAL
 * (non-ephemeral) parent project DB, keyed off the worktree's folder name, and
 * getPlatformConfigDir() points at the real config dir even when
 * KANGENTIC_DATA_DIR redirects everything else to the ephemeral data dir.
 *
 * Two folder shapes exist and both must resolve. Current worktrees are named for
 * the task's `display_id` (`460`); worktrees created before that scheme keep
 * their `<slug>-<shortId>` name, where shortId = taskId.slice(0, 8). Nothing on
 * disk was ever renamed, so the legacy form is not going away.
 *
 * Best-effort: any miss (no DB, no matching project/task, locked file) returns
 * null and the header simply falls back to "Project N".
 *
 * Build-excluded from production: imported only behind __KANGENTIC_DEV__ guards
 * (src/main/index.ts), so esbuild dead-code elimination drops this module from
 * prod bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getPlatformConfigDir } from '../../main/config/paths';
import { toForwardSlash } from '../../shared/paths';

const WORKTREE_MARKER = '/.kangentic/worktrees/';

/** True when two paths resolve to the same directory (drive-case / separator safe). */
function samePath(first: string, second: string): boolean {
  try {
    return path.relative(path.resolve(first), path.resolve(second)) === '';
  } catch {
    return false;
  }
}

/**
 * Resolve the original task's label for a preview worktree path, or null if it
 * cannot be determined. Reads the real parent project DB read-only.
 *
 * The label is `#<display_id> - <title>` (falling back to the bare title when a
 * legacy row has no display_id). Both consumers - the title-bar pill and the OS
 * window/taskbar title - render this single string, so the two can never drift
 * and the taskbar thumbnail carries the same "#N" the board shows. The id comes
 * from the DB row, not the folder name, so a legacy `<slug>-<shortId>` worktree
 * gets its number too.
 */
export function resolvePreviewTaskLabel(worktreePath: string): string | null {
  try {
    if (!worktreePath) return null;
    const normalizedWorktree = toForwardSlash(path.resolve(worktreePath));
    const markerIndex = normalizedWorktree.indexOf(WORKTREE_MARKER);
    if (markerIndex === -1) return null;

    const parentRoot = normalizedWorktree.slice(0, markerIndex);
    const folderName = normalizedWorktree.slice(markerIndex + WORKTREE_MARKER.length).split('/')[0];
    // Numeric folder = the task's display_id. Legacy folder = `${slug}-${shortId}`.
    const displayId = /^\d+$/.test(folderName) ? Number.parseInt(folderName, 10) : null;
    const shortIdMatch = folderName.match(/-([0-9a-f]{8})$/);
    if (displayId === null && !shortIdMatch) return null;

    const configDir = getPlatformConfigDir();
    const projectId = findProjectId(path.join(configDir, 'index.db'), parentRoot);
    if (!projectId) return null;

    const task = findTask(
      path.join(configDir, 'projects', `${projectId}.db`),
      { displayId, shortId: shortIdMatch?.[1] ?? null },
      worktreePath,
    );
    if (!task) return null;
    // A legacy row can carry a NULL display_id, so degrade to the bare title
    // rather than rendering a meaningless "#null - " prefix. A DB old enough to
    // lack the column entirely does not reach here at all: the SELECT throws at
    // prepare and the outer catch returns null, so the caller shows "Project N".
    return typeof task.displayId === 'number'
      ? `#${task.displayId} - ${task.title}`
      : task.title;
  } catch {
    return null;
  }
}

/** Look up the parent project's id by its root path in the real global DB. */
function findProjectId(globalDbPath: string, parentRoot: string): string | null {
  if (!fs.existsSync(globalDbPath)) return null;
  const db = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT id, path FROM projects').all() as Array<{ id: string; path: string }>;
    const match = rows.find((row) => samePath(row.path, parentRoot));
    return match ? match.id : null;
  } finally {
    db.close();
  }
}

/** A resolved task, carrying the number the board shows alongside its title. */
interface PreviewTask {
  displayId: number | null;
  title: string;
}

/** Look up the task by display_id or UUID prefix (primary) or stored worktree path (fallback). */
function findTask(
  projectDbPath: string,
  folderKey: { displayId: number | null; shortId: string | null },
  worktreePath: string,
): PreviewTask | null {
  if (!fs.existsSync(projectDbPath)) return null;
  const db = new Database(projectDbPath, { readonly: true, fileMustExist: true });
  try {
    if (folderKey.displayId !== null) {
      const taskByDisplayId = db.prepare('SELECT display_id AS displayId, title FROM tasks WHERE display_id = ? LIMIT 1')
        .get(folderKey.displayId) as PreviewTask | undefined;
      if (taskByDisplayId?.title) return taskByDisplayId;
    }

    // shortId is 8 hex chars containing no LIKE metacharacters, so the trailing `%` is the
    // only wildcard and needs no escaping. A UUIDv4 prefix collision within one project is
    // astronomically unlikely; LIMIT 1 takes the first match.
    if (folderKey.shortId) {
      const taskByIdPrefix = db.prepare('SELECT display_id AS displayId, title FROM tasks WHERE id LIKE ? LIMIT 1')
        .get(`${folderKey.shortId}%`) as PreviewTask | undefined;
      if (taskByIdPrefix?.title) return taskByIdPrefix;
    }

    const rows = db
      .prepare('SELECT display_id AS displayId, title, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
      .all() as Array<PreviewTask & { worktree_path: string }>;
    const match = rows.find((row) => samePath(row.worktree_path, worktreePath));
    // Gate on `title` like the two branches above. Before the label change an
    // empty title fell through as a falsy '' and rendered no pill; composing it
    // now would produce a truthy "#34 - " with nothing after the dash.
    return match?.title ? { displayId: match.displayId, title: match.title } : null;
  } finally {
    db.close();
  }
}
