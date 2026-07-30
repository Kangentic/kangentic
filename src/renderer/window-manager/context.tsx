/**
 * React context that hands one window-manager INSTANCE (its bound store hook +
 * layer options + snap-preview controller) to a layer's subtree. The engine is
 * mounted twice - the board task-detail layer and the command-terminal layer -
 * and every shared component / DnD hook reads its instance from here instead of
 * importing a module singleton, so the two layers never cross-talk (separate
 * windows, tiling trees, focus, snap preview, and id space).
 */

import { createContext, useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { WindowManager } from './store/window-store';
import { createSnapPreviewController } from './dnd/snap-preview-controller';
import type { SnapPreviewController } from './dnd/snap-preview-controller';

/** Per-layer presentation options (not part of the store's state). */
export interface WindowManagerLayerOptions {
  /** Pixel floor for a MANUALLY resized window in this layer. */
  minSize: { width: number; height: number };
  /**
   * How this layer turns a task-detail window into rendered content.
   *
   * Omitted by the board layer, which resolves its task from the board store
   * because its windows always belong to the open project. The Agent Monitor's
   * layer supplies one, because ITS windows can belong to any project and must
   * resolve through a per-project bundle plus its own host context instead.
   *
   * A hook on the layer rather than a `kind` branch inside `WindowContent`: the
   * difference is whose data a window reads, which is a property of the layer,
   * not of the window.
   */
  renderTaskDetail?: (input: TaskDetailRenderInput) => ReactNode;
}

/** What a layer's `renderTaskDetail` receives. Mirrors WindowContent's props. */
export interface TaskDetailRenderInput {
  /** The window's durable anchor. Board: a taskId. Monitor: `projectId:taskId`. */
  anchor: string;
  windowId: string;
  title: string;
  isFocused: boolean;
  isMaximized: boolean;
  initialEdit?: boolean;
  titleBarPointerDown: (event: React.PointerEvent) => void;
  requestClose: () => void;
}

export interface WindowManagerContextValue {
  /** The layer's window-manager instance: `store` (bound hook + api) + `options`. */
  manager: WindowManager;
  /** Per-layer presentation options. */
  layer: WindowManagerLayerOptions;
  /** The layer's isolated snap-preview controller. */
  snap: SnapPreviewController;
}

const WindowManagerContext = createContext<WindowManagerContextValue | null>(null);

interface WindowManagerProviderProps {
  manager: WindowManager;
  layer: WindowManagerLayerOptions;
  /** Optional pre-built controller (a layer creates one stable instance and passes
   *  it so the same controller drives both `SnapPreview` and the DnD hooks). */
  snap: SnapPreviewController;
  children: ReactNode;
}

export function WindowManagerProvider({ manager, layer, snap, children }: WindowManagerProviderProps) {
  const value = useMemo<WindowManagerContextValue>(() => ({ manager, layer, snap }), [manager, layer, snap]);
  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>;
}

export function useWindowManager(): WindowManagerContextValue {
  const value = useContext(WindowManagerContext);
  if (!value) {
    throw new Error('useWindowManager must be used within a WindowManagerProvider');
  }
  return value;
}

/** The bound Zustand store hook for the current layer. Call it with a selector
 *  (`useLayerStore()((state) => state.windows)`) or use `.getState()` imperatively. */
export function useLayerStore(): WindowManager['store'] {
  return useWindowManager().manager.store;
}

/** A stable snap-preview controller for one layer mount. Built once via a ref
 *  (NOT `useMemo`, which React is permitted to discard and rebuild) so the
 *  imperatively-registered preview element is never silently dropped mid-mount. */
export function useSnapPreviewController(): SnapPreviewController {
  const controllerRef = useRef<SnapPreviewController | null>(null);
  if (!controllerRef.current) controllerRef.current = createSnapPreviewController();
  return controllerRef.current;
}
