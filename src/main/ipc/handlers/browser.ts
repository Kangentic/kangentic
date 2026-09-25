import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, session, webContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { browserPartitionForTask } from '../../../shared/browser-partition';
import { BROWSER_PANE_VISIBILITIES } from '../../../shared/types';
import type {
  BrowserCaptureInput,
  BrowserPaneRegisterInput,
  BrowserPaneVisibility,
  BrowserViewportOverride,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { getProjectRepos, resolveProjectContext } from '../helpers/project-repos';
import { browserUrlStore } from '../../browser/browser-url-store';
import { browserPaneRegistry } from '../../browser/browser-pane-registry';
import { setBrowserPaneOpenerHost, offscreenSurfaceUrl } from '../../browser/browser-pane-opener';
import { installLaneHandoff } from '../../browser/browser-lane-handoff';
import { destroyLane, laneTaskIds, setLaneChangeListener } from '../../browser/browser-lane-manager';
import { broadcast } from '../../pop-out/window-broadcast';
import { enumerateProjectPartitions } from '../../browser/browser-partition-cleanup';
import { syncJarFromIdentity } from '../../browser/jar-seeder';
import { releaseViewportOverride } from '../../browser/viewport-override';
import {
  getViewportOverride,
  type ViewportOverrideRecord,
} from '../../browser/viewport-override-store';

import { PasteSubmitError } from '../../pty/terminal-submit';
import { agentRegistry } from '../../agent/agent-registry';
import {
  buildPromptPayload,
  isValidSessionId,
  isCrossDrivePath,
} from './browser-payload';

// Embedded webview capture-and-send. Persists the composited PNG
// under the session's existing on-disk directory at
// `<projectRoot>/.kangentic/sessions/<sessionId>/captures/`, then injects
// a short text prompt referencing the screenshot via @<relative-path> into
// the task's running PTY.
//
// Why under the session dir: it's already part of Kangentic's lifecycle.
// `cleanupTaskSession` (move-to-Backlog, move-to-Done, task-delete) removes
// the session directory recursively, and `pruneOrphanedDirectories` sweeps
// any stragglers on next project open. Captures inherit that for free, no
// new cleanup hook needed.
//
// Why @<relative-path>: this is the universal format. Claude Code and
// Gemini CLI auto-inject the file as multimodal input on @-mention.
// Agents without @ parsing (Aider, Codex, etc.) see it as natural prose
// with a path and reach for their Read tool. The relative path is
// computed from the agent's cwd, so worktree-cwd tasks see `../..` paths
// (Claude under bypass-permissions reads those fine; other agents inherit
// the same broad permissions in Kangentic's default config).
//
// We DO NOT send the rendered DOM as a sidecar HTML file -- the agent
// already has the codebase, and a full outerHTML dump is mostly noise
// relative to what makes elements findable in source. Instead, when the
// user uses the Inspect picker we send a small structured fingerprint
// (selector, role, testid, accessible name, ancestors, computed styles,
// the element's own outerHTML) optimized for grepping the codebase.
// Mirrors Chrome DevTools MCP's "snapshot over screenshot" guidance.

export function registerBrowserHandlers(context: IpcContext): void {
  // Give the pane opener (behind kangentic_browser_open_pane / _close_pane) the
  // slice of app state it needs. Injected rather than imported so the opener -
  // and through it the MCP browser tool file - stays free of the IPC context's
  // whole dependency graph (every handler, analytics, better-sqlite3).
  setBrowserPaneOpenerHost(() => ({
    currentProjectId: context.currentProjectId,
    currentProjectPath: context.currentProjectPath,
    taskExists: (projectId, taskId) => {
      try {
        return getProjectRepos(context, projectId).tasks.getById(taskId) !== undefined;
      } catch {
        return false;
      }
    },
    browserOverrides: (projectPath) => context.configManager.loadProjectOverrides(projectPath)?.browser ?? null,
    send: (channel, ...args) => {
      if (context.mainWindow.isDestroyed()) return false;
      context.mainWindow.webContents.send(channel, ...args);
      return true;
    },
  }));

  // A browser an agent is using belongs to the AGENT, not to a piece of UI. The
  // user must be free to close the task detail and move around the board without
  // disconnecting an agent that is midway through verifying something - but an
  // Electron <webview> guest dies the moment its DOM node unmounts, so closing
  // the window destroys it. This hands the page off to an offscreen lane
  // instead, and stands that lane down when the user's pane comes back.
  installLaneHandoff({
    hasLiveSession: (taskId) => {
      try {
        // Live (running/queued) specifically, not merely registered: a
        // suspended or exited session has no agent to keep a browser for. And
        // not a kill already in flight either: `kill()` stamps the session
        // synchronously, before the PTY actually exits, and the renderer flips
        // it to exited at the same moment - which drops a PARKED window, whose
        // pane then unregisters while the registry still says running. Handing
        // that pane off would stand a lane up for an agent that is being
        // stopped, only for session end to tear it down moments later
        // (observed live).
        return context.sessionManager.hasLiveSessionForTask(taskId);
      } catch {
        // Never let a lookup failure decide policy: no hand-off is the safe
        // answer, since a spurious one would open a browser nobody asked for.
        return false;
      }
    },
  });

  // Make an offscreen surface VISIBLE in the UI.
  //
  // Not cosmetic. The card globe and the task-detail Browser pill both read
  // `browserGuestTasks`, which is written in exactly one place -
  // `BrowserPane.tsx`, on the `<webview>`'s `dom-ready` - so an offscreen
  // `BrowserWindow` set nothing and the user had no way to know their task had
  // a browser at all, let alone close it. That is what ended agent-requested
  // lanes; this push is what lets the remaining fallback stay honest.
  //
  // `broadcast` rather than `webContents.send`, and the reason is the MONITOR
  // pop-out, not a detached task detail (there is no task-detail pop-out
  // surface). `PopOutMonitorRoot` mounts `MonitorDetailLayer`, so a task detail
  // - and its Browser pill - renders in that window's own renderer, which never
  // mounts App.tsx and so has none of its subscriptions. `broadcast` reaches a
  // pop-out only if its surface declares the channel, so the monitor surface
  // lists `BROWSER_OFFSCREEN_SURFACES` and seeds the set in its own bootstrap.
  setLaneChangeListener(() => {
    broadcast(context.mainWindow, IPC.BROWSER_OFFSCREEN_SURFACES, laneTaskIds());
  });

  ipcMain.handle(IPC.BROWSER_CAPTURE_SEND, async (_event, input: BrowserCaptureInput) => {
    if (!input.sessionId) throw new Error('captureAndSend requires a sessionId');
    if (!input.pngBase64) throw new Error('captureAndSend requires pngBase64');
    if (!input.cwd) throw new Error('captureAndSend requires cwd');

    // Defensive: sessionId is interpolated into a filesystem path. Reject
    // anything that isn't a UUID so a malformed IPC payload can't escape
    // the session directory via path traversal.
    if (!isValidSessionId(input.sessionId)) {
      throw new Error('captureAndSend received malformed sessionId');
    }

    // Always anchor at the project root so this directory lines up with
    // the session dir that resource-cleanup / cleanupTaskSession already
    // manage. Falls back to cwd when no project is open (transient case).
    const projectRoot = context.currentProjectPath ?? input.cwd;
    const captureDir = path.join(projectRoot, '.kangentic', 'sessions', input.sessionId, 'captures');
    await fs.promises.mkdir(captureDir, { recursive: true });

    const stamp = Date.now();
    const filename = `capture-${stamp}.png`;
    const absolutePngPath = path.join(captureDir, filename);
    // Async write so libuv's worker pool handles flush + close before we
    // hand the path to the agent. On Windows, this gives AV scanners a
    // moment to finish their open-on-create scan, avoiding sharing
    // violations when the agent's Read tool opens the file immediately
    // after Send. On Unix it's a no-op cost difference.
    await fs.promises.writeFile(absolutePngPath, Buffer.from(input.pngBase64, 'base64'));

    // Path the agent sees in the prompt is relative to its cwd. For
    // worktree-cwd tasks this starts with `..` (the captures dir lives
    // under the project root, not the worktree); buildPromptPayload
    // POSIX-ifies the separators before emitting the @-mention.
    let relativePngPath = path.relative(input.cwd, absolutePngPath);
    // Windows cross-drive guard: when projectRoot and cwd live on different
    // drives, path.relative returns the absolute target instead of a
    // walked-up path. Falling back to the absolute path keeps the file
    // reachable; the agent's @-mention parser handles either form.
    if (isCrossDrivePath(relativePngPath)) {
      console.warn(`[browser] capture path crosses drives (cwd=${input.cwd}); using absolute path`);
      relativePngPath = absolutePngPath;
    }
    const payload = buildPromptPayload(input, relativePngPath);

    // Look up the session's adapter to get the submission verifier for paste confirmation.
    const agentName = context.sessionManager.getSessionAgentName(input.sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    const verifier = adapter?.getSubmissionVerifier?.('paste') ?? undefined;

    // TerminalSubmit.submitContent handles bracketed-paste wrap, drain,
    // paste-to-Enter gap, and atomic submit. Translate engine errors to
    // renderer-facing toasts.
    try {
      await context.terminalSubmit.submitContent(input.sessionId, payload, {
        bracketed: true,
        source: 'browser-capture',
        verifier,
      });
    } catch (caught) {
      if (caught instanceof PasteSubmitError) {
        const userMessage = caught.code === 'timeout'
          ? 'Paste timed out - the agent may be busy. Try again.'
          : caught.code === 'no-submission-evidence'
            ? caught.message.includes('bracketed-paste mode')
              ? 'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.'
              : 'Paste landed but Enter did not submit. Press Enter in the terminal to submit.'
            : 'Paste was cancelled.';
        const error = new Error(userMessage);
        (error as Error & { cause?: unknown }).cause = caught;
        throw error;
      }
      throw caught;
    }

    return { filePath: absolutePngPath };
  });

  // === URL persistence ===
  // These carry an explicit projectId (see .claude/rules/project-scoped-ipc.md).
  // The pane that owns a task URL is not always in the foreground project: a
  // popped-out pane outlives a project switch, and a navigation there resolved
  // against the ambient current project wrote that task's URL into the OTHER
  // project's browser-urls.json. Nothing surfaced the mix-up; the task just
  // reopened on a page from a different project.
  ipcMain.handle(IPC.BROWSER_URL_GET, (_event, taskId: string, projectId?: string | null) => {
    const { projectId: resolvedProjectId, projectPath } = resolveProjectContext(context, projectId);
    if (!projectPath || !resolvedProjectId) return { projectDefault: null, taskOverride: null };
    const overrides = context.configManager.loadProjectOverrides(projectPath);
    const projectDefault = overrides?.browser?.defaultUrl ?? null;
    // An OFFSCREEN surface's live URL outranks the saved one, and this is what
    // makes the reclaim land on the right page.
    //
    // A pane asking for its URL while the task's surface is offscreen is a pane
    // about to REPLACE that surface: the registration it is heading for
    // destroys it (`browser-lane-handoff.ts`). So the honest answer to "what
    // was this task last looking at" is where the agent left the offscreen
    // surface, which the sidecar cannot know - it is written by the PANE on its
    // own `did-navigate`, and an offscreen surface has no renderer to write it.
    const taskOverride =
      offscreenSurfaceUrl(taskId, resolvedProjectId) ?? browserUrlStore.get(projectPath, taskId);
    // Deliberately does NOT report a reserved dev-server port. A reservation is
    // not evidence anything is serving there - the project decides its own ports
    // - so pointing the pane at one renders a blank page for a server nobody
    // started. See useBrowserUrl's resolution comment.
    return { projectDefault, taskOverride };
  });

  ipcMain.handle(IPC.BROWSER_URL_SET_TASK, (_event, taskId: string, url: string, projectId?: string | null) => {
    const { projectPath } = resolveProjectContext(context, projectId);
    if (!projectPath) throw new Error('No project open');
    if (!url) throw new Error('URL is required');
    browserUrlStore.set(projectPath, taskId, url);
  });

  ipcMain.handle(IPC.BROWSER_URL_CLEAR_TASK, (_event, taskId: string, projectId?: string | null) => {
    const { projectPath } = resolveProjectContext(context, projectId);
    if (!projectPath) return;
    browserUrlStore.clear(projectPath, taskId);
  });

  // Wipe the embedded browser's persistent partitions. Cookies, localStorage,
  // IndexedDB, service workers, and HTTP/auth caches all go. Per-task URL
  // overrides and the project default URL live elsewhere (browser-urls.json,
  // AppConfig.browser.defaultUrl) and are intentionally left alone. Those
  // are workflow state, not browsing identity.
  //
  // Per-task isolation means a project has one jar per task, so clear
  // them all: the legacy shared jar (data left from before the upgrade, plus
  // no-project panes), the project's identity jar, and every task jar the project
  // owns on disk (`kng-<projectId>-*`). Enumerated by prefix from the Partitions
  // directory, so no DB is touched.
  ipcMain.handle(IPC.BROWSER_CLEAR_STORAGE, async () => {
    const partitions = enumerateProjectPartitions(context.currentProjectId, app.getPath('userData'));
    // Clear the partitions concurrently: they are independent session stores, so
    // the three-call sequence per partition stays ordered while the (legacy +
    // identity + N task) jars clear in parallel rather than serially.
    await Promise.all(
      partitions.map(async (partition) => {
        const browserSession = session.fromPartition(partition);
        await browserSession.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'cachestorage', 'serviceworkers'],
        });
        await browserSession.clearCache();
        await browserSession.clearAuthCache();
      }),
    );
  });

  // Sync a task's jar with the project identity jar before its guest attaches, so
  // the pane opens already signed into shared non-localhost (IdP) sessions. A
  // load-boundary hook: runs on every pane mount, never rejects (a failed or slow
  // sync must never wedge the pane; the renderer also caps it with a timeout).
  // See jar-seeder.ts for the share-identity / isolate-localhost model.
  ipcMain.handle(IPC.BROWSER_JAR_ENSURE, async (_event, taskId: string, projectId?: string | null) => {
    try {
      // No ambient-project fallback on purpose: the pane computes its partition
      // from its OWN projectId prop (legacy shared jar when null), so seeding
      // `kng-<currentProject>-<task>` here would sync a jar the guest never
      // binds. A null projectId means the pane bound the legacy jar, which is a
      // hub partition and needs no seeding.
      if (!projectId || !taskId) return;
      const partition = browserPartitionForTask(projectId, taskId);
      await syncJarFromIdentity(partition, projectId);
    } catch (error) {
      console.warn('[browser-pane] ensureJar failed:', error);
    }
  });

  // === Pane registry: track an open Browser pane's guest webContents so the
  // kangentic_browser_* MCP tools can target it. Registry bookkeeping (not a
  // task-state mutation), so projectId rides in the payload rather than as a
  // trailing argument.
  ipcMain.handle(IPC.BROWSER_PANE_REGISTER, (_event, input: BrowserPaneRegisterInput) => {
    if (!input || !isValidSessionId(input.sessionId)) {
      throw new Error('registerPane received a malformed sessionId');
    }
    if (!Number.isInteger(input.webContentsId) || input.webContentsId <= 0) {
      throw new Error('registerPane received an invalid webContentsId');
    }
    // The session registry is the authoritative owner of a session's project:
    // it is stamped at spawn and cannot drift. The renderer's value is ambient
    // (`currentProject`), which a pop-out window's separate store holds stale
    // across a project switch, so it is only a fallback for a session the
    // registry does not know. Getting this wrong is not cosmetic: resolveTarget
    // refuses cross-project targets by comparing against this field.
    const resolvedProjectId =
      context.sessionManager.getSessionProjectId(input.sessionId) ?? input.projectId ?? null;
    // The registry mints (or, for a guest it already knows, keeps) the surface
    // handle; the renderer's `sessionId` is the agent session that OWNS the pane.
    const entry = browserPaneRegistry.register({
      ownerSessionId: input.sessionId,
      taskId: input.taskId,
      projectId: resolvedProjectId,
      webContentsId: input.webContentsId,
      url: input.url ?? null,
      visibility: isPaneVisibility(input.visibility) ? input.visibility : undefined,
    });

    // Diagnostic (main-side, because the renderer console never persists to
    // .kangentic/logs): record the jar this pane bound. Derived from the pane's
    // OWN projectId (the value its partition was computed from), NOT the
    // registry-resolved one above, so the trace names the jar the guest actually
    // attached to even if the two ever diverge. The jar is keyed by task
    // identity now, so the path-change logout it used to guard against cannot
    // occur; this stays only as a lightweight "which jar did it bind" trace.
    if (input.projectId) {
      console.log(
        `[browser-pane] pane bound partition=${browserPartitionForTask(input.projectId, input.taskId)} `
          + `task=${input.taskId.slice(0, 8)} owner=${input.sessionId.slice(0, 8)} handle=${entry.sessionId} wc=${input.webContentsId}`,
      );
    }
  });

  ipcMain.handle(IPC.BROWSER_PANE_UNREGISTER, (_event, webContentsId: number) => {
    // The renderer unregisters the exact guest it registered, never a session:
    // an out-of-order unmount across the in-app pane and its pop-out can then
    // only remove its own guest, and a newer registration for the same task
    // (a different guest) is untouched. A malformed id is a harmless no-op.
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId <= 0) return;
    browserPaneRegistry.unregisterByWebContentsId(webContentsId, 'renderer-unmount');
  });

  // The user's Close control. The renderer sends this BEFORE it unmounts the
  // pane, so the handle retires with `user-closed` (the hand-off allowlist does
  // not include it, so no lane is stood up - the user closed it to get the
  // memory back) and the agent's next call is told who closed it. The unmount
  // that follows unregisters a guest this registry no longer knows: a no-op.
  ipcMain.handle(IPC.BROWSER_PANE_USER_CLOSE, (_event, webContentsId: number) => {
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId <= 0) return;
    browserPaneRegistry.unregisterByWebContentsId(webContentsId, 'user-closed');
  });

  // Where a registered pane is on the user's screen, for list_panes. Validated
  // against the shared enum: an unknown value is dropped rather than stored,
  // since it would be echoed verbatim to every agent that lists panes.
  ipcMain.handle(IPC.BROWSER_PANE_VISIBILITY, (_event, webContentsId: number, visibility: unknown) => {
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId <= 0) return;
    if (!isPaneVisibility(visibility)) return;
    browserPaneRegistry.setVisibility(webContentsId, visibility);
  });

  // The pane element's own size, which only the renderer can measure. Fitting
  // a requested viewport needs it; see BrowserPaneEntry.widgetSize.
  ipcMain.handle(
    IPC.BROWSER_PANE_WIDGET_SIZE,
    (_event, webContentsId: number, width: unknown, height: unknown) => {
      if (!isGuestId(webContentsId)) return;
      if (typeof width !== 'number' || typeof height !== 'number') return;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      browserPaneRegistry.setWidgetSize(webContentsId, width, height);
    },
  );

  // What override this guest is already under. A pane that mounts after one was
  // set (a pop-out window, or a re-register) never saw the push, so it asks
  // once rather than showing nothing while the page renders at a width the user
  // cannot account for.
  ipcMain.handle(IPC.BROWSER_VIEWPORT_GET, (_event, webContentsId: number) => {
    if (!isGuestId(webContentsId)) return null;
    const record = getViewportOverride(webContentsId);
    if (!record) return null;
    return toRendererOverride(record);
  });

  // The user taking their pane back, from the chip in the pane's own toolbar.
  //
  // Deliberately NOT routed through the agent's `withGuest` chokepoint: that
  // path gates on the automation capability config and serializes behind
  // whatever drive currently holds the guest, and neither may stand between a
  // user and undoing something an agent did to their screen. The automatic
  // counterpart runs when the agent's session ends, which can be hours away.
  ipcMain.handle(IPC.BROWSER_VIEWPORT_CLEAR, async (_event, webContentsId: number) => {
    if (!isGuestId(webContentsId)) return false;
    const guest = webContents.fromId(webContentsId);
    if (!guest) return false;
    await releaseViewportOverride(guest);
    return true;
  });

  // Which tasks hold their one browser surface offscreen, asked for on mount
  // and after an HMR update. The push keeps it current from there; this is the
  // initial read, because a surface can sit unchanged for a whole session and
  // a reloaded renderer would otherwise show no browser for a task that has
  // one.
  ipcMain.handle(IPC.BROWSER_OFFSCREEN_SURFACES_GET, () => laneTaskIds());

  // The user's Close on a task whose surface is offscreen.
  //
  // `closeBrowserForTask`'s ordinary path retires a guest id and clears the
  // pane's open flag, and an offscreen surface has neither - so without this
  // the kebab's "Close browser" was a control that said Close and did nothing.
  // Scoped through `getByTaskId(taskId, projectId)` rather than by task id
  // alone, per `.claude/rules/project-scoped-ipc.md`.
  ipcMain.handle(IPC.BROWSER_OFFSCREEN_CLOSE, (_event, taskId: string, projectId?: string | null) => {
    const { projectId: resolvedProjectId } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId) return false;
    let closed = false;
    for (const entry of browserPaneRegistry.getByTaskId(taskId, resolvedProjectId)) {
      if (entry.kind !== 'lane') continue;
      if (destroyLane(entry.sessionId)) closed = true;
    }
    return closed;
  });
}

function isGuestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** The main-side record minus the bookkeeping the renderer has no use for
 *  (which session owns it), so the chip cannot accidentally render an id. */
function toRendererOverride(record: ViewportOverrideRecord): BrowserViewportOverride {
  return {
    mechanism: record.mechanism,
    requested: record.requested,
    measured: record.measured,
    deviceScaleFactor: record.deviceScaleFactor,
    appliedAt: record.appliedAt,
  };
}

function isPaneVisibility(value: unknown): value is BrowserPaneVisibility {
  return typeof value === 'string' && (BROWSER_PANE_VISIBILITIES as readonly string[]).includes(value);
}
