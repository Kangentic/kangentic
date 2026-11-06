import type { QueueColumnLine, QueueSnapshot, QueueTask } from './types';

/** Where a queued session stands, and what it waits for. */
export type QueuePlace =
  | { kind: 'column'; position: number; total: number; line: QueueColumnLine }
  | { kind: 'global'; position: number; total: number; tasks: QueueTask[] };

/** How many of a column's waiting tasks it has room for. The rest it holds back. */
function roomIn(line: QueueColumnLine): number {
  return Math.max(0, line.maxAgents - line.holders.length);
}

/**
 * Both counts are of waiting tasks, so a running agent never inflates them. A
 * task its column does not hold back waits for a free agent slot, the one queue
 * every project shares. A task held by both reads as its column, the more
 * specific reason. The agent line leaves out what a column holds back, because
 * the queue skips those tasks when a slot opens, so they are not ahead of anyone.
 */
export function queuePlaceOf(snapshot: QueueSnapshot, sessionId: string): QueuePlace | null {
  for (const line of snapshot.columns) {
    const index = line.waiting.findIndex((task) => task.sessionId === sessionId);
    if (index < 0) continue;
    // Inside the limit, so the column is not what holds it. A session sits in
    // one line only, so nothing is left to search.
    if (index < roomIn(line)) break;
    return { kind: 'column', position: index + 1, total: line.waiting.length, line };
  }
  const heldByColumn = new Set(snapshot.columns.flatMap((line) => line.waiting.slice(roomIn(line))).map((task) => task.sessionId));
  const tasks = snapshot.global.filter((task) => !heldByColumn.has(task.sessionId));
  const position = tasks.findIndex((task) => task.sessionId === sessionId);
  if (position < 0) return null;
  return { kind: 'global', position: position + 1, total: tasks.length, tasks };
}
