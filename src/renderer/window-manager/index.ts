/**
 * Public surface of the renderer-side window-manager engine. Consumers outside
 * this folder import from here, not from internal modules.
 */

export { WindowLayer, WindowManagerLayer } from './components/WindowLayer';
export { WindowContent } from './components/WindowContent';
export { boardWindowManager, commandWindowManager, useWindowStore } from './store/window-store';
export type { WindowManager } from './store/window-store';
export { WindowManagerProvider, useWindowManager, useLayerStore } from './context';
export type { WindowManagerLayerOptions } from './context';
export { createWorkspaceSaver } from './persistence/workspace-saver';
export type { WorkspaceSaver } from './persistence/workspace-saver';
export { clearSnapPreviewDom } from './hmr';
export type { ManagedWindow, WindowState, WindowContentKind, FractionalRect, TileNode, SnapEdge } from './store/types';
