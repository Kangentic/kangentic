/**
 * Freeze, draw, swap: a layout change that resizes terminals shows nothing until
 * every terminal it resized has its agent's new frame drawn, then shows the
 * finished layout in one paint.
 *
 * A terminal whose grid changes shows its old frame on the new grid until the
 * agent repaints, 98 to 181 ms after the PTY resize (`terminal-repaint-wait.ts`).
 * Covering that with the terminal's own pixels read as three stages: the old
 * frame pinned in a pane that had already grown, a crossfade, the new frame. So
 * the change runs inside an element-scoped View Transition
 * (`element.startViewTransition`, Chromium 147 and later): the scope keeps
 * showing its last frame while the update callback runs, everything outside it
 * keeps drawing, and a shield takes the pointer over it. The callback commits the
 * change (`flushSync`), lets every terminal under the scope refit and send its
 * PTY resize at once, waits for their repaints, and returns; the browser then
 * shows the new state, and the default crossfade is finished on the spot so the
 * swap is a cut.
 *
 * Measured in Playwright's Chromium through CDP's screencast (the compositor's
 * own frames; Electron's `capturePage` forces a fresh frame and does not see the
 * hold): the old frame stayed on screen through a 1.5 s callback, text printed
 * into the terminal during it showed in the first frame after, and no frame
 * blended the two. The callback starts a frame or two after the call. The
 * browser abandons a callback that runs 4 s, far past this cap.
 *
 * Nothing is copied: no pixel readback, no screenshot, no buffer kept per frame.
 * Outside a transition a terminal refits exactly as it always has.
 */

import { flushSync } from 'react-dom';
import { traceTerminalRenderer } from './terminal-grid-registry';

/** A transition shows its result by this long after it started, whatever the terminals do. */
export const LAYOUT_TRANSITION_CAP_MS = 700;
/**
 * The latest a transition is torn down, whether or not the browser ever
 * reports it finished: the shield and the scope's attribute go, and the
 * browser's transition is skipped. Chromium finishes a scoped transition about
 * 300 ms after it shows the new state (measured with the crossfade left in), so
 * this only fires if that ever stops being true; a shield left up would take
 * every click on the panel.
 */
export const LAYOUT_TRANSITION_WATCHDOG_MS = LAYOUT_TRANSITION_CAP_MS + 1000;
/**
 * Set on the scope while a transition is open (tests and tracing read it):
 * `open` while the scope is frozen, `shown` once the new state is on screen,
 * and gone when the browser has finished the transition.
 */
export const LAYOUT_TRANSITION_ATTRIBUTE = 'data-terminal-layout-transition';
/**
 * Marks an element a layout change freezes: a window layer's overlay, the
 * Command Terminal panel area (its rail changes with its terminals), the bottom
 * panel. A change finds its scope from any element inside (`terminalLayoutScopeOf`).
 */
export const LAYOUT_SCOPE_ATTRIBUTE = 'data-terminal-layout-scope';

/** The scope a layout change at `element` freezes: the nearest marked ancestor. */
export function terminalLayoutScopeOf(element: Element | null | undefined): HTMLElement | null {
  return element?.closest<HTMLElement>(`[${LAYOUT_SCOPE_ATTRIBUTE}]`) ?? null;
}

interface ViewTransitionHandle {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition?: () => void;
}

type ScopedTransitionStart = (update: () => Promise<void>) => ViewTransitionHandle;

