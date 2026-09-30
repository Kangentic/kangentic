import type Database from 'better-sqlite3';
import { timeSyncWork } from '../diagnostics/event-loop-lag';
import { writeTransaction } from '../db/transaction';

/** Main-thread time one slice of a background index write may take before it
 *  commits and yields. An item's cost follows its size (a change document reads
 *  every chunk of its conversation, a task record chunks its whole description),
 *  so a fixed count per slice cannot bound it: fifteen change documents held main
 *  for 58 ms on a first sweep of a real index. The budget is checked between
 *  items, so one very large item still runs past it on its own. */
export const SLICE_BUDGET_MS = 25;

export interface TimedSliceDeps {
  /** Milliseconds from any fixed origin. */
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

/**
 * Write `items` a slice at a time, each slice one transaction of about
 * `SLICE_BUDGET_MS`, yielding between slices. One transaction a slice because
 * each commit appends every page it touched (the row, each index, the FTS
 * index) to the WAL, and a page touched by many items is written once in one
 * transaction. Thirty task records of three chunks took 17.6 ms as separate
 * commits and 2.7 ms as one, at the synchronous NORMAL the app runs under.
 *
 * `writeOne` catches its own item's errors, so a throw here is the commit
 * failing: that ends the run, and the next sweep starts from what the index
 * says. Returns true when every item was written, false when `shouldContinue`
 * stopped it or a slice failed.
 */
export async function writeInTimedSlices<Item>(
  db: Database.Database,
  items: readonly Item[],
  writeOne: (item: Item) => void,
  label: string,
  shouldContinue: () => boolean,
  deps: TimedSliceDeps,
): Promise<boolean> {
  const writeSlice = writeTransaction(db, (from: number): number => {
    const startedMs = deps.clock();
    let next = from;
    while (next < items.length) {
      writeOne(items[next]);
      next += 1;
      if (deps.clock() - startedMs >= SLICE_BUDGET_MS) break;
    }
    return next;
  });
  let next = 0;
  while (next < items.length) {
    if (!shouldContinue()) return false;
    const from = next;
    try {
      next = timeSyncWork(label, () => writeSlice(from));
    } catch (error) {
      console.warn(`[retrieval] a ${label} write failed:`, error);
      return false;
    }
    await deps.yieldToEventLoop();
  }
  return true;
}
