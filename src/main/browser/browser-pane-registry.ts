import { webContents as electronWebContents, type WebContents } from 'electron';
import { detachDebugger, isDebuggerAttached } from './cdp/cdp';

/**
 * Registry mapping an open embedded Browser pane to its guest `<webview>`
 * webContents, so the `kangentic_browser_*` MCP tools can target the right
 * pane. The renderer is the only place that knows all three of taskId,
 * sessionId, and the guest's `getWebContentsId()`, so it registers each pane
 * via IPC on `dom-ready` and unregisters on unmount. The main process also
 * keeps the registry honest from the guest's own lifecycle events
 * (`did-navigate` -> updateUrl, `destroyed` -> unregister), which fire even
 * when a renderer cleanup is skipped (e.g. a hard reload).
 *
 * Keyed by sessionId: there is exactly one Browser pane per task-detail
 * window, and a session is unique to its pane.
 *
 * Main-process state, so no HMR concerns (esbuild does not Fast-Refresh main).
 */
export interface BrowserPaneEntry {
  sessionId: string;
  taskId: string;
  projectId: string | null;
  /** The guest webContents id from the renderer's `webview.getWebContentsId()`. */
  webContentsId: number;
  /** Last known navigated URL (null until the first navigation lands). */
  url: string | null;
  registeredAt: number;
}

/** A pane entry enriched with live status for `list()` / discovery. */
export interface BrowserPaneStatus extends BrowserPaneEntry {
  /** True when the guest webContents still resolves and is not destroyed. */
  alive: boolean;
  /** True when a CDP debugger is currently attached to the guest. */
  debuggerAttached: boolean;
}

export type ResolveTargetSelector = {
  sessionId?: string;
  taskId?: string;
  projectId?: string | null;
};

export type ResolveTargetResult =
  | { ok: true; entry: BrowserPaneEntry }
  | {
      ok: false;
      kind: 'no-pane-open' | 'multiple-panes' | 'no-target';
      detail: string;
      candidates?: BrowserPaneEntry[];
    };

export type ResolveGuestResult =
  | { ok: true; entry: BrowserPaneEntry; webContents: WebContents }
  | { ok: false; kind: 'pane-destroyed'; detail: string };

export class BrowserPaneRegistry {
  private readonly panes = new Map<string, BrowserPaneEntry>();

