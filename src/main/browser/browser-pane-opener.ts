import { IPC } from '../../shared/ipc-channels';
import { browserUrlStore } from './browser-url-store';
import {
  browserPaneRegistry,
  type BrowserPaneStatus,
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
import { openLane, destroyLane } from './browser-lane-manager';

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
  /**
   * Open a private LANE instead of the task's shared pane.
   *
   * The discriminator is the ACT OF ASKING, not who is asking - which is the
   * whole reason this is an argument rather than per-caller routing. Every
   * subagent inherits its parent's `callerSessionId`, so the server genuinely
   * cannot tell concurrent workers apart, and the alternatives (a hook that
   * stamps Claude's `agent_id`) are single-agent solutions in a product that
   * supports ten agent CLIs.
   *
   * A lane's id comes back as `sessionId`, which every driving tool already
   * accepts, so no tool needed a new argument.
   */
  isolated?: boolean;
  /** Worktree directory for the caller's task, so a lane shares its cookie jar. */
  cwd?: string | null;
}

export interface OpenPaneData {
  /** True when this call opened the pane; false when it was already open. */
  opened: boolean;
  /** True when this call pointed an already-open pane at a new URL. */
  navigated: boolean;
  url: string;
  pane: BrowserPaneStatus;
  /**
   * Present only for an isolated lane. The caller MUST pass this back as
   * `sessionId` on every later browser call, or it falls back to the shared
   * pane and the isolation it just asked for silently does nothing.
   */
  laneId?: string;
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
  sessionId: string;
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

  // ISOLATED LANE - handled FIRST, ahead of both the shared-pane lookup and the
  // project-not-open guard.
  //
  // Ahead of the pane lookup because a caller asking for isolation must never be
  // handed the shared pane instead; that would silently give it the opposite of
  // what it asked for.
  //
  // Ahead of the project-not-open guard because a lane needs NO task-detail
  // window: it is an offscreen window main owns outright, so the board layer
  // rendering only the open project is irrelevant to it. That guard exists for
  // the cold pane path, which genuinely cannot mount a window for a backgrounded
  // project, and applying it here would block the one recovery that does work.
  //
  // That recovery is the real-world failure this ordering fixes. Close a task's
  // detail window and its `<webview>` guest is destroyed - correctly; the node
  // unmounted. Switch projects too, and the agent still running in the
  // backgrounded project now has no pane AND cannot open one: every drive
  // returns `no-pane-open`, whose hint says to call open_pane, which used to
  // refuse with `project-not-open`. A lane is the way out, so it must not be
  // behind the same guard.
  //
  // Like the warm path, this reaches no project-scoped state: `callerTaskId`
  // came from the session registry (so a live session is already proof the task
  // is real) and `cwd` comes from the same place, which is what keeps
  // `host.taskExists` - and its stray-database precondition - out of this path.
  if (input.isolated) {
    const projectIsOpen = host.currentProjectId === projectId && Boolean(host.currentProjectPath);
    const laneUrl =
      input.url
      ?? (projectIsOpen
        ? browserUrlStore.get(host.currentProjectPath!, callerTaskId)
          ?? host.browserOverrides(host.currentProjectPath!)?.defaultUrl
          ?? null
        : null);

    if (!laneUrl) {
      return failure(
        'no-url',
        projectIsOpen
          ? 'No URL to load: this task has no saved Browser URL and the project has no default. Pass the `url` argument (for example http://localhost:5173).'
          : 'Pass an explicit `url` for an isolated lane while your project is backgrounded. Your project is not the one currently open, so its saved Browser URL and project default cannot be read - but the lane itself will open fine.',
      );
    }

    const validatedLane = validateNavigationUrl(laneUrl, config);
    if (!validatedLane.ok) return { ok: false, error: validatedLane.error };

    const lane = await openLane({
      taskId: callerTaskId,
      projectId,
      ownerSessionId: callerSessionId,
      cwd: input.cwd ?? (projectIsOpen ? host.currentProjectPath : null),
      url: validatedLane.url,
    });
    if (!lane.ok) return failure(lane.kind, lane.detail);
    const lanePane = paneStatus(lane.laneId);
    if (!lanePane) return failure('pane-destroyed', 'The browser lane closed immediately after opening. Retry.');
    return {
      ok: true,
      data: { opened: true, navigated: true, url: validatedLane.url, pane: lanePane, laneId: lane.laneId },
    };
  }

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
  const live = browserPaneRegistry
    .getByTaskId(callerTaskId, projectId)
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
    return { ok: true, data: { opened: false, navigated: true, url: validatedLive.url, pane } };
  }

  // COLD PATH: no live pane, so a window has to be mounted. The board window
  // layer renders only the OPEN project's tasks, so this genuinely cannot work
  // for a backgrounded project. Refusing here is honest and immediate; pushing
  // anyway would just time out with a vaguer message.
  if (host.currentProjectId !== projectId || !host.currentProjectPath) {
    return failure(
      'project-not-open',
      'Your project is not the one currently open in Kangentic, so a Browser pane cannot be opened for it. Ask the user to switch to it, then retry. (A pane that is ALREADY open stays driveable while its project is backgrounded.)',
    );
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
  const resolvedUrl =
    input.url ?? browserUrlStore.get(projectPath, callerTaskId) ?? overrides?.defaultUrl ?? null;
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
    taskId: pane.taskId,
    projectId: pane.projectId,
    url: pane.url,
  });

  // Lanes are closed HERE, in main, not by the renderer push below.
  //
  // A lane is an offscreen window main owns outright: there is no task-detail
  // window hosting it and no `browserOpenTasks` flag to clear, so the push
  // would do nothing and the lane would be reported "still registered" - a
  // skipped close, forever. Destroying it directly is also what makes this tool
  // the working escape hatch the lane-limit error points callers at.
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
