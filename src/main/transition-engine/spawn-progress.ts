import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';

// ---------------------------------------------------------------------------
// Spawn progress: typed phases emitted to the renderer during task move
//
// Mirrors session-lifecycle.ts pattern: typed phases, centralized labels.
// The main process emits progress at phase boundaries; the renderer stores
// the latest label per task and displays it.
//
// Phase flow (contextual per task):
//   Worktree task:      fetching → creating-worktree → [init-script] → starting-agent
//   Custom branch task: fetching → switching-branch  → starting-agent
//   Base branch task:   fetching → switching-branch  → starting-agent
//   Has worktree:       starting-agent (a base-drift probe may decorate it, see below)
//   Cross-agent:        packaging-handoff → detecting-agent → starting-agent
//   Restore from Done:  resuming → (whichever of the above the task needs)
//
// 'resuming' is emitted by TASK_UNARCHIVE / TASK_BULK_UNARCHIVE before any git
// work, so the card is never silent while the lane resolves and the git op
// queues. Every other phase is emitted by the git helpers themselves.
//
// QUERYABLE STATE (not just fire-once IPC): the latest in-flight label per
// task is also retained in a module-level map so the renderer can re-derive
// it at any time via getInFlightSpawnProgress() / IPC.TASK_GET_SPAWN_PROGRESS.
// This closes the HMR-strand bug where the clearing push fired in the
// IPC-listener-reattach gap and left a task stuck on "Starting agent...":
// syncSessions() now reconciles spawnProgress against this map instead of
// relying on having had a listener attached at emit time. The main process is
// a single esbuild bundle with no HMR, so this module-level state is a safe
// singleton.
// ---------------------------------------------------------------------------

/**
 * In-flight spawn-progress labels, keyed by taskId. Updated on every
 * emit/clear and read by IPC.TASK_GET_SPAWN_PROGRESS. `updatedAt` backs a TTL
 * sweep so a spawn path that dies without calling clearSpawnProgress (process
 * killed mid-spawn, uncaught throw bypassing the finally) cannot strand a
 * label here forever.
 */
const inFlightSpawnProgress = new Map<string, { label: string; updatedAt: number }>();

/**
 * Per-task staleness note appended to every label until the spawn clears
 * (e.g. "base 3 behind", "base fetch failed"). The map stores BASE labels and
 * the note is applied at the send/read boundaries, so the pushed string and
 * the getInFlightSpawnProgress() snapshot can never disagree. A note string
 * must never start with "Waiting" and always TRAILS the label - the renderer's
 * stall watcher classifies git-queue waits by sniffing label text.
 */
const spawnStaleNotes = new Map<string, string>();

/**
 * A note that arrived while the task had no in-flight entry, waiting for the
 * spawn's next label push. The REUSE spawn path emits nothing between the move
 * and Phase 3's 'starting-agent', and the drift probe (a throttle-hit fetch
 * plus one rev-list) usually resolves inside that empty window - dropping the
 * note there meant reuse drift effectively never surfaced (caught live in a
 * preview; the unit tests had masked it by pre-seeding a label). Entries are
 * generation-guarded: a pending note can only attach to the spawn that
 * requested the probe, never a future one. `storedAt` only feeds the sweep.
 */
const pendingStaleNotes = new Map<string, { note: string; probeGeneration: number; storedAt: number }>();

/**
 * Per-task count of spawn clears (null pushes). A probe captures the value at
 * its start; any clear between then and the note arriving bumps it, which
 * voids the note.
 *
 * Entries are swept once untouched for STALE_PROBE_HORIZON_MS (see
 * getInFlightSpawnProgress) so the map cannot grow with every task id the app
 * ever spawned. Dropping an entry resets that task's baseline to zero, which
 * is safe because the horizon outlives any probe's UNTOUCHED stretch: a
 * running probe holds its token for at most the fetch timeout plus the
 * rev-list timeout, beginSpawnStaleProbe touches the entry at capture, and
 * touchSpawnStaleProbe re-touches it when a git-queue-delayed probe finally
 * starts running, so a live probe's baseline never goes stale mid-flight.
 * After a reset both capture and compare read zero - the ordering semantics
 * simply restart.
 */
const spawnClearGenerations = new Map<string, { value: number; touchedAt: number }>();

