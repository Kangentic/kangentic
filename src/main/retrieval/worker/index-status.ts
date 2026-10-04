/**
 * The index's half of the Knowledge Graph status poll (Settings, every 1.5 s
 * while it is open): every indexed project read in the retrieval worker, then
 * summed on main with what only main knows (the model download, the embed
 * engine, the summary scheduler, the git branch size). See
 * `retrievalService.getStatus`.
 *
 * Each project is counted by `readIndexCounts`, the same read the map's snapshot
 * makes, so the Settings card and the map's Index panel cannot count a project
 * differently. "Indexed" is `isIndexedProject`, the set the map's picker calls
 * All projects.
 */

import { RetrievalStore } from '../retrieval-store';
import { SummaryStore } from '../summary/summary-store';
import { readIndexCounts, type CorpusTotalsRow, type IndexCountsOptions } from '../index-counts';
import { isIndexedProject } from '../../../shared/index-summary';
import type { KnowledgeGraphIndexCounts } from '../../../shared/types';
import { hasVecSupport } from '../vec-support';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type Database from 'better-sqlite3';

/** Each project is counted with these options (`readIndexCounts`). */
export interface IndexAllParams extends IndexCountsOptions {
  /** Every registered project; the ones with nothing indexed are left out. */
  projectIds: string[];
}

/** One indexed project as the status poll reads it. */
export interface ProjectIndexRead extends KnowledgeGraphIndexCounts {
  projectId: string;
}

export interface IndexAllStatus {
  /** A project database could load sqlite-vec: semantic search can run. */
  hasVec: boolean;
  /** Every indexed project, in the order asked: read now, or as it last read
   *  when the read's budget ran out before reaching it. */
  projects: ProjectIndexRead[];
}

/**
 * How long a project's corpus totals are kept before they are read again, at
 * the least. The totals are about 15 ms on a 94k-chunk index, and they move only
 * as documents are indexed. Keyed on the index's size instead, they were read
 * again after every embedding batch, on nearly every poll while embedding ran
 * (the size check alone is two full index counts). What moves by the second,
 * the passages still waiting and the summaries, is read on every poll.
 */
export const SOURCE_TOTALS_TTL_MS = 30_000;

/**
 * How long one project's totals are kept: the TTL plus a share of it that is
 * fixed per project, so the projects read together on the first poll do not all
 * fall due on one later poll. Without it, every 30 s one poll read every
 * project's totals at once.
 */
export function totalsKeptMs(projectId: string): number {
  let hash = 0;
  for (let position = 0; position < projectId.length; position += 1) {
    hash = (hash * 31 + projectId.charCodeAt(position)) % 1_000;
  }
  return SOURCE_TOTALS_TTL_MS + Math.floor((hash / 1_000) * SOURCE_TOTALS_TTL_MS);
}

/**
 * Synchronous work the read does before it yields a turn, so a question waiting
 * in the worker is answered between projects. Not a yield per project: each
 * yield can wait behind a background job's step (up to about 400 ms).
 */
const READ_SLICE_MS = 8;

/**
 * How long one status read reads projects before it serves the rest from their
 * last read. The read has the interactive call's 15 s budget, past which the
 * worker is restarted, and its own time is small (measured on 19 real projects:
 * 8.5 ms warm, 173 ms with every database opened cold after a restart, the
 * slowest project 43 ms). What it cannot bound is the waits: a cold read yields
 * a dozen times, and each yield can wait behind a background job's step. This
 * bounds the whole read whatever the project count or the worker's load.
 */
export const READ_BUDGET_MS = 2_000;

/** One event-loop turn. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createIndexStatusReader(now: () => number = Date.now, yieldTurn: () => Promise<void> = nextTurn) {
  const totalsCache = new Map<string, { expiresAt: number; totals: CorpusTotalsRow[] }>();
  /** Each project's last read and when it was made: what a read the budget cut
   *  short serves for the projects it did not reach (null: nothing indexed). */
  const lastReads = new Map<string, { at: number; read: ProjectIndexRead | null }>();

  function totalsFor(projectId: string, store: RetrievalStore): CorpusTotalsRow[] {
    const at = now();
    let cached = totalsCache.get(projectId);
    if (!cached || at >= cached.expiresAt) {
      cached = { expiresAt: at + totalsKeptMs(projectId), totals: timeSyncWork('status:source-totals', () => store.corpusTotals()) };
      totalsCache.set(projectId, cached);
    }
    return cached.totals;
  }

  /** One project, or null when it has nothing indexed. Throws when it cannot be read. */
  function readProject(db: Database.Database, projectId: string, params: IndexAllParams): ProjectIndexRead | null {
    const store = new RetrievalStore(db);
    const totals = totalsFor(projectId, store);
    const conversations = totals.find((row) => row.corpus === 'conversation')?.documents ?? 0;
    if (!isIndexedProject(conversations)) return null;
    const counts = readIndexCounts(store, new SummaryStore(db), totals, params);
    return { projectId, corpora: counts.corpora, summaries: counts.summaries };
  }

  return {
    async readAll(getDb: (projectId: string) => Database.Database, params: IndexAllParams): Promise<IndexAllStatus> {
      let hasVec = false;
      const projectIds = [...new Set(params.projectIds)];
      // The stalest first, so a read the budget cuts short reaches the rest on
      // the next poll. Never read sorts first; the sort keeps the asked order
      // among equals.
      const order = [...projectIds].sort((left, right) => (lastReads.get(left)?.at ?? 0) - (lastReads.get(right)?.at ?? 0));
      const fresh = new Map<string, ProjectIndexRead | null>();
      const startedAt = performance.now();
      let sliceStartedAt = startedAt;
      for (const projectId of order) {
        if (performance.now() - startedAt >= READ_BUDGET_MS) break;
        try {
          const db = getDb(projectId);
          hasVec = hasVec || hasVecSupport(db);
          const read = timeSyncWork('status:project', () => readProject(db, projectId, params));
          fresh.set(projectId, read);
          lastReads.set(projectId, { at: now(), read });
        } catch {
          // A project that cannot be read (deleted, or not migrated yet) is left
          // out, as the map's project list lists it with nothing indexed.
          fresh.set(projectId, null);
          lastReads.delete(projectId);
        }
        if (performance.now() - sliceStartedAt >= READ_SLICE_MS) {
          await yieldTurn();
          sliceStartedAt = performance.now();
        }
      }
      // A project the budget did not reach counts as it last read; one never
      // read yet is left out until a poll reaches it.
      const projects = projectIds.flatMap((projectId) => {
        const read = fresh.has(projectId) ? fresh.get(projectId) : lastReads.get(projectId)?.read;
        return read ? [read] : [];
      });
      return { hasVec, projects };
    },
    /** Forget a project's totals and last read, after its index was cleared. */
    forget(projectId: string): void {
      totalsCache.delete(projectId);
      lastReads.delete(projectId);
    },
  };
}
