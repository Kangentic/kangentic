import { IPC } from '../../shared/ipc-channels';
import { browserUrlStore } from './browser-url-store';
import {
  browserPaneRegistry,
  type BrowserPaneStatus,
  type BrowserSurfaceKind,
  type ResolveTargetSelector,
} from './browser-pane-registry';
import {
  withGuest,
  capabilityGate,
  validateNavigationUrl,
  navigateGuest,
  type BrowserCapability,
  type DriverError,
  type DriverResult,
} from './browser-pane-driver';
import type { ResolvedBrowserAutomationConfig } from './browser-automation-config';
import { openLane, destroyLane, hasLaneForTask } from './browser-lane-manager';

/**
 * Opens and closes a task's embedded Browser pane on behalf of the
 * `kangentic_browser_open_pane` / `kangentic_browser_close_pane` MCP tools.
 *
 * Why this module exists at all: pane open state is renderer-owned
 * (`browserOpenTasks` in the session store) while the MCP server is
 * main-process, so opening a pane crosses the process boundary the "wrong" way.
 * The shape that keeps that honest:
 *
 * 1. **Main validates everything it can.** Current project, the per-project
 *    browser gate, the task row, and the URL are all main-checkable, so there is
 *    no need for the renderer to report a refusal back. That is what lets the
 *    push stay fire-and-forget instead of introducing a correlated
 *    request/response channel, which `src/main/` deliberately does not have.
 * 2. **The completion signal is the pane REGISTRY, not an acknowledgement.**
 *    Registration is renderer-driven and lands on the guest's `dom-ready`. A
 *    reply saying "I set the flag" would not mean the pane is driveable, and
 *    returning on it would recreate the `no-pane-open` race this tool exists to
 *    remove.
 * 3. **The wait is bounded and ends in `withGuest`.** Resolving through the same
 *    chokepoint every driving tool uses is what makes "registered AND driveable"
 *    true rather than merely claimed.
 */

/**
 * The slice of app state this module needs, declared structurally and injected
 * rather than imported.
 *
 * Deliberate: reaching for `getOptionalIpcContext` directly would pull
 * `register-all` - and with it every IPC handler, the analytics client, and
 * better-sqlite3 - into `browser-tools.ts`, whose test harness builds a real MCP
 * server with no Electron and no database. It also keeps this module trivially
 * testable. Same reasoning as `BrowserSessionLookup` in `browser-tools.ts`.
 */
export interface BrowserPaneOpenerHost {
  /** The project currently open in the app window, or null. */
  currentProjectId: string | null;
  /** That project's path on disk. */
  currentProjectPath: string | null;
  /**
   * Whether a task exists on the given project's board.
   *
   * PRECONDITION: only ever called for the project already confirmed open.
   * The implementation resolves a project DB by id, and `getProjectDb` CREATES
   * the SQLite file for an unrecognized id rather than refusing, so calling
   * this with an unvalidated id would leave a stray `<projectId>.db` behind.
   * Keep the `project-not-open` check ahead of every call site.
   */
  taskExists(projectId: string, taskId: string): boolean;
  /** The project's `browser` config overrides, if any. */
  browserOverrides(projectPath: string): { enabled?: boolean; defaultUrl?: string } | null;
  /** Push to the app window. False when there is no live window to push to. */
  send(channel: string, ...args: unknown[]): boolean;
}

let readHost: () => BrowserPaneOpenerHost | null = () => null;

/** Wired once from `registerBrowserHandlers`, which owns the IPC context. */
export function setBrowserPaneOpenerHost(reader: () => BrowserPaneOpenerHost | null): void {
  readHost = reader;
}

/** How long to wait for a pushed pane to register a live guest. Covers the
 *  window mount, the `<webview>` attach, and the guest's `dom-ready`. */
export const PANE_OPEN_TIMEOUT_MS = 10_000;

/** How long to wait for closed panes to unregister. Just an unmount. */
export const PANE_CLOSE_TIMEOUT_MS = 3_000;

