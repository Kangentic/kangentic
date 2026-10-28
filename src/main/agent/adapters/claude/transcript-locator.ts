import fs from 'node:fs';
import path from 'node:path';
import { locateClaudeTranscriptFile } from './transcript-parser';
import { touchBounded } from '../../shared/bounded-lru';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Where a Claude conversation's transcript is, wherever Claude wrote it.
 *
 * Claude files a conversation under the slug of the folder it STARTED in,
 * `~/.claude/projects/<slug>/<id>.jsonl`, and a `--resume` from another folder
 * keeps appending to that file. Measured on Claude Code 2.1.312: four task
 * agents started in the project root (the #924 race) were resumed with their
 * worktree as cwd, and every later turn landed in the root-slug files. A path
 * built from the session's current cwd then names a file that does not exist,
 * and every read (the turn end's reply, the submit check, the viewer, the
 * index) found nothing.
 *
 * So every Claude read resolves its path here, in this order:
 *
 *  1. The path Claude reported (status.json's `transcript_path`, kept on the
 *     session row), when it names this conversation's file under a projects
 *     folder and the file is there. A project relocation leaves a stored path
 *     stale, so it is checked.
 *  2. The path derived from the cwd. A fresh session's file appears here.
 *  3. Where an earlier search found it, checked again.
 *  4. The cwd's parent folders: a conversation started in the project root and
 *     resumed in `<root>/.kangentic/worktrees/<n>` is found in three stats.
 *  5. Every folder under the projects folder, from one listing of their
 *     transcripts that answers every search for 30 s. Session ids are UUIDs,
 *     so a hit is the conversation. A miss covers steps 4 and 5 for 30 s.
 *
 * The cache is per process (main and the retrieval worker each keep one).
 */

/** Project folders listed or statted at once. */
export const PROJECT_SCAN_BATCH = 32;

/** How long a conversation the full scan did not find is not searched for again. */
const MISS_RETRY_MS = 30_000;

/** How long one listing of every project folder's transcripts answers the scans after it. */
const PROJECTS_LISTING_TTL_MS = 30_000;

const LOCATOR_CACHE_LIMIT = 512;
const LOCATOR_CACHE_BYTE_BUDGET = 64 * 1024;

export interface ClaudeTranscriptQuery {
  agentSessionId: string;
  /** The folder the session runs in now (Windows path for a WSL session). */
  cwd: string;
  /** Where the CLI ran when it was not this machine (a WSL distro). */
  place?: CliPlace | null;
  /** A transcript path Claude reported for this conversation. May be stale or null. */
  reportedPath?: string | null;
}

type LocatorEntry =
  | { kind: 'found'; filePath: string }
  | { kind: 'missing'; retryAt: number };

/** Every transcript under one projects folder, by file name: one name can sit in several folders. */
type ProjectTranscripts = Map<string, string[]>;

const locatedTranscripts = new Map<string, LocatorEntry>();
const searchesInFlight = new Map<string, Promise<string | null>>();
// One entry per projects folder (this machine's, and one per WSL distro), each
// dropped when it expires.
const projectListings = new Map<string, { expiresAt: number; transcripts: Promise<ProjectTranscripts | null> }>();

/** Reset between tests so one test's found path cannot answer another's. */
export function clearClaudeTranscriptLocatorCacheForTests(): void {
  locatedTranscripts.clear();
  searchesInFlight.clear();
  projectListings.clear();
}

/** The conversation's transcript, or null when it is nowhere Claude could have put it. */
export async function findClaudeTranscriptFile(query: ClaudeTranscriptQuery): Promise<string | null> {
  const { reported, derived, key } = startingPoints(query);
  if (reported && await isPresent(reported)) return reported;
  if (await isPresent(derived)) return derived;

  const cached = locatedTranscripts.get(key);
  if (cached?.kind === 'found') {
    if (await isPresent(cached.filePath)) return cached.filePath;
    forgetFound(key, derived);
  }

  const pending = searchesInFlight.get(key);
  if (pending) return pending;
  const search = searchElsewhere(query, derived, key).finally(() => searchesInFlight.delete(key));
  searchesInFlight.set(key, search);
  return search;
}

/**
 * The conversation's transcript, or the cwd-derived path when it is found
 * nowhere: a fresh session's file appears there, and every reader already
 * treats a missing file as an empty transcript.
 */
export async function resolveClaudeTranscriptFile(query: ClaudeTranscriptQuery): Promise<string> {
  const found = await findClaudeTranscriptFile(query);
  return found ?? locateClaudeTranscriptFile(query.agentSessionId, query.cwd, query.place ?? null);
}

/**
 * The synchronous form, for the readers on main that poll every 2 s. It checks
 * the reported path, the cwd path and an earlier find, and never searches: on a
 * miss it starts the async find, so the next poll has the answer. A search
 * already running, or a miss still remembered, starts nothing.
 */
export function peekClaudeTranscriptFile(query: ClaudeTranscriptQuery): string {
  const { reported, derived, key } = startingPoints(query);
  if (reported && isPresentSync(reported)) return reported;
  if (isPresentSync(derived)) return derived;

  const cached = locatedTranscripts.get(key);
  if (cached?.kind === 'found') {
    if (isPresentSync(cached.filePath)) return cached.filePath;
    forgetFound(key, derived);
  }
  if (!isMissRemembered(locatedTranscripts.get(key)) && !searchesInFlight.has(key)) {
    void findClaudeTranscriptFile(query).catch(() => undefined);
  }
  return derived;
}

/**
 * The conversation's transcript where Claude's own `--resume` from `cwd` reads
 * it: the cwd's file, or a parent folder's. Measured on 2.1.312 from a worktree
 * of the folder a conversation started in. A file under any other folder is
 * not counted, because whether Claude resumes from there is unmeasured.
 */
export async function findClaudeResumeTranscriptFile(query: ClaudeTranscriptQuery): Promise<string | null> {
  const derived = locateClaudeTranscriptFile(query.agentSessionId, query.cwd, query.place ?? null);
  if (await isPresent(derived)) return derived;
  return firstAncestorHit(query);
}

/**
 * Every folder under a projects folder that could hold a transcript:
 * directories, and links that may lead to one. Null when the projects folder
 * is not a directory this process can read.
 */
export async function listClaudeProjectFolders(projectsRoot: string): Promise<string[] | null> {
  let entries: fs.Dirent[];
  try {
    const rootStat = await fs.promises.stat(projectsRoot);
    if (!rootStat.isDirectory()) return null;
    entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const folders: string[] = [];
  for (const entry of entries) {
    const folderPath = path.join(projectsRoot, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await mayBeFolder(folderPath))) {
      folders.push(folderPath);
    }
  }
  return folders;
}

/** The paths a query names before any search, and the key a search for it is remembered by. */
function startingPoints(query: ClaudeTranscriptQuery): { reported: string | null; derived: string; key: string } {
  const place = query.place ?? null;
  const derived = locateClaudeTranscriptFile(query.agentSessionId, query.cwd, place);
  return {
    reported: reportedCandidate(query.reportedPath, query.agentSessionId, place),
    derived,
    key: cacheKey(derived, query.agentSessionId),
  };
}

async function searchElsewhere(query: ClaudeTranscriptQuery, derived: string, key: string): Promise<string | null> {
  // A miss came from a scan of every project folder, the parents' included, so
  // until it expires only the reported and cwd paths, which every find checks
  // first, can turn the conversation up.
  if (isMissRemembered(locatedTranscripts.get(key))) return null;

  const fromAncestor = await firstAncestorHit(query);
  if (fromAncestor) {
    remember(key, { kind: 'found', filePath: fromAncestor });
    return fromAncestor;
  }

  const fromScan = await scanProjectFolders(projectsRootOf(derived), path.basename(derived));
  remember(key, fromScan
    ? { kind: 'found', filePath: fromScan }
    : { kind: 'missing', retryAt: Date.now() + MISS_RETRY_MS });
  return fromScan;
}

/** The nearest parent folder of the cwd whose slug holds the conversation. */
async function firstAncestorHit(query: ClaudeTranscriptQuery): Promise<string | null> {
  const place = query.place ?? null;
  const candidates: string[] = [];
  let current = query.cwd;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) break;
    candidates.push(locateClaudeTranscriptFile(query.agentSessionId, parent, place));
    current = parent;
  }
  const modified = await Promise.all(candidates.map(modifiedAt));
  const index = modified.findIndex((modifiedMs) => modifiedMs !== null);
  return index === -1 ? null : candidates[index];
}

