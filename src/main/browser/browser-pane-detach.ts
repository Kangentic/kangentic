import { browserPaneRegistry, type BrowserPaneStatus } from './browser-pane-registry';
import {
  capabilityGate,
  withGuest,
  type BrowserCapability,
  type DriverError,
  type DriverResult,
} from './browser-pane-driver';
import type { ResolvedBrowserAutomationConfig } from './browser-automation-config';
import { openPaneForCallerTask, PANE_OPEN_TIMEOUT_MS } from './browser-pane-opener';
import { popOutWindowManager } from '../pop-out/pop-out-window-manager';
import {
  applyViewport,
  displayForWindow,
  type ViewportSize,
  type WindowAnchor,
} from './viewport-override';

/**
 * Detaching the caller's Browser pane into its own OS window, and putting it
 * back.
 *
 * ## Why this is a relocation, not a viewport control
 *
 * The other half of the viewport story (`viewport-override.ts`) never moves
 * anything: it changes what the page lays out against and the guest keeps its
 * document. This does the opposite. A `<webview>` guest dies the instant its
 * DOM node moves between documents, and a pop-out window is a different
 * document in a different renderer process, so there is no version of this that
 * carries the page across. The window mounts a FRESH pane, the page reloads,
 * `sessionStorage` and in-memory state are gone, and main mints a new surface
 * handle. Cookies and localStorage survive, because the partition is keyed by
 * task and does not move.
 *
 * That cost is real and the tool descriptions say so plainly, because the agent
 * is the only one who can weigh it: an agent midway through a logged-in flow
 * should reach for `kangentic_browser_set_viewport` instead and keep its page.
 *
 * What detaching buys is real OS pixels. A window can be sized up to the
 * display with no emulation at all, which means 1:1 coordinates and captures
 * that are the thing itself rather than a scaled rendering of it.
 *
 * ## Why the wait is the load-bearing part
 *
 * Returning as soon as the window opens would hand back a handle whose guest is
 * being destroyed, and every following call would fail `surface-gone`. So both
 * directions wait for the SUCCESSOR guest (naming the predecessor so the
 * overlap cannot satisfy the wait early) and then resolve it through `withGuest`
 * exactly as the cold open path does, so "it returned" means "it is driveable".
 *
 * ## Why a failed detach closes its own window
 *
 * Opening the window already unmounted the in-app pane, so a detach that gives
 * up has taken the agent's surface away. It used to give up and leave the
 * window open: an OS window nothing tracked, holding no registered pane, which
 * `list_panes` could not see and `close_pane` could not reach. So every failure
 * after the window opens closes it again, which docks the pane back into the
 * task window, and the error names the surface the agent has now.
 */

/** Long enough for a second renderer process to boot, load the app shell, mount
 *  the pane and have its guest reach `dom-ready`. Docking is the same work in
 *  reverse inside an already-running renderer, so it shares the bound. */
const DETACH_TIMEOUT_MS = 20_000;

/** How long a failed detach waits for the in-app pane to come back after it
 *  closes the window. A remount inside the running app window, the same work
 *  an opened pane does, so it takes the open path's bound. */
const RECOVER_TIMEOUT_MS = PANE_OPEN_TIMEOUT_MS;

export interface DetachPaneInput {
  projectId: string;
  callerSessionId?: string;
  callerTaskId?: string;
  capability: BrowserCapability;
  config: ResolvedBrowserAutomationConfig;
  width?: number;
  height?: number;
  maximized?: boolean;
  position?: WindowAnchor;
}

export interface DetachPaneData {
  /** True when this call moved the pane; false when it was already there. */
  moved: boolean;
  pane: BrowserPaneStatus;
  /** The new surface handle. Any handle held from before this call is dead. */
  sessionId: string;
  /** Present when a size was requested, reporting what the window actually
   *  gave the page rather than what was asked for. */
  viewport?: ViewportSize;
  /**
   * The usable area of the display this window is on.
   *
   * Reported here as well as on `set_viewport` so sizing relative to the
   * screen is one call rather than two: an agent that popped out and wanted
   * half the width had to fire a `set_viewport` purely to read the display
   * back, and said as much in its own transcript before doing it.
   */
  display: ViewportSize | null;
  note: string;
}

function failure(kind: string, detail: string): { ok: false; error: DriverError } {
  return { ok: false, error: { kind, detail } };
}

function paneStatus(sessionId: string): BrowserPaneStatus | null {
  return browserPaneRegistry.list().find((pane) => pane.sessionId === sessionId) ?? null;
}

