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
/**
 * What kind of surface an entry points at.
 *
 * `pane` is the user-visible `<webview>` inside a task-detail window, owned by
 * the renderer. `lane` is a main-process offscreen `BrowserWindow` opened for
 * one caller so concurrent workers stop sharing a viewport.
 *
 * A lane deliberately lives in THIS registry rather than a parallel one: it
 * keeps a single resolver, a single liveness self-heal, and a single shutdown
 * path, so `withGuest` needed no change at all to drive one. What the field
 * buys is the two places where the distinction is real - `list_panes` labels
 * lanes, and `close_pane` ignores them, because a lane's lifetime belongs to
 * the caller that opened it rather than to a user gesture.
 */
export type BrowserSurfaceKind = 'pane' | 'lane';

export interface BrowserPaneEntry {
  sessionId: string;
  taskId: string;
  projectId: string | null;
  /** The guest webContents id from the renderer's `webview.getWebContentsId()`. */
  webContentsId: number;
  /** Last known navigated URL (null until the first navigation lands). */
  url: string | null;
  registeredAt: number;
  /**
   * Defaults to `pane` when absent, so every existing renderer registration and
   * every existing test fixture keeps its meaning without being touched.
   */
  kind?: BrowserSurfaceKind;
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

/**
 * What to do about `no-pane-open`, addressed to the agent that hit it.
 *
 * This used to say "open the Browser pane (the Browser pill in the task header)
 * and load a URL first", which named a UI affordance an agent cannot reach: the
 * only way out was to stop and ask the user, and that made this the most common
 * dead end on the whole family. `kangentic_browser_open_pane` opens the caller's
 * own pane and navigates it in one call, so the fix is now something the agent
 * can actually perform. Keep this pointing at the tool, not at the pill.
 */
const NO_PANE_OPEN_HINT =
  'Call kangentic_browser_open_pane with a url to open and load your own task\'s Browser pane, then retry.';

/**
 * Why a pane left the registry. Every deletion names one.
 *
 * These are indistinguishable from the outside - all four make a later
 * explicit-`sessionId` call return `no-pane-open` - which is precisely what made
 * task #542's retained-pane death hard to attribute.
 */
export type PaneUnregisterReason =
  /** The renderer's effect cleanup ran (component unmounted). */
  | 'renderer-unmount'
  /** Same, but compare-and-delete matched this instance's own guest id. */
  | 'renderer-unmount-matched'
  /** The guest webContents emitted `destroyed`. */
  | 'guest-destroyed'
  /** Self-heal: the entry pointed at a guest that no longer exists. */
  | 'self-heal-dead-guest';

// `detachAll` is deliberately absent. It bulk-clears on the synchronous
// `before-quit` path (see .claude/rules/synchronous-shutdown.md), where adding
// per-pane console I/O would slow the one path that must stay fast - and a
// deletion during shutdown needs no attribution, since the app is going away.

export type ResolveGuestResult =
  | { ok: true; entry: BrowserPaneEntry; webContents: WebContents }
  | { ok: false; kind: 'pane-destroyed'; detail: string };

export class BrowserPaneRegistry {
  private readonly panes = new Map<string, BrowserPaneEntry>();

  /**
   * Callbacks re-evaluated on every membership change, so a main-process caller
   * can await a pane appearing or going away instead of polling.
   *
   * This is what makes `kangentic_browser_open_pane` able to return only once
   * the pane is actually driveable: pane registration is renderer-driven and
   * asynchronous (it lands on the guest's `dom-ready`), so main has no other
   * signal that the push it sent took effect.
   */
  private readonly waiters = new Set<() => void>();

  private notifyWaiters(): void {
    // Iterate a copy: a waiter that settles removes itself from the set.
    for (const waiter of [...this.waiters]) waiter();
  }

  register(input: {
    sessionId: string;
    taskId: string;
    projectId: string | null;
    webContentsId: number;
    url: string | null;
    /** Omitted by the renderer, which only ever registers real panes. */
    kind?: BrowserSurfaceKind;
  }): void {
    this.panes.set(input.sessionId, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      projectId: input.projectId,
      webContentsId: input.webContentsId,
      url: input.url,
      registeredAt: Date.now(),
      kind: input.kind ?? 'pane',
    });
    this.notifyWaiters();
  }

