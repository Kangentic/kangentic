import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isSamePath } from '../../shared/paths';
import { safeWriteJson } from '../safe-write';
import { isSpareWorktreeFolder } from '../git/spare-worktree';
import { worktreeFoldersOf } from '../ipc/helpers/spare-worktrees';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { TaskRepository } from '../db/repositories/task-repository';

/**
 * Whether this instance owns a project's folder.
 *
 * A project's folders live under `<project>/.kangentic/`, and its rows live in a
 * per-project database in the instance's data directory. Nothing tied the two
 * together, so the cold-open sweep read "not in this database" as "orphaned".
 * On 2026-11-05 a second instance, started with a copy of `index.db` and empty
 * per-project databases, deleted real worktrees and attachments on every
 * registered project that way.
 *
 * The proof is a token held in the per-project database and mirrored in
 * `.kangentic/project-owner.json`. It cannot be the project id: a copied
 * `index.db` carries the real ids at the real paths, so an id in the marker
 * would match. What was new in that instance was the per-project database, so
 * that is what has to prove itself. The marker also names the database that
 * wrote it, because a full copy of the data directory carries the token too.
 *
 * Only `verifyProjectOwnership` makes a `VerifiedOwnership`, and every pass that
 * removes folders takes one, so `tsc` fails a new caller that skips the check.
 */

const PROJECT_OWNER_FILE = 'project-owner.json';

/** The `schema_meta` key holding this database's owner token. */
const OWNER_TOKEN_KEY = 'folder_owner_token';

/** The folders under `.kangentic/` a sweep reads, and so the ones a claim is judged on. */
const SWEPT_FOLDERS = ['tasks', 'sessions', 'worktrees'] as const;

export interface ProjectOwnerMarker {
  token: string;
  /** Absolute path of the per-project database that wrote this marker. */
  database: string;
  /** The folder this marker was written for. A copied folder carries a stale one. */
  projectPath: string;
}

declare const ownershipProof: unique symbol;

/**
 * Proof that this instance owns `projectPath`. Passes that remove folders derive
 * the path from it, so a proof for one project cannot sweep another.
 */
export interface VerifiedOwnership {
  readonly projectPath: string;
  readonly [ownershipProof]: true;
}

export type ProjectStanding =
  | { kind: 'owned'; ownership: VerifiedOwnership }
  /** Another live database owns this folder. It starts and sweeps nothing here. */
  | { kind: 'foreign'; ownerDatabase: string }
  /** No evidence either way, so nothing is swept, and a board's own rows still recover. */
  | { kind: 'unclaimed' };

export interface OwnershipFacts {
  marker: ProjectOwnerMarker | null;
  projectPath: string;
  databasePath: string;
  databaseToken: string | null;
  /** Whether the database the marker names is still on disk. */
  markerDatabaseExists: boolean;
  hasTasks: boolean;
  /** A task id, session id or worktree folder in this database names an entry on disk. */
  sharesFolderEntry: boolean;
  /** Nothing in the swept folders, so a claim puts nothing at risk. */
  folderEmpty: boolean;
}

export type OwnershipDecision = 'owned' | 'foreign' | 'claim' | 'unclaimed';

/**
 * The decision, with no I/O. A claim needs evidence, and an empty database has
 * none. That is the incident's shape, so it never claims, whatever the folder
 * holds and whether or not a marker is there.
 *
 * A marker for another folder is a copy of that folder's, and a marker whose
 * database is gone has no owner left to protect. Both fall through to evidence.
 */
export function decideOwnership(facts: OwnershipFacts): OwnershipDecision {
  const { marker } = facts;
  if (marker) {
    const namesThisDatabase = isSamePath(marker.database, facts.databasePath);
    if (namesThisDatabase && marker.token === facts.databaseToken) return 'owned';
    if (!namesThisDatabase && facts.markerDatabaseExists && isSamePath(marker.projectPath, facts.projectPath)) {
      return 'foreign';
    }
  }
  if (!facts.hasTasks) return 'unclaimed';
  return facts.sharesFolderEntry || facts.folderEmpty ? 'claim' : 'unclaimed';
}

function markerPathFor(projectPath: string): string {
  return path.join(projectPath, '.kangentic', PROJECT_OWNER_FILE);
}

function isOwnerMarker(value: unknown): value is ProjectOwnerMarker {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.token === 'string'
    && typeof candidate.database === 'string'
    && typeof candidate.projectPath === 'string';
}