/**
 * Wait for the pane that replaces the guests in `previousWebContentsIds`, then
 * confirm it is actually driveable before handing its handle back.
 */
async function awaitSuccessorPane(
  input: { projectId: string; taskId: string; callerSessionId?: string; callerTaskId?: string },
  previousWebContentsIds: readonly number[],
  capability: BrowserCapability,
  config: ResolvedBrowserAutomationConfig,
  timedOutDetail: string,
  timeoutMs: number = DETACH_TIMEOUT_MS,
): Promise<DriverResult<BrowserPaneStatus>> {
  const entry = await browserPaneRegistry.waitForLivePane(
    {
      taskId: input.taskId,
      projectId: input.projectId,
      excludeWebContentsIds: previousWebContentsIds,
    },
    timeoutMs,
  );
  if (!entry) return failure('detach-timeout', timedOutDetail);

  const ready = await withGuest<BrowserPaneStatus | null>(
    {
      selector: {
        sessionId: entry.sessionId,
        projectId: input.projectId,
        callerSessionId: input.callerSessionId,
        callerTaskId: input.callerTaskId,
      },
      capability,
      config,
    },
    async () => paneStatus(entry.sessionId),
  );
  if (!ready.ok) return { ok: false, error: ready.error };
  if (!ready.data) {
    return failure('pane-destroyed', 'The Browser pane closed immediately after moving. Retry.');
  }
  return { ok: true, data: ready.data };
}

/** The caller's own live pane, if it has one. */
function liveOwnPane(projectId: string, taskId: string) {
  return browserPaneRegistry
    .getByTaskId(taskId, projectId)
    .find((entry) => entry.kind === 'pane' && browserPaneRegistry.resolveLiveGuest(entry).ok);
}

/** Where a surface is, in the words an agent can repeat to the user. */
function describeRecoveredSurface(pane: BrowserPaneStatus): string {
  if (pane.kind === 'lane' || pane.visibility === 'offscreen') {
    return `offscreen as ${pane.sessionId}, which the user cannot see`;
  }
  if (pane.visibility === 'hidden') return `back in the task window as ${pane.sessionId}, hidden behind the terminal`;
  if (pane.visibility === 'parked') return `back in the task window as ${pane.sessionId}, in a window the user closed`;
  return `back in the task window as ${pane.sessionId}`;
}

/**
 * Undo a detach that could not finish: close the window it opened, then hand
 * the agent a driveable surface and say which.
 *
 * In this order, because the surface that comes back depends on it:
 *
 * 1. Mark the window's own pane, if one registered, as a deliberate close.
 *    Closing destroys its guest, and without the mark the hand-off would stand
 *    a lane up for a page that is about to come back anyway.
 * 2. Close the window, unless the user already did. That IS a dock: the
 *    in-app pane reclaims its slot.
 * 3. Wait for that pane, as `dock` does. Before anything else, because in a
 *    backgrounded project the opener's offscreen path would hand back the
 *    hand-off lane, which the returning pane reclaims a moment later, and that
 *    handle would be dead on its next call.
 * 4. Else open one through the opener, the path that already guarantees a
 *    driveable surface whether the project is open or not.
 * 5. Else name any live surface the task still has.
 */
