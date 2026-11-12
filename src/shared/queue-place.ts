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
  return queuePlacesOf(snapshot).get(sessionId) ?? null;
}

/**
 * Every queued session's place, keyed by session id, in one pass over the
 * snapshot. A caller that reads the place of each task in the line uses this
 * instead of `queuePlaceOf` per task, which would walk the line once each.
 */
export function queuePlacesOf(snapshot: QueueSnapshot): Map<string, QueuePlace> {
  const places = new Map<string, QueuePlace>();
  const heldByColumn = new Set<string | null>();
  for (const line of snapshot.columns) {
    const room = roomIn(line);
    line.waiting.forEach((task, index) => {
      // Inside the limit, so the column is not what holds it.
      if (index < room) return;
      heldByColumn.add(task.sessionId);
      if (task.sessionId !== null && !places.has(task.sessionId)) {
        places.set(task.sessionId, { kind: 'column', position: index + 1, total: line.waiting.length, line });
      }
    });
  }
  const tasks = snapshot.global.filter((task) => !heldByColumn.has(task.sessionId));
  tasks.forEach((task, index) => {
    if (task.sessionId !== null && !places.has(task.sessionId)) {
      places.set(task.sessionId, { kind: 'global', position: index + 1, total: tasks.length, tasks });
    }
  });
  return places;
}

/**
 * Each queued task's place, keyed by task id, with the line entry it came
 * from. The first entry with a session wins when a task appears twice. A task
 * whose session has no place is left out.
 */
export function queuePlacesByTaskId(snapshot: QueueSnapshot): Map<string, { queued: QueueTask; place: QueuePlace }> {
  const placeBySessionId = queuePlacesOf(snapshot);
  const byTaskId = new Map<string, { queued: QueueTask; place: QueuePlace }>();
  for (const queued of snapshot.global) {
    if (!queued.sessionId || byTaskId.has(queued.taskId)) continue;
    const place = placeBySessionId.get(queued.sessionId);
    if (place) byTaskId.set(queued.taskId, { queued, place });
  }
  return byTaskId;
}
