// Reclaims orphaned embedded-Browser cookie jars.
//
// Jars are keyed by task identity (`kng-<projectId>-<taskId>`) and a per-project
// identity jar (`kng-<projectId>-identity`), so a jar directory name PARSES back
// to the project and task it belongs to (src/shared/browser-partition.ts). That
// makes cleanup a name-parse plus an existence check, with no need to reverse an
// opaque hash by re-deriving every task's possible paths.
//
// A jar is orphaned iff its PROJECT is gone (checked against the global project
// list, no per-project DB) or its TASK is gone (a light read-only `SELECT id FROM
// tasks` against that project's DB, on a throwaway connection - never
// `getProjectDb`, which would migrate + load sqlite-vec + cache the connection).
// The abandoned pre-task-keying `kngbrowser-<hash>` jars are reclaimed once here
// too. The startup sweep is the sole reclaim path; there is no mid-run hook,
// because with task-keyed jars the right trigger is task DELETION (not worktree
// removal, where the jar must survive for a Done round-trip), and the startup
// sweep covers it reliably.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BROWSER_PARTITION,
  browserPartitionForProjectIdentity,
  isKngPartitionDirName,
  isLegacyWorktreeJarDirName,
  normalizePartitionId,
  parseKngPartitionDir,
} from '../../shared/browser-partition';
import { removeWithRetry } from '../git/rm-with-retry';
import { PATHS } from '../config/paths';
import { ProjectRepository } from '../db/repositories/project-repository';
import type { Project } from '../../shared/types';

/**
 * Grace period mirroring `ORPHAN_DIRECTORY_GRACE_PERIOD_MS` in resource-cleanup.
 * A jar directory is created the instant a pane attaches, which can precede the
 * task row being visible; skipping a freshly modified directory keeps the sweep
 * from ever racing a pane that just opened.
 */
const PARTITION_SWEEP_GRACE_PERIOD_MS = 10 * 60 * 1000;

/**
 * The partition strings the clear-storage IPC handler wipes for one project: the
 * legacy shared jar, the project's identity jar, and every task jar it owns on
 * disk (`kng-<thisProjectId>-*`). Derived by prefix match on the Partitions
 * directory - no DB needed. Sync, matching the handler's shape.
 */
export function enumerateProjectPartitions(projectId: string | null, userDataPath: string): string[] {
  const partitions = new Set<string>([BROWSER_PARTITION]);
  if (!projectId) return [...partitions];
  partitions.add(browserPartitionForProjectIdentity(projectId));

  const projectKey = normalizePartitionId(projectId);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(userDataPath, 'Partitions'), { withFileTypes: true });
  } catch {
    // No Partitions directory yet - just the legacy + identity jars.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseKngPartitionDir(entry.name);
    if (parsed && parsed.projectId === projectKey) partitions.add(`persist:${entry.name}`);
  }
  return [...partitions];
}

/**
 * Refuse to recursively delete anything that is not a browser jar directly under
 * the Partitions root. Modeled on `assertRemovableWorktreePath`: the sweep's
 * deletion target is COMPUTED, so a single string comparison guards against ever
 * pointing `fs.rm` at a filesystem root, a traversal, a grandchild, the legacy
 * shared jar, or a foreign Electron consumer's directory. A current-scheme
 * (`kng-`) or abandoned-scheme (`kngbrowser-`) jar name is required.
 */
export function assertRemovablePartitionPath(partitionsRoot: string, targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (path.parse(resolved).root === resolved) {
    throw new Error(`Refusing to remove a filesystem root as a partition: ${resolved}`);
  }
  const root = path.resolve(partitionsRoot);
  const relative = path.relative(root, resolved);
  const isDirectChild = relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep)
    && !relative.includes('/');
  if (!isDirectChild) {
    throw new Error(`Refusing to remove ${resolved}: it is not a direct child of ${root}.`);
  }
  const name = path.basename(resolved);
  if (!isKngPartitionDirName(name) && !isLegacyWorktreeJarDirName(name)) {
    throw new Error(`Refusing to remove ${resolved}: not a browser jar directory.`);
  }
}

/** The set of live task ids (normalized) for one project, or null to ABSTAIN
 *  (keep that project's task jars) when the DB cannot be read. Uses a THROWAWAY
 *  read-only connection: no migrations, no sqlite-vec, closed immediately. */
