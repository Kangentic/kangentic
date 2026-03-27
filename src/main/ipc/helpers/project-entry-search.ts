import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ProjectSearchEntry, ProjectSearchEntriesInput, ProjectSearchEntriesResult } from '../../../shared/types';

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.kangentic',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  '.cache',
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectSearchEntry {
  normalizedPath: string;
  normalizedName: string;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

export function clearProjectEntrySearchCache(cwd?: string): void {
  if (cwd) {
    const resolvedCwd = path.resolve(cwd);
    workspaceIndexCache.delete(resolvedCwd);
    inFlightWorkspaceIndexBuilds.delete(resolvedCwd);
    return;
  }
  workspaceIndexCache.clear();
  inFlightWorkspaceIndexBuilds.clear();
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join('/');
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf('/');
  if (separatorIndex === -1) return undefined;
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf('/');
  if (separatorIndex === -1) return input;
  return input.slice(separatorIndex + 1);
}

function normalizeQuery(input: string): string {
  return input.trim().replace(/^[@./]+/, '').toLowerCase();
}

function toSearchableWorkspaceEntry(entry: ProjectSearchEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split('/')[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function splitNullSeparatedPaths(input: string): string[] {
  return input.split('\0').filter((value) => value.length > 0);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join('/'));
  }
  return directories;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { allowNonZeroExit?: boolean; stdin?: string },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback();
    };

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`git ${args.join(' ')} timed out`)));
    }, 20_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > GIT_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        finish(() => reject(new Error(`git ${args.join(' ')} exceeded max buffer`)));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (code === 0 || options?.allowNonZeroExit) {
        finish(() => resolve({ code: code ?? 1, stdout }));
        return;
      }
      finish(() => reject(new Error(`git ${args.join(' ')} exited with code ${code ?? 1}`)));
    });

    if (options?.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], {
    allowNonZeroExit: true,
  }).catch(() => null);
  return Boolean(result && result.code === 0 && result.stdout.trim() === 'true');
}

async function filterGitIgnoredPaths(cwd: string, relativePaths: string[]): Promise<string[]> {
  if (relativePaths.length === 0) return relativePaths;

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) return true;

    const result = await runGit(cwd, ['check-ignore', '--no-index', '-z', '--stdin'], {
      allowNonZeroExit: true,
      stdin: `${chunk.join('\0')}\0`,
    }).catch(() => null);

    chunk = [];
    chunkBytes = 0;

    if (!result) return false;
    if (result.code !== 0 && result.code !== 1) return false;

    for (const ignoredPath of splitNullSeparatedPaths(result.stdout)) {
      ignoredPaths.add(toPosixPath(ignoredPath));
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return relativePaths;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return relativePaths;
    }
  }

  if (!(await flushChunk())) return relativePaths;
  if (ignoredPaths.size === 0) return relativePaths;
  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}

async function buildWorkspaceIndexFromGit(cwd: string): Promise<WorkspaceIndex | null> {
  if (!(await isInsideGitWorkTree(cwd))) return null;

  const listedFiles = await runGit(
    cwd,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { allowNonZeroExit: true },
  ).catch(() => null);

  if (!listedFiles || listedFiles.code !== 0) {
    return null;
  }

  const listedPaths = splitNullSeparatedPaths(listedFiles.stdout)
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
  const filePaths = await filterGitIgnoredPaths(cwd, listedPaths);

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInIgnoredDirectory(directoryPath)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries = [...directorySet]
    .sort((left, right) => left.localeCompare(right))
    .map((directoryPath): ProjectSearchEntry => ({
      path: directoryPath,
      kind: 'directory',
      parentPath: parentPathOf(directoryPath),
    }))
    .map(toSearchableWorkspaceEntry);

  const fileEntries = [...new Set(filePaths)]
    .sort((left, right) => left.localeCompare(right))
    .map((filePath): ProjectSearchEntry => ({
      path: filePath,
      kind: 'file',
      parentPath: parentPathOf(filePath),
    }))
    .map(toSearchableWorkspaceEntry);

  const entries = [...directoryEntries, ...fileEntries];
  return {
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated: entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  };
}

async function buildWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(cwd);
  if (gitIndexed) return gitIndexed;

  const shouldFilterWithGitIgnore = await isInsideGitWorkTree(cwd);
  let pendingDirectories: string[] = [''];
  const entries: SearchableWorkspaceEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];

    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : 'unknown error'}`,
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === '.' || dirent.name === '..') continue;
        if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue;
        if (!dirent.isDirectory() && !dirent.isFile()) continue;

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredDirectory(relativePath)) continue;
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
      candidateEntries.map((entry) => entry.relativePath),
    );
    const allowedPathSet = shouldFilterWithGitIgnore
      ? new Set(await filterGitIgnoredPaths(cwd, candidatePaths))
      : null;

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) continue;

        const entry = toSearchableWorkspaceEntry({
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? 'directory' : 'file',
          parentPath: parentPathOf(candidate.relativePath),
        });
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
        }

        if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }

  return {
    scannedAt: Date.now(),
    entries,
    truncated,
  };
}

async function getWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (cached && Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightWorkspaceIndexBuilds.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = buildWorkspaceIndex(cwd)
    .then((next) => {
      workspaceIndexCache.set(cwd, next);
      while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
        const oldestKey = workspaceIndexCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        workspaceIndexCache.delete(oldestKey);
      }
      return next;
    })
    .finally(() => {
      inFlightWorkspaceIndexBuilds.delete(cwd);
    });

  inFlightWorkspaceIndexBuilds.set(cwd, nextPromise);
  return nextPromise;
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === 'directory' ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(left: RankedWorkspaceEntry, right: RankedWorkspaceEntry): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) break;

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) return;

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) return;

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

export async function searchProjectEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const cwd = path.resolve(input.cwd);
  const index = await getWorkspaceIndex(cwd);
  const normalizedQuery = normalizeQuery(input.query);
  const limit = Math.max(0, Math.floor(input.limit));
  const rankedEntries: RankedWorkspaceEntry[] = [];
  let matchedEntryCount = 0;

  for (const entry of index.entries) {
    const score = scoreEntry(entry, normalizedQuery);
    if (score === null) continue;

    matchedEntryCount += 1;
    insertRankedEntry(rankedEntries, { entry, score }, limit);
  }

  return {
    entries: rankedEntries.map((candidate) => ({
      path: candidate.entry.path,
      kind: candidate.entry.kind,
      ...(candidate.entry.parentPath ? { parentPath: candidate.entry.parentPath } : {}),
    })),
    truncated: index.truncated || matchedEntryCount > limit,
  };
}
