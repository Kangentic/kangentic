/**
 * Window body host. Resolves the window's task from the board store and renders
 * the full task-detail surface (`TaskDetailWindow`), which owns its own title
 * bar (the window drag handle) plus the terminal / changes / browser / edit
 * form. The window's drag handle and animated close are forwarded from
 * `WindowFrame`; the content reads its maximize state from the window store
 * directly via its `windowId`.
 *
 * A task can be on the board (`tasks`) or archived (`archivedTasks`, opened from
 * the Completed Tasks list). When neither has it (a just-deleted task during the
 * frame's exit animation, or a stale window), there is nothing to show: the
 * frame is closing, so we render a quiet placeholder rather than the modal's old
 * "No live session" terminal shell.
 */

import { useBoardStore } from '../../stores/board-store';
import { WindowTitleBar } from './WindowTitleBar';
import { TaskDetailWindow } from './TaskDetailWindow';
import type { ManagedWindow } from '../store/types';

interface WindowContentProps {
  managedWindow: ManagedWindow;
  isFocused: boolean;
  isMaximized: boolean;
  /** Pointer-down on the title bar starts the window drag (owned by WindowFrame). */
  titleBarPointerDown: (event: React.PointerEvent) => void;
  /** Animated, guard-aware window close (overlay-phase exit -> closeWindow). */
  requestClose: () => void;
}

export function WindowContent({
  managedWindow,
  isFocused,
  isMaximized,
  titleBarPointerDown,
  requestClose,
}: WindowContentProps) {
  const task = useBoardStore((state) =>
    state.tasks.find((candidate) => candidate.id === managedWindow.taskId)
    ?? state.archivedTasks.find((candidate) => candidate.id === managedWindow.taskId)
    ?? null,
  );

  if (!task) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <WindowTitleBar
          title={managedWindow.title}
          windowId={managedWindow.id}
          isMaximized={isMaximized}
          onHandlePointerDown={titleBarPointerDown}
          onRequestClose={requestClose}
        />
        <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-fg-faint">
          This task is no longer available.
        </div>
      </div>
    );
  }

  return (
    <TaskDetailWindow
      task={task}
      windowId={managedWindow.id}
      isFocused={isFocused}
      isMaximized={isMaximized}
      initialEdit={managedWindow.initialEdit}
      titleBarPointerDown={titleBarPointerDown}
      requestClose={requestClose}
    />
  );
}
