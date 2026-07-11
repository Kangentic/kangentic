/**
 * Shared descriptor contract for the pop-out window engine: any registered UI surface
 * (usage stats, git changes, the task Browser pane) can detach into its own OS-level
 * BrowserWindow. This module is the single source of truth both processes reference for
 * the `kind` union, params shapes, and the window-instance keying scheme, so the main
 * process's window registry and the renderer's pop-out store never drift.
 *
 * Distinct from `src/renderer/window-manager/` (movable DIVs inside the single
 * BrowserWindow) - this module concerns real second OS windows.
 */

import { IPC } from './ipc-channels';

export type PopOutKind = 'stats' | 'changes' | 'browser';

export const POPOUT_KINDS: readonly PopOutKind[] = ['stats', 'changes', 'browser'];

export function isPopOutKind(value: string): value is PopOutKind {
  return (POPOUT_KINDS as readonly string[]).includes(value);
}

export interface PopOutTaskParams {
  taskId: string;
  projectId: string;
}

export interface PopOutParamsByKind {
  stats: Record<string, never>;
  changes: PopOutTaskParams;
  browser: PopOutTaskParams;
}

export type PopOutParams<K extends PopOutKind = PopOutKind> = PopOutParamsByKind[K];

export interface PopOutDescriptor<K extends PopOutKind = PopOutKind> {
  kind: K;
  params: PopOutParamsByKind[K];
}

/** additionalArguments flag carrying the base64-encoded descriptor JSON. */
export const POPOUT_ARG_PREFIX = '--kangentic-popout=';

/**
 * Stable identity for one pop-out window instance. Global surfaces (no task/project)
 * collapse to their kind; task-scoped surfaces are keyed by kind + project + task so a
 * second task's pop-out never collides with the first's. Used identically as the main
 * process's window-tracking map key and the renderer's pop-out-store key.
 */
export function popOutInstanceKey<K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]): string {
  if (kind === 'stats') return 'stats';
  const taskParams = params as PopOutTaskParams;
  return `${kind}:${taskParams.projectId}:${taskParams.taskId}`;
}

export interface PopOutSurfaceMeta {
  kind: PopOutKind;
  scope: 'global' | 'task';
  /** OS window title. */
  title: string;
  defaultBounds: { width: number; height: number };
  minSize: { width: number; height: number };
  /** Only 'browser' needs webviewTag: true. */
  needsWebview: boolean;
  /** Push channels the main process fans out to this surface's open windows. */
  channels: readonly string[];
}

/**
 * Declarative metadata for every detachable surface, referenced by both processes.
 * Adding a surface here (plus a renderer registry entry + root component) is the whole
 * cost of making a new UI surface detachable.
 */
export const POP_OUT_SURFACES: Readonly<Record<PopOutKind, PopOutSurfaceMeta>> = {
  stats: {
    kind: 'stats',
    scope: 'global',
    title: 'Usage Statistics',
    defaultBounds: { width: 1100, height: 800 },
    minSize: { width: 640, height: 480 },
    needsWebview: false,
    channels: [
      IPC.SESSION_USAGE,
      IPC.SESSION_STATUS,
      IPC.SESSION_ACTIVITY,
      IPC.SESSION_EXIT,
      IPC.SESSION_IDLE_TIMEOUT,
      IPC.CONFIG_CHANGED,
    ],
  },
  changes: {
    kind: 'changes',
    scope: 'task',
    title: 'Changes',
    defaultBounds: { width: 1000, height: 750 },
    minSize: { width: 560, height: 400 },
    needsWebview: false,
    channels: [IPC.GIT_DIFF_CHANGED, IPC.CONFIG_CHANGED],
  },
  browser: {
    kind: 'browser',
    scope: 'task',
    title: 'Browser',
    defaultBounds: { width: 1200, height: 800 },
    minSize: { width: 480, height: 360 },
    needsWebview: true,
    channels: [IPC.CONFIG_CHANGED],
  },
};