/** The newest `<folder>/<fileName>` in any folder under the projects folder. */
async function scanProjectFolders(projectsRoot: string, fileName: string): Promise<string | null> {
  const candidates = (await projectTranscripts(projectsRoot))?.get(fileName);
  if (!candidates) return null;
  const modified = await Promise.all(candidates.map(modifiedAt));
  let newestPath: string | null = null;
  let newestMs = -Infinity;
  for (let index = 0; index < candidates.length; index++) {
    const modifiedMs = modified[index];
    if (modifiedMs !== null && modifiedMs > newestMs) {
      newestPath = candidates[index];
      newestMs = modifiedMs;
    }
  }
  return newestPath;
}

/**
 * Every transcript under the projects folder, from a listing that answers for
 * 30 s. A sweep of the index or the archive asks for every conversation of a
 * project, most of them long deleted, and one listing answers them all where a
 * stat in every folder per conversation cost a full scan each.
 */
function projectTranscripts(projectsRoot: string): Promise<ProjectTranscripts | null> {
  const listed = projectListings.get(projectsRoot);
  if (listed && listed.expiresAt > Date.now()) return listed.transcripts;
  const listing = { expiresAt: Date.now() + PROJECTS_LISTING_TTL_MS, transcripts: listProjectTranscripts(projectsRoot).catch(() => null) };
  projectListings.set(projectsRoot, listing);
  // Frees the listing's memory once nothing asks for it; the expiry above decides.
  setTimeout(() => {
    if (projectListings.get(projectsRoot) === listing) projectListings.delete(projectsRoot);
  }, PROJECTS_LISTING_TTL_MS).unref?.();
  return listing.transcripts;
}

