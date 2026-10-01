import type Database from 'better-sqlite3';
import { setWriteHoldObserver } from '../db/transaction';
import { QUIET_MS } from './index-builds';

/**
 * One share of a project database's write lock for all of the retrieval
 * worker's background writes together.
 *
 * Main writes the same file, and on Windows a write that meets the worker's
 * lock sleeps in SQLite's busy retry for at least one 15.6 ms timer tick. On
 * the upgrade dry run (a copy of the real install, a board write every 250 ms)
 * the paced upkeep alone held the lock 20% of the time and 11% of the board's
 * writes waited a tick; at 5%, 1.5% did. The remaining long waits came where
 * several jobs wrote at once (the upkeep, the embedding writeback, the map's
 * sums, the record sweeps), each within its own pace, so the pace is one
 * budget per connection rather than one per job.
 *
 * Every outermost write transaction on a worker connection reports how long it
 * held the lock (`setWriteHoldObserver`), interactive ones included, and moves
 * that connection's next background turn later by the rest its hold owes. A
 * background loop awaits its turn (`awaitWriteTurn`) before it writes again.
 * Work nobody is waiting on runs at 20% while no other connection has committed
 * for `QUIET_MS` (`data_version`, the index builds' signal) and at 5% while one
 * has: the board in use, a terminal flushing its transcript.
 */

/** Lock share for background writes while no other connection is writing. */
export const IDLE_LOCK_DUTY = 0.2;
/** Lock share while another connection has committed within `QUIET_MS`. */
export const BUSY_LOCK_DUTY = 0.05;
/**
 * While another connection writes, background commits are at least this far
 * apart. Main's waits follow how often the worker commits as well as how long
 * it holds the lock (two threads on one WAL file: 1 to 2% held at 33 commits a
 * second made 40 to 77% of the other side's writes wait a tick, 9 a second
 * made 20%), and a batch of tiny holds would otherwise commit hundreds of times
 * a second within its share.
 */
export const BUSY_COMMIT_GAP_MS = 50;

export interface WriteBudgetClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** A turn of the event loop, when no rest is owed. */
  yieldTurn: () => Promise<void>;
}

const realClock: WriteBudgetClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  yieldTurn: () => new Promise((resolve) => setImmediate(resolve)),
};

interface Budget {
  /** When the next background write may begin. */
  nextWriteAt: number;
  /** `data_version` when last read; it moves only for other connections' commits. */
  dataVersion: number | null;
  /** When another connection's commit was last seen. */
  foreignCommitAt: number;
  /** Prepared once: it is read after every commit. */
  readDataVersion: Database.Statement | null;
  /** The last turn handed out; the next waiter queues behind it. */
  lastTurn: Promise<void>;
}

const budgets = new WeakMap<Database.Database, Budget>();

function budgetFor(db: Database.Database): Budget {
  let budget = budgets.get(db);
  if (!budget) {
    budget = {
      nextWriteAt: 0,
      dataVersion: null,
      foreignCommitAt: Number.NEGATIVE_INFINITY,
      readDataVersion: null,
      lastTurn: Promise.resolve(),
    };
    budgets.set(db, budget);
  }
  return budget;
}

/** Whether another connection has committed within `QUIET_MS`. */
function othersWriting(db: Database.Database, budget: Budget, now: number): boolean {
  try {
    budget.readDataVersion ??= db.prepare('PRAGMA data_version');
    const version = Number((budget.readDataVersion.get() as { data_version: number }).data_version);
    if (budget.dataVersion !== null && version !== budget.dataVersion) budget.foreignCommitAt = now;
    budget.dataVersion = version;
  } catch {
    // A closed connection: its budget no longer matters.
  }
  return now - budget.foreignCommitAt < QUIET_MS;
}

/** One commit on `db` held the lock `heldMs`: the next background write waits out its share. */
export function recordWriteHold(db: Database.Database, heldMs: number, clock: WriteBudgetClock = realClock): void {
  const budget = budgetFor(db);
  const now = clock.now();
  const busy = othersWriting(db, budget, now);
  const rest = heldMs * (1 / (busy ? BUSY_LOCK_DUTY : IDLE_LOCK_DUTY) - 1);
  budget.nextWriteAt = Math.max(budget.nextWriteAt, now) + Math.max(rest, busy ? BUSY_COMMIT_GAP_MS : 0);
}

/**
 * Wait until background work may write `db` again: the rest every hold so far
 * has owed, or one turn of the event loop when none is owed.
 *
 * Turns are handed out in the order they were asked for. Each waiter's rest
 * is measured once the waiter before it has had its turn, so it counts the
 * write that turn made. A loop that re-slept until the turn was free starved
 * everyone else: the transcript conversion always re-armed its timer first,
 * the embedding writeback never wrote, and its call timed out until main
 * restarted the worker (upgrade dry run).
 */
export function awaitWriteTurn(db: Database.Database, clock: WriteBudgetClock = realClock): Promise<void> {
  const budget = budgetFor(db);
  const turn = budget.lastTurn.then(async () => {
    const waitMs = budget.nextWriteAt - clock.now();
    if (waitMs > 0) await clock.sleep(waitMs);
    else await clock.yieldTurn();
  });
  budget.lastTurn = turn.catch(() => undefined);
  return turn;
}

/** Report every worker write transaction's hold to the budget. The worker calls this once. */
export function installWriteBudget(): void {
  setWriteHoldObserver((db, heldMs) => recordWriteHold(db, heldMs));
}
