import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageAccumulator } from './usage-accumulator';
import { streamJsonlRecords } from '../agent/shared/history-scan';
import type { PerToolStat, SessionEvent } from '../../shared/types';

export interface ToolBreakdownReplayResult {
  /** Rebuilt breakdowns, by session id, for every log read to its end. */
  breakdowns: Record<string, PerToolStat[]>;
  /**
   * Ids whose log exists but could not be read to its end (a lock, a
   * permission error, a read that failed partway), so the caller can try them
   * again rather than treat them as done.
   */
  unreadable: string[];
}

/**
 * Rebuild finished sessions' per-tool breakdowns from their own event logs
 * (`<project>/.kangentic/sessions/<id>/events.jsonl`), through the same
 * `UsageAccumulator` the live path uses. It feeds the one-time repair of rows
 * saved while tool events were paired by name, whose durations were wrong
 * (`repairToolBreakdownDurations`). Runs in the retrieval worker: a project's
 * logs run to a hundred MB or more, and parsing them is work for off main.
 * Each log is streamed line by line, so the peak is one line, not one log.
 *
 * An id is in neither list when it is not a plain id or has no log at all:
 * there is nothing to replay. A log that exists but cannot be read to its end
 * goes in `unreadable`, never in `breakdowns`, since a partial replay would be
 * a wrong answer, not a smaller one.
 */
export async function replayToolBreakdowns(
  sessionsDir: string,
  sessionIds: readonly string[],
): Promise<ToolBreakdownReplayResult> {
  const breakdowns: Record<string, PerToolStat[]> = {};
  const unreadable: string[] = [];
  for (const sessionId of sessionIds) {
    // Ids come from the sessions table, but this is a path segment.
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const logPath = path.join(sessionsDir, sessionId, 'events.jsonl');
    try {
      await fs.stat(logPath);
    } catch (error) {
      if (!isMissingFileError(error)) unreadable.push(sessionId);
      continue;
    }
    const accumulator = new UsageAccumulator();
    const readWholeLog = await streamJsonlRecords(logPath, (record) => {
      if (isReplayableEvent(record)) accumulator.recordToolEvent(sessionId, record);
    });
    if (!readWholeLog) {
      unreadable.push(sessionId);
      continue;
    }
    breakdowns[sessionId] = accumulator.getToolBreakdown(sessionId);
  }
  return { breakdowns, unreadable };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isReplayableEvent(value: Record<string, unknown>): value is Record<string, unknown> & SessionEvent {
  return typeof value.ts === 'number' && typeof value.type === 'string';
}