interface OpenTransition {
  scope: HTMLElement;
  /** Takes the pointer over the frozen scope, whose live, unseen layout would otherwise receive it. */
  shield: HTMLElement;
  startedAt: number;
  /** Changes waiting for the update callback, which starts a frame or two after the call. */
  queued: Array<() => void>;
  /** The update callback has started: the old frame is captured, and a change now runs at once. */
  updating: boolean;
  repaints: Set<Promise<void>>;
  /** Bumped by every change and every repaint wait, so the settle loop can see a quiet frame. */
  activity: number;
  /** Set by the first of `finished` and the watchdog to end it; the other finds nothing to do. */
  ended: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

/** What a terminal inside an open transition reports to it. */
export interface TerminalLayoutTransition {
  /** The terminal's grid is changing; the transition holds until `repaint` settles. */
  awaitRepaint(repaint: Promise<void>): void;
}

// hmr-safe: a re-evaluation forgets transitions in flight; each still ends on
// its own (the browser ends the old one), and a terminal outside any refits as usual.
const openTransitions = new Map<HTMLElement, OpenTransition>();

function scopedTransitionStart(scope: HTMLElement): ScopedTransitionStart | null {
  const start = (scope as HTMLElement & { startViewTransition?: unknown }).startViewTransition;
  return typeof start === 'function' ? (start as ScopedTransitionStart).bind(scope) : null;
}

function runQueued(transition: OpenTransition): void {
  while (transition.queued.length > 0) {
    const change = transition.queued.shift();
    try {
      if (change) flushSync(change);
    } catch (error) {
      console.error('[terminal-layout-transition] a layout change failed', error);
    }
  }
}

/** The next frame, or 50 ms in a window that draws none (a hidden one stops its frames). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    });
  });
}

/**
 * How many frames in a row the scope must sit still before its new state is
 * shown. One was not enough: a change reaches its terminals in hops a frame
 * apart (the Command Terminal panel's box, then the layer's container-size
 * observer, then the windows, then each terminal's own observer), and React
 * lands a hop started from an observer in a task of its own. With one quiet
 * frame the swap showed the maximized panel with its terminals still at the old
 * size, one frame before they grew (measured: the cut at 2560x1364 with both
 * terminals at 741x864, and 1153x1231 a frame later).
 */
const SETTLED_FRAMES = 2;

/**
 * The boxes of every terminal pane under the scope and of each terminal's drawn
 * grid. A pane that has resized but whose terminal has not refit yet, or a grid
 * that just refit, changes it. Read once a frame while a transition is open; the
 * layout it forces is dirty anyway.
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
 * Hold until `SETTLED_FRAMES` frames in a row pass with no new change or repaint
 * wait, none pending, and no terminal pane or grid under the scope moving, or
 * until the cap.
 */
async function settle(transition: OpenTransition): Promise<void> {
  const deadline = transition.startedAt + LAYOUT_TRANSITION_CAP_MS;
  let seenActivity = -1;
  let seenLayout: string | null = null;
  let stillFrames = 0;
  for (;;) {
    await nextFrame();
    runQueued(transition);
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    if (transition.repaints.size > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        Promise.all(Array.from(transition.repaints)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      // The repaint is a change's last hop, so this moment is the baseline and
      // one still frame after it shows the drawn frames. A repaint can still start
      // another refit (a held grid answered, a second commit), which moves the
      // signature or the activity and puts the full rule back.
      seenActivity = transition.activity;
      seenLayout = layoutSignature(transition.scope);
      stillFrames = SETTLED_FRAMES - 1;
      continue;
    }
    const layout = layoutSignature(transition.scope);
    if (transition.activity === seenActivity && layout === seenLayout) {
      stillFrames += 1;
      if (stillFrames >= SETTLED_FRAMES) return;
    } else {
      stillFrames = 0;
    }
    seenActivity = transition.activity;
    seenLayout = layout;
  }
}

/** Finish the browser's default crossfade at once, so the swap is a cut. */
function cutToNewState(): void {
  for (const animation of document.getAnimations()) {
    const effect = animation.effect;
    if (effect instanceof KeyframeEffect && (effect.pseudoElement ?? '').startsWith('::view-transition')) {
      animation.finish();
    }
  }
}

/**
 * Under the frozen picture the new layout is already live, and a click goes to
 * it: a press aimed at what the user sees lands on what they cannot see yet
 * (measured: a press on the old rail stopped a terminal through the Running
 * row's Stop that Expand had just laid there). A transparent shield over the
 * scope's box, outside the scope so it is not frozen with it, takes the pointer
 * until the swap. It sits under no dismiss scope, so a press on it closes
 * nothing. Keys are untouched: typing still reaches the focused terminal and
 * shows after the swap.
 */
function raiseShield(scope: HTMLElement): HTMLElement {
  const box = scope.getBoundingClientRect();
  const shield = document.createElement('div');
  shield.setAttribute('data-terminal-layout-shield', '');
  shield.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`
    + 'z-index:2147483646;background:transparent';
  document.body.appendChild(shield);
  return shield;
}

function endTransition(transition: OpenTransition, reason: 'finished' | 'watchdog'): void {
  if (transition.ended) return;
  transition.ended = true;
  if (transition.watchdog) clearTimeout(transition.watchdog);
  // A callback the browser never ran still owes its changes.
  runQueued(transition);
  transition.shield.remove();
  if (openTransitions.get(transition.scope) === transition) openTransitions.delete(transition.scope);
  transition.scope.removeAttribute(LAYOUT_TRANSITION_ATTRIBUTE);
  traceTerminalRenderer(null, 'layout-transition-end', {
    durationMs: Math.round(performance.now() - transition.startedAt),
    reason,
  });
}

/**
 * Run a user's layout change that resizes terminals under `scope`, freezing the
 * scope until their new frames are drawn. Runs `change` exactly once. It runs at
 * once, with no freeze, when the browser has no scoped View Transitions, when
 * there is no scope, while a dialog is open in the scope (the browser's
 * transition-time `contain: layout` would move its fixed backdrop), and while the
 * window is hidden: nothing would show the freeze, and a hidden page draws no
 * frames and runs its timers about once a second, which held a freeze open for
 * up to 2.3 s (measured in Electron with the window covered). A change for
 * a scope that is already frozen joins that transition rather than starting a
 * second one, which would unfreeze the first partway through.
 *
 * A drag's release commits its result and ends its manager-resize gesture
 * inside `change`: ending it first would send the gesture's held refit before
 * the scope is frozen.
 *
 * Only a user's own gesture freezes: a restore, or a change an agent or main
 * starts, calls `change` directly, since a freeze holds the user's pointer.
 */
export function runTerminalLayoutChange(scope: HTMLElement | null, change: () => void): void {
  if (!scope || !scope.isConnected || document.visibilityState === 'hidden' || scope.querySelector('[data-base-dialog]')) {
    change();
    return;
  }
  const open = openTransitions.get(scope);
  if (open) {
    open.activity += 1;
    if (open.updating) {
      flushSync(change);
    } else {
      open.queued.push(change);
    }
    return;
  }
  const start = scopedTransitionStart(scope);
  if (!start) {
    change();
    return;
  }
  const transition: OpenTransition = {
    scope,
    shield: raiseShield(scope),
    startedAt: performance.now(),
    queued: [change],
    updating: false,
    repaints: new Set(),
    activity: 1,
    ended: false,
    watchdog: null,
  };
  openTransitions.set(scope, transition);
  scope.setAttribute(LAYOUT_TRANSITION_ATTRIBUTE, 'open');
  traceTerminalRenderer(null, 'layout-transition-begin', { scope: scope.dataset.testid ?? scope.tagName });
  let handle: ViewTransitionHandle;
  try {
    handle = start(async () => {
      transition.updating = true;
      runQueued(transition);
      await settle(transition);
    });
  } catch (error) {
    console.error('[terminal-layout-transition] could not start a view transition', error);
    endTransition(transition, 'finished');
    return;
  }
  handle.ready.then(() => {
    cutToNewState();
    // The new state is on screen from here, so a click aims at what it lands
    // on: the shield goes now rather than when the browser finishes, which a
    // terminal still drawing its frame can hold off for a while.
    transition.shield.remove();
    if (!transition.ended) scope.setAttribute(LAYOUT_TRANSITION_ATTRIBUTE, 'shown');
  }, (error: unknown) => {
    // A skipped transition shows the change as it lands. Worth knowing when it happens.
    const reason = error instanceof Error ? error.name : String(error);
    traceTerminalRenderer(null, 'layout-transition-skipped', { reason });
  });
  handle.finished.then(() => endTransition(transition, 'finished'), () => endTransition(transition, 'finished'));
  transition.watchdog = setTimeout(() => {
    if (transition.ended) return;
    try { handle.skipTransition?.(); } catch { /* the browser may have ended it already */ }
    endTransition(transition, 'watchdog');
  }, LAYOUT_TRANSITION_WATCHDOG_MS);
}

/** The open transition whose frozen scope holds `element` and is applying its change, or null. */
function transitionHolding(element: Element | null): OpenTransition | null {
  if (!element) return null;
  for (const transition of openTransitions.values()) {
    if (transition.updating && transition.scope.contains(element)) return transition;
  }
  return null;
}

/** Whether a layout change is being applied under a frozen scope that holds `element`. */
export function isTerminalLayoutTransitionOpenFor(element: Element | null): boolean {
  return transitionHolding(element) !== null;
}

/** The transition a terminal at `element` reports its refit to, or null outside one. */
export function terminalLayoutTransitionFor(element: Element | null): TerminalLayoutTransition | null {
  const transition = transitionHolding(element);
  if (!transition) return null;
  return {
    awaitRepaint(repaint) {
      if (transition.repaints.has(repaint)) return;
      transition.repaints.add(repaint);
      transition.activity += 1;
      void repaint.finally(() => transition.repaints.delete(repaint));
    },
  };
}
