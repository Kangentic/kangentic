import { useEffect, useState } from 'react';
import { boardWindowManager, commandWindowManager } from '../window-manager';

/** A focused terminal window's rect in viewport (CSS pixel) coordinates. */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

/**
 * Measure the currently-focused board/command terminal WINDOW frame directly
 * from the DOM (each frame carries `data-testid="window-frame-<id>"`), so the
 * result is a true viewport rect regardless of floating / tiled / maximized
 * layout. Command windows take priority over board windows (matching
 * `resolveDictationTarget`). Returns null when no window is focused/rendered -
 * the bottom-panel case, where the caller falls back to its fixed position.
 */
function measureFocusedWindowRect(): AnchorRect | null {
  const candidateIds = [
    commandWindowManager.store.getState().focusedWindowId,
    boardWindowManager.store.getState().focusedWindowId,
  ];
  for (const windowId of candidateIds) {
    if (!windowId) continue;
    const frame = document.querySelector(`[data-testid="window-frame-${windowId}"]`);
    if (!frame) continue;
    const rect = frame.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right,
      };
    }
  }
  return null;
}

function sameRect(first: AnchorRect | null, second: AnchorRect | null): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    first.left === second.left &&
    first.top === second.top &&
    first.width === second.width &&
    first.height === second.height
  );
}

/**
 * The focused terminal window's live viewport rect, or null when none is focused
 * (bottom panel / no terminal). Re-measures every animation frame while mounted
 * so a dictation surface anchored to it follows focus changes, drags, resizes,
 * and maximize in real time. Only mounted while a dictation surface is visible,
 * so the rAF loop is short-lived. State updates only on an actual change.
 */
export function useFocusedTerminalRect(): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(measureFocusedWindowRect);
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const next = measureFocusedWindowRect();
      setRect((previous) => (sameRect(previous, next) ? previous : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return rect;
}
