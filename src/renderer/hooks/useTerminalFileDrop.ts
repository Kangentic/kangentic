import { useCallback, useEffect, useRef, useState } from 'react';
import type { PastedImageCapability } from '../../shared/types';
import { encodeImageFileAsPng } from '../components/dialogs/image-compress';
import {
  convertPathForShell,
  needsImageNormalization,
  pasteDroppedItems,
  quoteForShell,
  resolveImagePasteText,
} from '../utils/terminal-clipboard';

/** Extensions recognized as an image drop. `File.type` can be empty for some
 *  drag sources, so extension is checked alongside the MIME type. This is the
 *  "is it an image at all" predicate, which decides whether the adapter's
 *  fallback template applies; which of these the CLI attaches natively is the
 *  adapter's own `pastedImageNativeExtensions`, a deliberately separate set
 *  (bmp and svg are images here and outside Claude's native set). */
const IMAGE_FILE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXTENSIONS.test(file.name);
}

/** A PNG copy of a dropped image the agent cannot take as-is, decoded here
 *  (Chromium reads every format `<img>` does) and saved by main next to the
 *  clipboard captures. Null when the bytes do not decode or the write failed,
 *  so the caller keeps the original path and the fallback text. */
async function normalizeImageForPaste(file: File): Promise<string | null> {
  const pngBytes = await encodeImageFileAsPng(file);
  if (!pngBytes) return null;
  try {
    return await window.electronAPI.clipboard.saveImage(pngBytes);
  } catch {
    return null;
  }
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
  /** `useTerminal`'s `paste` handle: delivers text through xterm's paste(), so a
   *  dropped path reaches the PTY the way a native terminal delivers a drop
   *  (bracketed when the foreground app enabled mode 2004, plain at a shell
   *  prompt). Never a raw `sessions.write`: an agent TUI's path scan runs only
   *  on a paste packet. Returns false when no xterm is mounted to receive it. */
  pasteText: (text: string) => boolean,
  shellName?: string,
  /** Adapter-declared image-paste capability (see `PastedImageCapability`), which
   *  decides the text pasted for a dropped image: the bare quoted path for an
   *  extension the CLI attaches natively, the fallback template otherwise.
   *  Non-image drops (e.g. a dropped .txt file) always get the bare quoted path. */
  pasteImageCapability?: PastedImageCapability,
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

  // Drops deliver in the order they landed. A drop that needs a PNG copy waits
  // on a decode and an IPC round trip, so a second drop arriving meanwhile
  // would otherwise start its own delivery and interleave its packets with the
  // first's (and the separator rule is per delivery, so `b.png` and `c.png`
  // could fuse). Each delivery is chained behind the previous one.
  const deliveryQueueRef = useRef<Promise<void>>(Promise.resolve());

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

    // Snapshot the drop SYNCHRONOUSLY: a DataTransfer is only readable while its
    // event dispatches, and the path is a native lookup on the File that the
    // async work below must not outlive.
    const dropped: { file: File; filePath: string }[] = [];
    for (const file of event.dataTransfer.files) {
      const filePath = window.electronAPI.webUtils.getPathForFile(file);
      if (filePath) dropped.push({ file, filePath });
    }
    if (dropped.length === 0) return;

    const deliver = async (): Promise<void> => {
      const items: string[] = [];
      for (const { file, filePath } of dropped) {
        const isImage = isImageFile(file);
        // An image the agent attaches natively from a path, but not in THIS
        // format (a bmp), is re-encoded as PNG by the renderer and saved by main
        // next to the clipboard captures, so it attaches instead of arriving as
        // fallback text. Sequential on purpose: order is the order dropped.
        const normalizedPath = isImage && needsImageNormalization(filePath, pasteImageCapability)
          ? await normalizeImageForPaste(file)
          : null;
        const effectivePath = normalizedPath ?? filePath;
        const shellPath = shellName ? convertPathForShell(effectivePath, shellName) : effectivePath;
        const quotedPath = quoteForShell(shellPath, shellName);
        items.push(
          isImage && !normalizedPath
            ? resolveImagePasteText(quotedPath, shellPath, pasteImageCapability)
            : quotedPath,
        );
      }

      // One paste() per item (see pasteDroppedItems for why). The overlay is
      // mounted a frame before useTerminal's deferred initTerminal has built the
      // xterm, so a drop landing in that frame has nowhere to go; writing the
      // bytes raw into the PTY instead is not a delivery either, so the gesture
      // is dropped and focus is left alone.
      if (!pasteDroppedItems(items, pasteText)) return;
      // arrival-focus-ok: the user just dropped files on THIS terminal and its paths
      // were pasted into that PTY, so focus belongs here.
      focusTerminal();
    };
    // The catch keeps the chain settled: a delivery that throws (an xterm
    // disposed mid-paste) must not leave every later drop skipped behind a
    // rejected link.
    deliveryQueueRef.current = deliveryQueueRef.current.then(deliver).catch(() => undefined);
  }, [sessionId, focusTerminal, pasteText, shellName, pasteImageCapability]);

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
