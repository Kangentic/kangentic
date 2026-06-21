/**
 * Public surface of the renderer-side window-manager engine. Consumers outside
 * this folder import from here, not from internal modules.
 */

export { WindowLayer } from './components/WindowLayer';
export { useWindowStore } from './store/window-store';
export { clearSnapPreviewDom } from './hmr';
export type { ManagedWindow, WindowState, FractionalRect, TileNode, SnapEdge } from './store/types';
