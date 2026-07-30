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

export type PopOutKind = 'stats' | 'changes' | 'browser' | 'monitor';

export const POPOUT_KINDS: readonly PopOutKind[] = ['stats', 'changes', 'browser', 'monitor'];

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
  monitor: Record<string, never>;
}

/**
 * Kinds with no task/project params. Every entry collapses to its own kind as the
 * instance key (there is only ever one such window). Kept as a set rather than an
 * inline `kind === 'stats'` check so adding a global surface cannot silently fall
 * through to the task-params branch and key as `monitor:undefined:undefined`.
 */
const GLOBAL_KINDS: readonly PopOutKind[] = ['stats', 'monitor'];

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
  if (GLOBAL_KINDS.includes(kind)) return kind;
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
  monitor: {
    kind: 'monitor',
    scope: 'global',
    title: 'Agent Monitor',
    defaultBounds: { width: 1100, height: 800 },
    // Floor is generous on width because the card grid's narrowest useful form is
    // still a full wide-row; below this the row's metadata line wraps badly.
    minSize: { width: 560, height: 400 },
    needsWebview: false,
    channels: [
      IPC.MONITOR_CHANGED,
      // Activity is patched into rows in place without a refetch, so the detached
      // window needs it directly - it never round-trips through the main window.
      IPC.SESSION_ACTIVITY,
      IPC.SESSION_STATUS,
      IPC.SESSION_EXIT,
      IPC.CONFIG_CHANGED,
      // This window can host a task detail (and therefore a live terminal) for a
      // project the board is not on, so it needs the per-session pushes a terminal
      // consumes. SESSION_DATA and SESSION_FIRST_OUTPUT are NOT listed: those are
      // routed per-renderer off the focus map rather than fanned to every pop-out,
      // so a window without that session's terminal never receives its bytes.
      IPC.SESSION_USAGE,
      IPC.SESSION_EVENT,
      IPC.TASK_SPAWN_PROGRESS,
    ],
  },
};
