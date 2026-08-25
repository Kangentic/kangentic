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
// Type-only, so the types.ts -> pop-out.ts import cycle stays erased at runtime.
import type { GitDiffScope, GitDiffStatus } from './types';

export type PopOutKind = 'stats' | 'changes' | 'browser' | 'monitor' | 'changes-file';

export const POPOUT_KINDS: readonly PopOutKind[] = ['stats', 'changes', 'browser', 'monitor', 'changes-file'];

export function isPopOutKind(value: string): value is PopOutKind {
  return (POPOUT_KINDS as readonly string[]).includes(value);
}

export interface PopOutTaskParams {
  taskId: string;
  projectId: string;
}

/**
 * Params for the per-file diff window: one file's diff, detached read-only.
 *
 * Beyond the identity fields (which feed the instance key), the params carry a
 * BOOT SEED - everything the opener already knows that the window would
 * otherwise have to re-derive from store hydration (a pop-out is a separate
 * renderer): the git paths, the file's list-entry fields, and the task label.
 * The seed lets the window fire its content fetch on the very first render, in
 * parallel with the Monaco chunk, instead of serializing behind three store
 * loads and a file-list round trip. Seed fields are point-in-time: the window's
 * own GIT_DIFF_CHANGED reconcile corrects any staleness.
 */
export interface PopOutChangesFileParams extends PopOutTaskParams {
  /** Repo-relative, '/'-separated path of the single file this window diffs. */
  filePath: string;
  /** Diff scope the file was opened from (mirrors GitDiffFilesInput). Ignored
   *  when `commitOid` is set. */
  scope?: GitDiffScope;
  /** When set, show this file's diff within that single commit (immutable;
   *  overrides `scope`, mirroring GitDiffFilesInput). */
  commitOid?: string;
  /** Boot seed: project directory (GitFileContentInput.projectPath). */
  projectPath: string;
  /** Boot seed: worktree directory, when the task has one. */
  worktreePath?: string;
  /** Boot seed: base branch the diff is against. */
  baseBranch: string;
  /** Boot seed: the file's status from the list entry it was opened from. */
  status: GitDiffStatus;
  /** Boot seed: pre-rename path, for renamed/copied entries. */
  oldPath?: string;
  /** Boot seed: whether the list entry is binary. */
  binary: boolean;
  /** Boot seed: task display number, for the window title's task anchor. */
  taskDisplayId: number;
  /** Boot seed: task title, for the window title's task anchor. */
  taskTitle: string;
}

export interface PopOutParamsByKind {
  stats: Record<string, never>;
  changes: PopOutTaskParams;
  browser: PopOutTaskParams;
  monitor: Record<string, never>;
  'changes-file': PopOutChangesFileParams;
}

/**
 * Kinds with no task/project params. Every entry collapses to its own kind as the
 * instance key (there is only ever one such window). Kept as a set rather than an
 * inline `kind === 'stats'` check so adding a global surface cannot silently fall
 * through to the task-params branch and key as `monitor:undefined:undefined`.
 */
const GLOBAL_KINDS: readonly PopOutKind[] = ['stats', 'monitor'];

/** True for a kind whose params carry no task/project, so a caller must not read
 *  `taskId` / `projectId` off them. Exported so every such branch reads the one
 *  set instead of re-spelling `kind === 'stats'`. */
