import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, session } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { BROWSER_PARTITION, browserPartitionForWorktree } from '../../../shared/browser-partition';
import type { BrowserCaptureInput, BrowserPaneRegisterInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { getProjectRepos, resolveProjectContext } from '../helpers/project-repos';
import { browserUrlStore } from '../../browser/browser-url-store';
import { browserPaneRegistry } from '../../browser/browser-pane-registry';
import { setBrowserPaneOpenerHost } from '../../browser/browser-pane-opener';
import { installLaneHandoff } from '../../browser/browser-lane-handoff';
import { getDevPortForTask } from '../../dev-ports/dev-port-allocator';
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
        // suspended or exited session has no agent to keep a browser for.
        return context.sessionManager.findLiveSessionByTaskId(taskId) !== undefined;
      } catch {
        // Never let a lookup failure decide policy: no hand-off is the safe
        // answer, since a spurious one would open a browser nobody asked for.
        return false;
      }
    },
    getTaskWorktreePath: (taskId) => {
      try {
        const projectId = context.currentProjectId;
        if (!projectId) return null;
        return getProjectRepos(context, projectId).tasks.getById(taskId)?.worktree_path ?? null;
      } catch {
        return null;
      }
    },
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
    const { projectPath } = resolveProjectContext(context, projectId);
    if (!projectPath) return { projectDefault: null, taskOverride: null, taskPortUrl: null };
    const overrides = context.configManager.loadProjectOverrides(projectPath);
    const projectDefault = overrides?.browser?.defaultUrl ?? null;
    const taskOverride = browserUrlStore.get(projectPath, taskId);
    // The task's own leased dev-server port, so a pane opens on THIS task's dev
    // server rather than whatever URL the project default happens to hold. That
    // default is one value shared by every task, so with several tasks running
    // at once it is right for at most one of them.
    const devPort = getDevPortForTask(taskId);
    const taskPortUrl = devPort === null ? null : `http://localhost:${devPort}`;
    return { projectDefault, taskOverride, taskPortUrl };
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
  // Per-worktree isolation means a project has one jar per worktree, so clear
  // them all: the legacy shared jar (data left from before the upgrade, plus
  // no-worktree panes), the project-root jar, and every worktree jar under
  // `.kangentic/worktrees/`. Enumerated from disk so no DB / registry coupling.
  ipcMain.handle(IPC.BROWSER_CLEAR_STORAGE, async () => {
    const partitions = new Set<string>([BROWSER_PARTITION]);
    const projectRoot = context.currentProjectPath;
    if (projectRoot) {
      partitions.add(browserPartitionForWorktree(projectRoot));
      const worktreesDir = path.join(projectRoot, '.kangentic', 'worktrees');
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
      } catch {
        // No worktrees directory yet - just the root + legacy jars.
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          partitions.add(browserPartitionForWorktree(path.join(worktreesDir, entry.name)));
        }
      }
    }
    // Clear the partitions concurrently: they are independent session stores, so
    // the three-call sequence per partition stays ordered while the (legacy +
    // root + N worktree) jars clear in parallel rather than serially.
    await Promise.all(
      [...partitions].map(async (partition) => {
        const browserSession = session.fromPartition(partition);
        await browserSession.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'cachestorage', 'serviceworkers'],
        });
        await browserSession.clearCache();
        await browserSession.clearAuthCache();
      }),
    );
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
    browserPaneRegistry.register({
      sessionId: input.sessionId,
      taskId: input.taskId,
      projectId: resolvedProjectId,
      webContentsId: input.webContentsId,
      url: input.url ?? null,
    });
  });

  ipcMain.handle(IPC.BROWSER_PANE_UNREGISTER, (_event, sessionId: string, webContentsId?: number) => {
    // Mirror the register handler's input guard (a registered sessionId always
    // passed it). A bad key would be a harmless Map no-op, but validating keeps
    // the two sibling handlers symmetric.
    if (!isValidSessionId(sessionId)) return;
    // When the caller passes the webContentsId it registered with (every
    // BrowserPane instance does), scope the unregister to that exact guest so
    // an out-of-order unmount across the in-app pane and its pop-out cannot
    // clobber a newer registration for the same sessionId. Falls back to the
    // unconditional unregister for any caller that omits it.
    if (typeof webContentsId === 'number' && Number.isInteger(webContentsId) && webContentsId > 0) {
      browserPaneRegistry.unregisterIfMatches(sessionId, webContentsId);
    } else {
      browserPaneRegistry.unregister(sessionId);
    }
  });
}
