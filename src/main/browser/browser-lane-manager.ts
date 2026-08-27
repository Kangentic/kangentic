import { BrowserWindow, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { browserPaneRegistry } from './browser-pane-registry';
import { browserPartitionForTask } from '../../shared/browser-partition';
import { syncJarFromIdentity } from './jar-seeder';

/**
 * Browser LANES: an isolated, offscreen browser surface per caller.
 *
 * The problem: several agents working under one task all resolved to that task's
 * single Browser pane and drove it at once, interleaving navigations, clicks and
 * screenshots while each believed it had exclusive control. Serializing the
 * drive (see `guest-drive-queue.ts`) stops the commands interleaving, but it
 * cannot stop caller A navigating away from the page caller B is midway through
 * verifying. Only separate surfaces do that.
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
 * Most lanes one task may hold at once.
 *
 * Bounded for the same reason `MAX_COMMAND_TERMINALS` is: each costs a renderer
 * process, and an agent that retries a failing open would otherwise walk the
 * count up until something else breaks.
 */
export const MAX_LANES_PER_TASK = 4;

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
  /**
   * True when main created this lane automatically to keep an agent's browser
   * alive after the user closed the task window (see `browser-lane-handoff.ts`),
   * rather than the agent asking for isolation.
   *
   * The distinction is load-bearing: a hand-off lane stands down as soon as the
   * user's own pane comes back, because two surfaces for one task would make
   * every implicit call ambiguous. A lane the agent deliberately requested is
   * its working surface and must never be closed out from under it.
   */
  handoff: boolean;
}

const lanes = new Map<string, LaneRecord>();

/** Lane ids are prefixed so a handle is recognizable in a log or an error. */
const LANE_ID_PREFIX = 'lane_';

export function isLaneId(sessionId: string): boolean {
  return sessionId.startsWith(LANE_ID_PREFIX);
}

export function laneCountForTask(taskId: string): number {
  let count = 0;
  for (const lane of lanes.values()) if (lane.taskId === taskId) count += 1;
  return count;
}

export function laneIdsForTask(taskId: string): string[] {
  return [...lanes.values()].filter((lane) => lane.taskId === taskId).map((lane) => lane.laneId);
}

/**
 * How long a lane's initial load may take before it is abandoned.
 *
 * Matches NAVIGATE_TIMEOUT_MS in `browser-pane-driver.ts` for the same reason:
 * `loadURL` resolves on load and rejects on failure, but a dev server that
 * accepts the connection and never responds leaves it pending forever. That is
 * the normal state of a build in progress, so an unbounded load here would hang
 * `kangentic_browser_open_pane { isolated: true }` with no way for the agent to
 * recover, and strand the fire-and-forget hand-off path silently.
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
  /** Created by the pane hand-off rather than requested by the agent. */
  handoff?: boolean;
}

export type OpenLaneResult =
  | { ok: true; laneId: string; webContents: WebContents }
  | { ok: false; kind: string; detail: string };

/**
 * Create an offscreen lane and register it so every existing browser tool can
 * target it by `sessionId`.
 */
export async function openLane(input: OpenLaneInput): Promise<OpenLaneResult> {
  // Reclaim abandoned lanes before counting, so a long-lived session that opened
  // and forgot lanes an hour ago is not refused a new one over renderer
  // processes nothing is using. Opportunistic on purpose - see destroyIdleLanes.
  destroyIdleLanes(LANE_IDLE_RECLAIM_MS);

  if (laneCountForTask(input.taskId) >= MAX_LANES_PER_TASK) {
    return {
      ok: false,
      kind: 'lane-limit',
      detail:
        `This task already holds ${MAX_LANES_PER_TASK} browser lanes, which is the limit. ` +
        'If you opened one earlier, reuse it by passing its sessionId rather than opening another: ' +
        `${laneIdsForTask(input.taskId).join(', ')}. ` +
        'Otherwise close one with kangentic_browser_close_pane.',
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

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
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
    handoff: input.handoff === true,
  };
  lanes.set(laneId, record);

  // Self-heal if the guest dies for any reason we did not initiate.
  guest.once('destroyed', () => {
    lanes.delete(laneId);
    browserPaneRegistry.unregisterByWebContentsId(guest.id);
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

  browserPaneRegistry.register({
    sessionId: laneId,
    taskId: input.taskId,
    projectId: input.projectId,
    webContentsId: guest.id,
    url: input.url,
    kind: 'lane',
  });

  return { ok: true, laneId, webContents: guest };
}

export function touchLane(sessionId: string): void {
  const lane = lanes.get(sessionId);
  if (lane) lane.lastUsedAt = Date.now();
}

export function destroyLane(laneId: string): boolean {
  const lane = lanes.get(laneId);
  if (!lane) return false;
  lanes.delete(laneId);
  // Say it was a lane teardown, not a renderer unmount. A lane has no renderer,
  // so the default reason would point an investigation at the wrong process.
  browserPaneRegistry.unregister(laneId, 'lane-destroyed');
  if (!lane.window.isDestroyed()) lane.window.destroy();
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

/** True when this task already has a hand-off lane standing in for its pane. */
export function hasHandoffLaneForTask(taskId: string): boolean {
  for (const lane of lanes.values()) {
    if (lane.taskId === taskId && lane.handoff) return true;
  }
  return false;
}

/**
 * Destroy only the AUTO-CREATED hand-off lanes for a task.
 *
 * Called when the user's own pane comes back. Never touches a lane the agent
 * asked for with `isolated: true`: that is its working surface, and closing it
 * because a human opened an unrelated pane would be the same class of bug this
 * whole task is about.
 */
export function destroyHandoffLanesForTask(taskId: string): number {
  let destroyed = 0;
  for (const lane of [...lanes.values()]) {
    if (lane.taskId !== taskId || !lane.handoff) continue;
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
  for (const lane of [...lanes.values()]) {
    try {
      destroyLane(lane.laneId);
    } catch (error) {
      console.warn(`[browser-lane] Could not destroy lane ${lane.laneId}:`, error);
      lanes.delete(lane.laneId);
    }
  }
}

/** Test seam: drop bookkeeping without touching real windows. */
export function resetLanesForTests(): void {
  lanes.clear();
}