function readLiveTaskIds(projectDbPath: string): Set<string> | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(projectDbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT id FROM tasks').all() as { id: string }[];
    return new Set(rows.map((row) => normalizePartitionId(row.id)));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** What one sweep did, for logging and tests. */
export interface PartitionSweepSummary {
  removed: string[];
  abstained: boolean;
  skippedRecent: number;
}

/**
 * Remove every jar directory under `<userData>/Partitions` whose project or task
 * no longer exists, plus any jar from the abandoned pre-task-keying scheme. Runs
 * once at startup, before any pane materializes a session, so nothing is locked
 * and a plain retried `fs.rm` is safe. Best-effort per directory. ABSTAINS
 * entirely if the project list cannot be read, and per-project if a project's
 * tasks cannot be read (keeping that project's jars) - never over-deletes on a
 * transient fault.
 */
export async function sweepOrphanedBrowserPartitions(
  userDataPath: string,
): Promise<PartitionSweepSummary> {
  const partitionsRoot = path.join(userDataPath, 'Partitions');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(partitionsRoot, { withFileTypes: true });
  } catch {
    return { removed: [], abstained: false, skippedRecent: 0 };
  }

  let projects: Project[];
  try {
    projects = new ProjectRepository().list();
  } catch (error) {
    console.warn('[browser-partition] sweep abstaining: could not list projects:', error);
    return { removed: [], abstained: true, skippedRecent: 0 };
  }
  const projectsByKey = new Map<string, Project>();
  for (const project of projects) projectsByKey.set(normalizePartitionId(project.id), project);

  const taskIdCache = new Map<string, Set<string> | null>();
  const taskIdsFor = (projectKey: string): Set<string> | null => {
    if (taskIdCache.has(projectKey)) return taskIdCache.get(projectKey) ?? null;
    const project = projectsByKey.get(projectKey);
    // A project with a row but no DB file has no tasks yet: every task jar under
    // it is an orphan (an empty set), never an abstain.
    const ids = project && fs.existsSync(PATHS.projectDb(project.id))
      ? readLiveTaskIds(PATHS.projectDb(project.id))
      : new Set<string>();
    taskIdCache.set(projectKey, ids);
    return ids;
  };

  const shouldDelete = (name: string): boolean => {
    if (isLegacyWorktreeJarDirName(name)) return true; // abandoned scheme, one-time reclaim
    const parsed = parseKngPartitionDir(name);
    if (!parsed) return false; // legacy shared jar or a foreign consumer - never touch
    if (!projectsByKey.has(parsed.projectId)) return true; // project gone
    if (parsed.kind === 'identity') return false;
    const taskIds = taskIdsFor(parsed.projectId);
    if (taskIds === null) return false; // could not read this project's tasks: abstain
    return !taskIds.has(parsed.taskId);
  };

  const removed: string[] = [];
  let skippedRecent = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!shouldDelete(entry.name)) continue;

    const dirPath = path.join(partitionsRoot, entry.name);
    let modifiedAtMs: number;
    try {
      modifiedAtMs = (await fs.promises.stat(dirPath)).mtimeMs;
    } catch (error) {
      const statError = error as NodeJS.ErrnoException;
      console.warn(
        `[browser-partition] Skipping orphan jar (stat failed): ${entry.name} `
          + `(code=${statError.code ?? 'unknown'}): ${statError.message}`,
      );
      continue;
    }
    if (Date.now() - modifiedAtMs < PARTITION_SWEEP_GRACE_PERIOD_MS) {
      skippedRecent += 1;
      continue;
    }

    try {
      assertRemovablePartitionPath(partitionsRoot, dirPath);
      await removeWithRetry(dirPath);
      removed.push(entry.name);
    } catch (error) {
      const removeError = error as NodeJS.ErrnoException;
      console.warn(
        `[browser-partition] Could not remove orphan jar: ${entry.name} `
          + `(code=${removeError.code ?? 'unknown'}): ${removeError.message}`,
      );
    }
  }

  if (removed.length > 0) {
    console.log(`[browser-partition] Reclaimed ${removed.length} orphaned browser jar(s).`);
  }
  return { removed, abstained: false, skippedRecent };
}
