import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { PopOutBrowserRoot } from '../roots/PopOutBrowserRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const browserSurface: SurfaceDescriptor<'browser'> = {
  kind: 'browser',
  Root: PopOutBrowserRoot,

  bootstrap: (_params, _context) => {
    void useProjectStore.getState().loadProjects();
    void useProjectStore.getState().loadCurrent();
    void useBoardStore.getState().loadBoard();
    void useSessionStore.getState().syncSessions();
    // No push subscription needed: BrowserPane manages its own guest
    // registration/zoom/navigation wiring internally on mount.
  },

  hmrResync: () => {
    void useBoardStore.getState().loadBoard();
    void useSessionStore.getState().syncSessions();
  },

  inAppSurface: 'browser-pane',
};