async function listProjectTranscripts(projectsRoot: string): Promise<ProjectTranscripts | null> {
  const folders = await listClaudeProjectFolders(projectsRoot);
  if (!folders) return null;
  const transcripts: ProjectTranscripts = new Map();
  for (let start = 0; start < folders.length; start += PROJECT_SCAN_BATCH) {
    const batch = folders.slice(start, start + PROJECT_SCAN_BATCH);
    const listings = await Promise.all(batch.map((folder) => fs.promises.readdir(folder).catch((): string[] => [])));
    listings.forEach((fileNames, index) => {
      for (const fileName of fileNames) {
        if (!fileName.endsWith('.jsonl')) continue;
        const filePath = path.join(batch[index], fileName);
        const known = transcripts.get(fileName);
        if (known) known.push(filePath);
        else transcripts.set(fileName, [filePath]);
      }
    });
  }
  return transcripts;
}

/**
 * A reported path is used only when it is absolute and names this
 * conversation's file in a projects folder: a path from before a `/clear` fork
 * names the other id, a relative one would resolve against Kangentic's own
 * folder, and a file outside `<config>/projects/<slug>/` is not a transcript
 * Claude wrote. A WSL Claude reports a Linux path, read here through the
 * distro's share.
 */
function reportedCandidate(reportedPath: string | null | undefined, agentSessionId: string, place: CliPlace | null): string | null {
  if (!reportedPath) return null;
  const hostPath = hostPathForTarget(reportedPath, place);
  if (!path.isAbsolute(hostPath) || path.basename(hostPath) !== `${agentSessionId}.jsonl`) return null;
  if (path.basename(projectsRootOf(hostPath)) !== 'projects') return null;
  return hostPath;
}

/** `<config>/projects` for a `<config>/projects/<slug>/<id>.jsonl` path. */
function projectsRootOf(transcriptPath: string): string {
  return path.dirname(path.dirname(transcriptPath));
}

function cacheKey(derivedPath: string, agentSessionId: string): string {
  return `${projectsRootOf(derivedPath)}\u0000${agentSessionId}`;
}

function isMissRemembered(entry: LocatorEntry | undefined): boolean {
  return entry?.kind === 'missing' && entry.retryAt > Date.now();
}

/**
 * A found file that is gone was moved or deleted, so the listing that may
 * have found it is stale too: the next scan lists the folders again.
 */
function forgetFound(key: string, derived: string): void {
  locatedTranscripts.delete(key);
  projectListings.delete(projectsRootOf(derived));
}

function remember(key: string, entry: LocatorEntry): void {
  touchBounded(locatedTranscripts, key, entry, {
    limit: LOCATOR_CACHE_LIMIT,
    byteBudget: LOCATOR_CACHE_BYTE_BUDGET,
    sizeOf: (held) => (held.kind === 'found' ? held.filePath.length : 0),
    minRetained: 0,
  });
}

/**
 * Present unless the stat proves it absent. A locked or unreadable file is
 * still there, and reading it reports its own error.
 */
async function isPresent(filePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch (error) {
    return !isAbsence(error);
  }
}

function isPresentSync(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    return !isAbsence(error);
  }
}

function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A guess (a parent's slug, a scanned folder) counts only when its stat succeeds. */
async function modifiedAt(filePath: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * False only for a link whose target is a file, which can hold no transcript.
 * A link to a folder, a dangling link and an unreadable one stay in the scan:
 * a stat inside them answers for itself.
 */
async function mayBeFolder(linkPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(linkPath)).isDirectory();
  } catch {
    return true;
  }
}
