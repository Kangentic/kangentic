import { useCallback, useEffect, useRef, useState } from 'react';
import { convertPathForShell, formatImageReference, quoteForShell } from '../utils/terminal-clipboard';

/** Extensions recognized as an image drop. `File.type` can be empty for some
 *  drag sources, so extension is checked alongside the MIME type. */
const IMAGE_FILE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXTENSIONS.test(file.name);
}

/**
 * Hook that manages file drag-and-drop onto a terminal.
 *
 * xterm.js renders a canvas that swallows all drag events, so a permanent
 * overlay div sits on top of the terminal. Normally it has pointer-events:none
 * (invisible to interaction). When a file drag enters the window, pointer-events
 * switches to 'auto' so the overlay captures dragover/drop instead of xterm.
 *
 * A window-level dragenter listener detects when files enter the app, and the
 * overlay's own dragleave/drop reset the state when the cursor leaves or drops.
 */
export function useTerminalFileDrop(
  sessionId: string | null,
  focusTerminal: () => void,
  shellName?: string,
  /** Adapter-declared template (see `AgentDetectionInfo.pastedImageReferenceTemplate`) applied
   *  to a dropped image file so the agent reliably reads it as an image. Non-image drops
   *  (e.g. a dropped .txt file) always get the bare quoted path. */
  pasteImageTemplate?: string,
) {
  const [fileDragActive, setFileDragActive] = useState(false);
  const windowDragCounterRef = useRef(0);

  // Track when ANY file drag enters/leaves the window so overlays become interactive.
  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        windowDragCounterRef.current++;
        if (windowDragCounterRef.current === 1) {
          setFileDragActive(true);
        }
      }
    };
    const handleDragLeave = () => {
      windowDragCounterRef.current--;
      if (windowDragCounterRef.current <= 0) {
        windowDragCounterRef.current = 0;
        setFileDragActive(false);
      }
    };
    const handleReset = () => {
      windowDragCounterRef.current = 0;
      setFileDragActive(false);
    };
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragend', handleReset);
    document.addEventListener('drop', handleReset);
    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragend', handleReset);
      document.removeEventListener('drop', handleReset);
    };
  }, []);

  // Track whether the cursor is hovering over THIS terminal's overlay.
  const [hoveringOverlay, setHoveringOverlay] = useState(false);
  const overlayDragCounterRef = useRef(0);

  const handleOverlayDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    overlayDragCounterRef.current++;
    if (overlayDragCounterRef.current === 1) {
      setHoveringOverlay(true);
    }
  }, []);

  const handleOverlayDragLeave = useCallback(() => {
    overlayDragCounterRef.current--;
    if (overlayDragCounterRef.current <= 0) {
      overlayDragCounterRef.current = 0;
      setHoveringOverlay(false);
    }
  }, []);

  const handleOverlayDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleOverlayDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setHoveringOverlay(false);
    overlayDragCounterRef.current = 0;
    setFileDragActive(false);
    windowDragCounterRef.current = 0;

    if (!event.dataTransfer?.files.length || !sessionId) return;

    const paths: string[] = [];
    for (const file of event.dataTransfer.files) {
      let filePath = window.electronAPI.webUtils.getPathForFile(file);
      if (filePath) {
        if (shellName) filePath = convertPathForShell(filePath, shellName);
        const quotedPath = quoteForShell(filePath, shellName);
        paths.push(isImageFile(file) ? formatImageReference(quotedPath, pasteImageTemplate) : quotedPath);
      }
    }
    if (paths.length > 0) {
      window.electronAPI.sessions.write(sessionId, paths.join(' '));
      focusTerminal();
    }
  }, [sessionId, focusTerminal, shellName, pasteImageTemplate]);

  return {
    /** True when a file drag is active anywhere in the window (overlay becomes interactive). */
    fileDragActive,
    /** True when the cursor is hovering over this specific terminal's overlay. */
    hoveringOverlay,
    handleOverlayDragEnter,
    handleOverlayDragLeave,
    handleOverlayDragOver,
    handleOverlayDrop,
  };
}
