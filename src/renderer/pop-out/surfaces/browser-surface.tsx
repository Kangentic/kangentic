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
    // BrowserPane manages its own guest registration and zoom wiring on mount.
    // The one push this window adds, a link relayed from the main window, is
    // subscribed in PopOutBrowserRoot, which knows the pane's owner key.
  },

  hmrResync: () => {
    void useBoardStore.getState().loadBoard();
    void useSessionStore.getState().syncSessions();
  },

  inAppSurface: 'browser-pane',
};
