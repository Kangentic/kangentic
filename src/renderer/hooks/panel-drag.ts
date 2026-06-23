import type { MouseEvent as ReactMouseEvent } from 'react';

export interface PanelDragOptions {
  /**
   * Body cursor for the duration of the drag, set immediately at mousedown.
   * Omit when the caller sets the cursor itself (the sidebar sets it lazily
   * after a dead zone). The cursor is always reset to '' on release regardless.
   */
  cursor?: 'col-resize' | 'row-resize';
  /** Fires on every mousemove with the live event. The caller does its own math. */
  onMove: (event: MouseEvent) => void;
  /** Fires once on release, after the listeners are removed and body styles reset. */
  onRelease: () => void;
}

/**
 * Shared pointer-drag gesture for the app-shell panel resizers (sidebar, bottom
 * terminal panel, task-detail divider). Owns the boilerplate that all three share:
 * preventDefault, the body userSelect lock, document mousemove/mouseup wiring, and
 * resetting body cursor + userSelect on release. Callers keep their own per-frame
 * math, clamping, persistence, and `terminal-panel-resize` dispatch in onMove /
 * onRelease.
 *
 * Imperative (no React state) by design, so callers invoke it from inside their own
 * onResizeStart useCallback without it entering a dependency array.
 */
export function startPanelDrag(event: ReactMouseEvent, options: PanelDragOptions): void {
  event.preventDefault();
  document.body.style.userSelect = 'none';
  if (options.cursor) document.body.style.cursor = options.cursor;

  const handleMove = options.onMove;

  const handleUp = () => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', handleMove);
    document.removeEventListener('mouseup', handleUp);
    options.onRelease();
  };

  document.addEventListener('mousemove', handleMove);
  document.addEventListener('mouseup', handleUp);
}