  /**
   * Say WHY a pane left the registry.
   *
   * Four call paths delete an entry, and from the outside they are
   * indistinguishable: every one of them makes a later explicit-`sessionId`
   * call return `no-pane-open`. Task #542 hit exactly that wall - a retained
   * pane's guest was destroyed on a project switch, and narrowing it down to a
   * deleter meant reasoning backwards from an error kind that four paths share,
   * across a boundary where the renderer's unmount and the guest's `destroyed`
   * event look identical.
   *
   * One line each removes that ambiguity. It is deliberately unconditional
   * rather than dev-gated: the repro is rare, timing-dependent, and needs a
   * restart to instrument, so the one time it happens the evidence has to
   * already be in the log.
   */
  private forget(sessionId: string, reason: PaneUnregisterReason): void {
    const entry = this.panes.get(sessionId);
    if (!entry) return;
    this.panes.delete(sessionId);
    console.log(
      `[browser-pane] unregister session=${sessionId.slice(0, 8)} task=${entry.taskId.slice(0, 8)} ` +
        `wc=${entry.webContentsId} project=${entry.projectId ?? 'none'} reason=${reason}`,
    );
    this.notifyWaiters();
  }

  unregister(sessionId: string): void {
    this.forget(sessionId, 'renderer-unmount');
  }

  /** Unregister sessionId's pane ONLY if its current entry still has this exact
   *  webContentsId. A renderer's unmount cleanup passes the webContentsId it
   *  itself registered with, so an out-of-order unmount (e.g. the in-app pane
   *  unmounting AFTER a pop-out window's pane already re-registered the same
   *  sessionId with a new guest) cannot clobber the newer registration. */
  unregisterIfMatches(sessionId: string, webContentsId: number): void {
    const entry = this.panes.get(sessionId);
    if (entry && entry.webContentsId === webContentsId) {
      this.forget(sessionId, 'renderer-unmount-matched');
    }
  }

  /** Remove whatever pane is bound to a guest webContents id (guest `destroyed`). */
  unregisterByWebContentsId(webContentsId: number): void {
    for (const [sessionId, entry] of this.panes) {
      if (entry.webContentsId === webContentsId) {
        this.forget(sessionId, 'guest-destroyed');
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
          detail: `No Browser pane is registered for session ${selector.sessionId}. ${NO_PANE_OPEN_HINT}`,
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
          detail: `No Browser pane is open for task ${selector.taskId}. ${NO_PANE_OPEN_HINT}`,
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
          ? `No Browser pane is open in any task. ${NO_PANE_OPEN_HINT}`
          : `No Browser pane is open in this project. ${NO_PANE_OPEN_HINT}`;
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
      this.forget(entry.sessionId, 'self-heal-dead-guest');
      return {
        ok: false,
        kind: 'pane-destroyed',
        detail: `The Browser pane for session ${entry.sessionId} was closed. Reopen it and load a URL.`,
      };
    }
    return { ok: true, entry, webContents: guest };
  }

  /**
   * Resolve when `predicate` holds, or after `timeoutMs`. Re-evaluated on every
   * membership change rather than polled. Follows the bounded-await discipline
   * used across the main process (see `cdp.ts`'s screenshot race): the timer is
   * always cleared on the settling path, so no waiter outlives its deadline.
   */
  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const check = (): void => {
        if (!predicate()) return;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(true);
      };
      // Declared after `check` but initialized before the waiter is registered,
      // so `check` can never run while it is still in its temporal dead zone.
      // The whole executor is synchronous, so no notification can slip between
      // the timer and the `waiters.add` below - do not "fix" this ordering.
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(check);
    });
  }

  /**
   * Wait for a pane belonging to `taskId` in `projectId` to become driveable,
   * returning its entry or null on timeout.
   *
   * The predicate requires a LIVE guest, not merely a registry entry. A stale
   * entry is only evicted by `resolveLiveGuest` on a drive call, so a
   * presence-only wait could resolve against a destroyed guest and hand the
   * caller a pane whose very next command fails `pane-destroyed` - exactly the
   * dead end the open tool exists to remove.
   */
  async waitForLivePane(
    target: { taskId: string; projectId: string },
    timeoutMs: number,
  ): Promise<BrowserPaneEntry | null> {
    const findLive = (): BrowserPaneEntry | null => {
      for (const entry of this.panes.values()) {
        if (entry.taskId !== target.taskId) continue;
        if (entry.projectId !== target.projectId) continue;
        const guest = electronWebContents.fromId(entry.webContentsId);
        if (!guest || guest.isDestroyed()) continue;
        return entry;
      }
      return null;
    };
    await this.waitFor(() => findLive() !== null, timeoutMs);
    return findLive();
  }

  /**
   * Wait for every named pane to unregister. Returns the sessionIds still
   * registered when the wait ends, so a caller can report what it actually
   * closed rather than assuming the push landed.
   */
  async waitForPanesGone(sessionIds: readonly string[], timeoutMs: number): Promise<string[]> {
    const stillRegistered = (): string[] => sessionIds.filter((sessionId) => this.panes.has(sessionId));
    await this.waitFor(() => stillRegistered().length === 0, timeoutMs);
    return stillRegistered();
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
    this.notifyWaiters();
  }

  /** Test/diagnostic helper: number of registered panes. */
  get size(): number {
    return this.panes.size;
  }
}

/** Process-wide singleton. */
export const browserPaneRegistry = new BrowserPaneRegistry();
