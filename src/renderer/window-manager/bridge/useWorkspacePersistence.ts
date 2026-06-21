/**
 * Debounced save of the in-app window layout to the open project's config
 * (`AppConfig.workspaceByProject`). Subscribes to the window-store and, ~500ms after
 * the layout settles, serializes it and writes it (keyed by the active project id)
 * through the global-config `config.set` path. The debounce coalesces rapid changes
 * (drag, focus, tile) into one write; a `beforeunload` flush persists the current layout
 * synchronously so the last arrangement made just before quitting is saved even if a
 * debounced async write is still in flight.
 *
 * Gated on the ACTIVE project, not the Settings panel, so it persists during normal
 * board use. Mounted once by WindowLayer; no-ops when no project is open. Restore is
 * the inverse, wired into the project-switch effect (after sessions resolve). The
 * debounce/gate/flush state machine itself lives in the pure `workspace-saver` module.
 */

import { useEffect } from 'react';
import { useWindowStore } from '../store/window-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { createWorkspaceSaver } from '../persistence/workspace-saver';

export function useWorkspacePersistence(): void {
  const saveWorkspaceForProject = useConfigStore((state) => state.saveWorkspaceForProject);
  const flushWorkspaceForProject = useConfigStore((state) => state.flushWorkspaceForProject);

  useEffect(() => {
    const saver = createWorkspaceSaver({
      getProjectId: () => useProjectStore.getState().currentProject?.id ?? null,
      getWorkspace: () => useWindowStore.getState().serializeWorkspace(),
      save: saveWorkspaceForProject,
      saveSync: flushWorkspaceForProject,
    });
    const unsubscribe = useWindowStore.subscribe(saver.onChange);
    // Persist synchronously before the renderer tears down, so the very last arrangement
    // made before quitting reaches disk even if a debounced async save is still in flight.
    const flushBeforeUnload = (): void => saver.flush();
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload);
      unsubscribe();
      saver.dispose();
    };
  }, [saveWorkspaceForProject, flushWorkspaceForProject]);
}
