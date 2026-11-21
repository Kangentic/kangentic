import { useBrowserMouseNavigation } from '../../hooks/useBrowserMouseNavigation';

/**
 * Mounts mouse back and forward navigation for this window's Browser panes.
 * A leaf of its own, rendering nothing, so a change to the hook's hook list
 * remounts only this and never the window's tree, where a remount would end
 * every live Browser pane guest (hmr-patterns, hook signatures).
 */
export function BrowserMouseNavigation() {
  useBrowserMouseNavigation();
  return null;
}