export interface OpenPaneInput {
  /** The caller's project, from the MCP URL path. */
  projectId: string;
  /** The caller's own session id, from the MCP URL path. */
  callerSessionId?: string;
  /** The caller's own task, resolved from `callerSessionId`. Required: this
   *  tool deliberately has no free-form taskId argument. */
  callerTaskId?: string;
  /** Absolute http(s) URL to load. Falls back to the task's saved override,
   *  then the project default. */
  url?: string;
  /**
   * The capability tier opening is gated at. Declared by the caller (the tool)
   * rather than hardcoded here so the tier sits next to the MCP `annotations:`
   * it has to agree with, which is what
   * `tests/unit/mcp-tool-list-parity.test.ts` cross-checks. Always `navigate`
   * today: opening a pane always loads a URL.
   */
  capability: BrowserCapability;
  config: ResolvedBrowserAutomationConfig;
}

export interface OpenPaneData {
  /** True when this call opened the pane; false when it was already open. */
  opened: boolean;
  /** True when this call pointed an already-open pane at a new URL. */
  navigated: boolean;
  url: string;
  pane: BrowserPaneStatus;
  /**
   * Present only when the surface came up OFFSCREEN, which happens when no
   * visible pane can be mounted (the caller's project is backgrounded). It is
   * the same value as `pane.sessionId`; both name the task's one surface.
   */
  laneId?: string;
  /**
   * True when `laneId` is set: the surface is real and driveable, but the user
   * cannot see it. Named so the agent can say so rather than reporting a
   * visible browser the user is not looking at.
   */
  offscreen?: boolean;
}

export interface ClosePaneInput {
  projectId: string;
  callerSessionId?: string;
  callerTaskId?: string;
  sessionId?: string;
  taskId?: string;
  /** Close every pane in scope rather than a single target. Takes precedence
   *  over `sessionId` / `taskId`, which are ignored when this is set. */
  all?: boolean;
  /** Widen `all`, and permit an EXPLICITLY named foreign target, to every
   *  project. Deliberately does not widen the implicit no-selector default. */
  includeOtherProjects?: boolean;
  config: ResolvedBrowserAutomationConfig;
}

export interface ClosedPaneSummary {
  /** The surface handle that was closed. */
  sessionId: string;
  kind: BrowserSurfaceKind;
  taskId: string;
  projectId: string | null;
  url: string | null;
}

export interface ClosePaneData {
  /** Which panes this call actually put away. */
  closed: ClosedPaneSummary[];
  /** Panes it tried to close that were still registered when the wait ended. */
  skipped: (ClosedPaneSummary & { reason: string })[];
  /** The scope that was actually applied, so a partial close reads honestly. */
  scope: 'this-project' | 'all-projects';
  /** Panes in other projects deliberately left alone. Only 0 after a genuine
   *  every-project sweep (`all` + `includeOtherProjects`); a single-target
   *  close still reports what it did not touch, so it cannot read as complete. */
  otherProjectPaneCount: number;
}

function failure(kind: string, detail: string): { ok: false; error: DriverError } {
  return { ok: false, error: { kind, detail } };
}

/** The pane's `list_panes` shape, so an agent can go straight into driving it. */
function paneStatus(sessionId: string): BrowserPaneStatus | null {
  return browserPaneRegistry.list().find((pane) => pane.sessionId === sessionId) ?? null;
}

/**
 * A live pane may be HIDDEN: held behind the terminal after the user put it
 * away with the Browser pill, or in a window the user closed while the agent
 * was live (parked). The renderer keeps the guest mounted in both cases, which
 * is why the warm path resolves it at all - but the agent asked for its pane
 * to be OPEN, and before parking existed that call put the pane on screen. So
 * the warm path pushes the same request the cold path does: the renderer ends
 * a hold and un-parks a parked window (both style-only on the same guest,
 * never a remount), and treats it as a no-op for a pane already showing.
 *
 * Best-effort on purpose: the pane is registered and driveable whatever the
 * window does, so a missing window is not a failure of this call.
 */
function resurfaceLivePane(host: BrowserPaneOpenerHost, projectId: string, taskId: string): void {
  host.send(IPC.BROWSER_PANE_OPEN_REQUEST, projectId, taskId);
}

/** The task's live OFFSCREEN surface, or null. At most one, by construction. */
function liveOffscreenSurface(taskId: string, projectId: string) {
  return (
    browserPaneRegistry
      .getByTaskId(taskId, projectId)
      .find((entry) => entry.kind === 'lane' && browserPaneRegistry.resolveLiveGuest(entry).ok) ?? null
  );
}