/**
 * Sweep horizon for the two probe-bookkeeping maps above. Comfortably past
 * the longest possible probe (15s fetch cap + 5s rev-list cap + process
 * margins), so no entry that could still matter is ever dropped.
 */
const STALE_PROBE_HORIZON_MS = 60_000;

function currentClearGeneration(taskId: string): number {
  return spawnClearGenerations.get(taskId)?.value ?? 0;
}

/** Apply the task's staleness note, if any, to a base label. */
function decorateLabel(taskId: string, label: string): string {
  const note = spawnStaleNotes.get(taskId);
  return note ? `${label} (${note})` : label;
}

/**
 * Start-of-probe marker for a fire-and-forget staleness probe. Returns the
 * task's current clear generation; pass it to setSpawnStaleNote so a note that
 * resolves after this spawn already cleared is dropped instead of decorating
 * the task's NEXT spawn. Touches the entry so the sweep cannot drop a baseline
 * out from under a probe that is still running.
 */
export function beginSpawnStaleProbe(taskId: string): number {
  const entry = spawnClearGenerations.get(taskId);
  if (!entry) return 0;
  entry.touchedAt = Date.now();
  return entry.value;
}

/**
 * Re-touch a task's clear-generation baseline from a probe that is still
 * alive. The drift probe queues on the per-project git lock at background
 * priority, so its wall-clock lifetime is its queue wait plus its own git
 * work and can exceed STALE_PROBE_HORIZON_MS on a busy queue. Calling this
 * when the probe actually starts running keeps the sweep from dropping (and a
 * later clear from re-numbering) the baseline its token compares against,
 * which could otherwise let a stale note decorate a newer spawn.
 */
export function touchSpawnStaleProbe(taskId: string): void {
  const entry = spawnClearGenerations.get(taskId);
  if (entry) entry.touchedAt = Date.now();
}

/**
 * Fired on a task's transition INTO or OUT OF the map (active=true/false),
 * never on a same-task label-only update - a listener that arms a stall
 * timer on `true` and disarms on `false` gets exactly the "arm on first
 * appearance, do not re-arm on phase change" behavior the desktop's own
 * spawn-stall toast uses, without duplicating that transition logic.
 */
type SpawnProgressTransitionListener = (taskId: string, active: boolean) => void;
const spawnProgressTransitionListeners = new Set<SpawnProgressTransitionListener>();

/** Subscribe to spawn-progress arm/disarm transitions. Returns an unsubscribe function. */
export function onSpawnProgressTransition(listener: SpawnProgressTransitionListener): () => void {
  spawnProgressTransitionListeners.add(listener);
  return () => spawnProgressTransitionListeners.delete(listener);
}

/**
 * TTL safety net. Longer than any realistic worktree-create + fetch + agent
 * spawn (those are bounded by AbortControllers anyway); this only catches the
 * pathological "never cleared" case. Normal cleanup is clearSpawnProgress().
 */
const SPAWN_PROGRESS_TTL_MS = 120_000;

/**
 * Update the queryable map and push the change to the renderer. The map is
 * updated UNCONDITIONALLY (before the destroyed-window guard) so it stays the
 * authoritative source of truth even when the send is skipped during teardown.
 * `label === null` removes the entry (spawn done/aborted).
 */
function pushSpawnProgress(mainWindow: BrowserWindow, taskId: string, label: string | null): void {
  const wasTracked = inFlightSpawnProgress.has(taskId);
  if (label === null) {
    inFlightSpawnProgress.delete(taskId);
    spawnStaleNotes.delete(taskId);
    pendingStaleNotes.delete(taskId);
    spawnClearGenerations.set(taskId, { value: currentClearGeneration(taskId) + 1, touchedAt: Date.now() });
  } else {
    // Promote a pending note the moment its spawn produces a label. The
    // generation re-check is belt and braces: a clear deletes pendings, so a
    // surviving entry is already same-spawn.
    const pending = pendingStaleNotes.get(taskId);
    if (pending) {
      pendingStaleNotes.delete(taskId);
      if (pending.probeGeneration === currentClearGeneration(taskId)) {
        spawnStaleNotes.set(taskId, pending.note);
      }
    }
    inFlightSpawnProgress.set(taskId, { label, updatedAt: Date.now() });
  }
  const isTracked = label !== null;
  if (wasTracked !== isTracked) {
    for (const listener of spawnProgressTransitionListeners) listener(taskId, isTracked);
  }
  if (mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.TASK_SPAWN_PROGRESS, taskId, label === null ? null : decorateLabel(taskId, label));
}