  register(input: {
    sessionId: string;
    taskId: string;
    projectId: string | null;
    webContentsId: number;
    url: string | null;
  }): void {
    this.panes.set(input.sessionId, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      projectId: input.projectId,
      webContentsId: input.webContentsId,
      url: input.url,
      registeredAt: Date.now(),
    });
  }

  unregister(sessionId: string): void {
    this.panes.delete(sessionId);
  }

  /** Remove whatever pane is bound to a guest webContents id (guest `destroyed`). */
  unregisterByWebContentsId(webContentsId: number): void {
    for (const [sessionId, entry] of this.panes) {
      if (entry.webContentsId === webContentsId) {
        this.panes.delete(sessionId);
        return;
      }
    }
  }

  updateUrl(sessionId: string, url: string): void {
    const entry = this.panes.get(sessionId);
    if (entry) entry.url = url;
  }

  /** Update the URL for whatever pane owns a guest webContents id (guest `did-navigate`). */
  updateUrlByWebContentsId(webContentsId: number, url: string): void {
    for (const entry of this.panes.values()) {
      if (entry.webContentsId === webContentsId) {
        entry.url = url;
        return;
      }
    }
  }

  get(sessionId: string): BrowserPaneEntry | undefined {
    return this.panes.get(sessionId);
  }

  getByTaskId(taskId: string, projectId?: string | null): BrowserPaneEntry[] {
    const matches: BrowserPaneEntry[] = [];
    for (const entry of this.panes.values()) {
      if (entry.taskId !== taskId) continue;
      if (projectId != null && entry.projectId !== projectId) continue;
      matches.push(entry);
    }
    return matches;
  }

  /** All registered panes enriched with live + debugger-attached status. */
  list(): BrowserPaneStatus[] {
    return [...this.panes.values()].map((entry) => {
      const guest = electronWebContents.fromId(entry.webContentsId);
      const alive = guest != null && !guest.isDestroyed();
      return {
        ...entry,
        alive,
        debuggerAttached: alive ? isDebuggerAttached(guest) : false,
      };
    });
  }

  /**
   * Resolve a target selector to a single pane entry. Prefers an explicit
   * sessionId; falls back to taskId (optionally scoped by project). Returns a
   * structured error the MCP layer can surface verbatim.
   */
  resolveTarget(selector: ResolveTargetSelector): ResolveTargetResult {
    if (selector.sessionId) {
      const entry = this.panes.get(selector.sessionId);
      if (!entry) {
        return {
          ok: false,
          kind: 'no-pane-open',
          detail: `No Browser pane is registered for session ${selector.sessionId}. Open the task's Browser pane (the Browser pill in the task header) and load a URL first.`,
        };
      }
      return { ok: true, entry };
    }
    if (selector.taskId) {
      const matches = this.getByTaskId(selector.taskId, selector.projectId);
      if (matches.length === 0) {
        return {
          ok: false,
          kind: 'no-pane-open',
          detail: `No Browser pane is open for task ${selector.taskId}. Open the task's Browser pane (the Browser pill in the task header) and load a URL first.`,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          kind: 'multiple-panes',
          detail: `${matches.length} Browser panes match task ${selector.taskId}. Pass an explicit sessionId to disambiguate. Candidates: ${matches.map((entry) => entry.sessionId).join(', ')}.`,
          candidates: matches,
        };
      }
      return { ok: true, entry: matches[0] };
    }
    // No explicit selector: default to the single open pane (the common case
    // of one task with one Browser pane). Error with candidates when ambiguous.
    const all = [...this.panes.values()];
    if (all.length === 0) {
      return {
        ok: false,
        kind: 'no-pane-open',
        detail: "No Browser pane is open in any task. Open a task's Browser pane (the Browser pill in the task header) and load a URL first.",
      };
    }
    if (all.length === 1) {
      return { ok: true, entry: all[0] };
    }
    return {
      ok: false,
      kind: 'multiple-panes',
      detail: `${all.length} Browser panes are open. Pass a sessionId or taskId to choose one. Use kangentic_browser_list_panes to list them.`,
      candidates: all,
    };
  }

  /**
   * Resolve an entry to a live guest webContents, evicting the entry and
   * reporting `pane-destroyed` when the guest no longer exists. This makes the
   * registry self-healing against stale ids even if an unregister was missed.
   */
  resolveLiveGuest(entry: BrowserPaneEntry): ResolveGuestResult {
    const guest = electronWebContents.fromId(entry.webContentsId);
    if (!guest || guest.isDestroyed()) {
      this.panes.delete(entry.sessionId);
      return {
        ok: false,
        kind: 'pane-destroyed',
        detail: `The Browser pane for session ${entry.sessionId} was closed. Reopen it and load a URL.`,
      };
    }
    return { ok: true, entry, webContents: guest };
  }

  /**
   * Synchronously detach every attached debugger. Wired into the synchronous
   * `before-quit` path (see .claude/rules/synchronous-shutdown.md): no await,
   * no network. `detachDebugger` already guards a destroyed webContents.
   */
  detachAll(): void {
    for (const entry of this.panes.values()) {
      const guest = electronWebContents.fromId(entry.webContentsId);
      if (guest) detachDebugger(guest);
    }
    this.panes.clear();
  }

  /** Test/diagnostic helper: number of registered panes. */
  get size(): number {
    return this.panes.size;
  }
}

/** Process-wide singleton. */
export const browserPaneRegistry = new BrowserPaneRegistry();