/**
 * Where the task's offscreen surface is RIGHT NOW, for a pane about to replace it.
 *
 * Read from the registry's `list()`, which reads the live guest, rather than
 * from `browserUrlStore`. The store is written by the PANE on its own
 * `did-navigate`, and an offscreen surface has no renderer to write it - and
 * main's guest-side `did-navigate` bridge is gated on `getType() === 'webview'`,
 * so it never fires for one either. Without this the reclaim mounts a pane on
 * whatever page the task last had a visible pane on, which can be many
 * navigations behind the agent.
 */
export function offscreenSurfaceUrl(taskId: string, projectId: string): string | null {
  const entry = liveOffscreenSurface(taskId, projectId);
  if (!entry) return null;
  return paneStatus(entry.sessionId)?.url ?? entry.url;
}

/**
 * Bring the task's one surface up OFFSCREEN, because no visible pane can mount.
 *
 * Reached ONLY from the cold path's backgrounded-project branch. It is not an
 * agent choice: `kangentic_browser_open_pane` had an `isolated` argument until
 * 2026-09-21 and it came out, because a surface the user cannot see, cannot
 * close, and cannot supervise is not something an agent should be able to ask
 * for. See `browser-lane-manager.ts` for the full reasoning.
 *
 * It stays as a FALLBACK because the alternative is a dead end with no way out.
 * Close a task's detail window and its `<webview>` guest is destroyed
 * (correctly; the node unmounted). Switch projects too, and an agent still
 * running in the backgrounded project has no pane AND cannot open one: every
 * drive returns `no-pane-open`, whose hint says to call open_pane, which
 * refused with `project-not-open`. The two composed into a loop.
 *
 * Like the warm path, this reaches no project-scoped state: `callerTaskId` came
 * from the session registry (so a live session is already proof the task is
 * real) and the surface's cookie jar is keyed by that task id, which is what
 * keeps `host.taskExists` - and its stray-database precondition - out of here.
 *
 * KNOWN GAP, stated rather than found later: that also means the project's
 * `browser.enabled` override is not consulted, because reading it needs the
 * project's path and the whole reason this path exists is that the project is
 * not the open one. A project that turned the Browser pane off therefore still
 * gets an offscreen surface while it is backgrounded. The cold pane path above
 * does enforce the gate, so the pane it reclaims into never appears. Closing
 * this needs the host to resolve an arbitrary project's overrides, which it
 * deliberately cannot do today.
 */
async function openOffscreenSurface(
  input: OpenPaneInput & { callerTaskId: string },
): Promise<DriverResult<OpenPaneData>> {
  const { projectId, callerSessionId, callerTaskId, config } = input;

  const existing = liveOffscreenSurface(callerTaskId, projectId);
  if (existing) {
    if (input.url) {
      const validatedLive = validateNavigationUrl(input.url, config);
      if (!validatedLive.ok) return { ok: false, error: validatedLive.error };
      const navigateResult = await withGuest<true>(
        {
          selector: { sessionId: existing.sessionId, projectId, callerSessionId, callerTaskId },
          capability: input.capability,
          config,
        },
        async (webContents) => {
          await navigateGuest(webContents, validatedLive.url);
          return true;
        },
      );
      if (!navigateResult.ok) return { ok: false, error: navigateResult.error };
      const navigated = paneStatus(existing.sessionId);
      if (!navigated) return failure('pane-destroyed', 'The browser surface closed while navigating. Retry.');
      return {
        ok: true,
        data: {
          opened: false,
          navigated: true,
          url: validatedLive.url,
          pane: navigated,
          laneId: existing.sessionId,
          offscreen: true,
        },
      };
    }

    const pane = paneStatus(existing.sessionId);
    if (!pane) return failure('pane-destroyed', 'The browser surface closed while opening. Retry.');
    if (pane.url) {
      return {
        ok: true,
        data: { opened: false, navigated: false, url: pane.url, pane, laneId: existing.sessionId, offscreen: true },
      };
    }
    return failure(
      'no-url',
      'Your task has a browser surface but it is on no page. Pass the `url` argument (for example http://localhost:5173).',
    );
  }

  // A surface for this task exists but has not REGISTERED yet.
  //
  // `openLane` enters its bookkeeping map before it loads the first URL and
  // registers only after, so for up to `LANE_LOAD_TIMEOUT_MS` a surface is
  // neither driveable nor absent - most often because the hand-off just stood
  // one up for a window the user closed. Falling through here would reach
  // `openLane`'s `surface-exists`, whose advice (pass that handle as
  // sessionId) answers `no-pane-open` for as long as the load takes. Say retry
  // instead, which is the thing that actually works.
  if (hasLaneForTask(callerTaskId)) {
    return failure(
      'surface-opening',
      'Your task already has a browser surface and it is still loading its first page. Retry in a moment. If that page never loads, the surface is abandoned and a retry opens a new one.',
    );
  }

  if (!input.url) {
    return failure(
      'no-url',
      'Pass an explicit `url`. Your project is not the one currently open in Kangentic, so its saved Browser URL and project default cannot be read - but the browser itself will open fine.',
    );
  }
  const validated = validateNavigationUrl(input.url, config);
  if (!validated.ok) return { ok: false, error: validated.error };

  const lane = await openLane({
    taskId: callerTaskId,
    projectId,
    ownerSessionId: callerSessionId,
    url: validated.url,
  });
  if (!lane.ok) return failure(lane.kind, lane.detail);
  const lanePane = paneStatus(lane.laneId);
  if (!lanePane) return failure('pane-destroyed', 'The browser surface closed immediately after opening. Retry.');
  return {
    ok: true,
    data: {
      opened: true,
      navigated: true,
      url: validated.url,
      pane: lanePane,
      laneId: lane.laneId,
      offscreen: true,
    },
  };
}