/**
 * Snapshot of in-flight spawn-progress labels, keyed by taskId. Prunes
 * TTL-expired entries on read. Returned by IPC.TASK_GET_SPAWN_PROGRESS so
 * syncSessions() can reconcile its spawnProgress map against live truth.
 */
export function getInFlightSpawnProgress(): Record<string, string> {
  const now = Date.now();
  const result: Record<string, string> = {};
  for (const [taskId, entry] of inFlightSpawnProgress) {
    if (now - entry.updatedAt > SPAWN_PROGRESS_TTL_MS) {
      inFlightSpawnProgress.delete(taskId);
      spawnStaleNotes.delete(taskId);
      continue;
    }
    result[taskId] = decorateLabel(taskId, entry.label);
  }
  // Bound the probe-bookkeeping maps: entries untouched past the horizon can
  // no longer influence any live probe (see the constant's JSDoc), and without
  // this sweep both maps grow with every task id ever spawned this session.
  for (const [taskId, generationEntry] of spawnClearGenerations) {
    if (now - generationEntry.touchedAt > STALE_PROBE_HORIZON_MS) {
      spawnClearGenerations.delete(taskId);
    }
  }
  for (const [taskId, pending] of pendingStaleNotes) {
    if (now - pending.storedAt > STALE_PROBE_HORIZON_MS) {
      pendingStaleNotes.delete(taskId);
    }
  }
  return result;
}

/**
 * Attach a staleness note to a task's in-flight spawn so every remaining
 * phase label carries it (e.g. "Starting agent... (base 3 behind)"). When an
 * entry exists, the current label is re-pushed immediately so the card updates
 * without waiting for the next phase boundary.
 *
 * With no in-flight entry, behavior depends on `probeGeneration`:
 * - Omitted: no-op. A caller without a probe token has no proof its spawn is
 *   still the live one, and must not decorate a future, unrelated spawn.
 * - From beginSpawnStaleProbe: the note is PENDED and applied to the task's
 *   next label push, but only while no clear has happened since the probe
 *   started. This is the reuse-spawn shape: the map is empty from the move
 *   until Phase 3's 'starting-agent', which is exactly when the drift probe
 *   tends to resolve.
 */
export function setSpawnStaleNote(
  mainWindow: BrowserWindow,
  taskId: string,
  note: string,
  probeGeneration?: number,
): void {
  const entry = inFlightSpawnProgress.get(taskId);
  if (entry) {
    if (probeGeneration !== undefined && probeGeneration !== currentClearGeneration(taskId)) {
      // The spawn that requested the probe ended and ANOTHER is already in
      // flight; its own probe (if any) owns the note.
      return;
    }
    spawnStaleNotes.set(taskId, note);
    pushSpawnProgress(mainWindow, taskId, entry.label);
    return;
  }
  if (probeGeneration === undefined) return;
  if (probeGeneration !== currentClearGeneration(taskId)) return;
  pendingStaleNotes.set(taskId, { note, probeGeneration, storedAt: Date.now() });
}

/** Test-only: reset the module-level maps between unit test cases. */
export function __resetSpawnProgressForTest(): void {
  inFlightSpawnProgress.clear();
  spawnStaleNotes.clear();
  pendingStaleNotes.clear();
  spawnClearGenerations.clear();
}

/** Valid spawn progress phases. */
export type SpawnPhase =
  | 'resuming'
  | 'fetching'
  | 'creating-worktree'
  | 'init-script'
  | 'switching-branch'
  | 'starting-agent'
  | 'packaging-handoff'
  | 'detecting-agent';

/** Phase → user-facing label (single source of truth for display text). */
const PHASE_LABELS: Record<SpawnPhase, string> = {
  // Emitted the instant a restore begins, before any git work. Unlike
  // 'fetching' (deliberately not emitted eagerly, because a queue wait would
  // masquerade as an active fetch), this one is always true when sent: the
  // restore IS starting. Without it the card holds its stale "Paused" for the
  // several seconds before the worktree helper produces its first phase.
  'resuming': 'Resuming session...',
  'fetching': 'Fetching latest...',
  'creating-worktree': 'Creating worktree...',
  'init-script': 'Running setup script...',
  'switching-branch': 'Switching branch...',
  'starting-agent': 'Starting agent...',
  'packaging-handoff': 'Packaging handoff context...',
  'detecting-agent': 'Detecting agent...',
};

