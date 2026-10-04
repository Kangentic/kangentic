import { listTree, readBranchHead, type BranchHead, type TreeEntry } from '../branch-git';
import { indexableEntries } from './code-indexer';
import type { KnowledgeGraphCodeStatus } from '../../../shared/types';

/**
 * What the Index card's Source code line says: before code is indexed, how
 * much there is to read and how long it would take here; while it indexes,
 * how far along it is; then that it is caught up.
 */

/**
 * Bytes of indexable file per passage, measured on this repository's default
 * branch: 15,748,851 bytes in 1,488 files, cut into 12,186 passages. The
 * estimate a branch gets before it is read, which is why the line says
 * "about".
 */
export const CODE_BYTES_PER_PASSAGE = 1_292;
/** How long a reading of a branch's size serves the status poll. */
export const BRANCH_SIZE_TTL_MS = 60_000;

/** A default branch's indexable code, as its tree reports it. */
export interface BranchSize {
  branch: string;
  files: number;
  /** Estimated from the files' sizes (`CODE_BYTES_PER_PASSAGE`). */
  passages: number;
}

/** A branch's indexable files and their estimated passages. */
export function branchSizeOf(branch: string, entries: ReadonlyArray<TreeEntry>): BranchSize {
  const kept = indexableEntries(entries);
  const bytes = kept.reduce((sum, entry) => sum + entry.size, 0);
  return { branch, files: kept.length, passages: Math.round(bytes / CODE_BYTES_PER_PASSAGE) };
}

export interface BranchSizeDeps {
  readHead: (projectPath: string, baseBranch: string) => Promise<BranchHead | null>;
  listTree: (projectPath: string, commit: string) => Promise<TreeEntry[]>;
  now: () => number;
}

const defaultDeps: BranchSizeDeps = { readHead: readBranchHead, listTree, now: () => Date.now() };

/**
 * Branch sizes for the status poll, read in the background and kept a minute.
 * The poll never waits on git: it gets the last reading (undefined before the
 * first lands) and a stale one is read again behind it. One `rev-parse` and one
 * `ls-tree` per reading, at most once a minute per project, and only while
 * Settings > Knowledge Graph is open.
 */
export function createBranchSizes(deps: BranchSizeDeps = defaultDeps) {
  const readings = new Map<string, { at: number; size: BranchSize | null }>();
  const reading = new Set<string>();

  async function read(projectPath: string, baseBranch: string): Promise<BranchSize | null> {
    const head = await deps.readHead(projectPath, baseBranch);
    if (!head) return null;
    return branchSizeOf(head.ref, await deps.listTree(projectPath, head.sha));
  }

  return {
    /** The branch's size, null when the project has no such branch, or
     *  undefined until the first reading lands. */
    get(projectId: string, projectPath: string, baseBranch: string): BranchSize | null | undefined {
      const key = `${projectId}\u0000${baseBranch}`;
      const last = readings.get(key);
      if ((!last || deps.now() - last.at >= BRANCH_SIZE_TTL_MS) && !reading.has(key)) {
        reading.add(key);
        void read(projectPath, baseBranch)
          .catch(() => null)
          .then((size) => {
            readings.set(key, { at: deps.now(), size });
          })
          .finally(() => reading.delete(key));
      }
      return last?.size;
    },
  };
}

export interface CodeStatusInput {
  /** Whether code is indexed (`codeIndexOn`). */
  on: boolean;
  /** What the index holds: files, passages, and passages with their vector,
   *  summed over every indexed project. */
  progress: { documents: number; chunks: number; embedded: number };
  /** The open project's branch size (see `createBranchSizes`); read only while
   *  nothing is indexed. */
  branchSize: BranchSize | null | undefined;
  /** This machine's background chunks a minute, or null before one is measured. */
  chunksPerMinute: number | null;
}

/** The status line's facts. Undefined while there is nothing to say yet. */
export function codeStatus(input: CodeStatusInput): KnowledgeGraphCodeStatus | undefined {
  const minutesFor = (passages: number): number | null => (
    input.chunksPerMinute && input.chunksPerMinute > 0 && passages > 0 ? passages / input.chunksPerMinute : null
  );
  const { progress } = input;
  const nothingCommitted: KnowledgeGraphCodeStatus = { state: 'nothing-committed', files: 0, passages: 0, embedded: 0, minutesLeft: null };
  if (!input.on || progress.documents === 0) {
    if (input.branchSize === null) return nothingCommitted;
    if (input.branchSize === undefined) {
      return input.on
        ? { state: 'reading', files: 0, passages: 0, embedded: 0, minutesLeft: null }
        : undefined;
    }
    const { files, passages } = input.branchSize;
    return { state: input.on ? 'reading' : 'estimate', files, passages, embedded: 0, minutesLeft: minutesFor(passages) };
  }
  const waiting = Math.max(0, progress.chunks - progress.embedded);
  return {
    state: waiting > 0 ? 'indexing' : 'ready',
    files: progress.documents,
    passages: progress.chunks,
    embedded: Math.min(progress.embedded, progress.chunks),
    minutesLeft: waiting > 0 ? minutesFor(waiting) : null,
  };
}