/**
 * Open (and navigate) the Browser pane for the CALLER's own task.
 *
 * Deliberately takes no free-form taskId: naming another task is the
 * cross-project hole the caller-scoping work closed, and defaulting to the
 * caller's own task is both safer and simpler.
 */
export async function openPaneForCallerTask(input: OpenPaneInput): Promise<DriverResult<OpenPaneData>> {
  const { projectId, callerSessionId, callerTaskId, config } = input;

  if (!callerTaskId) {
    return failure(
      'no-caller-task',
      'This connection is not bound to a task, so there is no pane to open. Only an agent running on a Kangentic task can open its own Browser pane; a Command Terminal or a manually configured MCP client cannot. Ask the user to open the task\'s Browser pane instead.',
    );
  }

  // Gate BEFORE any side effect. Unlike a driving tool, this one opens a window
  // and seeds a URL before there is a guest to resolve, so leaving the check to
  // the `withGuest` call at the end would let a gated-off capability still put a
  // pane on the user's screen and only refuse afterwards. That also makes the
  // documented "turning off Allow navigation disables this tool" true on every
  // return path, including the already-open one that never reaches `withGuest`.
  const gate = capabilityGate(input.capability, config);
  if (gate) return { ok: false, error: gate };

  const host = readHost();
  if (!host) {
    return failure('app-not-ready', 'Kangentic is still starting up. Retry in a moment.');
  }

  const selectorFor = (sessionId?: string): ResolveTargetSelector => ({
    sessionId,
    taskId: sessionId ? undefined : callerTaskId,
    projectId,
    callerSessionId,
    callerTaskId,
  });

  // WARM PATH FIRST: is this task's pane already up and driveable?
  //
  // This lookup has to precede the project-not-open guard below, and the
  // ordering is the whole fix. A pane whose project is BACKGROUNDED is
  // deliberately kept alive - that is what retention is for, so an agent can
  // keep driving its own pane while the user works elsewhere (see
  // `.claude/rules/retained-pane-never-remounts.md`). Guarding first refused
  // exactly that pane, and the `no-pane-open` hint sends the agent right back
  // here, so the two composed into a dead end: an agent with a live, retained,
  // driveable pane could not reach it and had to work blind.
  //
  // `closePanes` below already reasoned this through and does NOT require the
  // caller's project to be open. Opening simply never got revisited when
  // retention landed.
  //
  // Resolving the live pane first is also what makes this safe rather than just
  // a reordering: everything the warm path needs comes from the registry, so it
  // touches no project-scoped state. In particular it never reaches
  // `host.taskExists`, whose documented precondition is that the project be
  // confirmed open - `getProjectDb` CREATES a database file for an unrecognized
  // id, so calling it with an unvalidated one leaves a stray `<projectId>.db`
  // behind. A registered live pane is its own proof the task is real: the
  // renderer registered it, and main backfilled its `projectId` from the
  // session registry.
  //
  // Visible PANES only. A task whose surface is currently OFFSCREEN is not
  // "already open" for this tool's purposes: the caller asked for its pane, so
  // the cold path below mounts the visible one and its registration reclaims
  // the offscreen form. Handing the offscreen surface back here would report
  // `opened: false` for a browser the user cannot see, which is exactly the
  // failure that ended isolated lanes.
  const live = browserPaneRegistry
    .getByTaskId(callerTaskId, projectId)
    .filter((entry) => entry.kind === 'pane')
    .find((entry) => browserPaneRegistry.resolveLiveGuest(entry).ok);

  // Pure no-op: the pane is already up and the caller named no URL, so nothing
  // navigates. The navigation POLICY is deliberately not consulted on this
  // path - it gates navigations, and refusing here would reject a status-only
  // call because the policy tightened after the page loaded, which cannot
  // unload that page anyway. The capability gate above still applies.
  if (live && !input.url) {
    const pane = paneStatus(live.sessionId);
    if (!pane) return failure('pane-destroyed', 'The Browser pane closed while opening. Retry.');
    if (pane.url) {
      resurfaceLivePane(host, projectId, callerTaskId);
      return { ok: true, data: { opened: false, navigated: false, url: pane.url, pane } };
    }
    // A live guest with no URL is a pane sitting on its empty state. Reporting
    // the task's SAVED url here (which is what this path used to do) would
    // claim a page is loaded when nothing is. Fall through to the cold path so
    // a URL actually gets resolved and loaded.
  }

  if (live && input.url) {
    const validatedLive = validateNavigationUrl(input.url, config);
    if (!validatedLive.ok) return { ok: false, error: validatedLive.error };
    const navigateResult = await withGuest<true>(
      { selector: selectorFor(live.sessionId), capability: input.capability, config },
      async (webContents) => {
        // Bounded for the same reason as the navigate tool: this body runs
        // inside withGuest, so an unbounded load holds the guest's drive lock.
        await navigateGuest(webContents, validatedLive.url);
        return true;
      },
    );
    if (!navigateResult.ok) return { ok: false, error: navigateResult.error };
    const pane = paneStatus(live.sessionId);
    if (!pane) return failure('pane-destroyed', 'The Browser pane closed while navigating. Retry.');
    resurfaceLivePane(host, projectId, callerTaskId);
    return { ok: true, data: { opened: false, navigated: true, url: validatedLive.url, pane } };
  }

  // COLD PATH: no live pane, so a window has to be mounted. The board window
  // layer renders only the OPEN project's tasks, so a backgrounded project
  // genuinely cannot mount one.
  //
  // That used to be a flat `project-not-open` refusal, and it composed with the
  // `no-pane-open` hint into a loop an agent could not get out of. It now opens
  // the task's one surface OFFSCREEN instead: driveable, reported as
  // `offscreen: true`, visible to the user on the card globe and the Browser
  // pill, and reclaimed into a real pane the moment one can mount.
  if (host.currentProjectId !== projectId || !host.currentProjectPath) {
    return openOffscreenSurface({ ...input, callerTaskId });
  }
  const projectPath = host.currentProjectPath;

  // Enforced here rather than left to the UI: `TaskDetailBody` renders the pane
  // purely on its open flag, so a pane opened while this gate is off would show
  // with no Browser pill beside it - and the pill is the user's only way to
  // close it.
  const overrides = host.browserOverrides(projectPath);
  if (overrides?.enabled === false) {
    return failure(
      'browser-pane-disabled',
      'The Browser pane is turned off for this project. Ask the user to enable it in Settings -> Browser, then retry.',
    );
  }

  if (!host.taskExists(projectId, callerTaskId)) {
    return failure('task-not-found', `Task ${callerTaskId} is not on this project's board.`);
  }

  // A pane with no URL renders the empty state and registers no guest, so it is
  // invisible to every other tool in this family. "Open" and "navigate"
  // therefore cannot be two calls.
  // The OFFSCREEN surface's live URL outranks the saved one. Reaching here with
  // one alive means this call is a RECLAIM: the pane about to mount replaces
  // it, so it must land on the page the agent left it on, not on wherever a
  // visible pane last was. See `offscreenSurfaceUrl` for why the saved value
  // cannot be trusted for an offscreen surface at all.
  const resolvedUrl =
    input.url
    ?? offscreenSurfaceUrl(callerTaskId, projectId)
    ?? browserUrlStore.get(projectPath, callerTaskId)
    ?? overrides?.defaultUrl
    ?? null;
  if (!resolvedUrl) {
    return failure(
      'no-url',
      'No URL to load: this task has no saved Browser URL and the project has no default. Pass the `url` argument (for example http://localhost:5173).',
    );
  }
  const validated = validateNavigationUrl(resolvedUrl, config);
  if (!validated.ok) return { ok: false, error: validated.error };

  // No live-pane branch here any more: both warm cases are handled above, ahead
  // of the project-not-open guard, so a retained pane in a backgrounded project
  // stays driveable. Do not reintroduce one below the guard.

  // Seed the URL BEFORE the push so the pane's own mount-time lookup
  // resolves it and the pane comes up active rather than on the empty state.
  // This is the same write the pane performs for itself on `did-navigate`, just
  // earlier.
  try {
    browserUrlStore.set(projectPath, callerTaskId, validated.url);
  } catch (error) {
    return failure(
      'url-seed-failed',
      `Could not save the pane's URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!host.send(IPC.BROWSER_PANE_OPEN_REQUEST, projectId, callerTaskId)) {
    return failure('app-not-ready', 'The Kangentic window is not available.');
  }

  const entry = await browserPaneRegistry.waitForLivePane(
    { taskId: callerTaskId, projectId },
    PANE_OPEN_TIMEOUT_MS,
  );
  if (!entry) {
    return failure(
      'pane-open-timeout',
      `The Browser pane did not come up within ${PANE_OPEN_TIMEOUT_MS / 1000}s. The Kangentic window may be minimized, or the task's detail window may have failed to open. Ask the user to check, or call kangentic_browser_list_panes to see what is open.`,
    );
  }

  // Resolve through the same chokepoint every driving tool uses, so this returns
  // only once the pane is genuinely driveable. A minimized window fails here
  // with `pane-not-rendering`: the pane is left OPEN on purpose, so restoring
  // the window is all the user has to do.
  const readyResult = await withGuest<BrowserPaneStatus | null>(
    { selector: selectorFor(entry.sessionId), capability: input.capability, config },
    async () => paneStatus(entry.sessionId),
  );
  if (!readyResult.ok) return { ok: false, error: readyResult.error };
  if (!readyResult.data) {
    return failure('pane-destroyed', 'The Browser pane closed immediately after opening. Retry.');
  }
  return { ok: true, data: { opened: true, navigated: true, url: validated.url, pane: readyResult.data } };
}

