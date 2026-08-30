import { webContents as electronWebContents, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { detachDebugger, isDebuggerAttached } from './cdp/cdp';
import { trackFeatureUsed } from '../analytics/usage';
import type { BrowserPaneVisibility } from '../../shared/types';

/**
 * Registry mapping an open embedded Browser pane to its guest `<webview>`
 * webContents, so the `kangentic_browser_*` MCP tools can target the right
 * pane. The renderer is the only place that knows all three of taskId, the
 * agent session, and the guest's `getWebContentsId()`, so it registers each
 * pane via IPC on `dom-ready` and unregisters on unmount. The main process also
 * keeps the registry honest from the guest's own lifecycle events
 * (`did-navigate` -> updateUrl, `destroyed` -> unregister), which fire even
 * when a renderer cleanup is skipped (e.g. a hard reload). The tracked URL is
 * a fallback rather than the source of truth: `list()` reads it from the live
 * guest, since `did-navigate` misses same-document navigation entirely.
 *
 * ## Keyed by a SURFACE HANDLE bound to the guest, not by the agent session
 *
 * It used to be keyed by the task's agent session id, and `register()`
 * overwrote unconditionally. Every remount of the visible pane (task window
 * closed and reopened, pop-out and back, a hard reload) therefore re-bound the
 * SAME key to a brand-new guest: one session id was observed bound to nine
 * different webContents in a single agent session, and an agent holding it
 * silently addressed a different tab (fresh `sessionStorage`) on consecutive
 * calls, which presented as "the app keeps logging me out".
 *
 * A handle (`pane_<8hex>` minted here, `lane_<8hex>` minted by the lane
 * manager) now names exactly one guest webContents for its whole life.
 * Registering the same guest again (a `/clear` rotates the owning session)
 * updates the entry in place and keeps the handle; a different guest always
 * gets a new one. A handle whose guest is gone stays remembered for a while so
 * the caller is told what happened and what replaced it, rather than being
 * silently retargeted.
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
 * path, so `withGuest` needed no change at all to drive one. The resolver DOES
 * rank by kind (a visible pane wins over a hand-off lane, which wins over a
 * lane the agent asked for), because the ranking is what keeps an implicit
 * call deterministic while a hand-off lane and the returning pane briefly
 * coexist. `close_pane` destroys lanes in main instead of pushing a close to
 * the renderer: a lane has no task-detail window and no `browserOpenTasks`
 * flag, so the push would do nothing and report the lane still registered.
 */
export type BrowserSurfaceKind = 'pane' | 'lane';

export interface BrowserPaneEntry {
  /**
   * The surface HANDLE, bound to one guest webContents for its whole life:
   * `pane_<8hex>` for a renderer pane (minted here), `lane_<8hex>` for a lane
   * (minted by the lane manager). This is the value every kangentic_browser_*
   * tool accepts as its `sessionId` argument. It is NOT an agent session id;
   * that is `ownerSessionId`.
   */
  sessionId: string;
  /**
   * The agent session this surface serves, or null for a lane nobody owns.
   * Updated in place when a session rotates (`/clear`), so the handle survives.
   */
  ownerSessionId: string | null;
  taskId: string;
  projectId: string | null;
  /** The guest webContents id from the renderer's `webview.getWebContentsId()`. */
  webContentsId: number;
  /** Last known navigated URL (null until the first navigation lands). */
  url: string | null;
  registeredAt: number;
  kind: BrowserSurfaceKind;
  /**
   * True only for a lane main opened to stand in for a closed pane (see
   * `browser-lane-handoff.ts`). Always false for a pane. Recorded here rather
   * than looked up from the lane manager, which imports this module.
   */
  handoff: boolean;
  /**
   * Where the surface is on the user's screen. A pane is `showing` until the
   * renderer says otherwise (`hidden` behind the terminal after the Browser
   * pill, `parked` in a window the user closed); a lane is always
   * `offscreen`. Every value here is still driveable: this tells the agent
   * whether the user can SEE what it is doing, not whether it may act.
   */
  visibility: BrowserPaneVisibility;
}

/** Input to `register()`. The renderer path never supplies `handle`, `kind`, or `handoff`. */
export interface RegisterSurfaceInput {
  ownerSessionId: string | null;
  taskId: string;
  projectId: string | null;
  webContentsId: number;
  url: string | null;
  /** Lane manager (and tests) only: the pre-minted `lane_` id. Omitted for a pane. */
  handle?: string;
  /** Defaults to `pane`, which is what every renderer registration is. */
  kind?: BrowserSurfaceKind;
  /** Defaults to false. */
  handoff?: boolean;
  /** Defaults to `showing` for a pane and `offscreen` for a lane. */
  visibility?: BrowserPaneVisibility;
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
  /** A surface handle from `open_pane` / `list_panes`. */
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
   * (`/mcp/<projectId>/<callerSessionId>`). A PREFERENCE for a caller with no
   * task, matched against `ownerSessionId`: absent or unmatched degrades to
   * the next rule rather than failing.
   */
  callerSessionId?: string;
  /**
   * The caller's own task id, resolved server-side from `callerSessionId`.
   * When present, an implicit call resolves ONLY among that task's surfaces:
   * it never reaches another task's pane, however many are open.
   */
  callerTaskId?: string;
};

export type ResolveTargetResult =
  | { ok: true; entry: BrowserPaneEntry }
  | {
      ok: false;
      kind: 'no-pane-open' | 'multiple-panes' | 'foreign-project' | 'surface-gone';
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
 * These are indistinguishable from the outside (all of them make a later
 * explicit-handle call miss), which is precisely what made task #542's
 * retained-pane death hard to attribute. The reason is also what the retired
 * surface memory below turns into words for the agent.
 */
export type PaneUnregisterReason =
  /** The renderer's effect cleanup ran (the pane's component unmounted). */
  | 'renderer-unmount'
  /** The guest webContents emitted `destroyed`. */
  | 'guest-destroyed'
  /** Self-heal: the entry pointed at a guest that no longer exists. */
  | 'self-heal-dead-guest'
  /**
   * The user's Close control (the pane toolbar or the task kebab). Sent by the
   * renderer AHEAD of the unmount, so the hand-off sees this reason rather than
   * `renderer-unmount` and stands no lane up: the user closed it to get the
   * memory back, and a lane would spend it again.
   */
  | 'user-closed'
  /**
   * Main destroyed an offscreen lane (agent closed it, its session ended, it
   * went idle, or a hand-off lane stood down because the visible pane returned).
   *
   * Distinct from `renderer-unmount` even though both run through `unregister`:
   * a lane has no renderer to unmount, and reporting one would point an
   * investigation at the wrong process - the exact ambiguity this enum exists
   * to remove.
   */
  | 'lane-destroyed';

// `detachAll` is deliberately absent. It bulk-clears on the synchronous
// `before-quit` path (see .claude/rules/synchronous-shutdown.md), where adding
// per-pane console I/O would slow the one path that must stay fast - and a
// deletion during shutdown needs no attribution, since the app is going away.

/**
 * Plain words for a retirement reason, addressed to the agent whose handle
 * just stopped resolving. `satisfies` so a new reason cannot ship unworded.
 */
const RETIRED_REASON_WORDS = {
  'renderer-unmount': 'its pane unmounted (the task window was dropped, the pane was closed, or the app reloaded)',
  'guest-destroyed': 'its pane unmounted (the task window was dropped, the pane was closed, or the app reloaded)',
  'lane-destroyed': 'the lane was closed',
  'self-heal-dead-guest': 'its tab was destroyed',
  'user-closed': 'the user closed the browser',
} satisfies Record<PaneUnregisterReason, string>;

/** What `forget()` remembers so a later explicit-handle miss can say what happened. */
export interface RetiredSurface {
  handle: string;
  taskId: string;
  projectId: string | null;
  kind: BrowserSurfaceKind;
  reason: PaneUnregisterReason;
  retiredAt: number;
}

/**
 * How many retired handles are remembered. Bounded because a long session
 * churns panes freely; 64 is far more than any agent holds in context.
 */
const RETIRED_SURFACE_MEMORY = 64;

export type ResolveGuestResult =
  | { ok: true; entry: BrowserPaneEntry; webContents: WebContents }
  | { ok: false; kind: 'pane-destroyed'; detail: string };

/** Lower is better: the visible pane, then the hand-off stand-in, then a lane the agent asked for. */
function surfaceRank(entry: BrowserPaneEntry): 0 | 1 | 2 {
  if (entry.kind === 'pane') return 0;
  return entry.handoff ? 1 : 2;
}

/** The entries sharing the best rank. Empty in, empty out. */
function bestRanked(entries: readonly BrowserPaneEntry[]): BrowserPaneEntry[] {
  let bestRank = 3;
  const winners: BrowserPaneEntry[] = [];
  for (const entry of entries) {
    const rank = surfaceRank(entry);
    if (rank < bestRank) {
      bestRank = rank;
      winners.length = 0;
    }
    if (rank === bestRank) winners.push(entry);
  }
  return winners;
}

function describeSurface(entry: BrowserPaneEntry): string {
  if (entry.kind === 'pane') return `${entry.sessionId} (pane)`;
  return entry.handoff ? `${entry.sessionId} (hand-off lane)` : `${entry.sessionId} (isolated lane)`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export class BrowserPaneRegistry {
  private readonly panes = new Map<string, BrowserPaneEntry>();

  /** Oldest first. See `RETIRED_SURFACE_MEMORY`. */
  private readonly retiredSurfaces: RetiredSurface[] = [];

  /**
   * Handles whose upcoming unregister is the caller's own doing (an agent's
   * `close_pane`), so the hand-off must not resurrect the page in a lane the
   * agent never asked for. Consumed by `forget()`.
   */
  private readonly deliberateCloses = new Set<string>();

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

  /**
   * Bind a surface to its guest, or update the surface already bound to it.
   *
   * Same `webContentsId` means the same guest: Electron ids are monotonic
   * within a process and never reused. Re-registering it (a session rotation,
   * a retained window's project settling) therefore updates the owner, task
   * and project IN PLACE and keeps the handle, which is the whole point of the
   * handle: it names the tab, not the registration.
   */
  register(input: RegisterSurfaceInput): BrowserPaneEntry {
    const existing = this.findByWebContentsId(input.webContentsId);
    if (existing) {
      existing.ownerSessionId = input.ownerSessionId;
      existing.taskId = input.taskId;
      existing.projectId = input.projectId;
      existing.url = input.url ?? existing.url;
      if (input.visibility) existing.visibility = input.visibility;
      console.log(
        `[browser-pane] rebound handle=${existing.sessionId} owner=${shortId(existing.ownerSessionId)} ` +
          `task=${existing.taskId.slice(0, 8)} wc=${existing.webContentsId}`,
      );
      this.announceRegistered(existing);
      return existing;
    }

    const entry: BrowserPaneEntry = {
      sessionId: input.handle ?? `pane_${randomUUID().slice(0, 8)}`,
      ownerSessionId: input.ownerSessionId,
      taskId: input.taskId,
      projectId: input.projectId,
      webContentsId: input.webContentsId,
      url: input.url,
      registeredAt: Date.now(),
      kind: input.kind ?? 'pane',
      handoff: input.handoff === true,
      visibility: input.visibility ?? (input.kind === 'lane' ? 'offscreen' : 'showing'),
    };
    this.panes.set(entry.sessionId, entry);
    console.log(
      `[browser-pane] bound handle=${entry.sessionId} owner=${shortId(entry.ownerSessionId)} ` +
        `task=${entry.taskId.slice(0, 8)} wc=${entry.webContentsId} kind=${entry.kind}` +
        (entry.handoff ? ' handoff' : ''),
    );
    // Adoption signal for user-visible panes only: offscreen lanes are the
    // driver's plumbing, not a user opening the Browser pane. New-entry branch
    // only, so a rebind of the same guest never re-counts.
    if (entry.kind === 'pane') trackFeatureUsed('browser_pane');
    this.announceRegistered(entry);
    return entry;
  }

  private announceRegistered(entry: BrowserPaneEntry): void {
    try {
      this.paneRegisteredHandler?.(entry);
    } catch (error) {
      console.warn('[browser-pane] pane-registered handler failed:', error);
    }
    this.notifyWaiters();
  }

  private findByWebContentsId(webContentsId: number): BrowserPaneEntry | undefined {
    for (const entry of this.panes.values()) {
      if (entry.webContentsId === webContentsId) return entry;
    }
    return undefined;
  }

  /**
   * Say WHY a pane left the registry, and remember that it did.
   *
   * Four call paths delete an entry, and from the outside they are
   * indistinguishable: every one of them makes a later explicit-handle call
   * miss. Task #542 hit exactly that wall - a retained pane's guest was
   * destroyed on a project switch, and narrowing it down to a deleter meant
   * reasoning backwards from an error kind that four paths share, across a
   * boundary where the renderer's unmount and the guest's `destroyed` event
   * look identical.
   *
   * One line each removes that ambiguity. It is deliberately unconditional
   * rather than dev-gated: the repro is rare, timing-dependent, and needs a
   * restart to instrument, so the one time it happens the evidence has to
   * already be in the log. The retired-surface memory is the same evidence
   * handed to the AGENT, whose next call with the dead handle would otherwise
   * read as "no pane open".
   */
  private forget(handle: string, reason: PaneUnregisterReason): void {
    const entry = this.panes.get(handle);
    if (!entry) return;
    this.panes.delete(handle);
    const deliberate = this.deliberateCloses.delete(handle);
    this.retiredSurfaces.push({
      handle,
      taskId: entry.taskId,
      projectId: entry.projectId,
      kind: entry.kind,
      reason,
      retiredAt: Date.now(),
    });
    while (this.retiredSurfaces.length > RETIRED_SURFACE_MEMORY) this.retiredSurfaces.shift();
    console.log(
      `[browser-pane] unregister handle=${handle} owner=${shortId(entry.ownerSessionId)} ` +
        `task=${entry.taskId.slice(0, 8)} wc=${entry.webContentsId} project=${entry.projectId ?? 'none'} ` +
        `kind=${entry.kind} reason=${reason}${deliberate ? ' deliberate' : ''}`,
    );
    this.notifyWaiters();
    // Injected rather than imported, so the registry stays free of any
    // dependency on the lane manager (which imports the registry, so a direct
    // import would be a cycle). Never allowed to break a deletion.
    try {
      this.paneClosedHandler?.(entry, reason, deliberate);
    } catch (error) {
      console.warn('[browser-pane] pane-closed handler failed:', error);
    }
  }

  private paneClosedHandler:
    | ((entry: BrowserPaneEntry, reason: PaneUnregisterReason, deliberate: boolean) => void)
    | null = null;

  /**
   * Observe pane closures. Wired once at startup by the lane hand-off, which
   * keeps an agent's browser alive when the user closes the task's window.
   * `deliberate` is true when the closure was the agent's own `close_pane`.
   */
  setPaneClosedHandler(
    handler: ((entry: BrowserPaneEntry, reason: PaneUnregisterReason, deliberate: boolean) => void) | null,
  ): void {
    this.paneClosedHandler = handler;
  }

  /** Observe pane REGISTRATION, so a hand-off lane can stand down when the
   *  user's own pane comes back. Also fires for an in-place rebind. */
  setPaneRegisteredHandler(handler: ((entry: BrowserPaneEntry) => void) | null): void {
    this.paneRegisteredHandler = handler;
  }

  private paneRegisteredHandler: ((entry: BrowserPaneEntry) => void) | null = null;

  /**
   * Mark handles whose next unregister is the caller's own decision (an
   * agent's `close_pane`), so the pane-closed handler can tell "put away on
   * purpose" from "went away". Idempotent; cleared as each handle is forgotten.
   */
  markDeliberateClose(handles: readonly string[]): void {
    for (const handle of handles) this.deliberateCloses.add(handle);
  }

  /**
   * @param reason defaults to the renderer's unmount, which is every caller
   *   except the lane manager - a lane has no renderer, so it says so.
   */
  unregister(handle: string, reason: PaneUnregisterReason = 'renderer-unmount'): void {
    this.forget(handle, reason);
  }

  /**
   * Remove whatever surface is bound to a guest webContents id.
   *
   * This is how the renderer unregisters (with the guest id it registered), so
   * an out-of-order unmount across the in-app pane and its pop-out can only
   * ever remove its OWN guest and never a newer registration for the same
   * task. It is also the guest `destroyed` path, which is the default reason.
   */
  unregisterByWebContentsId(webContentsId: number, reason: PaneUnregisterReason = 'guest-destroyed'): void {
    const entry = this.findByWebContentsId(webContentsId);
    if (entry) this.forget(entry.sessionId, reason);
  }

  /**
   * Record where a registered pane is on the user's screen. Reported by the
   * renderer, which is the only side that knows; a guest this registry does
   * not know is ignored (the report can race a registration either way, and
   * the registration carries its own visibility).
   */
  setVisibility(webContentsId: number, visibility: BrowserPaneVisibility): boolean {
    const entry = this.findByWebContentsId(webContentsId);
    if (!entry || entry.visibility === visibility) return false;
    entry.visibility = visibility;
    return true;
  }

  updateUrl(handle: string, url: string): void {
    const entry = this.panes.get(handle);
    if (entry) entry.url = url;
  }

  /** Update the URL for whatever pane owns a guest webContents id (guest `did-navigate`). */
  updateUrlByWebContentsId(webContentsId: number, url: string): void {
    const entry = this.findByWebContentsId(webContentsId);
    if (entry) entry.url = url;
  }

  get(handle: string): BrowserPaneEntry | undefined {
    return this.panes.get(handle);
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
  private inScope(entry: { projectId: string | null }, projectId: string | null): boolean {
    if (projectId === null) return true;
    return entry.projectId === projectId;
  }

  /**
   * The URL as the live guest reports it, falling back to the cache.
   *
   * The cache is only ever as fresh as the `did-navigate` events that feed it,
   * and `did-navigate` does not fire at all for same-document navigation. Every
   * SPA route change, `pushState`, and fragment update therefore drifts the
   * cache by design, and a dev server is exactly what this feature points a
   * pane at.
   */
  private readLiveUrl(entry: BrowserPaneEntry): string | null {
    const guest = electronWebContents.fromId(entry.webContentsId);
    if (!guest || guest.isDestroyed()) return entry.url;
    try {
      return guest.getURL() || entry.url;
    } catch {
      // Guest torn down between the alive check and the read; keep the cache.
      return entry.url;
    }
  }

  /**
   * All registered panes enriched with live + debugger-attached status.
   *
   * The URL is read from the LIVE guest rather than reported from the cached
   * `entry.url` (see `readLiveUrl`). That made `list_panes`, the one tool an
   * agent has for checking where its own pane is pointed, report where it
   * actually is rather than a URL the pane had left.
   */
  list(): BrowserPaneStatus[] {
    return [...this.panes.values()].map((entry) => {
      const guest = electronWebContents.fromId(entry.webContentsId);
      const alive = guest != null && !guest.isDestroyed();
      return {
        ...entry,
        url: this.readLiveUrl(entry),
        alive,
        debuggerAttached: alive ? isDebuggerAttached(guest) : false,
      };
    });
  }

  /**
   * Resolve a target selector to a single surface entry, scoped to the CALLER's
   * project. Every branch refuses a pane outside `selector.projectId`, so an
   * agent cannot reach another project's Browser pane: not by omitting a
   * selector, not by naming a taskId, and not by naming a handle it read out of
   * `kangentic_browser_list_panes`.
   *
   * Precedence: an explicit handle, then an explicit taskId, then the caller's
   * OWN task's surfaces (visible pane first, then a hand-off lane, then an
   * isolated lane), and only for a caller with NO task the single pane open in
   * the caller's project.
   *
   * A caller bound to a task never falls through to another task's pane. That
   * fall-through was observed live: an agent whose own pane had died navigated
   * a sibling task's logged-in app to an identity-provider URL, because "the
   * single pane in the project" happened to be the sibling's. A preference that
   * matches nothing now refuses with `no-pane-open` and says so; only a caller
   * with no identity (a human-driven client, the two-segment
   * `.kangentic/mcp-config.json` URL, a Command Terminal session) still lands
   * on the project-wide rule.
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
      if (!entry) return this.describeMissingHandle(selector);
      if (!this.inScope(entry, scope)) {
        return {
          ok: false,
          kind: 'foreign-project',
          detail: `Surface ${selector.sessionId} belongs to a different project than this connection. ${FOREIGN_PROJECT_HINT}`,
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
      const best = bestRanked(matches);
      if (best.length > 1) {
        return {
          ok: false,
          kind: 'multiple-panes',
          detail: `${matches.length} Browser surfaces match task ${selector.taskId}. Pass one of their handles as sessionId to disambiguate: ${matches.map(describeSurface).join(', ')}.`,
          candidates: matches,
        };
      }
      return { ok: true, entry: best[0] };
    }

    // No explicit selector.
    const inScopePanes: BrowserPaneEntry[] = [];
    let unattributedCount = 0;
    for (const entry of this.panes.values()) {
      if (this.inScope(entry, scope)) inScopePanes.push(entry);
      else if (entry.projectId === null) unattributedCount += 1;
    }

    if (selector.callerTaskId) {
      // A caller WITH a task resolves only among that task's own surfaces. No
      // owner-session preference inside the pool: the visible pane IS the
      // caller's, and preferring the owner would let an isolated lane beat it
      // in the one render before a `/clear` re-registers the pane's owner.
      const ownTask = inScopePanes.filter((entry) => entry.taskId === selector.callerTaskId);
      const best = bestRanked(ownTask);
      if (best.length === 1) return { ok: true, entry: best[0] };
      if (best.length > 1) {
        return {
          ok: false,
          kind: 'multiple-panes',
          detail: `${ownTask.length} Browser surfaces belong to your own task ${selector.callerTaskId}. Pass one of their handles as sessionId to choose: ${ownTask.map(describeSurface).join(', ')}.`,
          candidates: ownTask,
        };
      }
      const otherTaskCount = inScopePanes.length;
      const others =
        otherTaskCount === 0
          ? ''
          : otherTaskCount === 1
            ? ' 1 Browser pane open in this project belongs to another task and is never used implicitly.'
            : ` ${otherTaskCount} Browser panes open in this project belong to other tasks and are never used implicitly.`;
      const unattributed = this.getByTaskId(selector.callerTaskId).some((entry) => entry.projectId === null)
        ? ' Your task has a registered Browser pane with no project recorded, which a scoped caller cannot use. Close and reopen it so it registers against this project.'
        : '';
      return {
        ok: false,
        kind: 'no-pane-open',
        detail: `No Browser surface is open for your task ${selector.callerTaskId}. ${NO_PANE_OPEN_HINT}${others}${unattributed}`,
      };
    }

    // A caller with no task: prefer a surface its own session owns, then the
    // single pane open in its project.
    if (selector.callerSessionId) {
      const own = bestRanked(inScopePanes.filter((entry) => entry.ownerSessionId === selector.callerSessionId));
      if (own.length === 1) return { ok: true, entry: own[0] };
      if (own.length > 1) {
        return {
          ok: false,
          kind: 'multiple-panes',
          detail: `${own.length} Browser surfaces belong to your session. Pass one of their handles as sessionId to choose: ${own.map(describeSurface).join(', ')}.`,
          candidates: own,
        };
      }
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
   * An explicit handle that no live surface carries. Two honest answers, both
   * ending with what the caller should do now:
   *
   * - a handle this registry once held is GONE, and the caller is told why,
   *   how long ago, what did and did not carry over, and what replaced it;
   * - anything else is not a surface handle at all (typically the agent's own
   *   session id, which is what this argument used to accept).
   */
  private describeMissingHandle(selector: ResolveTargetSelector): ResolveTargetResult {
    const handle = selector.sessionId ?? '';
    const current = this.describeCallerSurfaces(selector);
    let retired: RetiredSurface | undefined;
    for (let index = this.retiredSurfaces.length - 1; index >= 0; index -= 1) {
      if (this.retiredSurfaces[index].handle === handle) {
        retired = this.retiredSurfaces[index];
        break;
      }
    }
    if (!retired) {
      return {
        ok: false,
        kind: 'no-pane-open',
        detail:
          `"${handle}" is not a browser surface handle. Handles look like pane_xxxxxxxx or lane_xxxxxxxx and come from ` +
          `kangentic_browser_open_pane or kangentic_browser_list_panes; a Kangentic session id is not one. ${current}`,
      };
    }
    if (!this.inScope(retired, selector.projectId)) {
      return {
        ok: false,
        kind: 'foreign-project',
        detail: `Surface ${handle} belonged to a different project than this connection. ${FOREIGN_PROJECT_HINT}`,
      };
    }
    return {
      ok: false,
      kind: 'surface-gone',
      detail:
        `Browser surface ${handle} (a ${retired.kind} for task ${retired.taskId}) is gone: ` +
        `${RETIRED_REASON_WORDS[retired.reason]} ${formatElapsed(Date.now() - retired.retiredAt)} ago. ` +
        'Its per-tab state (sessionStorage, in-memory app state, an unsaved form) did not carry over to any other surface; ' +
        `cookies and localStorage did, because every surface of a task shares the task's jar. ${current}`,
    };
  }

  private describeCallerSurfaces(selector: ResolveTargetSelector): string {
    if (!selector.callerTaskId) {
      return 'This connection is not bound to a task. Call kangentic_browser_list_panes to see the surfaces in this project and pass one of their handles as sessionId.';
    }
    const surfaces = this.getByTaskId(selector.callerTaskId)
      .filter((entry) => this.inScope(entry, selector.projectId))
      .sort((left, right) => surfaceRank(left) - surfaceRank(right));
    if (surfaces.length === 0) {
      return 'Your task has no Browser surface open now. Call kangentic_browser_open_pane with a url to open one, then pass the handle it returns as sessionId (or omit sessionId to use it).';
    }
    const named = surfaces.map((entry) => `${describeSurface(entry)} at ${this.readLiveUrl(entry) ?? 'no URL yet'}`);
    if (named.length === 1) {
      return `Your task's current surface is ${named[0]}. Pass it as sessionId, or omit sessionId to use it; redo any per-tab setup it needs.`;
    }
    return `Your task's current surfaces are ${named.join('; ')}. Pass one of them as sessionId (omitting sessionId uses the first); redo any per-tab setup it needs.`;
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
        detail: `Browser surface ${entry.sessionId} (task ${entry.taskId}) was destroyed. Call kangentic_browser_list_panes to see what is open, or kangentic_browser_open_pane to open your task's pane again.`,
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
   * Wait for a visible PANE belonging to `taskId` in `projectId` to become
   * driveable, returning its entry or null on timeout.
   *
   * The predicate requires a LIVE guest, not merely a registry entry. A stale
   * entry is only evicted by `resolveLiveGuest` on a drive call, so a
   * presence-only wait could resolve against a destroyed guest and hand the
   * caller a pane whose very next command fails `pane-destroyed` - exactly the
   * dead end the open tool exists to remove.
   *
   * A lane never satisfies it: the opener's cold path is waiting for the
   * renderer pane it just pushed, and a hand-off lane standing in for that
   * pane is the thing the pane's arrival stands down.
   */
  async waitForLivePane(
    target: { taskId: string; projectId: string },
    timeoutMs: number,
  ): Promise<BrowserPaneEntry | null> {
    const findLive = (): BrowserPaneEntry | null => {
      for (const entry of this.panes.values()) {
        if (entry.kind !== 'pane') continue;
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
   * Wait for every named surface to unregister. Returns the handles still
   * registered when the wait ends, so a caller can report what it actually
   * closed rather than assuming the push landed.
   */
  async waitForPanesGone(handles: readonly string[], timeoutMs: number): Promise<string[]> {
    const stillRegistered = (): string[] => handles.filter((handle) => this.panes.has(handle));
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
    this.deliberateCloses.clear();
    this.notifyWaiters();
  }

  /** Test/diagnostic helper: number of registered panes. */
  get size(): number {
    return this.panes.size;
  }
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) : 'none';
}

/** Process-wide singleton. */
export const browserPaneRegistry = new BrowserPaneRegistry();
