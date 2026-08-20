import { BrowserWindow, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { browserPaneRegistry } from './browser-pane-registry';
import { browserPartitionForWorktree } from '../../shared/browser-partition';

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

export interface OpenLaneInput {
  taskId: string;
  projectId: string;
  /** The caller's session, used only to scope cleanup. */
  ownerSessionId?: string;
  /** Worktree directory, so a lane shares the task's cookie jar. */
  cwd: string | null;
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

  // Share the task's cookie jar rather than minting a fresh one. Isolation here
  // is about not fighting over a viewport, not about credentials: a lane with
  // its own jar would land every subagent on a sign-in wall for an app the user
  // is already authenticated into.
  const partition = browserPartitionForWorktree(input.cwd);

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
    await guest.loadURL(input.url);
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

export function destroyLanesForTask(taskId: string): number {
  let destroyed = 0;
  for (const lane of [...lanes.values()]) {
    if (lane.taskId !== taskId) continue;
    if (destroyLane(lane.laneId)) destroyed += 1;
  }
  return destroyed;
}

/** Reclaim lanes no drive has touched for `idleMs`. */
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
 */
export function destroyAllLanes(): void {
  for (const lane of [...lanes.values()]) {
    lanes.delete(lane.laneId);
    if (!lane.window.isDestroyed()) lane.window.destroy();
  }
}

/** Test seam: drop bookkeeping without touching real windows. */
export function resetLanesForTests(): void {
  lanes.clear();
}
