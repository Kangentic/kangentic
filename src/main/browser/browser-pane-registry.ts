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
 * when a renderer cleanup is skipped (e.g. a hard reload). The tracked URL is
 * a fallback rather than the source of truth: `list()` reads it from the live
 * guest, since `did-navigate` misses same-document navigation entirely.
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
  /**
   * Narrower than the entry's own `url`: read from the live guest while it
   * exists, so it reflects same-document navigation the `did-navigate` cache
   * never sees. Falls back to the cached value once the guest is gone.
   */
  url: string | null;
  /** True when the guest webContents still resolves and is not destroyed. */
  alive: boolean;
  /** True when a CDP debugger is currently attached to the guest. */
  debuggerAttached: boolean;
}

export type ResolveTargetSelector = {
  sessionId?: string;
  taskId?: string;
  /**
   * The CALLER's project. Every branch of `resolveTarget` refuses a pane
   * outside it, and the implicit default only ever considers panes inside it.
   *
   * Required and explicitly nullable rather than optional, so a new call site
   * cannot fall back into the old process-wide behavior by forgetting the
   * field: `null` is the deliberate unscoped opt-in for main-process internal
   * callers and tests, and has to be typed out.
   */
  projectId: string | null;
  /**
   * The caller's own session id, from the MCP URL path
   * (`/mcp/<projectId>/<callerSessionId>`). A PREFERENCE for the implicit
   * default only, never a refusal input: absent or unmatched degrades to the
   * next rule rather than failing.
   */
  callerSessionId?: string;
  /**
   * The caller's own task id, resolved server-side from `callerSessionId`.
   * Second preference after a direct `callerSessionId` hit, so a session
   * rotation still finds the caller's own task's pane.
   */
  callerTaskId?: string;
};

export type ResolveTargetResult =
  | { ok: true; entry: BrowserPaneEntry }
  | {
      ok: false;
      kind: 'no-pane-open' | 'multiple-panes' | 'foreign-project';
      detail: string;
      candidates?: BrowserPaneEntry[];
    };

/**
 * `foreign-project` deliberately reveals that the named pane exists somewhere
 * else rather than collapsing to `no-pane-open`. The `no-pane-open` copy tells
 * the agent to open the Browser pill, which is actively wrong when the pane IS
 * open and simply is not theirs: the agent asks the user to open something
 * already open, and neither can tell why. This is a same-machine, same-user
 * boundary and an honesty mechanism (see `mcp-http/caller-url.ts` on why caller
 * identity is honesty-by-default, not cryptographic attribution), so a
 * misleading error costs more than the disclosure. Do not "fix" this back into
 * `no-pane-open`.
 */
