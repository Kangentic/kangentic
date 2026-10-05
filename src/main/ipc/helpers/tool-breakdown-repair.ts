import type Database from 'better-sqlite3';
import { SessionRepository } from '../../db/repositories/session-repository';
import { writeTransaction } from '../../db/transaction';
import type { PerToolStat } from '../../../shared/types';

/**
 * One-time repair of per-tool durations saved before tool events were paired
 * by `toolId`.
 *
 * The accumulator used to pair a tool's start and end FIFO by tool name, so
 * one start that never ended (a PreToolUse the bash-guard hook denied, a
 * cancelled parallel sibling) shifted that tool's queue for the rest of the
 * session, and every later call reported the gap since the previous call as
 * its duration. Replaying this repo's own logs: Bash 4,242h by name against
 * 168h by id. Every `tool_breakdown` written before the fix carries those
 * numbers into the archived Session Summary.
 *
 * Each record's own event log still exists under
 * `<project>/.kangentic/sessions/<record id>/events.jsonl`, so `replay`
 * rebuilds the breakdown with today's accumulator (in the retrieval worker;
 * see `replayToolBreakdowns`) and main patches the durations in.
 * `SessionRepository.patchToolBreakdownDurations` decides per row what may
 * change. A record with no log keeps its row.
 *
 * Runs once per project database: a `schema_meta` flag is written only after
 * every batch succeeded, so a project opened while the worker is down, or
 * closed mid-run, simply tries again on its next open.
 */

export const TOOL_BREAKDOWN_REPAIR_FLAG = 'tool_breakdown_duration_repair';

/** Records per worker call: keeps each read short and each write transaction small. */
const REPAIR_BATCH_SIZE = 100;

export type ToolBreakdownReplay = (
  sessionsDir: string,
  sessionIds: string[],
) => Promise<Record<string, PerToolStat[]>>;

export interface ToolBreakdownRepairResult {
  /** False when a batch failed; the flag stays unset and the next open retries. */
  completed: boolean;
  /** Records offered to the replay. */
  scanned: number;
  /** Records whose stored breakdown changed. */
  repaired: number;
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
  if (toolBreakdownRepairRan(db)) return { completed: true, scanned: 0, repaired: 0 };
  const sessionRepo = new SessionRepository(db);
  const recordIds = sessionRepo.listToolBreakdownRecordIds();
  let repaired = 0;
  for (let start = 0; start < recordIds.length; start += REPAIR_BATCH_SIZE) {
    const batch = recordIds.slice(start, start + REPAIR_BATCH_SIZE);
    let replayed: Record<string, PerToolStat[]>;
    try {
      replayed = await replay(sessionsDir, batch);
    } catch {
      return { completed: false, scanned: start, repaired };
    }
    writeTransaction(db, () => {
      for (const recordId of batch) {
        const replayedRows = replayed[recordId];
        if (replayedRows && sessionRepo.patchToolBreakdownDurations(recordId, replayedRows)) repaired += 1;
      }
    })();
  }
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .run(TOOL_BREAKDOWN_REPAIR_FLAG, new Date().toISOString());
  return { completed: true, scanned: recordIds.length, repaired };
}
