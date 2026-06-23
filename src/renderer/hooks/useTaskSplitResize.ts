import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';
import { useSessionStore } from '../stores/session-store';
import { startPanelDrag } from './panel-drag';

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

function clampRatio(value: number): number {
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, value));
}

export interface TaskSplitResizeState {
  /** Fraction of horizontal space for the left (terminal) pane, clamped to [0.25, 0.75]. */
  ratio: number;
  isResizing: boolean;
  onResizeStart: (event: React.MouseEvent) => void;
}

/**
 * Drag-to-resize for the task-detail terminal / right-panel split. Drives the
 * gesture through the shared `startPanelDrag` helper (document mousemove/mouseup
 * wiring + body cursor/userSelect lock) and dispatches `terminal-panel-resize` on
 * release so the embedded xterm refits to its new width.
 *
 * The ratio is one shared value per task (keyed by `taskId` in the session
 * store), so the divider position is identical whether the Browser or Changes
 * view is showing. Local state drives live feedback during the drag; the store
 * is written once on release.
 */
export function useTaskSplitResize(
  taskId: string,
  containerRef: RefObject<HTMLDivElement | null>,
): TaskSplitResizeState {
  const storedRatio = useSessionStore((state) => state.dividerRatio[taskId] ?? DEFAULT_SPLIT_RATIO);
  const setDividerRatio = useSessionStore((state) => state.setDividerRatio);

  const [ratio, setRatio] = useState(storedRatio);
  const [isResizing, setIsResizing] = useState(false);
  const latestRatioRef = useRef(storedRatio);

  // Resync local state when the stored ratio changes externally (switching to a
  // different task, or the value being cleared), but never mid-drag.
  useEffect(() => {
    if (isResizing) return;
    setRatio(storedRatio);
    latestRatioRef.current = storedRatio;
  }, [storedRatio, isResizing]);

  const onResizeStart = useCallback((event: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;

    setIsResizing(true);

    startPanelDrag(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0) return;
        const nextRatio = clampRatio((moveEvent.clientX - rect.left) / rect.width);
        setRatio(nextRatio);
        latestRatioRef.current = nextRatio;
      },
      onRelease: () => {
        setIsResizing(false);
        setDividerRatio(taskId, latestRatioRef.current);
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
        });
      },
    });
  }, [containerRef, setDividerRatio, taskId]);

  return { ratio, isResizing, onResizeStart };
}
