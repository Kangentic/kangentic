import path from 'node:path';
import { UsageAccumulator } from './usage-accumulator';
import { streamJsonlRecords } from '../agent/shared/history-scan';
import type { PerToolStat, SessionEvent } from '../../shared/types';

/**
 * Rebuild finished sessions' per-tool breakdowns from their own event logs
 * (`<project>/.kangentic/sessions/<id>/events.jsonl`), through the same
 * `UsageAccumulator` the live path uses. It feeds the one-time repair of rows
 * saved while tool events were paired by name, whose durations were wrong
 * (`repairToolBreakdownDurations`). Runs in the retrieval worker: a project's
 * logs run to a hundred MB or more, and parsing them is work for off main.
 * Each log is streamed line by line, so the peak is one line, not one log.
 *
 * A session id that is not a plain id, or has no log readable to its end, is
 * left out of the result rather than answered with an empty or partial
 * breakdown, so the caller can tell "nothing to replay" from "replayed to
 * nothing".
 */
export async function replayToolBreakdowns(
  sessionsDir: string,
  sessionIds: readonly string[],
): Promise<Record<string, PerToolStat[]>> {
  const replayed: Record<string, PerToolStat[]> = {};
  for (const sessionId of sessionIds) {
    // Ids come from the sessions table, but this is a path segment.
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const accumulator = new UsageAccumulator();
    const readWholeLog = await streamJsonlRecords(path.join(sessionsDir, sessionId, 'events.jsonl'), (record) => {
      if (isReplayableEvent(record)) accumulator.recordToolEvent(sessionId, record);
    });
    if (!readWholeLog) continue;
    replayed[sessionId] = accumulator.getToolBreakdown(sessionId);
  }
  return replayed;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function isReplayableEvent(value: Record<string, unknown>): value is Record<string, unknown> & SessionEvent {
  return typeof value.ts === 'number' && typeof value.type === 'string';
}