async function abandonDetach(
  input: DetachPaneInput & { callerTaskId: string },
  previousWebContentsId: number,
  cause: DriverError,
): Promise<{ ok: false; error: DriverError }> {
  const { projectId, callerSessionId, callerTaskId, capability, config } = input;
  const windowKey = { projectId, taskId: callerTaskId };

  // The user may have closed the window during the wait. Then there is nothing
  // to close, and a pane other than the docked one is the in-app pane already
  // back, which must be neither marked nor skipped.
  const windowOpen = popOutWindowManager.has('browser', windowKey);
  // Before the close, every pane of this task other than the one that was
  // docked belongs to the detached window. Read here rather than threaded in,
  // so a pane that registered just after the wait gave up is caught too.
  const detachedPanes = windowOpen
    ? browserPaneRegistry
        .getByTaskId(callerTaskId, projectId)
        .filter((entry) => entry.kind === 'pane' && entry.webContentsId !== previousWebContentsId)
    : [];
  if (detachedPanes.length > 0) {
    browserPaneRegistry.markDeliberateClose(detachedPanes.map((entry) => entry.sessionId));
  }
  if (windowOpen) popOutWindowManager.close('browser', windowKey);

  const closedNote = `${cause.detail} The detached window was closed`;
  const returned = await awaitSuccessorPane(
    { projectId, taskId: callerTaskId, callerSessionId, callerTaskId },
    // The window's own guests are still alive for a moment after `close()`, so
    // the wait must skip every one of them. The docked guest died when the
    // window opened, and skipping it too keeps the wait off it either way.
    [previousWebContentsId, ...detachedPanes.map((entry) => entry.webContentsId)],
    capability,
    config,
    'The pane did not come back into the task window.',
    RECOVER_TIMEOUT_MS,
  );
  if (returned.ok) {
    return failure(
      cause.kind,
      `${closedNote}, so the pane is ${describeRecoveredSurface(returned.data)}. The page reloaded, and any earlier surface handle is dead: use ${returned.data.sessionId} from now on.`,
    );
  }

  const opened = await openPaneForCallerTask({ projectId, callerSessionId, callerTaskId, capability, config });
  if (opened.ok) {
    return failure(
      cause.kind,
      `${closedNote}, and your task's Browser surface is ${describeRecoveredSurface(opened.data.pane)}. Any earlier surface handle is dead: use ${opened.data.pane.sessionId} from now on.`,
    );
  }

  const remaining = browserPaneRegistry
    .getByTaskId(callerTaskId, projectId)
    .map((entry) => paneStatus(entry.sessionId))
    .find((pane): pane is BrowserPaneStatus => pane !== null && pane.alive);
  if (remaining) {
    return failure(
      cause.kind,
      `${closedNote}, and your task's Browser surface is ${describeRecoveredSurface(remaining)}. Use ${remaining.sessionId} from now on.`,
    );
  }
  return failure(
    cause.kind,
    `${closedNote}, but no Browser surface came back for this task (${opened.error.kind}: ${opened.error.detail}). Call kangentic_browser_open_pane to open one.`,
  );
}

/**
 * Detach the caller's own Browser pane into its own OS window.
 *
 * Caller-scoped by construction, like `open_pane`: there is no argument naming
 * a task, so there is no path to detaching someone else's pane.
 */
