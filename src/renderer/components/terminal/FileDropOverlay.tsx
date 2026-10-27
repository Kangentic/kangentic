import { FileDown } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

/**
 * Persistent overlay that captures file drag-and-drop events above xterm's canvas.
 *
 * Always rendered but normally invisible (pointer-events: none). When a file drag
 * is active in the window, pointer-events switches to 'auto' so the overlay
 * intercepts dragover/drop instead of xterm's canvas. Visual highlight only
 * appears when the cursor is hovering over this specific overlay.
 */
interface FileDropOverlayProps {
  fileDragActive: boolean;
  hoveringOverlay: boolean;
  handleOverlayDragEnter: (event: React.DragEvent) => void;
  handleOverlayDragLeave: () => void;
  handleOverlayDragOver: (event: React.DragEvent) => void;
  handleOverlayDrop: (event: React.DragEvent) => void;
}

export function FileDropOverlay({
  fileDragActive,
  hoveringOverlay,
  handleOverlayDragEnter,
  handleOverlayDragLeave,
  handleOverlayDragOver,
  handleOverlayDrop,
}: FileDropOverlayProps) {
  return (
    <div
      className={`absolute inset-0 z-20 rounded ${
        hoveringOverlay ? 'bg-accent/5 ring-2 ring-inset ring-accent/40' : ''
      }`}
      style={{ pointerEvents: fileDragActive ? 'auto' : 'none' }}
      onDragEnter={handleOverlayDragEnter}
      onDragLeave={handleOverlayDragLeave}
      onDragOver={handleOverlayDragOver}
      onDrop={handleOverlayDrop}
    >
      {hoveringOverlay && (
        <span className="absolute bottom-4 right-3 flex items-center gap-1.5 text-xs text-fg-faint pointer-events-none">
          <FileDown size={13} />
          <Trans>Drop files to insert path</Trans>
        </span>
      )}
    </div>
  );
}
