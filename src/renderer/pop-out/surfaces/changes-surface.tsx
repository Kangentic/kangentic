import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { PopOutChangesRoot } from '../roots/PopOutChangesRoot';
import { loadAmbientBoard } from '../load-ambient-board';
import type { SurfaceDescriptor } from '../surface-registry';

export const changesSurface: SurfaceDescriptor<'changes'> = {
  kind: 'changes',
  Root: PopOutChangesRoot,

  bootstrap: (_params, context) => {
    void useProjectStore.getState().loadProjects();
    loadAmbientBoard(context.signal);
    // Live diff updates are handled internally by ChangesPanel itself
    // (git.subscribeDiff / onDiffChanged on mount) - no separate push wiring needed here.
  },

  hmrResync: () => {
    void useBoardStore.getState().loadBoard();
  },

  inAppSurface: 'task-changes',
};
