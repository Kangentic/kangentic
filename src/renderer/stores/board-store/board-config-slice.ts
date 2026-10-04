import { type StateCreator } from 'zustand';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import { describeIpcError } from '../../lib/ipc-error';
import type { BoardStore } from './types';

export interface BoardConfigSlice {
  configWarnings: string[];
  pendingConfigChange: string | null;
  setConfigWarnings: (warnings: string[]) => void;
  /** The project-open reconcile's warnings, pushed by main. Ignored for a project the user has left. */
  receiveOpenConfigWarnings: (projectId: string, warnings: string[]) => void;
  /**
   * Fetch the warnings of the project's last apply, for the push the renderer
   * dropped because the project was not current yet. Called when a project
   * becomes current. Deliberately not named `load*`: the HMR re-sync calls every
   * `load*` method on each Fast Refresh, which would bring back a banner the
   * user dismissed.
   */
  fetchOpenConfigWarnings: (projectId: string) => Promise<void>;
  dismissConfigWarnings: () => void;
  setPendingConfigChange: (projectId: string | null) => void;
  applyConfigChange: () => Promise<void>;
  dismissConfigChange: () => void;
}

export const createBoardConfigSlice: StateCreator<BoardStore, [], [], BoardConfigSlice> = (set, get) => ({
  configWarnings: [],
  pendingConfigChange: null,

  setConfigWarnings: (warnings) => {
    set({ configWarnings: warnings });
  },

  receiveOpenConfigWarnings: (projectId, warnings) => {
    // The reconcile is deferred past the open, so a fast switch can land the
    // push after the user has moved on. Banner only, no toasts: this fires on
    // every open, and the banner is what stays until the file is fixed.
    if (useProjectStore.getState().currentProject?.id !== projectId) return;
    set({ configWarnings: warnings });
  },

  fetchOpenConfigWarnings: async (projectId) => {
    let warnings: string[];
    try {
      warnings = await window.electronAPI.boardConfig.getLastWarnings(projectId);
    } catch {
      // The banner is advisory. A failed fetch leaves it as the push left it.
      return;
    }
    get().receiveOpenConfigWarnings(projectId, warnings);
  },

  dismissConfigWarnings: () => {
    set({ configWarnings: [] });
  },

  setPendingConfigChange: (projectId) => {
    set({ pendingConfigChange: projectId });
  },

  applyConfigChange: async () => {
    const projectId = get().pendingConfigChange;
    if (!projectId) return;
    set({ pendingConfigChange: null });

    // Switch project if needed. openProject never throws - it reports its
    // own failure (a toast, or the missing-path dialog) - so a switch that
    // did not land must be caught here explicitly, or `boardConfig.apply`
    // below would run against whatever project was actually still current.
    const activeProjectId = useProjectStore.getState().currentProject?.id;
    if (projectId !== activeProjectId) {
      const outcome = await useProjectStore.getState().openProject(projectId);
      if (outcome !== 'opened') return;
    }

    // Both callers fire this without awaiting it, so a throw that escapes here
    // is an unhandled rejection the user never sees (Sentry DESKTOP-1H). The
    // apply runs in one transaction in main, so a failure changed nothing and
    // there is no board to reload.
    let warnings: string[];
    try {
      warnings = await window.electronAPI.boardConfig.apply(projectId);
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Could not apply the kangentic.json change. ${describeIpcError(error)}`,
        variant: 'error',
      });
      return;
    }
    if (warnings.length > 0) {
      set({ configWarnings: warnings });
      for (const warning of warnings) {
        useToastStore.getState().addToast({ message: warning, variant: 'warning' });
      }
    } else {
      set({ configWarnings: [] });
    }
    await get().loadBoard();
  },

  dismissConfigChange: () => {
    set({ pendingConfigChange: null });
  },
});
