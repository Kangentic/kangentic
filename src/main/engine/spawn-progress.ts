import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';

// ---------------------------------------------------------------------------
// Spawn progress: typed phases emitted to the renderer during task move
//
// Mirrors session-lifecycle.ts pattern: typed phases, centralized labels,
// pure functions. The main process emits progress at phase boundaries;
// the renderer stores the latest label per task and displays it.
//
// Phase flow (contextual per task):
//   Worktree task:      fetching → creating-worktree → starting-agent
//   Custom branch task: fetching → switching-branch  → starting-agent
//   Base branch task:   starting-agent
//   Has worktree:       starting-agent
// ---------------------------------------------------------------------------

/** Valid spawn progress phases. */
export type SpawnPhase =
  | 'fetching'
  | 'creating-worktree'
  | 'switching-branch'
  | 'starting-agent';

/** Phase → user-facing label (single source of truth for display text). */
const PHASE_LABELS: Record<SpawnPhase, string> = {
  'fetching': 'Fetching latest...',
  'creating-worktree': 'Creating worktree...',
  'switching-branch': 'Switching branch...',
  'starting-agent': 'Starting agent...',
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
  if (mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.TASK_SPAWN_PROGRESS, taskId, PHASE_LABELS[phase]);
}

/**
 * Create an onProgress callback that emits spawn progress labels.
 * The callback accepts phase strings from the git layer and resolves
 * them to user-facing labels via the PHASE_LABELS map.
 */
export function createProgressCallback(
  mainWindow: BrowserWindow,
  taskId: string,
): (phase: string) => void {
  return (phase: string) => {
    if (mainWindow.isDestroyed()) return;
    const label = PHASE_LABELS[phase as SpawnPhase] ?? phase;
    mainWindow.webContents.send(IPC.TASK_SPAWN_PROGRESS, taskId, label);
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
  if (mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.TASK_SPAWN_PROGRESS, taskId, null);
}
