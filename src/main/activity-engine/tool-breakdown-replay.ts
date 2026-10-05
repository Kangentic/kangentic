import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageAccumulator } from './usage-accumulator';
import type { PerToolStat, SessionEvent } from '../../shared/types';

/**
 * Rebuild finished sessions' per-tool breakdowns from their own event logs
 * (`<project>/.kangentic/sessions/<id>/events.jsonl`), through the same
 * `UsageAccumulator` the live path uses. It feeds the one-time repair of rows
 * saved while tool events were paired by name, whose durations were wrong
 * (`repairToolBreakdownDurations`). Runs in the retrieval worker: a project's
 * logs run to a hundred MB or more, and parsing them is work for off main.
 *
 * A session id that is not a plain id, or has no readable log, is left out of
 * the result rather than answered with an empty breakdown, so the caller can
 * tell "nothing to replay" from "replayed to nothing".
 */
export async function replayToolBreakdowns(
  sessionsDir: string,
  sessionIds: readonly string[],
): Promise<Record<string, PerToolStat[]>> {
  const replayed: Record<string, PerToolStat[]> = {};
  for (const sessionId of sessionIds) {
    // Ids come from the sessions table, but this is a path segment.
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    let text: string;
    try {
      text = await fs.readFile(path.join(sessionsDir, sessionId, 'events.jsonl'), 'utf8');
    } catch {
      continue;
    }
    const accumulator = new UsageAccumulator();
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isReplayableEvent(parsed)) accumulator.recordToolEvent(sessionId, parsed);
    }
    replayed[sessionId] = accumulator.getToolBreakdown(sessionId);
  }
  return replayed;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function isReplayableEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ts === 'number' && typeof candidate.type === 'string';
}