/** Get the user-facing label for a spawn phase. */
export function phaseLabel(phase: SpawnPhase): string {
  return PHASE_LABELS[phase];
}

/**
 * Emit a spawn progress update to the renderer.
 * Sends the resolved label string (not the phase enum) so the renderer
 * doesn't need to import the phase map.
 */
export function emitSpawnProgress(
  mainWindow: BrowserWindow,
  taskId: string,
  phase: SpawnPhase,
): void {
  pushSpawnProgress(mainWindow, taskId, PHASE_LABELS[phase]);
}

/**
 * Translate an internal git-queue job label (e.g. `remove-worktree:1a2b3c4d`)
 * into a short, sentence-case phrase for the waiting card. The phrase LEADS the
 * label (e.g. "Removing worktree (waiting 45s)"), so it is capitalized to match
 * the active phase labels in PHASE_LABELS ("Fetching latest...", "Creating
 * worktree..."). Falls back to a generic phrase so a new label never leaks a raw
 * `verb:id` token to the user.
 */
function describeGitJobLabel(runningLabel: string): string {
  const kind = runningLabel.split(':')[0];
  switch (kind) {
    case 'remove-worktree':
    case 'cleanup-worktree':
    case 'retry-remove-worktree':
    case 'transition-cleanup':
    case 'stale-cleanup':
    case 'project-delete-worktree':
    case 'mcp-worktree':
      return 'Removing worktree';
    case 'create-worktree':
    case 'transition-ensure':
      return 'Creating worktree';
    case 'checkout-branch':
      return 'Switching branch';
    case 'rename-branch':
      return 'Renaming branch';
    case 'update-from-base':
      return 'Updating from base';
    case 'background-prune':
      return 'Pruning worktrees';
    default:
      return 'Git operation';
  }
}

/**
 * Emit a "waiting in the per-project git queue" label. Not a PHASE_LABELS
 * entry because it carries a runtime count - but it rides the same
 * pushSpawnProgress path, so it lands in the queryable map and is reconciled
 * by syncSessions / swept by the TTL exactly like a phase label. Used while a
 * spawn is parked behind another git op so the card shows a distinct waiting
 * state instead of a static "Fetching latest...".
 *
 * When `running` is provided, the label leads with what the queue is blocked
 * behind and tucks the wait state next to the elapsed (e.g. "Removing worktree
 * (waiting 45s)"). Leading with the action keeps the most informative token
 * first on a compact card; the lowercase "(waiting Ns)" qualifier sits next to
 * the timer so a parked task is never mistaken for one actively doing the work
 * (the active phase label would be "Creating worktree..."). Without a running op
 * to name, it degrades to the bare wait state. Re-emitting on a timer refreshes
 * the elapsed and the queryable map's TTL.
 */
export function emitSpawnWaiting(
  mainWindow: BrowserWindow,
  taskId: string,
  jobsAhead: number,
  running?: { label: string; elapsedMs: number },
): void {
  let label: string;
  if (running) {
    const seconds = Math.round(running.elapsedMs / 1000);
    label = `${describeGitJobLabel(running.label)} (waiting ${seconds}s)`;
  } else if (jobsAhead > 0) {
    label = `Waiting (${jobsAhead} ahead)`;
  } else {
    label = 'Waiting...';
  }
  pushSpawnProgress(mainWindow, taskId, label);
}

/**
 * Create an onProgress callback that emits spawn progress labels.
 * The callback accepts phase strings from the git layer and resolves
 * them to user-facing labels via the PHASE_LABELS map. Unknown phases
 * (e.g. raw git progress strings) are passed through verbatim.
 */
export function createProgressCallback(
  mainWindow: BrowserWindow,
  taskId: string,
): (phase: string) => void {
  return (phase: string) => {
    pushSpawnProgress(mainWindow, taskId, PHASE_LABELS[phase as SpawnPhase] ?? phase);
  };
}

/**
 * Clear spawn progress for a task (abort, error, or session arrived).
 * Sends null as the label to signal removal.
 */
export function clearSpawnProgress(
  mainWindow: BrowserWindow,
  taskId: string,
): void {
  pushSpawnProgress(mainWindow, taskId, null);
}
