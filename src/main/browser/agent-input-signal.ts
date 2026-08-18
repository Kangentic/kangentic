import type { WebContents } from 'electron';

/**
 * Announces to the renderer when an agent is driving a Browser pane's guest, so
 * the pane can put the user's keyboard focus back if Chromium moved it.
 *
 * WHY MAIN OWNS THIS. `Input.dispatchMouseEvent` lands a real synthesized
 * mousedown in the guest, and Blink answers by focusing the guest frame; the
 * browser process propagates that up until the embedder's `<webview>` element is
 * `document.activeElement` and the terminal the user was typing into is blurred.
 * The renderer cannot tell that apart from the user clicking into the page,
 * because a click into a guest is routed straight to the guest widget and never
 * produces a mousedown on the host document. Main, by contrast, is the ONLY
 * caller of `Input.*` and `Runtime.evaluate` (see
 * `.claude/rules/browser-automation-driver.md`), so it knows the interval
 * exactly. Deterministic beats heuristic here specifically because the failure is
 * silent and intermittent - the same class as
 * `.claude/rules/terminal-arrival-focus.md`.
 *
 * See `.claude/rules/agent-driven-focus.md`.
 */

/**
 * How many drives are in flight per guest webContents id.
 *
 * Refcounted rather than a boolean: two tool calls can overlap on one pane (a
 * `wait` polling while a `click` lands), and a boolean would let the first one to
 * finish end the guard while the second is still dispatching. Only the 0->1 and
 * 1->0 edges are announced, so an overlapping burst costs two pushes, not two per
 * call.
 */
const activeDriveDepthByGuestId = new Map<number, number>();

export type AgentInputSender = (guest: WebContents, active: boolean) => void;

let sendAgentInput: AgentInputSender | null = null;

/**
 * Wired once at startup from `src/main/index.ts`. Injected rather than imported
 * so this module (and `withGuest`, which calls into it on every tool call) stays
 * testable with no Electron window plumbing.
 *
 * Passing null detaches the sender, which is what makes the begin/end calls inert
 * in unit tests rather than something every test has to mock away.
 */
export function setAgentInputSender(sender: AgentInputSender | null): void {
  sendAgentInput = sender;
}

/**
 * How long a burst stays "still driving" after its last tool call ends.
 *
 * A BURST, not a call, is the unit the renderer must see. An agent drives a pane
 * with tool calls back to back - one measured run made ~1500 of them in 90
 * seconds - and announcing the end of each one made the pane hand the user's
 * focus back between every pair. Focus then oscillated between the guest and the
 * terminal roughly five times per round (measured: 810 trusted `focusin` events
 * on the terminal in one drive), and each restore opened a window in which the
 * NEXT call's keystrokes were delivered to whatever held focus - the user's
 * terminal - instead of the guest. That is how the agent's own text ended up in
 * a live shell, with the page input missing exactly those characters.
 *
 * Long enough to bridge the gap between consecutive calls (tens of
 * milliseconds), short enough that the user gets their focus back promptly once
 * the agent genuinely stops.
 */
const DRIVE_BURST_QUIET_MS = 400;

/** Pending end-of-burst announcements, so a new call can cancel one. */
const pendingBurstEndByGuestId = new Map<number, ReturnType<typeof setTimeout>>();

/** Announce that an agent has started driving this guest. Pairs with `endAgentInput`. */
export function beginAgentInput(guest: WebContents): void {
  // A call arriving inside the quiet window continues the SAME burst: cancel the
  // pending end rather than letting it fire and then re-announcing a new drive,
  // which is exactly the oscillation this exists to stop.
  const pendingEnd = pendingBurstEndByGuestId.get(guest.id);
  if (pendingEnd) {
    clearTimeout(pendingEnd);
    pendingBurstEndByGuestId.delete(guest.id);
  }

  const depth = (activeDriveDepthByGuestId.get(guest.id) ?? 0) + 1;
  activeDriveDepthByGuestId.set(guest.id, depth);
  // Announce only when nothing was in flight AND no burst was still open.
  if (depth === 1 && !openBurstGuestIds.has(guest.id)) {
    openBurstGuestIds.add(guest.id);
    sendAgentInput?.(guest, true);
  }
}

/** Guests whose burst the renderer currently believes is open. */
const openBurstGuestIds = new Set<number>();

/**
 * Announce that an agent has finished driving this guest.
 *
 * Callers put this in a `finally`, so it runs for a throwing tool too. An
 * unmatched call (no live drive) is a no-op rather than a negative depth, since a
 * guard that never ends is worse than one that ends early.
 */
export function endAgentInput(guest: WebContents): void {
  const depth = activeDriveDepthByGuestId.get(guest.id);
  if (!depth) return;
  if (depth > 1) {
    activeDriveDepthByGuestId.set(guest.id, depth - 1);
    return;
  }
  activeDriveDepthByGuestId.delete(guest.id);

  // Do NOT announce the end yet. The next tool call is typically tens of
  // milliseconds away, and telling the pane the drive is over between every pair
  // is what made focus oscillate and delivered the agent's keystrokes into the
  // user's terminal. The announcement waits for the burst to go quiet, and
  // `beginAgentInput` cancels it if another call arrives first.
  const existingTimer = pendingBurstEndByGuestId.get(guest.id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    pendingBurstEndByGuestId.delete(guest.id);
    // A drive that started while this was pending owns the guest now.
    if ((activeDriveDepthByGuestId.get(guest.id) ?? 0) > 0) return;
    openBurstGuestIds.delete(guest.id);
    sendAgentInput?.(guest, false);
  }, DRIVE_BURST_QUIET_MS);
  // Never hold the process open for a diagnostic timer.
  timer.unref?.();
  pendingBurstEndByGuestId.set(guest.id, timer);
}

/**
 * True while an agent is driving this guest.
 *
 * This is what makes the user's own keystrokes identifiable. Validated on
 * Electron 41 with a positive control in the log itself: across a 120-round
 * drive (~3400 dispatched keys) the guest's `before-input-event` fired ZERO
 * times, while the user's own `Shift` and `Control` presses came through it. CDP
 * input does not travel that path, so an event arriving while this returns true
 * is the user's.
 */
export function isAgentDriving(guestId: number): boolean {
  // The whole BURST, including the quiet tail, not just a call in flight.
  //
  // The pane keeps the guest's focus until the burst is announced as over, so
  // between two calls the user's keystrokes still land in the page. Gating on
  // the in-flight call alone left exactly that window unguarded: measured at a
  // realistic agent cadence with the user typing, 11 of their ~62 keystrokes
  // reached the page instead of their terminal.
  if (openBurstGuestIds.has(guestId)) return true;
  return (activeDriveDepthByGuestId.get(guestId) ?? 0) > 0;
}


/** Test seam: drop all in-flight state. Never called by product code. */
export function resetAgentInputSignalForTests(): void {
  activeDriveDepthByGuestId.clear();
  for (const timer of pendingBurstEndByGuestId.values()) clearTimeout(timer);
  pendingBurstEndByGuestId.clear();
  openBurstGuestIds.clear();
  sendAgentInput = null;
}

/** The quiet window, exported so tests advance exactly past it rather than
 *  hardcoding a duplicate of the constant. */
export const AGENT_INPUT_BURST_QUIET_MS = DRIVE_BURST_QUIET_MS;
