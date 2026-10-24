import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { PopOutBrowserRoot } from '../roots/PopOutBrowserRoot';
import { loadAmbientBoard } from '../load-ambient-board';
import type { SurfaceDescriptor } from '../surface-registry';

export const browserSurface: SurfaceDescriptor<'browser'> = {
  kind: 'browser',
  Root: PopOutBrowserRoot,

  bootstrap: (_params, context) => {
    void useProjectStore.getState().loadProjects();
    // Only the window's title reads the board. The pane resolves its task by
    // params and syncs the session list itself (PopOutBrowserRoot), so neither
    // waits on a board that may not hold the task.
    loadAmbientBoard(context.signal);
    // No push subscription needed: BrowserPane manages its own guest
    // registration/zoom/navigation wiring internally on mount.
  },

  hmrResync: () => {
    void useBoardStore.getState().loadBoard();
    void useSessionStore.getState().syncSessions();
  },

  inAppSurface: 'browser-pane',
};
