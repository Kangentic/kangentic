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

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { IPC } from './ipc-channels';
import type { LocalizedText } from './i18n/text';
// Type-only, so the types.ts -> pop-out.ts import cycle stays erased at runtime.
import type { GitDiffRange, GitDiffScope, GitDiffStatus } from './types';

export type PopOutKind = 'stats' | 'changes' | 'browser' | 'monitor' | 'changes-file' | 'knowledge-graph' | 'command-terminal';

export const POPOUT_KINDS: readonly PopOutKind[] = ['stats', 'changes', 'browser', 'monitor', 'changes-file', 'knowledge-graph', 'command-terminal'];

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
  /** When set (and no `commitOid`), show this file's diff over a completed
   *  task's whole range, read from commits only, so the window watches nothing. */
  range?: GitDiffRange;
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

/**
 * Params for a surface that belongs to one PROJECT rather than one task: the
 * Command Terminal panel, detached. Only `projectId` is identity (the instance
 * key); `projectName` is a boot seed for the window's title, so renaming the
 * project never opens a second window beside the first.
 */
export interface PopOutProjectParams {
  projectId: string;
  /** Boot seed: the project's name, for the window title. */
  projectName: string;
}

export interface PopOutParamsByKind {
  stats: Record<string, never>;
  changes: PopOutTaskParams;
  browser: PopOutTaskParams;
  monitor: Record<string, never>;
  'changes-file': PopOutChangesFileParams;
  'knowledge-graph': Record<string, never>;
  'command-terminal': PopOutProjectParams;
}

/**
 * Kinds with no task/project params. Every entry collapses to its own kind as the
 * instance key (there is only ever one such window). Kept as a set rather than an
 * inline `kind === 'stats'` check so adding a global surface cannot silently fall
 * through to the task-params branch and key as `monitor:undefined:undefined`.
 */
const GLOBAL_KINDS: readonly PopOutKind[] = ['stats', 'monitor', 'knowledge-graph'];

/** True for a kind whose params carry no task/project, so a caller must not read
 *  `taskId` / `projectId` off them. Exported so every such branch reads the one
 *  set instead of re-spelling `kind === 'stats'`. */
export function isGlobalPopOutKind(kind: PopOutKind): boolean {
  return GLOBAL_KINDS.includes(kind);
}

/** Kinds keyed by project alone: one window per project, never per task. */
const PROJECT_KINDS: readonly PopOutKind[] = ['command-terminal'];

/** True for a kind whose params carry a project and no task. */
export function isProjectPopOutKind(kind: PopOutKind): boolean {
  return PROJECT_KINDS.includes(kind);
}

export type PopOutParams<K extends PopOutKind = PopOutKind> = PopOutParamsByKind[K];

export interface PopOutDescriptor<K extends PopOutKind = PopOutKind> {
  kind: K;
  params: PopOutParamsByKind[K];
}

// Re-exported for main and tests. The preload imports it from `pop-out-arg`.
export { POPOUT_ARG_PREFIX } from './pop-out-arg';

/**
 * Stable identity for one pop-out window instance. Global surfaces (no task/project)
 * collapse to their kind; task-scoped surfaces are keyed by kind + project + task so a
 * second task's pop-out never collides with the first's. Used identically as the main
 * process's window-tracking map key and the renderer's pop-out-store key.
 */