/**
 * Put Browser panes away, the way the user's Browser pill does. Closes the pane,
 * never the task-detail window that hosts it.
 *
 * Scope is the caller's project by default, and the response always names the
 * scope it applied plus what it left alone, so "close all browsers" can never be
 * reported as complete when it was partial. `includeOtherProjects` is the
 * explicit opt-in for a genuinely global close.
 *
 * Unlike opening, this does NOT require the caller's project to be the open one:
 * a backgrounded project's panes are deliberately kept alive (retention), and
 * those are exactly what a "close everything" request should reach.
 */
export async function closePanes(input: ClosePaneInput): Promise<DriverResult<ClosePaneData>> {
  const { projectId, callerSessionId, callerTaskId, config } = input;

  // This tool attaches no CDP, so it never reaches `withGuest`'s capability
  // gate. Check the master switch explicitly rather than inheriting it.
  if (!config.enabled) {
    return failure(
      'automation-disabled',
      'Agent browser automation is turned off. Enable it in Settings -> Agent Browser.',
    );
  }

  const scoped = browserPaneRegistry.listForProject(projectId);
  const scope = input.includeOtherProjects ? 'all-projects' : 'this-project';

  // `includeOtherProjects` widens the `all` sweep and permits an EXPLICITLY
  // named foreign target - exactly what its doc comment promises. It must not
  // widen the IMPLICIT default: a bare call means "close my own pane", and
  // unscoping it would let `resolveTarget`'s single-pane fallback reach into
  // another project whose pane the caller never named, which is the
  // cross-project reach this whole family refuses everywhere else.
  const hasExplicitTarget = Boolean(input.sessionId || input.taskId);
  // A full sweep is the only case that leaves nothing behind; anything else
  // must keep reporting the panes it did not touch, or a narrow close reads as
  // a comprehensive one.
  const sweptEveryProject = Boolean(input.all && input.includeOtherProjects);
  const otherProjectPaneCount = sweptEveryProject ? 0 : scoped.otherProjectPaneCount;

  let targets: BrowserPaneStatus[];
  if (input.all) {
    targets = input.includeOtherProjects ? browserPaneRegistry.list() : scoped.panes;
  } else {
    // Reuse the drive tools' resolution so precedence and error kinds match
    // exactly. Caller identity is what makes a bare call resolve to the agent's
    // OWN pane instead of refusing `multiple-panes` when a sibling task also has
    // one open - that is the most common call this tool will ever receive.
    const resolved = browserPaneRegistry.resolveTarget({
      sessionId: input.sessionId,
      taskId: input.taskId,
      projectId: input.includeOtherProjects && hasExplicitTarget ? null : projectId,
      callerSessionId,
      callerTaskId,
    });
    if (!resolved.ok) return failure(resolved.kind, resolved.detail);
    const pane = paneStatus(resolved.entry.sessionId);
    targets = pane ? [pane] : [];
  }

  if (targets.length === 0) {
    return { ok: true, data: { closed: [], skipped: [], scope, otherProjectPaneCount } };
  }

  const summarize = (pane: BrowserPaneStatus): ClosedPaneSummary => ({
    sessionId: pane.sessionId,
    kind: pane.kind,
    taskId: pane.taskId,
    projectId: pane.projectId,
    url: pane.url,
  });

  // Lanes are closed HERE, in main, not by the renderer push below.
  //
  // A lane is an offscreen window main owns outright: there is no task-detail
  // window hosting it and no `browserOpenTasks` flag to clear, so the push
  // would do nothing and the lane would be reported "still registered" - a
  // skipped close, forever. Destroying it directly is also what makes this the
  // one tool that can put an offscreen surface away.
  const laneTargets = targets.filter((pane) => pane.kind === 'lane');
  const paneTargets = targets.filter((pane) => pane.kind !== 'lane');
  const closedLanes = laneTargets.filter((lane) => destroyLane(lane.sessionId)).map(summarize);

  if (paneTargets.length === 0) {
    return { ok: true, data: { closed: closedLanes, skipped: [], scope, otherProjectPaneCount } };
  }

  const host = readHost();
  if (!host) {
    return failure('app-not-ready', 'The Kangentic window is not available.');
  }

  // This close is the agent's own decision, so the unregister it causes must
  // not trigger the hand-off that keeps an agent's browser alive when the USER
  // closes a window. Marked before the push, since the unregister can land
  // before the push call even returns.
  browserPaneRegistry.markDeliberateClose(paneTargets.map((pane) => pane.sessionId));

  // Push the task ids: pane open state is keyed by task, not session.
  const taskIds = [...new Set(paneTargets.map((pane) => pane.taskId))];
  if (!host.send(IPC.BROWSER_PANE_CLOSE_REQUEST, projectId, taskIds)) {
    return failure('app-not-ready', 'The Kangentic window is not available.');
  }

  const stillRegistered = new Set(
    await browserPaneRegistry.waitForPanesGone(
      paneTargets.map((pane) => pane.sessionId),
      PANE_CLOSE_TIMEOUT_MS,
    ),
  );

  // Report what actually happened rather than what was attempted.
  //
  // The known straggler is a pane detached into its own pop-out window:
  // `PopOutBrowserRoot` mounts `BrowserPane` from its own window params and
  // never reads `browserOpenTasks`, so clearing the flag cannot unmount it (and
  // broadcasting the push to pop-out renderers would not help either - only
  // closing that OS window would, which is out of scope). Main cannot tell that
  // apart from a renderer that simply did not act, so the reason states the
  // fact and names the known cause without asserting it.
  const closed = [
    ...closedLanes,
    ...paneTargets.filter((pane) => !stillRegistered.has(pane.sessionId)).map(summarize),
  ];
  const skipped = paneTargets
    .filter((pane) => stillRegistered.has(pane.sessionId))
    .map((pane) => ({
      ...summarize(pane),
      reason: 'Still registered after the close request, so it was not closed. A pane detached into its own pop-out window is not closed by this tool.',
    }));

  return { ok: true, data: { closed, skipped, scope, otherProjectPaneCount } };
}
