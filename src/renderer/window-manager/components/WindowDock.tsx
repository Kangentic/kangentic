/**
 * Dock strip for minimized windows. A minimized window's frame is not rendered;
 * it lives here as a chip. Clicking a chip restores the window (to its
 * pre-minimize state) and focuses it. Sits at the bottom-left of the overlay,
 * always on top so it is never hidden behind a window.
 */

import { SquareTerminal } from 'lucide-react';
import { useWindowStore } from '../store/window-store';

// Above any window's zIndex (which grows from 1 per focus) but below the snap
// preview, so the dock is never covered by a window.
const DOCK_Z = 2147482000;

export function WindowDock() {
  const windows = useWindowStore((state) => state.windows);
  const restoreWindow = useWindowStore((state) => state.restoreWindow);
  const focusWindow = useWindowStore((state) => state.focusWindow);

  const minimized = Object.values(windows).filter((managedWindow) => managedWindow.state === 'minimized');
  if (minimized.length === 0) return null;

  return (
    <div
      className="pointer-events-auto absolute bottom-2 left-2 flex items-center gap-2"
      style={{ zIndex: DOCK_Z }}
    >
      {minimized.map((managedWindow) => (
        <button
          key={managedWindow.id}
          type="button"
          onClick={() => {
            restoreWindow(managedWindow.id);
            focusWindow(managedWindow.id);
          }}
          title={`Restore ${managedWindow.title}`}
          data-testid={`window-dock-${managedWindow.id}`}
          className="flex items-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-lg hover:bg-surface-hover transition-colors max-w-[220px]"
        >
          <SquareTerminal size={14} className="flex-shrink-0 text-fg-faint" />
          <span className="truncate">{managedWindow.title}</span>
        </button>
      ))}
    </div>
  );
}
