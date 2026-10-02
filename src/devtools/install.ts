import type { App, BrowserWindow } from 'electron';
import { app } from 'electron';
import { writeLockfile, removeLockfile } from './main/lockfile';
import { startInspectionServer, stopInspectionServer } from './main/inspection-server';
import { attachDebugger, detachDebugger } from './main/cdp';
import { installSpawnTracer } from './main/spawn-tracer';
import {
  isStallProfilerRunning,
  stallProfileDirectory,
  startStallProfiler,
  stopStallProfiler,
} from './main/stall-profiler';
import type { SessionManager } from '../main/pty/session-manager';
import type { IpcContext } from '../main/ipc/ipc-context';

/**
 * Single entry point for the dev-only inspection bridge subsystem.
 * Called from `src/main/index.ts` at startup, gated behind
 * `if (__KANGENTIC_DEV__)`. The entire `src/devtools/` tree is
 * tree-shaken out of production builds via the esbuild constant.
 *
 * Lifecycle:
 *   - Startup: stores the context and registers a synchronous
 *     `before-quit` shutdown hook. The bridge does NOT start here -
 *     `installDevtools` runs at the top of `main/index.ts`, before any
 *     IPC context exists.
 *   - First start: triggered by `notifyDevtoolsRefresh()` which is
 *     called from `applyRuntimeConfig` after a project opens (so the
 *     IPC context, sessionManager, and mainWindow are all live).
 *   - Toggle on/off: subsequent `notifyDevtoolsRefresh()` calls flow
 *     through `applyRuntimeConfig` for every config change, so flipping
 *     `developer.previewInspectionServer` starts or stops the bridge
 *     live without restart.
 *   - Shutdown: synchronous `before-quit` removes the lockfile + closes
 *     the server (per .claude/rules/synchronous-shutdown.md - no async work
 *     in the quit path).
 */

export interface DevtoolsContext {
  app: App;
  /** Returns the active main window once one has been created. Null pre-window. */
  getMainWindow: () => BrowserWindow | null;
  /** Returns the active worktree's project root (for the lockfile). */
  getProjectRoot: () => string | null;
  /** Returns the active project ID. */
  getProjectId: () => string | null;
  /** Returns the active worktree path (may equal project root for the main checkout). */
  getWorktreePath: () => string | null;
  /** Live SessionManager handle, used by /engine-state and /pty-input. */
  getSessionManager: () => SessionManager | null;
  /** Live IpcContext, used by the /command proxy to run product MCP handlers. */
  getIpcContext: () => IpcContext | null;
  /** Returns `developer.previewInspectionServer`. Live read on each lookup. */
  getInspectionServerEnabled: () => boolean;
  /** Returns `developer.previewEvalEnabled`. Live read on each lookup. */
  getEvalEnabled: () => boolean;
  /** Returns `developer.stallProfiler`. Live read on each lookup. */
  getStallProfilerEnabled: () => boolean;
}

let installedContext: DevtoolsContext | null = null;
let activeProjectRoot: string | null = null;
let bridgeStarting = false;

export function installDevtools(context: DevtoolsContext): void {
  if (installedContext) return;
  installedContext = context;
  // Count every child-process spawn on main by caller (spawn-tracer.ts).
  installSpawnTracer();

  // Synchronous before-quit per .claude/rules/synchronous-shutdown.md. Removes
  // the lockfile, detaches CDP, closes the HTTP server. No async work in
  // the quit path.
  app.on('before-quit', () => {
    stopStallProfiler();
    teardownBridge(context);
  });
}

/** Start or stop the stall profiler to match `developer.stallProfiler`. */
function reconcileStallProfiler(context: DevtoolsContext): void {
  const wanted = context.getStallProfilerEnabled();
  if (wanted && !isStallProfilerRunning()) {
    void startStallProfiler(stallProfileDirectory(context.app.getPath('userData')));
  } else if (!wanted && isStallProfilerRunning()) {
    stopStallProfiler();
  }
}

/**
 * Re-evaluate whether the inspection bridge should be running. Called
 * from `applyRuntimeConfig` after every project open and config change,
 * so toggle flips and project switches both flow through here.
 *
 * State machine:
 *   - Toggle on AND project ready AND not running -> start bridge + lockfile + CDP attach.
 *   - Toggle off AND running -> stop bridge + remove lockfile + CDP detach.
 *   - All other combinations are no-ops.
 *
 * Idempotent. Safe to call from any number of places.
 */
export function notifyDevtoolsRefresh(): void {
  const context = installedContext;
  if (!context) return;

  reconcileStallProfiler(context);

  const enabled = context.getInspectionServerEnabled();
  const running = activeProjectRoot !== null;

  if (enabled && !running && !bridgeStarting) {
    void startBridge(context);
    return;
  }
  if (!enabled && running) {
    teardownBridge(context);
  }
}

async function startBridge(context: DevtoolsContext): Promise<void> {
  const projectRoot = context.getProjectRoot();
  const projectId = context.getProjectId();
  const worktreePath = context.getWorktreePath();
  if (!projectRoot || !projectId || !worktreePath) return;

  bridgeStarting = true;
  try {
    const port = await startInspectionServer({
      getMainWindow: context.getMainWindow,
      getEvalEnabled: context.getEvalEnabled,
      getSessionManager: context.getSessionManager,
      getProjectRoot: context.getProjectRoot,
      getIpcContext: context.getIpcContext,
      getProjectId: context.getProjectId,
    });
    if (port === null) return;

    writeLockfile({ projectRoot, port, worktreePath, projectId });
    activeProjectRoot = projectRoot;

    const window = context.getMainWindow();
    if (window) attachDebugger(window);
  } finally {
    bridgeStarting = false;
  }
}

function teardownBridge(context: DevtoolsContext): void {
  if (activeProjectRoot) {
    removeLockfile(activeProjectRoot);
    activeProjectRoot = null;
  }
  const window = context.getMainWindow();
  if (window) detachDebugger(window);
  stopInspectionServer();
}
