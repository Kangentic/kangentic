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

import { Suspense, lazy, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import { WindowTitleBar } from './WindowTitleBar';
import { useWindowManager } from '../context';
import { TaskDetailWindow } from './TaskDetailWindow';
import { ConversationWindow } from './ConversationWindow';
import type { ManagedWindow } from '../store/types';
import { getRetainedTask } from '../bridge/retained-task-snapshots';

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

  if (managedWindow.kind === 'conversation') {
    return (
      <PanelErrorBoundary label="Conversation">
        <ConversationWindow
          managedWindow={managedWindow}
          isFocused={isFocused}
          isMaximized={isMaximized}
          titleBarPointerDown={titleBarPointerDown}
          requestClose={requestClose}
        />
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

/**
 * Task-detail content, dispatched to the LAYER. A layer that supplies
 * `renderTaskDetail` (the Agent Monitor, whose windows can belong to any project)
 * resolves its own task; the board layer omits it and falls through to the board
 * store below. The branch is on the layer, not the window, because what differs
 * is whose data a window reads.
 */
function TaskDetailContent(props: WindowContentProps) {
  const { layer } = useWindowManager();
  if (!layer.renderTaskDetail) return <BoardTaskDetailContent {...props} />;
  return (
    <>
      {layer.renderTaskDetail({
        anchor: props.managedWindow.anchor,
        windowId: props.managedWindow.id,
        title: props.managedWindow.title,
        isFocused: props.isFocused,
        isMaximized: props.isMaximized,
        initialEdit: props.managedWindow.initialEdit,
        titleBarPointerDown: props.titleBarPointerDown,
        requestClose: props.requestClose,
      })}
    </>
  );
}

/** The BOARD layer's task-detail content: resolve the task from the board store. */
function BoardTaskDetailContent({
  managedWindow,
  isFocused,
  isMaximized,
  titleBarPointerDown,
  requestClose,
}: WindowContentProps) {
  const retained = managedWindow.retainedProjectId !== undefined;
  // Skipped entirely for a retained window: its project is backgrounded, so this
  // scan can only ever miss, yet it would still run over the FOREGROUND
  // project's whole board on every board write. A retained window is meant to be
  // idle, not merely invisible.
  const liveTask = useBoardStore((state) =>
    retained
      ? null
      : state.tasks.find((candidate) => candidate.id === managedWindow.anchor)
        ?? state.archivedTasks.find((candidate) => candidate.id === managedWindow.anchor)
        ?? null,
  );
  // A retained window's project is backgrounded, so the project-scoped board
  // store no longer holds its row. Falling back to the frozen snapshot keeps the
  // subtree rendering, which is the only thing keeping its Browser pane's
  // <webview> guest alive. The fallback is gated on `retained` rather than on
  // `liveTask === null` so the deep-archive self-heal below still runs for an
  // ordinary window, and so un-retaining returns to live data with nothing stale
  // left behind.
  const task = liveTask ?? (retained ? getRetainedTask(managedWindow.anchor) : null);

  // Deep-archive self-heal: a window anchored to an archived task older than the
  // board's newest-N preview misses both lists. Pull the full archive so it can
  // resolve, and hold a viewer for the duration so hydration keeps the full list
  // loaded until this window closes or the task resolves. Normal (non-archived)
  // windows resolve from `tasks` immediately and never trigger this.
  const anchorUnresolved = task === null && !retained;
  useEffect(() => {
    if (!anchorUnresolved) return;
    useBoardStore.getState().acquireArchiveView();
    if (!useBoardStore.getState().archivedFullyLoaded) {
      void useBoardStore.getState().loadArchivedTasks().catch(() => {});
    }
    return () => { useBoardStore.getState().releaseArchiveView(); };
  }, [anchorUnresolved]);

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
      retainedProjectId={managedWindow.retainedProjectId}
    />
  );
}
