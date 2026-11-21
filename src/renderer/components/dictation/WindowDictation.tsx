import { DictationHost } from './DictationHost';
import { DictationSurface } from './DictationSurface';
import { BrowserMouseNavigation } from './BrowserMouseNavigation';

/**
 * Push-to-talk, its chip, and mouse back and forward navigation for one
 * window. Each window is its own renderer, so the main window (`AppLayout`) and
 * every pop-out (`PopOutSurfaceRoot`) mount this once. Main sends a session's
 * text to the window that started it, and a pop-out's blur from its own
 * `BrowserWindow`.
 *
 * Mounted outside any `data-dismiss-layer` subtree, like the toasts. Each hook
 * sits in its own null-rendering leaf, so a hook-list change never remounts the
 * window's tree and a live Browser pane guest with it.
 */
export function WindowDictation() {
  return (
    <>
      <DictationHost />
      <DictationSurface />
      <BrowserMouseNavigation />
    </>
  );
}