/** The marker, or null when it is missing or does not parse. */
async function readOwnerMarker(projectPath: string): Promise<ProjectOwnerMarker | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(markerPathFor(projectPath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isOwnerMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readDatabaseToken(database: Database.Database): string | null {
  const row = database.prepare('SELECT value FROM schema_meta WHERE key = ?').get(OWNER_TOKEN_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** The directory names in a folder. A missing folder is an empty one; any other failure throws. */
async function listDirectoryNames(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

interface FolderEvidence {
  hasTasks: boolean;
  sharesFolderEntry: boolean;
  folderEmpty: boolean;
}

async function readFolderEvidence(
  projectPath: string,
  tasks: Pick<TaskRepository, 'list' | 'listArchived'>,
  sessions: Pick<SessionRepository, 'listAllSessionIds'>,
): Promise<FolderEvidence> {
  const kangenticPath = path.join(projectPath, '.kangentic');
  const allTasks = [...tasks.list(), ...tasks.listArchived()];
  const known: Record<(typeof SWEPT_FOLDERS)[number], Set<string>> = {
    tasks: new Set(allTasks.map((task) => task.id)),
    sessions: new Set([...sessions.listAllSessionIds(), ...allTasks.map((task) => task.id)]),
    worktrees: worktreeFoldersOf(allTasks),
  };
  let sharesFolderEntry = false;
  let folderEmpty = true;
  for (const folder of SWEPT_FOLDERS) {
    // A spare is no task's until one adopts it, so it is neither evidence nor at risk here.
    const names = (await listDirectoryNames(path.join(kangenticPath, folder)))
      .filter((name) => folder !== 'worktrees' || !isSpareWorktreeFolder(name));
    if (names.length > 0) folderEmpty = false;
    if (names.some((name) => known[folder].has(name))) sharesFolderEntry = true;
  }
  return { hasTasks: allTasks.length > 0, sharesFolderEntry, folderEmpty };
}

/** The path with its links resolved, or as given when it is not on disk. */
async function resolvedPath(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return target;
  }
}

function grantOwnership(projectPath: string): VerifiedOwnership {
  return { projectPath } as VerifiedOwnership;
}

/**
 * Write the claim: the database first, so a quit between the two writes leaves a
 * token the next open reuses. A marker that cannot be written is no ownership,
 * which is the safe direction: this open sweeps nothing.
 */
function writeClaim(
  projectPath: string,
  databasePath: string,
  database: Database.Database,
  databaseToken: string | null,
): boolean {
  const token = databaseToken ?? randomUUID();
  if (databaseToken === null) {
    database.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(OWNER_TOKEN_KEY, token);
  }
  const marker: ProjectOwnerMarker = { token, database: databasePath, projectPath };
  return safeWriteJson(markerPathFor(projectPath), marker, 'project_owner');
}

/**
 * Establish this instance's standing on a project's folder. Called once per cold
 * open, before anything sweeps. Never rejects: a check that fails is `unclaimed`,
 * so a project that cannot be read is simply not swept this open.
 *
 * Only a claim or a moved folder writes, and only an owner writes at all.
 */
export async function verifyProjectOwnership(
  projectPath: string,
  databasePath: string,
  database: Database.Database,
  tasks: Pick<TaskRepository, 'list' | 'listArchived'>,
  sessions: Pick<SessionRepository, 'listAllSessionIds'>,
): Promise<ProjectStanding> {
  try {
    const marker = await readOwnerMarker(projectPath);
    // Links resolved, so one folder or database reached through a junction or a
    // symlink never reads as a second one: a copied database opening the owner's
    // folder through a link would otherwise claim it.
    const resolvedProjectPath = await resolvedPath(projectPath);
    const resolvedMarker = marker && {
      ...marker,
      database: await resolvedPath(marker.database),
      projectPath: await resolvedPath(marker.projectPath),
    };
    const databaseToken = readDatabaseToken(database);
    const decision = decideOwnership({
      marker: resolvedMarker,
      projectPath: resolvedProjectPath,
      databasePath: await resolvedPath(databasePath),
      databaseToken,
      markerDatabaseExists: marker !== null && fs.existsSync(marker.database),
      ...await readFolderEvidence(projectPath, tasks, sessions),
    });
    switch (decision) {
      case 'owned':
        // The marker moved with the folder (a relocate). Stale text costs nothing,
        // so a failed refresh does not undo what the token proved.
        if (marker && resolvedMarker && !isSamePath(resolvedMarker.projectPath, resolvedProjectPath)) {
          safeWriteJson(markerPathFor(projectPath), { ...marker, projectPath }, 'project_owner');
        }
        return { kind: 'owned', ownership: grantOwnership(projectPath) };
      case 'claim':
        return writeClaim(projectPath, databasePath, database, databaseToken)
          ? { kind: 'owned', ownership: grantOwnership(projectPath) }
          : { kind: 'unclaimed' };
      case 'foreign':
        return { kind: 'foreign', ownerDatabase: marker?.database ?? '' };
      case 'unclaimed':
        return { kind: 'unclaimed' };
    }
  } catch (error) {
    console.warn(`[PROJECT_OWNER] Could not verify ownership of ${projectPath}, so nothing is swept this open:`, error);
    return { kind: 'unclaimed' };
  }
}
