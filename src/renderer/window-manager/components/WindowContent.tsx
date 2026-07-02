/**
 * Window body host. Routes on the window's `kind` to the right content surface:
 *  - `command-terminal` -> `CommandTerminalWindow` (lazy, to avoid a static engine
 *    -> command-bar import cycle), hosting the transient terminal + its controls;
 *  - `task-detail` -> `TaskDetailWindow`, resolved from the board store by anchor
 *    (the taskId). A task can be on the board (`tasks`) or archived
 *    (`archivedTasks`); when neither has it (a just-deleted task during the frame's
 *    exit animation, or a stale window), a quiet placeholder is shown.
 *
 * The window's drag handle and animated close are forwarded from `WindowFrame`;
 * the content reads its maximize state from the window store via its `windowId`.
 */

import { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import { WindowTitleBar } from './WindowTitleBar';
import { TaskDetailWindow } from './TaskDetailWindow';
import type { ManagedWindow } from '../store/types';

const CommandTerminalWindow = lazy(() =>
  import('../../components/command-bar/CommandTerminalWindow').then((module) => ({ default: module.CommandTerminalWindow })),
);

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
  if (managedWindow.kind === 'command-terminal') {
    return (
      <PanelErrorBoundary label="Command Terminal">
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center">
              <Loader2 size={20} className="animate-spin text-fg-muted" />
            </div>
          }
        >
          <CommandTerminalWindow
            managedWindow={managedWindow}
            isMaximized={isMaximized}
            titleBarPointerDown={titleBarPointerDown}
          />
        </Suspense>
      </PanelErrorBoundary>
    );
  }

  return <TaskDetailContent
    managedWindow={managedWindow}
    isFocused={isFocused}
    isMaximized={isMaximized}
    titleBarPointerDown={titleBarPointerDown}
    requestClose={requestClose}
  />;
}

/** Task-detail content: resolve the task from the board store by anchor. */
function TaskDetailContent({
  managedWindow,
  isFocused,
  isMaximized,
  titleBarPointerDown,
  requestClose,
}: WindowContentProps) {
  const task = useBoardStore((state) =>
    state.tasks.find((candidate) => candidate.id === managedWindow.anchor)
    ?? state.archivedTasks.find((candidate) => candidate.id === managedWindow.anchor)
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
