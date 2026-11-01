import type { QueueColumnLine, QueueSnapshot } from './types';

/** Where a queued session stands, and what it waits for. */
export type QueuePlace =
  | { kind: 'column'; position: number; total: number; line: QueueColumnLine }
  | { kind: 'global'; position: number; total: number };

/**
 * A column's line counts its running agent first, so the numbers match the
 * column's own count. A task its column does not hold back waits for a free
 * agent slot, the one queue every project shares, and counts among queued tasks
 * only. A task held by both reads as its column, the more specific reason.
 */
export function queuePlaceOf(snapshot: QueueSnapshot, sessionId: string): QueuePlace | null {
  for (const line of snapshot.columns) {
    const index = line.waiting.findIndex((task) => task.sessionId === sessionId);
    if (index < 0) continue;
    // Inside the limit, so the column is not what holds it. A session sits in
    // one line only, so nothing is left to search.
    if (line.holders.length + index < line.maxAgents) break;
    return {
      kind: 'column',
      position: line.holders.length + index + 1,
      total: line.holders.length + line.waiting.length,
      line,
    };
  }
  const position = snapshot.global.findIndex((task) => task.sessionId === sessionId);
  if (position < 0) return null;
  return { kind: 'global', position: position + 1, total: snapshot.global.length };
}
