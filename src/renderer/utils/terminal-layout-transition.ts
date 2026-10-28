/**
 * The frame hold: a layout change that resizes terminals shows its new layout on
 * the next frame, and each terminal it resized holds its last frame, as drawn,
 * until the agent's frame at the new grid is in, then draws that frame once.
 *
 * A terminal whose grid changes shows its old frame reflowed onto the new grid,
 * then ConPTY's redraw of the old screen, then the agent's frame 126 to 155 ms
 * after the PTY resize in the desktop app (`terminal-repaint-wait.ts`): the
 * double paint this exists to remove. Freezing the whole scope until then hid it,
 * but held the window still for 180 ms after the click. So the change lands at
 * once, and for a few frames after it (the landing) every terminal under the
 * scope that refits holds its frame instead (`useTerminal`): xterm keeps its
 * grid, the PTY gets the new grid, and the agent's output is held. A frame that
 * still fills its new box (the box shrank) stays on screen, pinned to the
 * bottom where an agent keeps its input box; one that no longer fills it (the
 * box grew) is not drawn, so nothing shows in a place it will not stay. When the
 * agent's frame is in, xterm takes the new grid and draws the held output in the
 * gap between two frames, so the next frame painted is the agent's.
 *
 * Nothing is copied: no pixel readback, no screenshot, no buffer kept per frame.
 * Outside a landing a terminal refits exactly as it always has.
 */

import { traceTerminalRenderer } from './terminal-grid-registry';

/** A landing ends by this long after it started, however long its layout keeps moving. */
export const LAYOUT_LANDING_CAP_MS = 700;
/**
 * A landing stays open at least this long, however still its layout looks. A
 * refit this soon after a user's change is that change's.
 */
export const LAYOUT_LANDING_MIN_MS = 150;
/**
 * A landing no terminal has fitted in stays open this long. A change can reach
 * its terminals through a render React runs in a task of its own (the Command
 * Terminal panel's box, then the layer's observer re-tiling its windows, then
 * each terminal's own observer). On a loaded runner a terminal's fit came more
 * than 150 ms after the click: the landing had closed, and the panel's terminals
 * reflowed instead of holding their frames (4 of 6 runs on two cores). The
 * scope's boxes had moved by then, so a still layout does not show that the
 * terminals have heard of the change; their own fit does
 * (`noteTerminalFitInLanding`). A change that fits no terminal pays only this.
 */
export const LAYOUT_LANDING_IDLE_MS = 500;
/**
 * Marks an element a layout change lands in: a window layer's overlay, the
 * Command Terminal panel area (its rail changes with its terminals), the bottom
 * panel. A change finds its scope from any element inside (`terminalLayoutScopeOf`).
 */
export const LAYOUT_SCOPE_ATTRIBUTE = 'data-terminal-layout-scope';

/** The scope a layout change at `element` lands in: the nearest marked ancestor. */
export function terminalLayoutScopeOf(element: Element | null | undefined): HTMLElement | null {
  return element?.closest<HTMLElement>(`[${LAYOUT_SCOPE_ATTRIBUTE}]`) ?? null;
}

interface Landing {
  scope: HTMLElement;
  startedAt: number;
  /** How many terminal fits have landed in it (`noteTerminalFitInLanding`). */
  fits: number;
  /** Bumped by every change that joins the landing, so the settle loop can see a quiet frame. */
  activity: number;
}

// hmr-safe: a re-evaluation forgets landings in flight; a terminal outside one
// refits as usual, so a reset costs one change its frame hold.
const landings = new Map<HTMLElement, Landing>();

/**
 * The next frame, or 50 ms in a window that draws none (a hidden one stops its frames). Resolves
 * with that frame's start time, which every animation frame callback in the frame shares, or with
 * null when the 50 ms passed first and the caller resumed between frames.
 */
export function nextFrame(): Promise<number | null> {
  return new Promise((resolve) => {
    const fallback = setTimeout(() => resolve(null), 50);
    requestAnimationFrame((frameTime) => {
      clearTimeout(fallback);
      resolve(frameTime);
    });
  });
}

export interface HiddenFrameCount {
  /** Stop counting, with what `nextFrame` resolved with for the frame that shows the screen again. */
  finish(shownAt: number | null): number;
}

/**
 * Counts the frames that paint while a caller keeps something hidden, for the dev trace's
 * `framesHidden`. Start it as the thing is hidden and `finish` it as it is shown again.
 *
 * Each frame is counted from an animation frame callback, which runs before that frame paints, so
 * a counted frame painted hidden unless the caller showed the screen in the same frame. The frame
 * time tells the two apart: the show frame and the counter's callback share it when the counter
 * ran first. A show that came from `nextFrame`'s 50 ms fallback ran between frames and shares it
 * with none, so every frame counted painted hidden. An earlier count started at -1 and let the
 * show frame add the missing one, which left it a frame short on the fallback, the path a starved
 * runner takes.
 */
