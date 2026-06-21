/**
 * Debounced save of the in-app window layout to the open project's config
 * (`AppConfig.workspace`). Subscribes to the window-store and, ~500ms after the
 * layout settles, serializes it and writes it through the project-override config
 * path. The debounce coalesces rapid changes (drag, focus, tile) into one write
 * and rides out a project-switch transition, so only the settled layout is saved.
 *
 * Mounted once by WindowLayer; no-ops when no project is open. Restore is the
 * inverse, wired into the project-switch effect (after sessions resolve).
 */

import { useEffect } from 'react';
import { useWindowStore } from '../store/window-store';
import { useConfigStore } from '../../stores/config-store';

const WORKSPACE_SAVE_DEBOUNCE_MS = 500;

export function useWorkspacePersistence(): void {
  const projectSettingsPath = useConfigStore((state) => state.projectSettingsPath);
  const updateProjectOverride = useConfigStore((state) => state.updateProjectOverride);

  useEffect(() => {
    if (!projectSettingsPath) return; // no project open: nothing to persist to
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useWindowStore.subscribe(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        updateProjectOverride({ workspace: useWindowStore.getState().serializeWorkspace() });
      }, WORKSPACE_SAVE_DEBOUNCE_MS);
    });
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      unsubscribe();
    };
  }, [projectSettingsPath, updateProjectOverride]);
}
