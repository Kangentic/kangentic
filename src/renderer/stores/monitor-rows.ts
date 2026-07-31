/**
 * Row-identity reconciliation for the Agent Monitor snapshot.
 *
 * `MONITOR_CHANGED` is pushed unconditionally (debounced 250ms) whenever a session
 * is spawned, changes status, or exits, and the payload crosses the IPC boundary by
 * structured clone. That means EVERY row object is a fresh identity on every push,
 * even when nothing about it changed. Applied naively, that is a guaranteed store
 * write on a 250ms cadence for as long as session events flow, and with the monitor
 * open it cascades: the body's `useShallow` selector fails, the `units` memo
 * re-derives (filter + sort + group + chunk), and `React.memo(MonitorCardInner)`
 * fails for every visible card because `row` alone is a new reference. Each of those
 * cards then re-runs `stripMarkdown` over the task description.
 *
 * So the snapshot is merged rather than assigned: a row that is structurally
 * unchanged keeps its previous object, and when no row moved or changed the whole
 * array keeps its previous identity. The store can then return its state object
 * untouched, which zustand treats as "no update" and does not notify at all - the
 * same discipline `applyActivity` already uses for a single-row patch.
 *
 * The comparison is structural and key-driven rather than a hand-listed field set,
 * so a new field on `MonitorSessionRow` is covered the moment it is added instead of
 * silently defeating the reuse. Depth is bounded because the row's own nesting is
 * shallow by construction: `labels` is a string array, `activityReason` is a flat
 * union whose only non-scalar member is `ids`, and `lastEvent` is flat.
 */
import type { MonitorSessionRow } from '../../shared/types';

/**
 * Recursion ceiling for the structural compare. The guard is checked AFTER the
 * `Object.is` fast path, so scalar leaves always compare correctly no matter how
 * deep they sit; this only stops an unexpectedly nested value from walking forever.
 */
const MAX_COMPARE_DEPTH = 4;

function valuesEqual(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth >= MAX_COMPARE_DEPTH) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;

  if (leftIsArray) {
    const leftArray = left as readonly unknown[];
    const rightArray = right as readonly unknown[];
    if (leftArray.length !== rightArray.length) return false;
    return leftArray.every((item, index) => valuesEqual(item, rightArray[index], depth + 1));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      valuesEqual(leftRecord[key], rightRecord[key], depth + 1),
  );
}

/** True when two rows carry the same values, whatever their object identities. */
export function monitorRowsEqual(left: MonitorSessionRow, right: MonitorSessionRow): boolean {
  return valuesEqual(left, right, 0);
}

/**
 * Merge an incoming snapshot over the rows already held, reusing the object for any
 * row whose values did not change.
 *
 * Returns the PREVIOUS array reference when the new snapshot is equivalent (same
 * rows, same order, same values), so the caller can skip the store write entirely.
 * Otherwise returns a new array whose unchanged entries are the previous objects.
 */
export function reconcileMonitorRows(
  previous: MonitorSessionRow[],
  incoming: MonitorSessionRow[],
): MonitorSessionRow[] {
  const previousBySessionId = new Map<string, MonitorSessionRow>();
  for (const row of previous) previousBySessionId.set(row.sessionId, row);

  // A length change is a change even if every surviving row is reused, and it also
  // means the positional check below cannot speak for the rows that went away.
  let changed = previous.length !== incoming.length;
  const next: MonitorSessionRow[] = new Array<MonitorSessionRow>(incoming.length);

  for (let index = 0; index < incoming.length; index += 1) {
    const incomingRow = incoming[index];
    const previousRow = previousBySessionId.get(incomingRow.sessionId);

    if (previousRow !== undefined && monitorRowsEqual(previousRow, incomingRow)) {
      next[index] = previousRow;
      // Reused, but possibly at a different position: a reorder is a real change
      // for consumers that read the array in order (grouping, virtualizer keys).
      if (!changed && previous[index] !== previousRow) changed = true;
    } else {
      next[index] = incomingRow;
      changed = true;
    }
  }

  return changed ? next : previous;
}
