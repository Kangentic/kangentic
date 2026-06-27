/**
 * Dev-only: resolve the ORIGINAL task's title for a `/preview` window so the
 * title bar can identify which task the (otherwise indistinguishable
 * "Project 1" / "Project 2") preview clones belong to.
 *
 * The preview clones run a fresh seeded board DB, so the original task is NOT in
 * any database the preview process opens. We recover it from the REAL
 * (non-ephemeral) parent project DB: the worktree path encodes the task UUID
 * prefix (`<slug>-<shortId>`, where shortId = taskId.slice(0, 8)), and
 * getPlatformConfigDir() points at the real config dir even when
 * KANGENTIC_DATA_DIR redirects everything else to the ephemeral data dir.
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
 * Resolve the original task's title for a preview worktree path, or null if it
 * cannot be determined. Reads the real parent project DB read-only.
 */
export function resolvePreviewTaskTitle(worktreePath: string): string | null {
  try {
    if (!worktreePath) return null;
    const normalizedWorktree = toForwardSlash(path.resolve(worktreePath));
    const markerIndex = normalizedWorktree.indexOf(WORKTREE_MARKER);
    if (markerIndex === -1) return null;

    const parentRoot = normalizedWorktree.slice(0, markerIndex);
    const folderName = normalizedWorktree.slice(markerIndex + WORKTREE_MARKER.length).split('/')[0];
    // Worktree folders are `${slug}-${shortId}`, where shortId = taskId.slice(0, 8).
    const shortIdMatch = folderName.match(/-([0-9a-f]{8})$/);
    if (!shortIdMatch) return null;
    const shortId = shortIdMatch[1];

    const configDir = getPlatformConfigDir();
    const projectId = findProjectId(path.join(configDir, 'index.db'), parentRoot);
    if (!projectId) return null;

    return findTaskTitle(path.join(configDir, 'projects', `${projectId}.db`), shortId, worktreePath);
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

/** Look up the task title by UUID prefix (primary) or stored worktree path (fallback). */
function findTaskTitle(projectDbPath: string, shortId: string, worktreePath: string): string | null {
  if (!fs.existsSync(projectDbPath)) return null;
  const db = new Database(projectDbPath, { readonly: true, fileMustExist: true });
  try {
    // shortId is 8 hex chars containing no LIKE metacharacters, so the trailing `%` is the
    // only wildcard and needs no escaping. A UUIDv4 prefix collision within one project is
    // astronomically unlikely; LIMIT 1 takes the first match.
    const taskByIdPrefix = db.prepare('SELECT title FROM tasks WHERE id LIKE ? LIMIT 1').get(`${shortId}%`) as
      | { title: string }
      | undefined;
    if (taskByIdPrefix?.title) return taskByIdPrefix.title;

    const rows = db
      .prepare('SELECT title, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
      .all() as Array<{ title: string; worktree_path: string }>;
    const match = rows.find((row) => samePath(row.worktree_path, worktreePath));
    return match ? match.title : null;
  } finally {
    db.close();
  }
}
