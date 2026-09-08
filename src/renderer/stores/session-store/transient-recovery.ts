/**
 * Pure planner that re-pairs surviving Command Terminal PTYs to their windows.
 *
 * `transientSessions` is renderer-only memory keyed by `(projectId, slot)`. It
 * survives Fast Refresh via `import.meta.hot.data` but NOT a full page reload,
 * while main keeps every transient PTY running. Without recovery the reload
 * leaves a live conversation with nothing pointing at it: the window comes back
 * as a fresh empty boot and the project's terminal count exceeds its window
 * count.
 *
 * Main stamps the slot at spawn (`ipc/handlers/transient-sessions.ts`) and it now
 * reaches the renderer on every `Session` row, so pairing is EXACT rather than
 * guessed. The previous implementation sorted survivors by uuid and dealt them
 * `slot-1`, `slot-2`, ... which had no relationship to the slot a PTY actually
 * ran under: closing slot 1 of 2, or ids sorting the other way, silently put
 * someone else's conversation under "Command Terminal 1" with no error.
 *
 * Kept pure and store-free so it is unit-testable without jsdom, Zustand, or
 * React, mirroring `command-window-reconcile.ts` and the `workspace-saver.ts`
 * precedent. The caller applies the result (see `syncSessions`).
 */

import type { Session } from '../../../shared/types';
import { buildTransientSessionEntry, type TransientSessionEntry, transientKey } from './transient-session-slice';

/** A running Command Terminal PTY for some project. */
function isLiveTransient(session: Session): boolean {
  return !!session.transient && session.status === 'running';
}

/**
 * Oldest first, so that when two survivors claim the same slot the one that has
 * held it longest keeps it. `startedAt` is a UTC ISO 8601 string, so a lexical
 * compare IS the chronological one. Ids break a tie, purely so the result is
 * deterministic when two sessions share a timestamp (which fixtures do).
 */
function byStartedAtThenId(first: Session, second: Session): number {
  return first.startedAt.localeCompare(second.startedAt) || first.id.localeCompare(second.id);
}

/** Lowest `slot-N` (from 1 up) not already claimed for this project.
 *
 *  No `MAX_COMMAND_TERMINALS` cap: live transients are already bounded by the
 *  window allocator (`nextFreeSlot`), and `planCommandWindowReconciliation`
 *  applies its own `openBudget`. A second cap here could only disagree with
 *  those, and the way it would fail is by leaving a live PTY unpaired, which is
 *  the bug this module exists to prevent.
 *
 *  The loop is bounded anyway. `claimedSlots.size + 1` candidates cannot all be
 *  claimed by a set of that size, so a free slot is always found before the
 *  bound - it is a termination proof, not a policy. An unbounded `for(;;)` in a
 *  path that runs on every session sync is not worth the (however small) risk of
 *  a hang if an invariant above it ever changes. */
function lowestFreeSlot(claimedSlots: ReadonlySet<string>): string {
  for (let slotNumber = 1; slotNumber <= claimedSlots.size + 1; slotNumber++) {
    const slot = `slot-${slotNumber}`;
    if (!claimedSlots.has(slot)) return slot;
  }
  /* c8 ignore next 2 -- unreachable by the pigeonhole argument above. */
  throw new Error('lowestFreeSlot: no free slot below the pigeonhole bound');
}

/**
 * A live transient PTY that main says belongs to `(projectId, slot)` but which no
 * map entry points at, or null.
 *
 * This is the orphan shape a renderer reload produces, seen from one window's
 * point of view. `planTransientRecovery` normally re-pairs before any window
 * mounts, so this is the mount effect's guard for the case where it does not:
 * spawning on an empty map manufactures a duplicate AND strands the survivor,
 * which is strictly worse than either alone.
 *
 * Deliberately does NOT fall back to "any unpaired live transient for this
 * project". Attaching a window to a terminal that main says belongs to a
 * different slot is the mis-pairing this whole module exists to prevent: the user
 * would get someone else's conversation under this window's title, with no error.
 */
export function findAdoptableTransientSession(
  sessions: readonly Session[],
  transientSessions: Readonly<Record<string, TransientSessionEntry>>,
  projectId: string,
  slot: string,
): Session | null {
  const pairedSessionIds = new Set(Object.values(transientSessions).map((entry) => entry.sessionId));
  return sessions.find((session) => (
    isLiveTransient(session)
    && session.projectId === projectId
    && session.commandTerminalSlot === slot
    && !pairedSessionIds.has(session.id)
  )) ?? null;
}

