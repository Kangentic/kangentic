import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isSamePath, toForwardSlash } from '../shared/paths';

/**
 * Find the task a worktree belongs to, read-only, from the task rows in a
 * config dir's databases: the global `index.db` names the project by its root,
 * and the project's own database holds the task.
 *
 * The number comes from the task's row, never from the folder's name. A
 * worktree folder is the task's display number (`460`), a legacy `<slug>-<id8>`
 * name, or the spare worktree a task adopted (`spare_<8 hex>`), and only the row
 * knows the number for all three. Lookup order: the row whose `worktree_path`
 * is this path, then a numeric folder's `display_id`, then a legacy folder's id
 * prefix.
 *
 * Used by the window title (`computeWindowTitle`) and, in a dev build, the
 * `/preview` title (`src/devtools/main/preview-task-title.ts`). Best-effort:
 * any miss (no database, no project or task, a locked file) returns null.
 */

const WORKTREE_MARKER = '/.kangentic/worktrees/';

/** A worktree's task: the number the board shows and its title. */
export interface WorktreeTask {
  displayId: number | null;
  title: string;
}

/**
 * The task whose worktree `worktreePath` is (or is inside), read from the
 * databases under `configDir`, or null.
 */
export function findTaskByWorktreePath(configDir: string, worktreePath: string): WorktreeTask | null {
  try {
    if (!worktreePath) return null;
    const normalizedWorktree = toForwardSlash(path.resolve(worktreePath));
    const markerIndex = normalizedWorktree.indexOf(WORKTREE_MARKER);
    if (markerIndex === -1) return null;

    const parentRoot = normalizedWorktree.slice(0, markerIndex);
    const folderName = normalizedWorktree.slice(markerIndex + WORKTREE_MARKER.length).split('/')[0];
    if (!folderName) return null;
    const worktreeRoot = `${parentRoot}${WORKTREE_MARKER}${folderName}`;

    const projectId = findProjectId(path.join(configDir, 'index.db'), parentRoot);
    if (!projectId) return null;

    return findTask(path.join(configDir, 'projects', `${projectId}.db`), folderName, worktreeRoot);
  } catch {
    return null;
  }
}

/** Look up the parent project's id by its root path in the global DB. */
function findProjectId(globalDbPath: string, parentRoot: string): string | null {
  if (!fs.existsSync(globalDbPath)) return null;
  const db = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT id, path FROM projects').all() as Array<{ id: string; path: string }>;
    const match = rows.find((row) => isSamePath(row.path, parentRoot));
    return match ? match.id : null;
  } finally {
    db.close();
  }
}

function findTask(projectDbPath: string, folderName: string, worktreeRoot: string): WorktreeTask | null {
  if (!fs.existsSync(projectDbPath)) return null;
  const db = new Database(projectDbPath, { readonly: true, fileMustExist: true });
  try {
    // The row that records this worktree, whatever its folder is called. Gated
    // on `title` like the two lookups below, so an empty title never composes a
    // label with nothing after the number.
    const rows = db
      .prepare('SELECT display_id AS displayId, title, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
      .all() as Array<WorktreeTask & { worktree_path: string }>;
    const byPath = rows.find((row) => isSamePath(row.worktree_path, worktreeRoot));
    if (byPath?.title) return { displayId: byPath.displayId, title: byPath.title };

    // A task whose row no longer records the path (it went through Done): its
    // numeric folder is its display number.
    if (/^\d+$/.test(folderName)) {
      const byDisplayId = db.prepare('SELECT display_id AS displayId, title FROM tasks WHERE display_id = ? LIMIT 1')
        .get(Number.parseInt(folderName, 10)) as WorktreeTask | undefined;
      if (byDisplayId?.title) return byDisplayId;
    }

    // A legacy `<slug>-<shortId>` folder, shortId = taskId.slice(0, 8). 8 hex
    // characters hold no LIKE metacharacters, so the trailing `%` is the only
    // wildcard. A UUIDv4 prefix collision within one project is astronomically
    // unlikely; LIMIT 1 takes the first match.
    const shortIdMatch = folderName.match(/-([0-9a-f]{8})$/);
    if (shortIdMatch) {
      const byIdPrefix = db.prepare('SELECT display_id AS displayId, title FROM tasks WHERE id LIKE ? LIMIT 1')
        .get(`${shortIdMatch[1]}%`) as WorktreeTask | undefined;
      if (byIdPrefix?.title) return byIdPrefix;
    }
    return null;
  } finally {
    db.close();
  }
}
