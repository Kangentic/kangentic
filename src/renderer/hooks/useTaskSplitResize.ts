import { useState, useCallback, useRef, type RefObject } from 'react';
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

  // The live ratio while a drag is in flight; the stored ratio otherwise, so an
  // external change (switching to a different task, or the value being
  // cleared) shows at once and never mid-drag. Derived rather than resynced
  // from the store in an effect, the cascading-render shape React's compiler
  // rules forbid. The ref carries the latest value for the release handler.
  const [liveRatio, setLiveRatio] = useState(storedRatio);
  const [isResizing, setIsResizing] = useState(false);
  const latestRatioRef = useRef(storedRatio);
  const ratio = isResizing ? liveRatio : storedRatio;

  const onResizeStart = useCallback((event: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;

    setIsResizing(true);
    // Start the live ratio where the divider already is, so the first frame of
    // the drag (before any mousemove) does not jump.
    const startRatio = useSessionStore.getState().dividerRatio[taskId] ?? DEFAULT_SPLIT_RATIO;
    setLiveRatio(startRatio);
    latestRatioRef.current = startRatio;

    startPanelDrag(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0) return;
        const nextRatio = clampRatio((moveEvent.clientX - rect.left) / rect.width);
        setLiveRatio(nextRatio);
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