export async function popOutPaneForCallerTask(
  input: DetachPaneInput,
): Promise<DriverResult<DetachPaneData>> {
  const { projectId, callerSessionId, callerTaskId, config } = input;

  if (!callerTaskId) {
    return failure(
      'no-caller-task',
      'This connection is not bound to a task, so there is no Browser pane to detach. Only an agent running on a Kangentic task can move its own pane.',
    );
  }

  // Gated before the side effect, for the same reason `open_pane` is: this puts
  // a window on the user's screen before there is any guest to resolve, so
  // leaving the check to the `withGuest` call at the end would let a gated-off
  // capability open a window and only then refuse.
  const gate = capabilityGate(input.capability, config);
  if (gate) return { ok: false, error: gate };

  if (popOutWindowManager.has('browser', { projectId, taskId: callerTaskId })) {
    const existing = liveOwnPane(projectId, callerTaskId);
    const status = existing ? paneStatus(existing.sessionId) : null;
    if (!status) {
      return failure(
        'pane-destroyed',
        'A detached Browser window is open for this task but holds no page. Call kangentic_browser_dock to close it and bring the pane back into the task window, then retry.',
      );
    }
    return resizeExistingWindow(input, status);
  }

  const current = liveOwnPane(projectId, callerTaskId);
  if (!current) {
    return failure(
      'no-pane-open',
      'This task has no Browser pane to detach. Call kangentic_browser_open_pane first, then detach it.',
    );
  }
  const previousWebContentsId = current.webContentsId;

  let window;
  try {
    window = popOutWindowManager.open(
      'browser',
      { projectId, taskId: callerTaskId },
      // An agent opening a window must not raise it over what the user is
      // doing. See `.claude/rules/agent-driven-focus.md`.
      { focus: false },
    );
  } catch (error) {
    return failure(
      'detach-failed',
      `Could not open the detached Browser window: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!window) {
    return failure('detach-failed', 'The detached Browser window could not be opened.');
  }

  if (input.maximized === true) window.maximize();

  // From here on the window exists and the in-app pane is gone, so every
  // failure goes through `abandonDetach` rather than returning as is.
  const ready = await awaitSuccessorPane(
    { projectId, taskId: callerTaskId, callerSessionId, callerTaskId },
    [previousWebContentsId],
    input.capability,
    config,
    `The detached Browser window's pane did not come up within ${DETACH_TIMEOUT_MS / 1000}s.`,
  );
  if (!ready.ok) return abandonDetach({ ...input, callerTaskId }, previousWebContentsId, ready.error);

  const sized = await resizeExistingWindow(input, ready.data);
  if (!sized.ok) return abandonDetach({ ...input, callerTaskId }, previousWebContentsId, sized.error);
  return {
    ok: true,
    data: {
      ...sized.data,
      moved: true,
      note:
        'The page RELOADED into a new window, so this is a fresh document: sessionStorage and in-memory state are gone and any earlier surface handle is dead. Cookies and localStorage carried over. Use the sessionId returned here from now on.',
    },
  };
}

/**
 * Apply a requested size to the already-open detached window, reusing the same
 * measure-and-correct path `set_viewport` uses so the two cannot disagree about
 * what a requested viewport means.
 */
async function resizeExistingWindow(
  input: DetachPaneInput,
  pane: BrowserPaneStatus,
): Promise<DriverResult<DetachPaneData>> {
  const window = popOutWindowManager.windowFor('browser', {
    projectId: input.projectId,
    taskId: input.callerTaskId as string,
  });
  const base: DetachPaneData = {
    moved: false,
    pane,
    sessionId: pane.sessionId,
    display: window ? displayForWindow(window) : null,
    note: 'A detached Browser window was already open for this task.',
  };
  // `maximized` alone is NOT a resize, and treating it as one is what made a
  // maximized pop-out spill across two monitors: with no width or height the
  // target fell back to the CURRENT viewport, the resize path then
  // un-maximized the window (correctly, for an explicit size), set that
  // viewport as the window's CONTENT size, and the chrome correction grew it
  // past the display. Maximize is its own intent: the window is already the
  // size the user's display allows.
  if (input.width === undefined && input.height === undefined && input.position === undefined) {
    return { ok: true, data: base };
  }

  const result = await withGuest<ViewportSize>(
    {
      selector: {
        sessionId: pane.sessionId,
        projectId: input.projectId,
        callerSessionId: input.callerSessionId,
        callerTaskId: input.callerTaskId,
      },
      capability: input.capability,
      config: input.config,
    },
    async (webContents, entry) => {
      const outcome = await applyViewport(
        webContents,
        entry,
        { width: input.width, height: input.height, position: input.position },
        input.callerSessionId ?? null,
      );
      return outcome.viewport;
    },
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: { ...base, viewport: result.data } };
}

/**
 * Put the caller's detached Browser window back into the task.
 *
 * Closing the window IS the dock: the renderer's `popOut:changed` push flips
 * the in-app guard back and the pane reclaims its slot. So this closes and then
 * waits for the re-mounted in-app guest, rather than pushing anything itself.
 */
export async function dockPaneForCallerTask(
  input: Omit<DetachPaneInput, 'width' | 'height' | 'maximized'>,
): Promise<DriverResult<DetachPaneData>> {
  const { projectId, callerSessionId, callerTaskId, config } = input;

  if (!callerTaskId) {
    return failure(
      'no-caller-task',
      'This connection is not bound to a task, so there is no detached Browser window to dock.',
    );
  }

  const gate = capabilityGate(input.capability, config);
  if (gate) return { ok: false, error: gate };

  if (!popOutWindowManager.has('browser', { projectId, taskId: callerTaskId })) {
    return failure(
      'not-detached',
      "This task's Browser pane is not in a detached window, so there is nothing to dock.",
    );
  }

  const detached = liveOwnPane(projectId, callerTaskId);

  popOutWindowManager.close('browser', { projectId, taskId: callerTaskId });

  const ready = await awaitSuccessorPane(
    { projectId, taskId: callerTaskId, callerSessionId, callerTaskId },
    detached ? [detached.webContentsId] : [],
    input.capability,
    config,
    `The Browser pane did not come back into the task window within ${DETACH_TIMEOUT_MS / 1000}s. It may be that the task's detail window is closed; call kangentic_browser_open_pane to bring it back.`,
  );
  if (!ready.ok) return ready;

  return {
    ok: true,
    data: {
      moved: true,
      pane: ready.data,
      sessionId: ready.data.sessionId,
      // Docked: the pane has no window of its own any more, so no display.
      display: null,
      note:
        'The page RELOADED back into the task window, so this is a fresh document: sessionStorage and in-memory state are gone and the detached window\'s handle is dead. Use the sessionId returned here from now on.',
    },
  };
}