export function isGlobalPopOutKind(kind: PopOutKind): boolean {
  return GLOBAL_KINDS.includes(kind);
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
  if (GLOBAL_KINDS.includes(kind)) return kind;
  const taskParams = params as PopOutTaskParams;
  const taskKey = `${kind}:${taskParams.projectId}:${taskParams.taskId}`;
  // Per-file surface: one window per file, so the file joins the key. filePath is
  // the LAST segment because repo-relative git paths contain '/' (never split a
  // key on it); scope/commitOid are deliberately excluded so re-opening the same
  // file from another scope focuses the existing window instead of spawning a
  // sibling.
  if (kind === 'changes-file') return `${taskKey}:${(params as PopOutChangesFileParams).filePath}`;
  return taskKey;
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
  /** Per-instance OS/taskbar title derived from params, falling back to `title`.
   *  Read through `resolveSurfaceTitle` by BOTH processes (main at BrowserWindow
   *  creation, the renderer for document.title) so the two cannot drift. */
  resolveTitle?: (params: PopOutParams) => string;
  /** Cap on concurrently-open windows of this kind, enforced main-side in
   *  PopOutWindowManager.open() (which returns null at the cap - the only
   *  chokepoint that can see every window). Omitted = the existing surfaces'
   *  singleton-per-instance-key behavior with no kind-wide cap. */
  maxInstances?: number;
  /** When the kind has NO saved bounds yet, open MAXIMIZED (a diff reads best
   *  with the whole screen; a full-height-only column was tried first and read
   *  as an awkward strip). Un-maximizing restores defaultBounds' float, and a
   *  user resize/move/maximize persists via popOutBounds as usual and wins
   *  from then on - this governs only the out-of-box open. */
  openMaximized?: boolean;
}

/** The one place a surface's per-instance title is derived, shared by main and
 *  renderer so the OS title bar and document.title always agree. */
export function resolveSurfaceTitle(meta: PopOutSurfaceMeta, params: PopOutParams): string {
  return meta.resolveTitle?.(params) ?? meta.title;
}

/** The "#N task title" anchor a changes-file window's titles end with - one
 *  builder for the taskbar form (resolveTitle's basename prefix) and the frame
 *  header (PopOutSurfaceRoot's full-path prefix) so the two cannot drift. */
export function formatTaskAnchor(taskDisplayId: number, taskTitle: string): string {
  return `#${taskDisplayId} ${taskTitle}`;
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
  // A single changed file's diff, detached read-only from a Changes file row
  // (double-click, or the row's "Open in new window"). Unlike every other kind
  // this surface is ADDITIVE - many windows per task (one per file, hence the
  // filePath key segment and the maxInstances cap), and its in-app origin stays
  // mounted while windows are open.
  'changes-file': {
    kind: 'changes-file',
    scope: 'task',
    title: 'File Diff',
    defaultBounds: { width: 900, height: 700 },
    minSize: { width: 480, height: 360 },
    needsWebview: false,
    maxInstances: 8,
    openMaximized: true,
    // "basename - #N task title": the file first so multiple diff windows stay
    // distinguishable when the taskbar truncates, the task anchor after so the
    // user never loses which task a window belongs to. The frame's header shows
    // the same anchor with the FULL repo-relative path. Cast documented:
    // PopOutSurfaceMeta is deliberately non-generic (a mapped POP_OUT_SURFACES
    // type is not worth the union-call friction at its consumers), so the one
    // resolver narrows inside.
    resolveTitle: (params) => {
      const fileParams = params as PopOutChangesFileParams;
      const fileName = fileParams.filePath.split('/').pop() ?? 'File Diff';
      return `${fileName} - ${formatTaskAnchor(fileParams.taskDisplayId, fileParams.taskTitle)}`;
    },
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
      // The output peek is patched in place for the same reason. Unlike the
      // pushes above it is subscribe-gated, and this window subscribes on its own
      // behalf, so main is already fanning to it by the time rows exist.
      IPC.MONITOR_PEEK,
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
      // PTY dims echo for the width-drift self-heal. Unlike SESSION_DATA it IS
      // fanned to every window: echoes only fire on real dim changes, and a
      // freshly mounted xterm could miss a focus-routed echo during exactly the
      // mount window where a divergence is born. Any future pop-out surface
      // that hosts a terminal must declare this channel too.
      IPC.SESSION_PTY_RESIZED,
      IPC.TASK_SPAWN_PROGRESS,
    ],
  },
};
