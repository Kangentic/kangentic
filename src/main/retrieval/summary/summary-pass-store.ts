import type Database from 'better-sqlite3';
import { readSummaryCandidates, type SummaryCandidate } from './summary-sources';
import { SummaryStore } from './summary-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { writeTransaction } from '../../db/transaction';

/** One summary to save, as `SummaryStore.write` takes it. */
export type SummaryRow = Parameters<SummaryStore['write']>[0];

/**
 * The summary pass's two database steps, behind an async interface. On main
 * they are retrieval worker calls; the worker and the unit tests run them
 * directly (`localSummaryPassStore`). The agent call between them stays on
 * main, which spawns agent CLIs.
 */
export interface SummaryPassStore {
  /** Finished tasks whose summary is missing or out of date, most recent work
   *  first, less `skip`. Summaries of deleted tasks are removed first. */
  candidates(projectId: string, skip: ReadonlyArray<string>): Promise<SummaryCandidate[]>;
  /** Save a pass's summaries in one transaction; how many were saved. */
  save(projectId: string, rows: ReadonlyArray<SummaryRow>): Promise<number>;
}

export function localSummaryPassStore(
  getDb: (projectId: string) => Database.Database,
  yieldToEventLoop: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): SummaryPassStore {
  return {
    async candidates(projectId, skip) {
      const db = getDb(projectId);
      const store = new SummaryStore(db);
      store.removeOrphans();
      const hashes = store.inputHashes();
      const skipped = new Set(skip);
      return (await readSummaryCandidates(db, yieldToEventLoop))
        .filter((candidate) => hashes.get(candidate.input.taskId) !== candidate.hash && !skipped.has(candidate.input.taskId))
        .sort((left, right) => right.lastActivityMs - left.lastActivityMs);
    },
    async save(projectId, rows) {
      const db = getDb(projectId);
      const store = new SummaryStore(db);
      let saved = 0;
      // One transaction. Each commit appends every page it touched to the WAL,
      // so thirty separate ones write the same table and index pages thirty
      // times over (see timed-slices.ts for the measured cost).
      timeSyncWork('summaries:write', () => writeTransaction(db, () => {
        for (const row of rows) {
          try {
            store.write(row);
            saved += 1;
          } catch (error) {
            console.warn(`[retrieval] summary for ${row.taskId} failed to save:`, error);
          }
        }
      })());
      return saved;
    },
  };
}