export function countHiddenFrames(): HiddenFrameCount {
  let frames = 0;
  let lastFrameTime: number | null = null;
  let counting = true;
  const onFrame = (frameTime: number): void => {
    if (!counting) return;
    frames += 1;
    lastFrameTime = frameTime;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  return {
    finish(shownAt) {
      counting = false;
      return frames - (shownAt !== null && shownAt === lastFrameTime ? 1 : 0);
    },
  };
}

/**
 * How many frames in a row the scope must sit still before its landing ends. A
 * change reaches its terminals in hops a frame apart (the Command Terminal
 * panel's box, then the layer's container-size observer, then the windows, then
 * each terminal's own observer), and React lands a hop started from an observer
 * in a task of its own. With one quiet frame the old freeze cut to the
 * maximized panel with its terminals still at the old size, one frame before
 * they grew (measured: the cut at 2560x1364 with both terminals at 741x864, and
 * 1153x1231 a frame later), so a terminal's last hop could land after it.
 */
const SETTLED_FRAMES = 2;

/**
 * The boxes of every terminal pane under the scope and of each terminal's drawn
 * grid. A pane that has resized but whose terminal has not refit yet, or a grid
 * that a hold just moved, changes it. Read once a frame while a landing is open;
 * the layout it forces is dirty anyway.
 */
function layoutSignature(scope: HTMLElement): string {
  let signature = '';
  for (const element of scope.querySelectorAll('[data-terminal-host], .xterm-screen')) {
    const box = element.getBoundingClientRect();
    signature += `${box.left},${box.top},${box.width},${box.height};`;
  }
  return signature;
}

/**
 * Hold the landing open for `LAYOUT_LANDING_MIN_MS`, then until `SETTLED_FRAMES`
 * frames pass with no change joining it and nothing under the scope moving, or
 * until the cap. Until a terminal has fitted in it, the landing stays open to
 * `LAYOUT_LANDING_IDLE_MS`, since the change's hop to that terminal may not have
 * run yet. Each fit restarts the count of still frames.
 */
async function settle(landing: Landing): Promise<void> {
  let seenActivity = -1;
  let seenLayout: string | null = null;
  let stillFrames = 0;
  for (;;) {
    await nextFrame();
    const elapsed = performance.now() - landing.startedAt;
    if (elapsed >= LAYOUT_LANDING_CAP_MS) return;
    const layout = layoutSignature(landing.scope);
    if (landing.activity === seenActivity && layout === seenLayout) {
      stillFrames += 1;
      if (stillFrames >= SETTLED_FRAMES && elapsed >= (landing.fits > 0 ? LAYOUT_LANDING_MIN_MS : LAYOUT_LANDING_IDLE_MS)) return;
    } else {
      stillFrames = 0;
    }
    seenActivity = landing.activity;
    seenLayout = layout;
  }
}

/**
 * Run a user's layout change that resizes terminals under `scope`. Runs `change`
 * exactly once, at once, and opens a landing on the scope: until its layout
 * holds still, a terminal under it that refits holds its frame rather than
 * reflowing it. A change for a scope with a landing open joins it.
 *
 * There is no landing when there is no scope, or while the window is hidden:
 * nothing would show the hold, and a hidden page draws no frames.
 *
 * Only a user's own gesture opens a landing: a restore, or a change an agent or
 * main starts, calls `change` directly.
 */
export function runTerminalLayoutChange(scope: HTMLElement | null, change: () => void): void {
  if (!scope || !scope.isConnected || document.visibilityState === 'hidden') {
    change();
    return;
  }
  const open = landings.get(scope);
  if (open) {
    open.activity += 1;
    change();
    return;
  }
  const landing: Landing = { scope, startedAt: performance.now(), fits: 0, activity: 1 };
  landings.set(scope, landing);
  traceTerminalRenderer(null, 'layout-landing-begin', { scope: scope.dataset.testid ?? scope.tagName });
  try {
    change();
  } finally {
    void settle(landing).then(() => {
      if (landings.get(scope) === landing) landings.delete(scope);
      traceTerminalRenderer(null, 'layout-landing-end', { durationMs: Math.round(performance.now() - landing.startedAt) });
    });
  }
}

/**
 * A terminal fitted while a landing was open in a scope that holds `element`:
 * the change has reached it. The landing can then end once its layout holds
 * still, instead of waiting out `LAYOUT_LANDING_IDLE_MS`.
 */
export function noteTerminalFitInLanding(element: Element | null): void {
  if (!element) return;
  for (const landing of landings.values()) {
    if (!landing.scope.contains(element)) continue;
    landing.fits += 1;
    landing.activity += 1;
  }
}

/** Whether a user's layout change is landing in a scope that holds `element`. */
export function isTerminalLayoutLandingFor(element: Element | null): boolean {
  if (!element) return false;
  for (const landing of landings.values()) {
    if (landing.scope.contains(element)) return true;
  }
  return false;
}
