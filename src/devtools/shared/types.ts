import type { WorktreeRecord } from '../../shared/types';

/**
 * Dev-only types backing the inspection bridge. These do NOT ship in
 * production builds - anything imported from this file must be reachable
 * only from `src/devtools/` (which is itself tree-shaken out of prod via
 * the `__KANGENTIC_DEV__` esbuild constant).
 */

/**
 * On-disk record at `<projectRoot>/.kangentic/preview.lock`. Written when
 * the inspection server binds; removed synchronously on `before-quit`.
 * Stale lockfiles are detected via PID liveness.
 */
export interface PreviewLockfile {
  /** OS PID of the Electron main process. */
  pid: number;
  /** Localhost port the inspection HTTP server is bound to. */
  port: number;
  /** Absolute path to the worktree this preview instance is bound to. */
  worktreePath: string;
  /** Absolute path of the project root the worktree belongs to. */
  projectRoot: string;
  /** UUID of the project record. */
  projectId: string;
  /** ISO 8601 timestamp the lockfile was written. */
  startedAt: string;
  /** Version reported by `app.getVersion()`. */
  kangenticVersion: string;
}

/**
 * Status of a discovered lockfile. `responding` means the inspection
 * server answered the `/info` ping within the timeout. `stale` means the
 * file exists but the PID is dead (or the server isn't listening).
 * `absent` means no lockfile was found at all (used in instance lists
 * that include worktrees without a running preview).
 */
export type PreviewLockfileStatus = 'responding' | 'stale' | 'absent';

/**
 * A worktree record enriched with preview-instance discovery metadata.
 * Consumed by the dev-only `kangentic_devtools_list_instances` MCP tool.
 */
export interface PreviewInstanceRecord extends WorktreeRecord {
  projectId: string;
  projectName: string;
  lockfile: PreviewLockfile | null;
  lockfileStatus: PreviewLockfileStatus;
}

/**
 * Snapshot returned by the inspection server's `/info` endpoint and the
 * `kangentic_devtools_list_instances` tool's `responding` records.
 */
export interface PreviewInfoResponse {
  pid: number;
  port: number;
  worktreePath: string;
  kangenticVersion: string;
  /** Currently running session IDs that have an active PTY. */
  sessionIds: string[];
  /** ISO 8601 timestamp at the moment the response was assembled. */
  ts: string;
}

/**
 * Renderer Zustand snapshot returned by the inspection server's
 * `/renderer-state` endpoint. The shape intentionally uses `unknown`
 * for nested store data because each store's full shape changes
 * frequently; the agent can read the JSON and reason about whatever
 * fields are present.
 */
export interface RendererStateSnapshot {
  ts: string;
  board: unknown;
  session: unknown;
  project: unknown;
  config: unknown;
  backlog: unknown;
  toast: unknown;
  transient: unknown;
  scroll: unknown;
  focus: { activeElementSelector: string | null; activeElementTag: string | null };
  /** Ring buffer: last N toasts shown, newest last. */
  recentToasts: unknown[];
}

/**
 * Query-all result shapes now live with the shipped CDP driver
 * (`src/main/browser/cdp/types.ts`) so both the user-facing browser-pane
 * driver and this dev-only bridge can share them. Re-exported here so
 * existing dev-only consumers keep their `src/devtools/shared/types`
 * import path.
 */
export type {
  QueryAllElementBox,
  QueryAllElement,
  QueryAllResult,
} from '../../main/browser/cdp/types';

/**
 * Result of a renderer store-state read via `/store-state`. On success
 * `value` holds the (sanitized) state at `path` and `error` is null; on an
 * unknown store name `error` is set and `available` lists registered stores.
 */
export interface StoreStateResult {
  store: string;
  path: string | null;
  /** Registered store names, always returned so callers can self-correct. */
  available: string[];
  value?: unknown;
  error?: string;
}

/**
 * One React component's debug info, returned by
 * `kangentic_devtools_react_query`. Walks the React fiber from a DOM
 * node and reports the nearest custom component.
 */
export interface ReactComponentInfo {
  /** Display name of the component. */
  name: string;
  /** Source file from React's `_debugSource` (set by the Babel plugin in dev). */
  file: string | null;
  line: number | null;
  column: number | null;
  /** React `key` prop, if any. */
  key: string | null;
  /** Sanitized snapshot of the props object. Functions become `[Function: name]`. */
  props: Record<string, unknown>;
  /** Ordered list of hook names + sanitized current values. */
  hooks: { name: string; value: unknown }[];
  /** Names of ancestor components from this fiber up to the root. */
  parentChain: string[];
}

/**
 * One commit/render entry from the React fiber tree's
 * `onCommitFiberRoot` hook. Populated into a ring buffer in dev only.
 */
export interface ReactRenderRecord {
  /** Wall-clock timestamp the commit completed. */
  ts: string;
  /** Display name of the root fiber that was committed. */
  fiberName: string;
  /** Source file when available. */
  file: string | null;
  /** Total render duration in ms. Reported by React when profiling is on. */
  durationMs: number;
}
