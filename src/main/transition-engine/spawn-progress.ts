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
//   Base branch task:   starting-agent
//   Has worktree:       starting-agent
//   Cross-agent:        packaging-handoff → detecting-agent → starting-agent
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
  } else {
    inFlightSpawnProgress.set(taskId, { label, updatedAt: Date.now() });
  }
  const isTracked = label !== null;
  if (wasTracked !== isTracked) {
    for (const listener of spawnProgressTransitionListeners) listener(taskId, isTracked);
  }
  if (mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.TASK_SPAWN_PROGRESS, taskId, label);
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
      continue;
    }
    result[taskId] = entry.label;
  }
  return result;
}

/** Test-only: reset the module-level map between unit test cases. */
export function __resetSpawnProgressForTest(): void {
  inFlightSpawnProgress.clear();
}

/** Valid spawn progress phases. */
export type SpawnPhase =
  | 'fetching'
  | 'creating-worktree'
  | 'init-script'
  | 'switching-branch'
  | 'starting-agent'
  | 'packaging-handoff'
  | 'detecting-agent';

/** Phase → user-facing label (single source of truth for display text). */
const PHASE_LABELS: Record<SpawnPhase, string> = {
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
