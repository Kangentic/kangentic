import { BrowserWindow, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { browserPaneRegistry } from './browser-pane-registry';
import { browserPartitionForTask } from '../../shared/browser-partition';
import { syncJarFromIdentity } from './jar-seeder';

/**
 * Browser LANES: the OFFSCREEN form of a task's one browser surface.
 *
 * A task has exactly one browser surface. It is normally the visible `<webview>`
 * pane; a lane is what that surface falls back to when no pane can be mounted -
 * the user closed the task window, or the project is backgrounded and the board
 * layer renders only the open project's tasks. The agent never chooses a lane
 * and cannot ask for one.
 *
 * ## Why an agent cannot ask for one
 *
 * It could until 2026-09-21, through `kangentic_browser_open_pane { isolated:
 * true }`, and the argument for that was concurrency: several agents under one
 * task resolving to the same pane and interleaving navigations. It was removed
 * because the concurrency was never real and the cost was. Parallel callers
 * already contend for a single guest and are serialized by `guest-drive-queue`,
 * so four lanes bought a queue with four heads rather than four workers. Against
 * that: a lane sets no `browserGuestTasks` entry (only `BrowserPane.tsx` does,
 * on the guest's `dom-ready`), so nothing in the UI said one existed, the user
 * could not close it, and every supervision guard built for the pane - the veil,
 * the ring, the label, the pointer block - lives on the pane and reached none of
 * it. An agent completed a whole verification run in a lane with no browser
 * anywhere on screen. See `docs/embedded-browser.md`.
 *
 * What replaces it: the offscreen surface is now pushed to the renderer, so the
 * card globe and the header pill light up for it exactly as they do for a pane,
 * and opening the Browser pill converts it back into a visible pane.
 *
 * ## Why offscreen, and why that is safe here
 *
 * Chromium stops compositing a window that is minimized or fully occluded, and
 * `Page.captureScreenshot` then never resolves - which is why a hidden
 * `<webview>` is NOT a viable lane, and why `.claude/rules/retained-pane-never-
 * remounts.md` insists a background pane hide with `opacity: 0` only.
 *
 * Offscreen rendering is exempt by construction rather than by luck:
 * `initially_hidden` is set only in the NON-offscreen branch of Electron's
 * `electron_api_web_contents.cc`, and `OffScreenWebContentsView` declares no
 * visibility methods at all, so `show: false` never marks the WebContents
 * hidden and it keeps its own `ui::Compositor`.
 *
 * Measured on this build (Electron 41.1.1 / Chromium 146.0.7680.166) before
 * committing to it, because every one of these silently kills the design:
 *   - `isMinimized()` on a never-shown offscreen window is FALSE, so
 *     `withGuest`'s compositing precondition does not refuse every lane drive.
 *     (It resolves the lane window itself, since a lane guest has no
 *     `hostWebContents` - that was the specific risk.)
 *   - CDP `Page.captureScreenshot` RESOLVES against an offscreen target.
 *   - `Input.dispatchMouseEvent` and `mouseWheel` both work, and the page
 *     genuinely receives them (a click listener fired; the page scrolled).
 *     These are asymmetric with key events, so keys passing proves nothing.
 *   - Destroying one offscreen window leaves its siblings alive and driveable.
 *
 * ## Cost, and why it stays bounded
 *
 * Each lane is a renderer process, which is inherent to any isolation
 * substrate. The cost that actually bites is CPU: offscreen rendering copies a
 * FULL frame bitmap on every paint, so an animating page in a lane nobody is
 * watching would burn CPU at the default 60fps. Lanes therefore run at
 * `LANE_FRAME_RATE` and are created on demand and destroyed eagerly.
 *
 * Sandboxing was verified not to interfere: with `sandbox: true` a lane loads,
 * captures, and receives wheel input identically to an unsandboxed one, so the
 * hardened `webPreferences` below cost nothing.
 */

/**
 * Frames per second for a lane.
 *
 * Throttled because offscreen rendering copies a FULL frame bitmap on every
 * paint, so an animating page in a lane nobody is watching would otherwise burn
 * CPU at 60fps for no one.
 *
 * 10 rather than a lower floor, and the difference is measured, not guessed.
 * Wheel-driven scroll takes this long to land on Electron 41.1.1:
 *
 *   unthrottled  100ms
 *   10fps        100ms   <- no penalty at all
 *   2fps         300ms   <- 3x slower
 *
 * At 2fps a lane's input settles noticeably late, and an agent that scrolls and
 * then immediately screenshots captures the PRE-scroll frame - a silently wrong
 * answer, which is worse than a slow one. 10fps costs nothing on that axis and
 * is still a 6x saving over the default. Do not lower it without re-measuring
 * that table.
 *
 * Capture itself is unaffected: `Page.captureScreenshot` forces its own frame,
 * and an explicit `invalidate()` before capturing changed nothing (identical
 * byte counts at every frame rate tested).
 */
export const LANE_FRAME_RATE = 10;

/**
 * The viewport a lane starts at, and the one `kangentic_browser_set_viewport`
 * restores it to on reset.
 *
 * A desktop default, because a lane exists to verify the user's dev server and
 * a narrow one would silently put every check in a mobile breakpoint. These are
 * the numbers the page actually lays out against, measured: an offscreen window
 * has no frame, so `innerWidth` reads 1280x800 here.
 */
export const DEFAULT_LANE_WIDTH = 1280;
export const DEFAULT_LANE_HEIGHT = 800;

/**
 * How long a lane may go untouched before it is reclaimed.
 *
 * Generous, because reclaiming a lane an agent is merely pausing on would be
 * worse than holding a renderer process: the agent would come back to a page
 * that silently no longer exists. A drive of any kind refreshes it.
 */
export const LANE_IDLE_RECLAIM_MS = 30 * 60 * 1000;

interface LaneRecord {
  laneId: string;
  taskId: string;
  projectId: string;
  /** The session that owns this lane. Its end is what guarantees cleanup. */
  ownerSessionId: string | null;
  window: BrowserWindow;
  lastUsedAt: number;
}

const lanes = new Map<string, LaneRecord>();

/**
 * Bumped by every `destroyAllLanes()` sweep.
 *
 * `openLane` is async BEFORE it constructs its window (the jar seed), and a lane
 * only enters `lanes` after that. So a sweep landing in that gap finds nothing
 * to destroy, and the window is constructed immediately afterwards - outliving
 * the teardown that was meant to remove it.
 *
 * That is not a theoretical ordering. It is how the app ends up alive with no
 * main window: the surviving offscreen lane holds `getAllWindows()` above zero,
 * so `window-all-closed` never fires and `app.quit()` never runs on Windows or
 * Linux (it is gated on `platform !== 'darwin'`), and the process lingers
 * invisibly still holding the single-instance lock. Every relaunch then exits
 * at once (Sentry DESKTOP-J reached the crash through exactly this state).
 *
 * `openLane` captures this counter on entry and abandons once it changes, which
 * closes the gap for every await in the function rather than only today's.
 */
let laneSweepGeneration = 0;

/** Lane ids are prefixed so a handle is recognizable in a log or an error. */
const LANE_ID_PREFIX = 'lane_';

export function isLaneId(sessionId: string): boolean {
  return sessionId.startsWith(LANE_ID_PREFIX);
}

/** The task's offscreen surface, or null. At most one, by construction. */
export function laneIdForTask(taskId: string): string | null {
  for (const lane of lanes.values()) if (lane.taskId === taskId) return lane.laneId;
  return null;
}

/** True when this task's one surface is currently offscreen. */
export function hasLaneForTask(taskId: string): boolean {
  return laneIdForTask(taskId) !== null;
}

/**
 * Every task currently holding an offscreen surface.
 *
 * Read by the renderer push, which is what makes a lane VISIBLE in the UI: the
 * card globe and the task-detail Browser pill light up from it. Without that
 * push a lane is unseeable and unclosable, which is the bug that ended isolated
 * lanes (see the module docblock).
 */
export function laneTaskIds(): string[] {
  return [...new Set([...lanes.values()].map((lane) => lane.taskId))];
}

/**
 * Called after any change to the set of offscreen surfaces.
 *
 * Injected rather than imported: this module is constructed in unit tests with
 * no window plumbing, and a null listener makes the push inert. Same shape as
 * `setViewportOverrideSender`.
 */
let laneChangeListener: (() => void) | null = null;

export function setLaneChangeListener(listener: (() => void) | null): void {
  laneChangeListener = listener;
}

function announceLaneChange(): void {
  try {
    laneChangeListener?.();
  } catch (error) {
    console.warn('[browser-lane] lane-change listener failed:', error);
  }
}

/**
 * How long a lane's initial load may take before it is abandoned.
 *
 * Matches NAVIGATE_TIMEOUT_MS in `browser-pane-driver.ts` for the same reason:
 * `loadURL` resolves on load and rejects on failure, but a dev server that
 * accepts the connection and never responds leaves it pending forever. That is
 * the normal state of a build in progress, so an unbounded load here would hang
 * `kangentic_browser_open_pane`'s offscreen fallback with no way for the agent
 * to recover, and strand the fire-and-forget hand-off path silently.
 *
 * Not imported from the driver: `browser-pane-driver.ts` imports `touchLane`
 * from this module, so reaching back for `navigateGuest` would close an import
 * cycle.
 */
const LANE_LOAD_TIMEOUT_MS = 20_000;

/** Cap on the pre-attach jar seed, mirroring BrowserPane's own 3s bound: a
 *  stalled cookie sync degrades to an unseeded lane rather than hanging
 *  `kangentic_browser_open_pane` (the same failure shape LANE_LOAD_TIMEOUT_MS
 *  exists for). */
const JAR_SEED_TIMEOUT_MS = 3_000;

/** Load a lane's first URL, bounded. Abandons rather than cancels - Electron
 *  exposes no way to cancel an in-flight `loadURL` - which is fine here because
 *  the caller destroys the lane on failure. */
async function loadLaneUrl(guest: WebContents, url: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`it did not load within ${LANE_LOAD_TIMEOUT_MS / 1000}s. The dev server may be starting, unreachable, or hung.`)),
      LANE_LOAD_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([guest.loadURL(url), bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface OpenLaneInput {
  taskId: string;
  projectId: string;
  /** The caller's session, used only to scope cleanup. */
  ownerSessionId?: string;
  url: string;
}

export type OpenLaneResult =
  | { ok: true; laneId: string; webContents: WebContents }
  | { ok: false; kind: string; detail: string };

/**
 * Create an offscreen lane and register it so every existing browser tool can
 * target it by `sessionId`.
 */
export async function openLane(input: OpenLaneInput): Promise<OpenLaneResult> {
  // Captured before any await. See laneSweepGeneration: a sweep that lands while
  // this function is suspended must not be outlived by the window it is about to
  // build.
  const sweepGenerationAtEntry = laneSweepGeneration;

  // Reclaim abandoned lanes before counting, so a long-lived session that opened
  // and forgot lanes an hour ago is not refused a new one over renderer
  // processes nothing is using. Opportunistic on purpose - see destroyIdleLanes.
  destroyIdleLanes(LANE_IDLE_RECLAIM_MS);

  // ONE surface per task, enforced here rather than trusted to callers.
  //
  // Both callers check first (the hand-off through `hasLaneForTask`, the opener
  // by returning the existing surface), so this refusal is a structural
  // guarantee rather than a path anything reaches. It is what makes "open the
  // Browser pill and the surface becomes visible" well defined: with two
  // offscreen surfaces there is no answer to which one the pane becomes.
  const existingLaneId = laneIdForTask(input.taskId);
  if (existingLaneId) {
    return {
      ok: false,
      kind: 'surface-exists',
      detail:
        `This task already has a browser surface (${existingLaneId}). A task has exactly one. ` +
        'Drive it by passing that handle as sessionId, or omit sessionId and it resolves by default.',
    };
  }

  const laneId = `${LANE_ID_PREFIX}${randomUUID().slice(0, 8)}`;

  // Share the task's cookie jar rather than minting a fresh one. The jar is keyed
  // by task identity, so a lane inherits it automatically; isolation here is about
  // not fighting over a viewport, not credentials.
  const partition = browserPartitionForTask(input.projectId, input.taskId);

  // Log the jar a lane binds (main-side, since renderer console never persists).
  console.log(`[browser-lane] open lane=${laneId} task=${input.taskId.slice(0, 8)} partition=${partition}`);

  // Seed the shared (non-localhost) login into this jar before the offscreen
  // guest attaches, so an agent-opened lane inherits the user's project login the
  // same way a task's pane does. Best-effort and bounded; a hand-off lane
  // normally finds the pane's already-synced jar (same task partition), and
  // syncJarFromIdentity never rejects. See jar-seeder.ts.
  await new Promise<void>((resolve) => {
    const seedCap = setTimeout(resolve, JAR_SEED_TIMEOUT_MS);
    seedCap.unref?.();
    void syncJarFromIdentity(partition, input.projectId).finally(() => {
      clearTimeout(seedCap);
      resolve();
    });
  });

  // THE gap this guard exists for: the jar seed above suspended, and a sweep
  // (the main window closing, or app shutdown) ran while it did. `lanes` was
  // empty then, so the sweep had nothing to destroy - and constructing the
  // window now would leave an offscreen BrowserWindow nothing will ever clean
  // up, keeping the app alive with no visible window.
  if (sweepGenerationAtEntry !== laneSweepGeneration) {
    return {
      ok: false,
      kind: 'lane-swept',
      detail: 'The browser lanes were torn down while this one was opening (the window closed, or the app is quitting). Retry once: a sweep from a closed window is already over, but a quitting app will keep refusing.',
    };
  }

  const window = new BrowserWindow({
    show: false,
    // Says the two numbers below are the VIEWPORT rather than the outer
    // window. For an OFFSCREEN window that is already true - measured on
    // Electron 41, a lane built at 1280x800 reported `innerWidth` 1280x800
    // with and without this flag, because there is no frame to subtract - so
    // this changes no behavior today. It is here because `setViewport` resizes
    // a lane with `setContentSize`, and having the constructor and the resize
    // state the same units is what stops the two drifting if a lane ever stops
    // being offscreen.
    useContentSize: true,
    width: DEFAULT_LANE_WIDTH,
    height: DEFAULT_LANE_HEIGHT,
    webPreferences: {
      offscreen: true,
      partition,
      // A lane renders the user's own dev server, never Kangentic UI, so it gets
      // no preload and no node integration - the same posture the <webview>
      // guest has.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const guest = window.webContents;
  guest.setFrameRate(LANE_FRAME_RATE);

  const record: LaneRecord = {
    laneId,
    taskId: input.taskId,
    projectId: input.projectId,
    ownerSessionId: input.ownerSessionId ?? null,
    window,
    lastUsedAt: Date.now(),
  };
  lanes.set(laneId, record);

  // Self-heal if the guest dies for any reason we did not initiate.
  guest.once('destroyed', () => {
    lanes.delete(laneId);
    browserPaneRegistry.unregisterByWebContentsId(guest.id);
    announceLaneChange();
  });

  try {
    await loadLaneUrl(guest, input.url);
  } catch (error) {
    destroyLane(laneId);
    return {
      ok: false,
      kind: 'lane-load-failed',
      detail: `The lane could not load ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // The load above suspended too. A sweep during it DID find this lane (it
  // entered `lanes` before the load) and already destroyed the window, so
  // registering now would publish a handle to a dead guest for the registry to
  // self-heal away later.
  if (!lanes.has(laneId)) {
    return {
      ok: false,
      kind: 'lane-swept',
      detail: 'The browser lanes were torn down while this one was loading (the window closed, or the app is quitting). Retry once: a sweep from a closed window is already over, but a quitting app will keep refusing.',
    };
  }

  browserPaneRegistry.register({
    handle: laneId,
    ownerSessionId: input.ownerSessionId ?? null,
    taskId: input.taskId,
    projectId: input.projectId,
    webContentsId: guest.id,
    url: input.url,
    kind: 'lane',
  });

  // Only now: the surface is real, registered and driveable, so the card globe
  // and the Browser pill light up for something that exists.
  announceLaneChange();
  return { ok: true, laneId, webContents: guest };
}

export function touchLane(sessionId: string): void {
  const lane = lanes.get(sessionId);
  if (lane) lane.lastUsedAt = Date.now();
}

/**
 * The offscreen window backing a lane, for the one caller that must resize it.
 *
 * Exported rather than letting callers reach for
 * `BrowserWindow.fromWebContents(guest)`, which is wrong here in a way that
 * would not show up until it did: for a `<webview>` guest that call resolves
 * the HOST window, so a mis-dispatched pane would resize the user's main
 * Kangentic window. Going through the `lanes` map can only ever return a lane.
 */
export function laneWindow(laneId: string): BrowserWindow | null {
  const lane = lanes.get(laneId);
  if (!lane || lane.window.isDestroyed()) return null;
  return lane.window;
}

export function destroyLane(laneId: string): boolean {
  const lane = lanes.get(laneId);
  if (!lane) return false;
  lanes.delete(laneId);
  // Say it was a lane teardown, not a renderer unmount. A lane has no renderer,
  // so the default reason would point an investigation at the wrong process.
  browserPaneRegistry.unregister(laneId, 'lane-destroyed');
  if (!lane.window.isDestroyed()) lane.window.destroy();
  announceLaneChange();
  return true;
}

/**
 * Destroy every lane owned by a session.
 *
 * This is the GUARANTEE, not a nicety. A `SubagentStop` hook is a faster signal
 * where one exists, but only one of the ten supported agent CLIs has such a
 * hook, so lane cleanup cannot depend on it. Session end is a lifecycle every
 * agent goes through.
 */
export function destroyLanesForSession(sessionId: string): number {
  let destroyed = 0;
  for (const lane of [...lanes.values()]) {
    if (lane.ownerSessionId !== sessionId) continue;
    if (destroyLane(lane.laneId)) destroyed += 1;
  }
  return destroyed;
}

/**
 * Destroy the task's offscreen surface, because its visible pane is back.
 *
 * This is the RECLAIM: a task has one surface, so the moment a pane registers
 * for this task the offscreen form of that surface stops being the answer and
 * goes away. Two surfaces would make every implicit call ambiguous
 * (`multiple-panes`), and the visible one is always the better answer because
 * the user can see it.
 *
 * Mechanically a re-create rather than a move: a `webContents` cannot migrate
 * from a `BrowserWindow` into a `<webview>` tag, so the pane mounts fresh at
 * the offscreen surface's current URL and this destroys the old one. The
 * agent's old handle then answers `surface-gone` naming the replacement, which
 * is the same compromise `pop_out` and `dock` already make.
 */
export function destroyLanesForTask(taskId: string): number {
  let destroyed = 0;
  for (const lane of [...lanes.values()]) {
    if (lane.taskId !== taskId) continue;
    if (destroyLane(lane.laneId)) destroyed += 1;
  }
  return destroyed;
}

/**
 * Reclaim lanes no drive has touched for `idleMs`.
 *
 * Swept OPPORTUNISTICALLY, from `openLane`, rather than on an interval. A timer
 * would run for the life of the app to serve a subsystem most sessions never
 * touch, and the moment reclaim actually matters is the moment a new lane is
 * wanted - which is exactly when this runs. Sessions ending and app shutdown
 * remain the guarantees; this only stops a long-lived session that churns lanes
 * from holding renderer processes it stopped using.
 */
export function destroyIdleLanes(idleMs: number, now: number = Date.now()): number {
  let destroyed = 0;
  for (const lane of [...lanes.values()]) {
    if (now - lane.lastUsedAt < idleMs) continue;
    if (destroyLane(lane.laneId)) destroyed += 1;
  }
  return destroyed;
}

/**
 * Destroy every lane, synchronously.
 *
 * Runs from the `before-quit` path alongside `browserPaneRegistry.detachAll()`,
 * so it must stay synchronous - see `.claude/rules/synchronous-shutdown.md`.
 *
 * ALSO runs from the main window's `close`, where the app keeps running on
 * macOS - which is why it goes through `destroyLane` rather than clearing the
 * map itself. Clearing the map directly leaves a `kind: 'lane'` entry in the
 * registry pointing at a destroyed webContents, and that was only ever harmless
 * because `detachAll()` happens to run first on the quit path.
 *
 * Each destroy is isolated: this sits ahead of session preservation, PTY kill
 * and DB close in `syncShutdownCleanup`'s single try, so one throwing window
 * must not skip them.
 */
export function destroyAllLanes(): void {
  // First, so nothing added below can skip it. The position is not observable
  // today: this function is synchronous, the per-lane catch means the loop
  // always reaches the end, and destroying a lane cannot re-enter openLane (the
  // hand-off returns early on entry.kind === 'lane'). What it buys is future
  // proofing against an early return or an await added inside the loop, not
  // protection from a throwing destroy - the catch is what covers that.
  laneSweepGeneration++;
  for (const lane of [...lanes.values()]) {
    try {
      destroyLane(lane.laneId);
    } catch (error) {
      console.warn(`[browser-lane] Could not destroy lane ${lane.laneId}:`, error);
      lanes.delete(lane.laneId);
    }
  }
}

/** Test seam: drop bookkeeping without touching real windows. Resets the sweep
 *  counter too, so a test that sweeps cannot carry a generation into the next
 *  one. Nothing reads the counter's absolute value today, but leaving live
 *  module state behind is how order-dependent tests start. */
export function resetLanesForTests(): void {
  lanes.clear();
  laneSweepGeneration = 0;
  laneChangeListener = null;
}