/**
 * Rebuild the (project, slot) pairing map from the authoritative session list.
 *
 * Runs on every `syncSessions`, for EVERY project, with no "already tracked"
 * short-circuit. The old gates were the bug: one freshly spawned entry made the
 * whole project look recovered and permanently blocked re-pairing of its other
 * survivors, and the current-project wrapper meant a background project's
 * terminals were never recovered at all.
 *
 * Returns the SAME object reference when nothing needs to change, so the common
 * no-op sync does not touch the store.
 */
export function planTransientRecovery(input: {
  sessions: readonly Session[];
  transientSessions: Readonly<Record<string, TransientSessionEntry>>;
}): Record<string, TransientSessionEntry> | null {
  const { sessions, transientSessions } = input;

  // One pass over each input, grouped by project. Doing the `transientSessions`
  // scan per project instead would be O(projects x entries) on a function that
  // runs on every session sync.
  const liveByProject = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!isLiveTransient(session)) continue;
    const forProject = liveByProject.get(session.projectId);
    if (forProject) forProject.push(session);
    else liveByProject.set(session.projectId, [session]);
  }
  if (liveByProject.size === 0) return null;

  const entriesByProject = new Map<string, TransientSessionEntry[]>();
  for (const entry of Object.values(transientSessions)) {
    if (!liveByProject.has(entry.projectId)) continue;
    const forProject = entriesByProject.get(entry.projectId);
    if (forProject) forProject.push(entry);
    else entriesByProject.set(entry.projectId, [entry]);
  }

  // Allocated on the first write, not up front: the overwhelmingly common call
  // is a no-op sync where every survivor is already paired, and that case should
  // cost no copy of the map at all.
  let next: Record<string, TransientSessionEntry> | null = null;
  const pair = (projectId: string, slot: string, session: Session): void => {
    next ??= { ...transientSessions };
    // Shared with `adoptTransientSession`, the other path that re-pairs a
    // survivor, so the two cannot disagree about which fields an entry carries.
    // The label is the one that matters: main retains the derived name for
    // exactly this moment, and without it a recovered terminal falls back to
    // "Command Terminal N" and the auto-namer renames it from a LATER prompt,
    // since it fires per prompt event.
    next[transientKey(projectId, slot)] = buildTransientSessionEntry(projectId, slot, session);
  };

  for (const [projectId, liveSessions] of liveByProject) {
    const liveSessionIds = new Set(liveSessions.map((session) => session.id));

    // Pass 1: keep what is already paired, VERBATIM. An entry pointing at a
    // still-running session owns its slot, and rewriting it would drop the
    // `label` that `setTransientSessionLabel` derived from the first prompt -
    // first-prompt-wins, so a clobbered label never comes back. This matters
    // because syncSessions is Pattern B (re-run on every Fast Refresh), not just
    // on the hard reload this module is named for.
    const claimedSlots = new Set<string>();
    const pairedSessionIds = new Set<string>();
    for (const entry of entriesByProject.get(projectId) ?? []) {
      // An entry whose session is gone or dead is stale: its slot goes back in
      // the pool rather than blocking a survivor.
      if (!liveSessionIds.has(entry.sessionId)) continue;
      claimedSlots.add(entry.slot);
      pairedSessionIds.add(entry.sessionId);
    }
    if (pairedSessionIds.size === liveSessions.length) continue;

    const unpaired = liveSessions
      .filter((session) => !pairedSessionIds.has(session.id))
      .sort(byStartedAtThenId);

    // Pass 2: exact re-pair. Each survivor claims the slot main recorded for it.
    const rehome: Session[] = [];
    for (const session of unpaired) {
      const slot = session.commandTerminalSlot;
      // No slot is a real case, not defensive padding (see
      // `commandTerminalSlotNumber`): a session spawned before this plumbing
      // existed, or by a path that sends none. A collision is real too - a slot
      // is reused as soon as its window is closed, so a post-reload spawn can
      // take the same slot a survivor still holds.
      if (!slot || claimedSlots.has(slot)) {
        rehome.push(session);
        continue;
      }
      claimedSlots.add(slot);
      pair(projectId, slot, session);
    }

    // Pass 3: everything left (unslotted, or its slot taken) gets the lowest free
    // slot, so no live PTY is ever left unreachable.
    for (const session of rehome) {
      const slot = lowestFreeSlot(claimedSlots);
      claimedSlots.add(slot);
      pair(projectId, slot, session);
    }
  }

  return next;
}
