/**
 * The debounce + gate + serialize + save core for workspace persistence, factored
 * out of the React hook (`useWorkspacePersistence`) as a pure module so the exact
 * persistence logic is unit-testable in a tier with no jsdom (the repo pattern for
 * Zustand + DOM hooks) without dragging React or the stores into the test.
 *
 * The project id and the layout are read TOGETHER at persist time, so a save can
 * never write one project's windows under another's id even if a project switch lands
 * between the change and the debounce firing.
 */

import type { SerializedWorkspace } from '../../../shared/types';

/** Default settle delay before a layout change is written. The debounce coalesces a
 *  drag / resize / tile gesture's rapid updates into a single save. */
export const WORKSPACE_SAVE_DEBOUNCE_MS = 500;

export interface WorkspaceSaver {
  /** Schedule a debounced save of the current layout. */
  onChange: () => void;
  /** Persist the current layout immediately and SYNCHRONOUSLY (via saveSync), cancelling any
   *  pending debounce. Always writes, even with nothing pending, so a debounced async save
   *  still in flight can never be the last word before the renderer tears down on quit.
   *  No-op only when no project is open. */
  flush: () => void;
  /** Cancel any pending save and release the debounce timer. */
  dispose: () => void;
}

export function createWorkspaceSaver(deps: {
  getProjectId: () => string | null;
  getWorkspace: () => SerializedWorkspace;
  save: (projectId: string, workspace: SerializedWorkspace) => void;
  /** Synchronous persist used by flush() (e.g. on app quit) so the final layout is written
   *  before the renderer tears down. Defaults to `save` when omitted. */
  saveSync?: (projectId: string, workspace: SerializedWorkspace) => void;
  debounceMs?: number;
}): WorkspaceSaver {
  const { getProjectId, getWorkspace, save } = deps;
  const saveSync = deps.saveSync ?? save;
  const debounceMs = deps.debounceMs ?? WORKSPACE_SAVE_DEBOUNCE_MS;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const persist = (saveFn: (projectId: string, workspace: SerializedWorkspace) => void): void => {
    const projectId = getProjectId();
    if (!projectId) return; // no project open: nothing to persist to
    saveFn(projectId, getWorkspace());
  };

  return {
    onChange: () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        persist(save);
      }, debounceMs);
    },
    flush: () => {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      persist(saveSync);
    },
    dispose: () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}
