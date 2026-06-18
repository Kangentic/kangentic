/**
 * Eight resize handles (4 edges + 4 corners) on the window border. Each handle
 * only STARTS the gesture (pointerdown); `useWindowResize` (owned by WindowFrame)
 * captures the pointer on the frame and the frame's move/up drive the resize, so
 * pointermove is reliably delivered even when the cursor leaves the thin handle.
 *
 * The handles sit at the frame's perimeter (z-20); the title-bar controls are
 * raised above them (z-30, see WindowTitleBar) so the close/maximize buttons
 * stay clickable at the top corners.
 */

import type { ResizeDirection } from '../dnd/useWindowResize';

const HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: 'n', className: 'top-0 left-0 right-0 h-1.5 cursor-ns-resize' },
  { direction: 's', className: 'bottom-0 left-0 right-0 h-1.5 cursor-ns-resize' },
  { direction: 'w', className: 'left-0 top-0 bottom-0 w-1.5 cursor-ew-resize' },
  { direction: 'e', className: 'right-0 top-0 bottom-0 w-1.5 cursor-ew-resize' },
  { direction: 'nw', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { direction: 'ne', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { direction: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { direction: 'se', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

interface WindowResizeHandlesProps {
  windowId: string;
  onHandlePointerDown: (direction: ResizeDirection) => (event: React.PointerEvent) => void;
}

export function WindowResizeHandles({ windowId, onHandlePointerDown }: WindowResizeHandlesProps) {
  return (
    <>
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          data-testid={`window-resize-${windowId}-${direction}`}
          className={`absolute z-20 ${className}`}
          onPointerDown={onHandlePointerDown(direction)}
        />
      ))}
    </>
  );
}
