import { type StateCreator } from 'zustand';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import type { BoardStore } from './types';

export interface BoardConfigSlice {
  configWarnings: string[];
  pendingConfigChange: string | null;
  setConfigWarnings: (warnings: string[]) => void;
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

    // Switch project if needed
    const activeProjectId = useProjectStore.getState().currentProject?.id;
    if (projectId !== activeProjectId) {
      await useProjectStore.getState().openProject(projectId);
    }

    const warnings = await window.electronAPI.boardConfig.apply(projectId);
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