const FOREIGN_PROJECT_HINT =
  'The kangentic_browser_* tools only drive Browser panes in your own project. Call kangentic_browser_list_panes to see the panes you can drive.';

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

  /** Unregister sessionId's pane ONLY if its current entry still has this exact
   *  webContentsId. A renderer's unmount cleanup passes the webContentsId it
   *  itself registered with, so an out-of-order unmount (e.g. the in-app pane
   *  unmounting AFTER a pop-out window's pane already re-registered the same
   *  sessionId with a new guest) cannot clobber the newer registration. */
  unregisterIfMatches(sessionId: string, webContentsId: number): void {
    const entry = this.panes.get(sessionId);
    if (entry && entry.webContentsId === webContentsId) {
      this.panes.delete(sessionId);
    }
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

  /**
   * Whether one entry is visible to a caller scoped to `projectId`. A null
   * scope is a main-process internal caller and sees everything. A scoped
   * caller never sees an entry whose own project is null: an unattributed pane
   * cannot be PROVEN to belong to the caller, and guessing is exactly the bug
   * this scoping closes. Those panes are surfaced by count instead of being
   * silently dropped (see the skipped clause in `resolveTarget`).
   */
  private inScope(entry: BrowserPaneEntry, projectId: string | null): boolean {
    if (projectId === null) return true;
    return entry.projectId === projectId;
  }

  /**
   * All registered panes enriched with live + debugger-attached status.
   *
   * The URL is read from the LIVE guest rather than reported from the cached
   * `entry.url`, because the cache is only ever as fresh as the `did-navigate`
   * events that feed it and `did-navigate` does not fire at all for
   * same-document navigation. Every SPA route change, `pushState`, and fragment
   * update therefore drifts the cache by design, and a dev server is exactly
   * what this feature points a pane at. That made `list_panes`, the one tool an
   * agent has for checking where its own pane is pointed, report a URL the pane
   * had left.
   *
   * Reading live is free here: this method already resolves the guest to decide
   * `alive`. The cached value stays as the fallback for a pane whose guest is
   * gone, where it is the last thing we truthfully knew.
   */
  list(): BrowserPaneStatus[] {
    return [...this.panes.values()].map((entry) => {
      const guest = electronWebContents.fromId(entry.webContentsId);
      const alive = guest != null && !guest.isDestroyed();
      let url = entry.url;
      if (alive) {
        try {
          url = guest.getURL() || entry.url;
        } catch {
          // Guest torn down between the alive check and the read; keep the cache.
        }
      }
      return {
        ...entry,
        url,
        alive,
        debuggerAttached: alive ? isDebuggerAttached(guest) : false,
      };
    });
  }

  /**
   * Resolve a target selector to a single pane entry, scoped to the CALLER's
   * project. Every branch refuses a pane outside `selector.projectId`, so an
   * agent cannot reach another project's Browser pane: not by omitting a
   * selector, not by naming a taskId, and not by naming a sessionId it read out
   * of `kangentic_browser_list_panes`.
   *
   * Precedence: an explicit sessionId, then an explicit taskId, then the
   * caller's own pane, then the caller's own task, then the single pane open in
   * the caller's project.
   *
   * The invariant that makes this safe to degrade: a PREFERENCE matching zero
   * panes falls through to the next rule. Only an explicit selector or a
   * genuine ambiguity refuses. So a caller with no identity (a human-driven
   * client, the two-segment `.kangentic/mcp-config.json` URL, a Command
   * Terminal session) skips both preference rules and lands on exactly the old
   * behavior, scoped to its project, rather than on a new refusal.
   *
   * Returns a structured error the MCP layer surfaces verbatim.
   */
  resolveTarget(selector: ResolveTargetSelector): ResolveTargetResult {
    // Deliberately NOT `?? null`. The type makes the field mandatory, but a
    // plain-JS caller that omits it must fail CLOSED (match nothing) rather
    // than silently reopening the process-wide path that leaked panes across
    // projects. Only an explicit `null` means unscoped.
    const scope = selector.projectId;

    if (selector.sessionId) {
      const entry = this.panes.get(selector.sessionId);
      if (!entry) {
        return {
          ok: false,
          kind: 'no-pane-open',
          detail: `No Browser pane is registered for session ${selector.sessionId}. Open the task's Browser pane (the Browser pill in the task header) and load a URL first.`,
        };
      }
      if (!this.inScope(entry, scope)) {
        return {
          ok: false,
          kind: 'foreign-project',
          detail: `Session ${selector.sessionId} belongs to a different project than this connection. ${FOREIGN_PROJECT_HINT}`,
        };
      }
      return { ok: true, entry };
    }

    if (selector.taskId) {
      // Query unscoped, then filter, so "no pane for this task anywhere" stays
      // distinguishable from "that task's pane lives in another project".
      const anywhere = this.getByTaskId(selector.taskId);
      const matches = anywhere.filter((entry) => this.inScope(entry, scope));
      if (matches.length === 0) {
        if (anywhere.length > 0) {
          return {
            ok: false,
            kind: 'foreign-project',
            detail: `Task ${selector.taskId} has a Browser pane open in a different project. ${FOREIGN_PROJECT_HINT}`,
          };
        }
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

    // No explicit selector. Prefer the caller's own pane, then their own task,
    // then the single pane open in their project.
    const inScopePanes: BrowserPaneEntry[] = [];
    let unattributedCount = 0;
    for (const entry of this.panes.values()) {
      if (this.inScope(entry, scope)) inScopePanes.push(entry);
      else if (entry.projectId === null) unattributedCount += 1;
    }

    if (selector.callerSessionId) {
      // Survives a null session lookup: this rule needs only the URL segment.
      const own = this.panes.get(selector.callerSessionId);
      if (own && this.inScope(own, scope)) return { ok: true, entry: own };
    }

    if (selector.callerTaskId) {
      // Survives a session rotation, where the pane is registered under an id
      // that is no longer the caller's.
      const ownTaskPanes = inScopePanes.filter((entry) => entry.taskId === selector.callerTaskId);
      if (ownTaskPanes.length === 1) return { ok: true, entry: ownTaskPanes[0] };
      if (ownTaskPanes.length > 1) {
        return {
          ok: false,
          kind: 'multiple-panes',
          detail: `${ownTaskPanes.length} Browser panes match your own task ${selector.callerTaskId}. Pass an explicit sessionId to disambiguate. Candidates: ${ownTaskPanes.map((entry) => entry.sessionId).join(', ')}.`,
          candidates: ownTaskPanes,
        };
      }
      // Zero matches falls through rather than refusing.
    }

    if (inScopePanes.length === 1) {
      return { ok: true, entry: inScopePanes[0] };
    }
    if (inScopePanes.length === 0) {
      const base =
        scope === null
          ? "No Browser pane is open in any task. Open a task's Browser pane (the Browser pill in the task header) and load a URL first."
          : "No Browser pane is open in this project. Open a task's Browser pane (the Browser pill in the task header) and load a URL first.";
      // Never strand a pane silently: an entry with no project recorded is
      // unreachable from a scoped caller, so say so and say how to fix it.
      const skipped =
        unattributedCount === 0
          ? ''
          : unattributedCount === 1
            ? ' 1 registered Browser pane has no project recorded and was skipped. Close and reopen it so it registers against this project.'
            : ` ${unattributedCount} registered Browser panes have no project recorded and were skipped. Close and reopen them so they register against this project.`;
      return { ok: false, kind: 'no-pane-open', detail: `${base}${skipped}` };
    }
    return {
      ok: false,
      kind: 'multiple-panes',
      detail:
        scope === null
          ? `${inScopePanes.length} Browser panes are open. Pass a sessionId or taskId to choose one. Use kangentic_browser_list_panes to list them.`
          : `${inScopePanes.length} Browser panes are open in this project. Pass a sessionId or taskId to choose one. Use kangentic_browser_list_panes to list them.`,
      candidates: inScopePanes,
    };
  }

  /**
   * Panes visible to a caller scoped to `projectId`, plus counts of what was
   * withheld so an empty list is never mistaken for an idle machine. Built over
   * `list()` so the alive / debugger-attached enrichment lives in one place.
   */
  listForProject(projectId: string): {
    panes: BrowserPaneStatus[];
    otherProjectPaneCount: number;
    unknownProjectPaneCount: number;
  } {
    const panes: BrowserPaneStatus[] = [];
    let otherProjectPaneCount = 0;
    let unknownProjectPaneCount = 0;
    for (const status of this.list()) {
      if (status.projectId === projectId) panes.push(status);
      else if (status.projectId === null) unknownProjectPaneCount += 1;
      else otherProjectPaneCount += 1;
    }
    return { panes, otherProjectPaneCount, unknownProjectPaneCount };
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
