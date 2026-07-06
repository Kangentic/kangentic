/**
 * Per-project state cache for warm project switches.
 *
 * Today every `currentProject` change in App.tsx fires a coordinated
 * 5-IPC fan-out (board, backlog, config, sessions x 2) and hard-resets
 * per-project UI state. This cache makes a round-trip (A -> B -> A
 * within the same process lifetime) a pointer swap: zero IPC traffic
 * and the dialog the user had open in A is still open when they
 * return.
 *
 * Lifecycle:
 *  - Switch away from project X: `snapshotProject(X)` captures the
 *    relevant slices of the live stores into the in-memory map.
 *  - Switch in to project Y: `restoreProject(Y)` writes those slices
 *    back into the stores in one set() call per store and returns
 *    `true`. Caller skips the usual loadBoard/loadBacklog/loadConfig
 *    + hard-reset path.
 *  - Live mutations of project Y (slice writes, IPC pushes for the
 *    current project) flow into the live stores normally; the next
 *    `snapshotProject(Y)` will capture them.
 *  - Cross-project agent pushes (e.g. an MCP-created task in a
 *    background project) call `invalidateProject(thatProjectId)` so
 *    the next switch to it bypasses the cache and refetches.
 *  - PROJECT_DELETE on main calls `dropProject(id)` here via the
 *    delete handler echo so we don't leak entries.
 *
 * HMR preservation mirrors the `transientSessions` pattern in
 * session-store.ts: the cache map is stashed in `import.meta.hot.data`
 * during `dispose` and restored on module re-evaluation. Without this,
 * every renderer HMR cycle would blow the cache and force a refetch on
 * the next switch, breaking dogfooding when the user is iterating on
 * App.tsx itself.
 *
 * Not cached deliberately:
 *  - Cross-project `sessions` list, `sessionActivity`, and
 *    `sessionActivityReason`. These already span projects and are kept
 *    fresh by incremental IPC pushes (`onStatus`, `onActivity`).
 *    Restoring them per-project would clobber the cross-project view
 *    used by the sidebar's activity badges.
 *  - Per-session usage and events maps (`sessionUsage`, `sessionEvents`).
 *    Keyed by sessionId rather than projectId; pushed incrementally;
 *    the existing reconcileCache merge in `syncSessions` handles them.
 */

import type { Task, Swimlane, BacklogTask, AppConfig, ShortcutConfig } from '../../shared/types';

interface ProjectSnapshot {
  board: {
    tasks: Task[];
    swimlanes: Swimlane[];
    archivedTasks: Task[];
    /** Total archived count (source of truth for badges); see archived-tasks-slice. */
    archivedTotalCount: number;
    /** Whether archivedTasks holds the full archive vs the newest-N preview. */
    archivedFullyLoaded: boolean;
    /**
     * Per-project shortcut definitions (loaded from kangentic.json /
     * kangentic.local.json via `boardConfig.getShortcuts`). Consumed by
     * CommandBarOverlay, TaskDetailDialog, and ShortcutsTab. Without
     * snapshotting these we'd show project A's tasks but project B's
     * shortcuts after a warm restore.
     */
    shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  };
  backlog: BacklogTask[];
  config: AppConfig;
  view: {
    detailTaskId: string | null;
    /**
     * We do NOT snapshot `activeSessionId` here. TerminalPanel's
     * auto-select useEffect fires (child-first) before our parent
     * useEffect can snapshot, so by the time we read `activeSessionId`
     * from the live store it has already been clobbered to a session
     * from the project we're leaving FOR, not the one we're leaving
     * FROM. Instead, on warm restore we re-derive the active tab from
     * `config.lastActiveTaskByProject` (which IS in the snapshot, via
     * `config`). This mirrors the cold-path's restore logic and gives
     * a single source of truth: the user's persisted tab choice.
     */
  };
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedCache: Map<string, ProjectSnapshot> | undefined = import.meta.hot?.data?.projectCache;
// @ts-expect-error -- Vite handles import.meta.hot
const preservedSeen: Set<string> | undefined = import.meta.hot?.data?.seenProjects;
// @ts-expect-error -- Vite handles import.meta.hot
const preservedDirty: Set<string> | undefined = import.meta.hot?.data?.dirtyProjects;

const cache: Map<string, ProjectSnapshot> = preservedCache ?? new Map();
const seenProjects: Set<string> = preservedSeen ?? new Set();
const dirtyProjects: Set<string> = preservedDirty ?? new Set();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.projectCache = cache;
    data.seenProjects = seenProjects;
    data.dirtyProjects = dirtyProjects;
  });
}

/**
 * Predicate the project-switch effect uses to decide whether to take
 * the warm-cache path. Returns true only when we've previously cached
 * this project's slices AND no invalidation has fired since.
 */
export function isWarmProject(projectId: string): boolean {
  return seenProjects.has(projectId) && !dirtyProjects.has(projectId) && cache.has(projectId);
}

/**
 * Mark a project as having completed its initial load. Called by the
 * switch effect after a cold-path IPC fan-out resolves so the next
 * switch to this project can take the warm path.
 */
export function markProjectSeen(projectId: string): void {
  seenProjects.add(projectId);
  dirtyProjects.delete(projectId);
}

/**
 * Capture the current store state for `projectId` before the user
 * switches away. Callers pass a snapshot they assembled by reading
 * each store's `getState()`. This module deliberately does NOT
 * import the stores to avoid a circular import (stores -> cache ->
 * stores).
 */
export function snapshotProject(projectId: string, snapshot: ProjectSnapshot): void {
  cache.set(projectId, snapshot);
}

/**
 * Look up a cached snapshot. Returns `undefined` for projects that
 * have never been opened or have been invalidated. Callers should
 * gate on `isWarmProject` first.
 */
export function getProjectSnapshot(projectId: string): ProjectSnapshot | undefined {
  return cache.get(projectId);
}

/**
 * Mark a project's cache as stale. Used when:
 *  - An agent push (`onCreatedByAgent` / `onUpdatedByAgent` /
 *    `onDeletedByAgent` / `onChangedByAgent`) targets a non-current
 *    project. The live store reflects the current project only, so we
 *    can't update the cache in-place; instead we drop the cache so
 *    the next switch to that project refetches.
 *  - Project settings changed externally.
 *  - Any future event that mutates background-project state.
 *
 * For the current project, no invalidation is needed: the live store
 * is the truth and the next snapshot will capture the change.
 */
export function invalidateProject(projectId: string): void {
  dirtyProjects.add(projectId);
}

/**
 * Mark every cached project as stale. Used by config mutations that
 * recompute effective config for all projects (global settings change,
 * label-color updates). Without this, returning to a non-current
 * project via warm cache would restore an effective config that was
 * computed against the previous global settings.
 */
export function invalidateAllProjects(): void {
  for (const projectId of seenProjects) {
    dirtyProjects.add(projectId);
  }
}

/**
 * Drop a project entirely from the cache. Called from PROJECT_DELETE's
 * renderer-side echo so we don't leak entries for projects that no
 * longer exist.
 */
export function dropProject(projectId: string): void {
  cache.delete(projectId);
  seenProjects.delete(projectId);
  dirtyProjects.delete(projectId);
}
