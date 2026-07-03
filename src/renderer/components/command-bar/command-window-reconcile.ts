/**
 * Pure planner for reconciling the Command Terminal window POPULATION to a
 * project's live transient sessions.
 *
 * The command window store is a global module singleton, but transient PTY
 * sessions are keyed per `(projectId, slot)`. Without reconciliation, windows
 * carried over from project A remount under project B and each spawns a fresh
 * PTY (the window count leaks across projects). This planner computes which
 * carried-over windows to close (their slot has no live session for the current
 * project) and which windows to open (a live session lacks a window, so a
 * back-switch reattaches instead of orphaning the PTY).
 *
 * Kept pure and store-free so it is unit-testable without jsdom, Zustand, or
 * React, mirroring the `workspace-saver.ts` precedent. The caller applies the
 * plan against the singleton store (see `reconcileCommandTerminalWindows`).
 */

import type { SessionStatus } from '../../../shared/types';

/** A window's identity for reconciliation: its store id and its durable slot
 *  anchor (`slot-N`). Structural so a real `ManagedWindow` maps in cheaply. */
export interface CommandWindowSlotRef {
  windowId: string;
  /** The window's durable anchor, a `slot-N` id (equals `ManagedWindow.anchor`). */
  slot: string;
}

/** A minimal transient-session entry: only the fields liveness needs. Structural
 *  so a real `TransientSessionEntry` assigns without an import. */
export interface CommandWindowTransientEntry {
  projectId: string;
  slot: string;
  sessionId: string;
}

/** A minimal session row: only the fields liveness needs. `status` uses the real
 *  `SessionStatus` union (a type-only import, erased at build, so the module stays
 *  runtime-pure) to keep the `'running'` liveness check typo-proof and tracking
 *  the source enum. A real `Session` still assigns structurally. */
export interface CommandWindowSessionRef {
  id: string;
  status: SessionStatus;
}

export interface CommandWindowReconcilePlan {
  /** Windows whose slot has no live transient session for the current project. */
  closeWindowIds: string[];
  /** Slots with a live session but no window, ascending slot order. */
  openSlots: string[];
}

/** Parse the numeric suffix of a `slot-N` id for ordering; unparseable ids sort
 *  last (stable, deterministic). */
function slotNumber(slot: string): number {
  const match = /^slot-(\d+)$/.exec(slot);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** Plan the per-project window reconciliation. See the module header for intent.
 *
 *  Liveness matches the window mount effect exactly (`CommandTerminalWindow.tsx`):
 *  a map entry counts as live only when it belongs to the current project AND a
 *  `sessions` row with the same id is still `running`. */
export function planCommandWindowReconciliation(input: {
  windows: ReadonlyArray<CommandWindowSlotRef>;
  transientSessions: Readonly<Record<string, CommandWindowTransientEntry>>;
  sessions: ReadonlyArray<CommandWindowSessionRef>;
  projectId: string;
  maxWindows: number;
}): CommandWindowReconcilePlan {
  const { windows, transientSessions, sessions, projectId, maxWindows } = input;

  const runningSessionIds = new Set(
    sessions.filter((session) => session.status === 'running').map((session) => session.id),
  );
  const liveSlots = new Set(
    Object.values(transientSessions)
      .filter((entry) => entry.projectId === projectId && runningSessionIds.has(entry.sessionId))
      .map((entry) => entry.slot),
  );

  // No live session for this project: keep exactly one window (lowest slot, so
  // the layer always opens with a terminal) and close the rest. That kept window
  // fresh-spawns for the current project via its own mount effect. Fills from the
  // lowest slot to match `syncSessions` re-pairing (slot-1 up).
  if (liveSlots.size === 0 && windows.length > 0) {
    const bySlotAscending = [...windows].sort((first, second) => slotNumber(first.slot) - slotNumber(second.slot));
    const [, ...surplus] = bySlotAscending;
    return { closeWindowIds: surplus.map((managedWindow) => managedWindow.windowId), openSlots: [] };
  }

  // Otherwise every remaining window must map to a live slot (reattach) and every
  // live slot must have a window (so a back-switch reattaches the PTY).
  const closeWindowIds = windows
    .filter((managedWindow) => !liveSlots.has(managedWindow.slot))
    .map((managedWindow) => managedWindow.windowId);

  const windowSlots = new Set(windows.map((managedWindow) => managedWindow.slot));
  const missingLiveSlots = [...liveSlots]
    .filter((slot) => !windowSlots.has(slot))
    .sort((first, second) => slotNumber(first) - slotNumber(second));

  // Defensive cap: kept + opened must never exceed the terminal cap. In practice
  // live slots are already bounded by the slot allocator, so this never trims.
  const keptCount = windows.length - closeWindowIds.length;
  const openBudget = Math.max(0, maxWindows - keptCount);
  const openSlots = missingLiveSlots.slice(0, openBudget);

  return { closeWindowIds, openSlots };
}
