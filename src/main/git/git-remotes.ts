import { simpleGit } from 'simple-git';
import path from 'node:path';
import { viaGitRead } from './git-read-queue';

/**
 * Read a repository's git remote fetch URLs.
 *
 * The PR registry uses this to decide which connector OWNS a repository before
 * dispatching to it, so that a connector which does not own the remote can
 * never pre-empt one that does, and so that "no PR here" is only ever reported
 * by a connector that actually could have found one.
 *
 * Deliberately generic (no PR knowledge) and cached, because the linker's
 * confidence ladder dispatches up to four times per task and the background
 * sweep runs the ladder for every eligible task in a project.
 */

/**
 * Long enough that a whole project sweep re-uses one read (a sweep runs in
 * seconds, and each task's ladder dispatches up to four times), short enough
 * that `git remote set-url` self-heals within a minute. There is deliberately
 * no lifecycle invalidation wired for that case: a one-minute wait is cheaper
 * than a hook that would have to know every path a remote can change behind.
 */
const HIT_TTL_MS = 60_000;
/**
 * A miss is cached far more briefly: the common cause is a worktree that has
 * not been created yet, and that self-heals within seconds.
 */
const MISS_TTL_MS = 10_000;
/** Worktree paths churn, so the map is bounded rather than unbounded-by-repo. */
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  urls: readonly string[] | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<readonly string[] | null>>();

/**
 * `origin<TAB>url (fetch)` - the push twin of each pair is dropped.
 *
 * The type is CAPTURED and filtered on rather than written into the pattern,
 * because that lets the URL group be `.+?` instead of `\S+`, and the URL half
 * genuinely can contain spaces: a local-filesystem remote under a path like
 * `My Repos`, or any folder Windows syncs as `OneDrive - <Company>`, is one URL
 * with whitespace in it. A `\S+` URL group matches no part of such a line, so
 * the line is dropped silently and a repo whose ONLY remote is that one reads
 * back as `[]` - a real repository with no remotes - and dispatch then reports
 * that no connector owns it, which is confidently wrong for a repo that has
 * one. Non-greedy so the trailing ` (fetch)` marker still anchors the end.
 */
const REMOTE_LINE = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/;

function parseRemoteOutput(raw: string): readonly string[] {
  const byName = new Map<string, string>();
  // Split on \r?\n rather than the platform separator: git's own output uses
  // \n even on Windows, but a shell wrapper can introduce \r.
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(REMOTE_LINE);
    if (!match || match[3] !== 'fetch') continue;
    if (!byName.has(match[1])) byName.set(match[1], match[2]);
  }
  // `origin` first: ownership is decided on the primary remote, so that a repo
  // with an Azure `origin` and a GitHub `upstream` resolves against Azure
  // rather than letting registry array order pick the winner.
  const names = [...byName.keys()].sort((left, right) => {
    if (left === 'origin') return -1;
    if (right === 'origin') return 1;
    return 0;
  });
  return names.map((name) => byName.get(name) as string);
}

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still over budget after pruning: drop oldest-inserted first (Map preserves
  // insertion order), matching the bounded-map pattern in pr-linking.ts.
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * The fetch URLs of `repoCwd`'s git remotes, `origin` first.
 *
 * - `null` means the remotes could not be READ at all (the path is gone, it is
 *   not a repository, git errored).
 * - `[]` means a real repository that has no remotes configured.
 *
 * Both mean "ownership is undecidable"; the distinction only buys a truthful
 * message. NEVER REJECTS: a rejection would reach `pr-linking.ts` as a
 * non-`PRResolver*` error, which is the one shape that can clear a task's PR
 * link. The never-throws catch therefore lives INSIDE the queued job, exactly
 * as `git-read-queue.ts` requires and `isShaContainedInRef` documents.
 */
export async function readRemoteUrls(repoCwd: string): Promise<readonly string[] | null> {
  if (!repoCwd) return null;
  const key = path.resolve(repoCwd);

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.urls;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const read = viaGitRead(async (): Promise<readonly string[] | null> => {
    try {
      // simpleGit() itself throws synchronously when the directory is missing,
      // so the constructor has to be inside the try, not above it.
      const git = simpleGit(key);
      return parseRemoteOutput(await git.raw(['remote', '-v']));
    } catch {
      return null;
    }
  })
    .then((urls) => {
      pruneExpired(Date.now());
      cache.set(key, { urls, expiresAt: Date.now() + (urls == null ? MISS_TTL_MS : HIT_TTL_MS) });
      return urls;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, read);
  return read;
}

/**
 * Drop cached remotes for one repo, or all of them.
 *
 * Test seam only today - no production caller. A remote that changes on disk
 * self-heals within `HIT_TTL_MS` instead. Kept exported so a future lifecycle
 * hook has somewhere to call, but do not read its existence as evidence that
 * such a hook is wired.
 */
export function invalidateRemoteUrlsCache(repoCwd?: string): void {
  if (repoCwd == null) {
    cache.clear();
    return;
  }
  cache.delete(path.resolve(repoCwd));
}
