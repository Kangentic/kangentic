import type Database from 'better-sqlite3';
import { timeSyncWork } from '../diagnostics/event-loop-lag';
import { writeTransaction } from '../db/transaction';
import { CHUNKS_PER_TRANSACTION } from './retrieval-store';
import { awaitWriteTurn } from './write-budget';

/**
 * One item's writes, prepared outside any transaction: its reads and its CPU
 * work are done, and `write` only writes. `write` catches its own item's
 * errors, so one bad item never rolls back the others in its slice.
 */
export interface PreparedWrite {
  /** Rows the write inserts, rewrites or deletes, its state row included. */
  rows: number;
  /** Text bytes it writes. */
  bytes: number;
  write: () => void;
}

/**
 * Rows and text bytes one slice's transaction may write. The index and the rest
 * of the app write the same database, one writer at a time, so a transaction is
 * capped by what it writes. A clock read after each item could not do it: it
 * never counts the commit, and one large item overran a 25 ms budget alone.
 */
export const SLICE_ROWS = CHUNKS_PER_TRANSACTION;
export const SLICE_BYTES = 64 * 1024;

/** Time a slice may spend preparing before it writes and yields, so a long run
 *  of reads and chunking still gives way to other work. */
export const PREPARE_BUDGET_MS = 25;

export interface SliceDeps {
  /** Milliseconds from any fixed origin. */
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

function overCap(rows: number, bytes: number): boolean {
  return rows > SLICE_ROWS || bytes > SLICE_BYTES;
}

/**
 * Prepare `items` and write them a slice at a time, yielding between slices.
 *
 * Prepared writes share one transaction up to `SLICE_ROWS` rows and
 * `SLICE_BYTES` of text, because each commit appends every page it touched to
 * the WAL (the row, each index, the full-text index), and a page many items
 * touch is written once per transaction: thirty task records of three chunks
 * took 17.6 ms as separate commits and 2.7 ms as one. An item over either cap
 * on its own is written with no transaction around it, where
 * `RetrievalStore.upsertDocument` and `deleteDocument` split it into bounded
 * transactions themselves.
 *
 * A throw from a slice is its commit failing: that ends the run, and the next
 * sweep starts from what the index says. Returns true when every item was
 * written, false when `shouldContinue` stopped it or a slice failed.
 */
export async function writeInSlices<Item>(
  db: Database.Database,
  items: readonly Item[],
  prepare: (item: Item) => PreparedWrite | null,
  label: string,
  shouldContinue: () => boolean,
  deps: SliceDeps,
): Promise<boolean> {
  let next = 0;
  // Prepared by the last slice, which it would have taken over a cap.
  let carried: PreparedWrite | null = null;
  while (next < items.length || carried) {
    if (!shouldContinue()) return false;
    const preparingSince = deps.clock();
    const slice: PreparedWrite[] = carried ? [carried] : [];
    let rows = carried?.rows ?? 0;
    let bytes = carried?.bytes ?? 0;
    // Labelled apart from the write, so the slow-work log says which half held main.
    carried = timeSyncWork(`${label}:prepare`, (): PreparedWrite | null => {
      while (next < items.length && !overCap(rows, bytes) && deps.clock() - preparingSince < PREPARE_BUDGET_MS) {
        const prepared = prepareOne(prepare, items[next], label);
        next += 1;
        if (!prepared) continue;
        if (slice.length > 0 && overCap(rows + prepared.rows, bytes + prepared.bytes)) return prepared;
        slice.push(prepared);
        rows += prepared.rows;
        bytes += prepared.bytes;
      }
      return null;
    });
    try {
      if (slice.length === 1 && overCap(rows, bytes)) {
        timeSyncWork(label, () => slice[0].write());
      } else if (slice.length > 0) {
        timeSyncWork(label, writeTransaction(db, () => {
          for (const prepared of slice) prepared.write();
        }));
      }
    } catch (error) {
      console.warn(`[retrieval] a ${label} write failed:`, error);
      return false;
    }
    // The worker's background writes share one turn of the lock
    // (`write-budget.ts`): the first sweep after an upgrade writes thousands of
    // new records, and back to back they held main's own writes at launch.
    await awaitWriteTurn(db, { now: deps.clock, sleep: sleepFor, yieldTurn: deps.yieldToEventLoop });
  }
  return true;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prepareOne<Item>(prepare: (item: Item) => PreparedWrite | null, item: Item, label: string): PreparedWrite | null {
  try {
    return prepare(item);
  } catch (error) {
    console.warn(`[retrieval] a ${label} item failed to prepare:`, error);
    return null;
  }
}
