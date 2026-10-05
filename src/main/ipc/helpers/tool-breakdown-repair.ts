import type Database from 'better-sqlite3';
import { SessionRepository } from '../../db/repositories/session-repository';
import { writeTransaction } from '../../db/transaction';
import type { ToolBreakdownReplayResult } from '../../activity-engine/tool-breakdown-replay';

/**
 * One-time repair of per-tool durations saved before tool events were paired
 * by `toolId`.
 *
 * The accumulator used to pair a tool's start and end FIFO by tool name, so
 * one start that never ended (a PreToolUse the bash-guard hook denied, a
 * cancelled parallel sibling) shifted that tool's queue for the rest of the
 * session, and every later call reported the gap since the previous call as
 * its duration. Every `tool_breakdown` written before the fix carries those
 * numbers into the archived Session Summary.
 *
 * Each record's own event log still exists under
 * `<project>/.kangentic/sessions/<record id>/events.jsonl`, so `replay`
 * rebuilds the breakdown with today's accumulator (in the retrieval worker;
 * see `replayToolBreakdowns`) and main patches the durations in.
 * `SessionRepository.patchToolBreakdownDurations` decides per row what may
 * change. A record with no log keeps its row.
 *
 * Runs once per project database: a `schema_meta` flag is written only when
 * every record was replayed or had no log. A project opened while the worker
 * is down, or closed mid-run, tries the whole list again on its next open. A
 * log that exists but could not be read to its end (a lock, a permission
 * error) is kept under `TOOL_BREAKDOWN_REPAIR_RETRY`, and the next open
 * replays only those, so one bad log neither loses its repair nor makes every
 * open replay the project's whole history.
 */

export const TOOL_BREAKDOWN_REPAIR_FLAG = 'tool_breakdown_duration_repair';
/** `schema_meta` key holding a JSON array of record ids still to replay. */
export const TOOL_BREAKDOWN_REPAIR_RETRY = 'tool_breakdown_duration_repair_retry';

/** Records per worker call: keeps each read short and each write transaction small. */
const REPAIR_BATCH_SIZE = 100;

export type ToolBreakdownReplay = (
  sessionsDir: string,
  sessionIds: string[],
) => Promise<ToolBreakdownReplayResult>;

export interface ToolBreakdownRepairResult {
  /** False when a batch failed or a log was unreadable; the flag stays unset and the next open retries. */
  completed: boolean;
  /** Records offered to the replay. */
  scanned: number;
  /** Records whose stored breakdown changed. */
  repaired: number;
  /** Records whose log exists but could not be read; kept for the next open. */
  unreadable: number;
}

export function toolBreakdownRepairRan(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(TOOL_BREAKDOWN_REPAIR_FLAG);
  return row !== undefined;
}

export async function repairToolBreakdownDurations(
  db: Database.Database,
  sessionsDir: string,
  replay: ToolBreakdownReplay,
): Promise<ToolBreakdownRepairResult> {
  if (toolBreakdownRepairRan(db)) return { completed: true, scanned: 0, repaired: 0, unreadable: 0 };
  const sessionRepo = new SessionRepository(db);
  const recordIds = readRetryIds(db) ?? sessionRepo.listToolBreakdownRecordIds();
  const unreadable: string[] = [];
  let repaired = 0;
  for (let start = 0; start < recordIds.length; start += REPAIR_BATCH_SIZE) {
    const batch = recordIds.slice(start, start + REPAIR_BATCH_SIZE);
    try {
      const { breakdowns, unreadable: batchUnreadable } = await replay(sessionsDir, batch);
      // Counted inside the transaction but added only once it commits, so a
      // batch that rolls back reports nothing it did not write.
      const batchRepaired = writeTransaction(db, () => {
        let patched = 0;
        for (const recordId of batch) {
          const replayedRows = breakdowns[recordId];
          if (replayedRows && sessionRepo.patchToolBreakdownDurations(recordId, replayedRows)) patched += 1;
        }
        return patched;
      })();
      repaired += batchRepaired;
      unreadable.push(...batchUnreadable);
    } catch {
      // The worker is down or a write failed: leave everything as it was, so
      // the next open starts this list again.
      return { completed: false, scanned: start, repaired, unreadable: unreadable.length };
    }
  }
  try {
    const upsert = db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');
    if (unreadable.length > 0) {
      upsert.run(TOOL_BREAKDOWN_REPAIR_RETRY, JSON.stringify(unreadable));
      return { completed: false, scanned: recordIds.length, repaired, unreadable: unreadable.length };
    }
    writeTransaction(db, () => {
      upsert.run(TOOL_BREAKDOWN_REPAIR_FLAG, new Date().toISOString());
      db.prepare('DELETE FROM schema_meta WHERE key = ?').run(TOOL_BREAKDOWN_REPAIR_RETRY);
    })();
  } catch {
    // The rows are patched; without the flag the next open replays again and
    // the patch, which is idempotent, changes nothing more.
    return { completed: false, scanned: recordIds.length, repaired, unreadable: unreadable.length };
  }
  return { completed: true, scanned: recordIds.length, repaired, unreadable: 0 };
}

/** The ids a previous run could not read, or null when there is no usable list. */
function readRetryIds(db: Database.Database): string[] | null {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(TOOL_BREAKDOWN_REPAIR_RETRY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) return parsed;
  } catch {
    // A corrupt list falls back to every record, which the patch keeps idempotent.
  }
  return null;
}