export function popOutInstanceKey<K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]): string {
  if (GLOBAL_KINDS.includes(kind)) return kind;
  if (PROJECT_KINDS.includes(kind)) return `${kind}:${(params as PopOutProjectParams).projectId}`;
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

/**
 * Inverse of {@link popOutInstanceKey} for the TASK-SCOPED kinds: recover which kind
 * and task a key belongs to. Returns null for a global surface (which carries no task),
 * an unknown kind, or a malformed key.
 *
 * Exists because `popOut:changed` pushes the whole open-key SET with no per-key close
 * event, so a consumer that needs to react to one window disappearing has to diff the
 * sets and then read the vanished key back. Lives beside the builder so the two cannot
 * drift; tests/unit/pop-out.test.ts round-trips them.
 */
export function parsePopOutInstanceKey(
  key: string,
): { kind: PopOutKind; projectId: string; taskId: string } | null {
  // Segments 1 and 2 are always projectId/taskId, including for 'changes-file' - its
  // filePath is deliberately the LAST segment, so extra segments never shift these two.
  const segments = key.split(':');
  if (segments.length < 3) return null;
  const [kind, projectId, taskId] = segments;
  if (!isPopOutKind(kind) || isGlobalPopOutKind(kind) || isProjectPopOutKind(kind)) return null;
  if (!projectId || !taskId) return null;
  return { kind, projectId, taskId };
}

/**
 * Inverse of {@link popOutInstanceKey} for the PROJECT-SCOPED kinds, read by the
 * same `popOut:changed` consumer: which project's detached window just closed.
 * Null for any other kind or a malformed key. Its own function, so the task
 * kinds' result keeps a task id its callers can rely on.
 */
export function parseProjectPopOutInstanceKey(key: string): { kind: PopOutKind; projectId: string } | null {
  const segments = key.split(':');
  if (segments.length !== 2) return null;
  const [kind, projectId] = segments;
  if (!isPopOutKind(kind) || !isProjectPopOutKind(kind) || !projectId) return null;
  return { kind, projectId };
}

export interface PopOutSurfaceMeta {
  kind: PopOutKind;
  scope: 'global' | 'task' | 'project';
  /** OS window title. Each process resolves it with its own translator. */
  title: MessageDescriptor;
  defaultBounds: { width: number; height: number };
  minSize: { width: number; height: number };
  /** Only 'browser' needs webviewTag: true. */
  needsWebview: boolean;
  /** Push channels the main process fans out to this surface's open windows. */
  channels: readonly string[];
  /** Per-instance OS/taskbar title derived from params, falling back to `title`.
   *  Read through `resolveSurfaceTitle` by BOTH processes (main at BrowserWindow
   *  creation, the renderer for document.title) so the two cannot drift. */
  resolveTitle?: (params: PopOutParams) => LocalizedText;
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
export function resolveSurfaceTitle(meta: PopOutSurfaceMeta, params: PopOutParams): LocalizedText {
  return meta.resolveTitle?.(params) ?? meta.title;
}

/** The "#N task title" anchor a changes-file window's titles end with - one
 *  builder for the taskbar form (resolveTitle's basename prefix) and the frame
 *  header (PopOutSurfaceRoot's full-path prefix) so the two cannot drift. */
export function formatTaskAnchor(taskDisplayId: number, taskTitle: string): string {
  return `#${taskDisplayId} ${taskTitle}`;
}

/** A changes-file window's title when its path has no file name. */
const FILE_DIFF_TITLE = msg`File Diff`;
/** A detached Command Terminal's title, named for its project. */
const COMMAND_TERMINAL_TITLE = msg({ message: 'Command Terminal - {projectName}' });

/**
 * Declarative metadata for every detachable surface, referenced by both processes.
 * Adding a surface here (plus a renderer registry entry + root component) is the whole
 * cost of making a new UI surface detachable.
 */
export const POP_OUT_SURFACES: Readonly<Record<PopOutKind, PopOutSurfaceMeta>> = {
  stats: {
    kind: 'stats',
    scope: 'global',
    title: msg`Usage Statistics`,
    defaultBounds: { width: 1100, height: 800 },
    minSize: { width: 640, height: 480 },
    needsWebview: false,
    channels: [
      IPC.SESSION_USAGE,
      IPC.SESSION_STATUS,
      IPC.SESSION_REMOVED,
      IPC.SESSION_ACTIVITY,
      IPC.SESSION_EXIT,
      IPC.SESSION_IDLE_TIMEOUT,
      IPC.CONFIG_CHANGED,
    ],
  },
  changes: {
    kind: 'changes',
    scope: 'task',
    title: msg`Changes`,
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
    title: FILE_DIFF_TITLE,
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
      const fileName = fileParams.filePath.split('/').pop();
      // No words of its own, so a plain string; only the fallback is a message.
      if (fileName === undefined) return FILE_DIFF_TITLE;
      return `${fileName} - ${formatTaskAnchor(fileParams.taskDisplayId, fileParams.taskTitle)}`;
    },
    channels: [IPC.GIT_DIFF_CHANGED, IPC.CONFIG_CHANGED],
  },
  browser: {
    kind: 'browser',
    scope: 'task',
    title: msg`Browser`,
    defaultBounds: { width: 1200, height: 800 },
    minSize: { width: 480, height: 360 },
    needsWebview: true,
    channels: [IPC.CONFIG_CHANGED],
  },
  monitor: {
    kind: 'monitor',
    scope: 'global',
    title: msg`Agent Monitor`,
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
      // The card's slot follows the Card Preview setting, and its two agent
      // modes read the session's message trail from this window's own session
      // store, which `syncSessions` seeds and this push keeps live.
      IPC.SESSION_MESSAGE_TRAIL,
      IPC.SESSION_STATUS,
      // A surface that hears a session change hears its removal too, so a
      // hosted task detail cannot keep a row main has dropped.
      IPC.SESSION_REMOVED,
      IPC.SESSION_EXIT,
      IPC.CONFIG_CHANGED,
      // This window can host a task detail (and therefore a live terminal) for a
      // project the board is not on, so it needs the per-session pushes a terminal
      // consumes. A terminal's output is not a push at all: the pty host sends
      // it on each renderer's own port, only to the renderers that show that
      // session, so a window without that session's terminal never receives
      // its bytes.
      IPC.SESSION_USAGE,
      IPC.SESSION_EVENT,
      // The one push that lifts a hosted terminal's launch overlay. Main
      // broadcasts it once per session to the main window and to each pop-out
      // that lists it here, so a detail opened here while its agent boots lifts
      // when the agent is on screen rather than at the next resync.
      IPC.SESSION_FIRST_OUTPUT,
      // PTY dims echo for the width-drift self-heal. Unlike a terminal's output
      // it IS fanned to every window: echoes only fire on real dim changes, and a
      // freshly mounted xterm could miss a focus-routed echo during exactly the
      // mount window where a divergence is born. Any future pop-out surface
      // that hosts a terminal must declare this channel too.
      IPC.SESSION_PTY_RESIZED,
      IPC.TASK_SPAWN_PROGRESS,
      // A hosted task detail's Browser pill lights its alive dot from the set of
      // tasks holding their one browser surface OFFSCREEN, and only main can see
      // those. Without this channel the pill in THIS window reads dark for a
      // browser that exists - which is the invisibility this whole mechanism was
      // built to remove, reappearing in one host.
      IPC.BROWSER_OFFSCREEN_SURFACES,
    ],
  },
  'knowledge-graph': {
    kind: 'knowledge-graph',
    scope: 'global',
    title: msg`Knowledge Graph`,
    // Wider than tall: the surface is a canvas beside the answer rail, and the
    // map is far more readable with horizontal room than vertical.
    defaultBounds: { width: 1200, height: 820 },
    // Below this the canvas and the answer rail cannot both be useful.
    minSize: { width: 720, height: 480 },
    needsWebview: false,
    channels: [
      // A projection pass can take minutes on a cold corpus and finishes in the
      // background, so a detached window must be told rather than poll. Omitting
      // this leaves the pop-out permanently showing "building".
      IPC.KNOWLEDGE_GRAPH_CHANGED,
      // A first build's progress, carried by the push itself. Without it a
      // detached window's building card holds its first figure until the end.
      IPC.KNOWLEDGE_GRAPH_BUILD_PROGRESS,
      // Progress on an answer in flight. Declared here or a detached window
      // sits on a spinner while the main window watches the answer arrive.
      IPC.KNOWLEDGE_GRAPH_ANSWER_STREAM,
      IPC.CONFIG_CHANGED,
    ],
  },
  // The Command Terminal panel for ONE project, in a window of its own. Its
  // in-app panel does not mount while it is open; closing it brings the panel
  // back to the app while that project still has a terminal running.
  'command-terminal': {
    kind: 'command-terminal',
    scope: 'project',
    title: msg`Command Terminal`,
    defaultBounds: { width: 1180, height: 770 },
    // The app window's own floor. One terminal at the 630 x 200 pane floor fits
    // beside the rail; a window too small for the grid tiles every terminal
    // under the floor, as the panel does in a small app window.
    minSize: { width: 900, height: 600 },
    needsWebview: false,
    resolveTitle: (params) => ({ ...COMMAND_TERMINAL_TITLE, values: { projectName: (params as PopOutProjectParams).projectName } }),
    channels: [
      // This window runs no App.tsx, so it keeps its own session replica live
      // from the same pushes the main window's App.tsx maps.
      IPC.SESSION_STATUS,
      IPC.SESSION_REMOVED,
      IPC.SESSION_EXIT,
      // The pane's context bar.
      IPC.SESSION_USAGE,
      // The Stop control's activity mark.
      IPC.SESSION_ACTIVITY,
      // Lifts a terminal's launch overlay once its agent is on screen.
      IPC.SESSION_FIRST_OUTPUT,
      // The width-drift self-heal every terminal host declares (see 'monitor').
      // SESSION_DATA is not listed: main routes it to the renderers focused on
      // the session, and this window publishes its own focused set.
      IPC.SESSION_PTY_RESIZED,
      // The branch pills re-read HEAD on every diff-watcher fire.
      IPC.GIT_DIFF_CHANGED,
      // The rail's Earlier list.
      IPC.COMMAND_TERMINAL_HISTORY_CHANGED,
      IPC.CONFIG_CHANGED,
    ],
  },
};
