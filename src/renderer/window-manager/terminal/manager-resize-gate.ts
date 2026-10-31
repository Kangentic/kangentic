/**
 * Shared "manager-resize in progress" gate.
 *
 * The window manager's imperative resizers (TileSplitter seam-drag,
 * FootprintResizer, useWindowResize 8-handle, the Command Terminal panel's
 * edges) resize the frames' DOM boxes on every pointermove WITHOUT a store
 * write, so a window-hosted terminal's ResizeObserver fires per frame. Refitting
 * per frame sends a SIGWINCH per frame, and a full-screen TUI (Claude Code)
 * re-emits its whole banner + transcript frame on each SIGWINCH - stacking
 * duplicate banners in the PTY scrollback.
 *
 * A resizer opens a gesture on the gate for the duration of its drag. While any
 * gesture is open the terminal suppresses its per-frame ResizeObserver refit
 * (see `TerminalTab`), and `scheduleWindowTerminalResize` holds its ask
 * (`deferUntilManagerResizeEnds`); the last gesture to close sends the held one,
 * so a drag ends in one resize.
 *
 * The gate never trusts a resizer to close what it opened. Every terminal in a
 * window waits on it, so one gesture left open freezes all of their grids until
 * a reload: measured once, the task window grew to 1981px while its terminal
 * stayed at the 1483px grid it mounted at. A release can miss the element that
 * owns the drag (pointer capture lost, a throw in another handler on the same
 * element, the window losing focus mid-drag), so the gate watches the pointer
 * itself while a gesture is open. A gesture cannot outlive its button: the first
 * host pointer event that shows the primary button up (a move, an enter, a new
 * press of the same pointer, or a release no owner answered) abandons it, and so
 * does the window losing focus. Abandoning tells the owner first, so it commits
 * the drag as the user left it and resets its own state, then closes the
 * gesture. There is no timer: holding still mid-drag is a drag.
 *
 * A drag of the OS window's own edge shows the page no pointer at all, only a
 * resize event per frame, and it reached every window terminal unheld: measured,
 * a 40-step drag sent 40 PTY resizes to a maximized task window's terminal. So
 * the gate watches the window's resizes too. A resize that keeps coming (a second
 * within `WINDOW_RESIZE_SETTLE_MS` of the last) opens a gesture of its own, which
 * closes once the size has held that long, and the held refit goes out once. A
 * lone resize opens nothing and refits at once, as before: the OS maximizing or
 * restoring the window delivers one (measured in Electron 45). That gesture
 * belongs to no pointer, so the pointer checks
 * above pass it by; the window losing focus still ends it.
 */

import { traceTerminalRenderer } from '../../utils/terminal-grid-registry';

/** The `buttons` bit of the primary (left) mouse button. */
const PRIMARY_BUTTON = 1;

/**
 * The most two resizes of the OS window can be apart and still be one drag of
 * its edge, and how long the size must hold before that drag is over. Resizes
 * come once a frame while the edge moves.
 */
export const WINDOW_RESIZE_SETTLE_MS = 150;

/** An OS window drag's gesture belongs to no pointer the page sees. */
const WINDOW_RESIZE_POINTER_ID = -1;

/** One open drag's hold on the gate. */
export interface ManagerResizeGesture {
  /** Close this gesture. Safe to call more than once, and after the gate abandoned it. */
  end(): void;
}

export interface ManagerResizeGate {
  /**
   * Open a gesture for the drag `owner` runs with `pointerId`. `onAbandoned`
   * runs if the gate finds the button released before the owner closed it: the
   * owner commits its drag as it stands and forgets it.
   */
  begin(owner: string, pointerId: number, onAbandoned: () => void): ManagerResizeGesture;
  isInProgress(): boolean;
  /** Run `callback` once the last open gesture closes. A later call replaces an earlier one. */
  deferUntilEnds(callback: () => void): void;
  /** Stop watching the window: a module re-evaluation builds a gate of its own. */
  dispose(): void;
}

export interface ManagerResizeGateOptions {
  /**
   * Runs once a drag of the OS window's edge has ended and the held refit gone
   * out. The gate holds every terminal's observer refit meanwhile, and nothing
   * else asks a host outside the window manager (the bottom panel) again.
   */
  onWindowResizeEnd?: () => void;
}

interface OpenGesture {
  owner: string;
  pointerId: number;
  onAbandoned: () => void;
  open: boolean;
}

/** The pointer fields the gate reads; Node's test `Event` carries them as plain properties. */
interface PointerFields {
  pointerId?: number;
  buttons?: number;
  button?: number;
}

/**
 * A gate that watches `target` (the window) for the pointer while a gesture is
 * open. `trace` records opens and abandons, so a gesture that ever sticks again
 * names its owner in the terminal trace.
 */
export function createManagerResizeGate(
  target: EventTarget | null,
  trace: (event: string, detail: Record<string, unknown>) => void = () => {},
  options: ManagerResizeGateOptions = {},
): ManagerResizeGate {
  const gestures = new Set<OpenGesture>();
  let deferred: (() => void) | null = null;
  let listening = false;

  const close = (gesture: OpenGesture): void => {
    if (!gesture.open) return;
    gesture.open = false;
    gestures.delete(gesture);
    if (gestures.size > 0) return;
    stopListening();
    const callback = deferred;
    deferred = null;
    callback?.();
  };

  const abandon = (gesture: OpenGesture, reason: string): void => {
    if (!gesture.open) return;
    trace('manager-resize-abandoned', { owner: gesture.owner, reason });
    // An owner that fails to finish its drag still loses the gesture, and the
    // rest of the sweep still runs: a throw here would leave the gate open.
    try {
      gesture.onAbandoned();
    } catch (error) {
      console.error(`[manager-resize-gate] ${gesture.owner} failed to finish an abandoned drag`, error);
    }
    close(gesture);
  };

  /** Abandon every open gesture of `pointerId`, or every one when it is null. */
  const sweep = (reason: string, pointerId: number | null): void => {
    for (const gesture of Array.from(gestures)) {
      if (pointerId === null || gesture.pointerId === pointerId) abandon(gesture, reason);
    }
  };

  const primaryHeld = (pointer: PointerFields): boolean => ((pointer.buttons ?? 0) & PRIMARY_BUTTON) !== 0;

  // A move or an enter with the button up: it was released where no owner saw it.
  const onPointerWithoutButton = (event: Event): void => {
    const pointer = event as Event & PointerFields;
    if (!primaryHeld(pointer)) sweep(event.type, pointer.pointerId ?? null);
  };
  // A new press of the same pointer: the old one was released unseen, whatever the press holds now.
  // Runs in the capture phase, so it closes before a resizer opens the press's own gesture.
  const onPointerDown = (event: Event): void => {
    const pointer = event as Event & PointerFields;
    if (!primaryHeld(pointer) || pointer.button === 0) sweep(event.type, pointer.pointerId ?? null);
  };
  // A release normally closes its gesture in the owner's own handler. Look once
  // the event has finished dispatching, and abandon whatever no handler closed:
  // only the gestures open at the release. Input outranks the timer, which ran
  // 61ms late under a fast drag (measured), and by then the next press of the
  // same pointer had opened a gesture this release never ended.
  const onPointerRelease = (event: Event): void => {
    const pointerId = (event as Event & PointerFields).pointerId ?? null;
    const reason = event.type;
    const openAtRelease = Array.from(gestures).filter((gesture) => pointerId === null || gesture.pointerId === pointerId);
    if (openAtRelease.length === 0) return;
    setTimeout(() => {
      for (const gesture of openAtRelease) abandon(gesture, reason);
    }, 0);
  };
  const onBlur = (): void => sweep('blur', null);

  const startListening = (): void => {
    if (listening || !target) return;
    listening = true;
    target.addEventListener('pointermove', onPointerWithoutButton, true);
    target.addEventListener('pointerover', onPointerWithoutButton, true);
    target.addEventListener('pointerdown', onPointerDown, true);
    target.addEventListener('pointerup', onPointerRelease, true);
    target.addEventListener('pointercancel', onPointerRelease, true);
    target.addEventListener('blur', onBlur);
  };
  const stopListening = (): void => {
    if (!listening || !target) return;
    listening = false;
    target.removeEventListener('pointermove', onPointerWithoutButton, true);
    target.removeEventListener('pointerover', onPointerWithoutButton, true);
    target.removeEventListener('pointerdown', onPointerDown, true);
    target.removeEventListener('pointerup', onPointerRelease, true);
    target.removeEventListener('pointercancel', onPointerRelease, true);
    target.removeEventListener('blur', onBlur);
  };

  const begin = (owner: string, pointerId: number, onAbandoned: () => void): ManagerResizeGesture => {
    const gesture: OpenGesture = { owner, pointerId, onAbandoned, open: true };
    gestures.add(gesture);
    trace('manager-resize-begin', { owner, open: gestures.size });
    startListening();
    return { end: () => close(gesture) };
  };

  // The refit an OS window drag held, sent once the drag is over. A pointer
  // gesture still open (a seam, a window edge) holds it to that gesture's end,
  // as it holds every other refit; sent at once it refit the terminals mid-drag.
  const announceWindowResizeEnd = (): void => {
    if (gestures.size === 0) {
      options.onWindowResizeEnd?.();
      return;
    }
    const heldCallback = deferred;
    deferred = () => {
      heldCallback?.();
      options.onWindowResizeEnd?.();
    };
  };

  // The OS window's own edge (see the header).
  let lastWindowResizeAt = Number.NEGATIVE_INFINITY;
  let windowDrag: { gesture: ManagerResizeGesture; settle: ReturnType<typeof setTimeout> | null } | null = null;
  const finishWindowDrag = (): void => {
    const drag = windowDrag;
    if (!drag) return;
    windowDrag = null;
    if (drag.settle) clearTimeout(drag.settle);
    drag.gesture.end();
    // After the held refit, which the end above sent.
    queueMicrotask(announceWindowResizeEnd);
  };
  const onWindowResize = (): void => {
    const now = Date.now();
    const continuing = now - lastWindowResizeAt < WINDOW_RESIZE_SETTLE_MS;
    lastWindowResizeAt = now;
    if (!windowDrag) {
      if (!continuing) return;
      // Abandoned only by the window losing focus: the gate then closes the
      // gesture itself, so all that is left is the end's own work.
      const drag: { gesture: ManagerResizeGesture; settle: ReturnType<typeof setTimeout> | null } = {
        gesture: { end: () => {} },
        settle: null,
      };
      drag.gesture = begin('os-window', WINDOW_RESIZE_POINTER_ID, () => {
        if (windowDrag !== drag) return;
        windowDrag = null;
        if (drag.settle) clearTimeout(drag.settle);
        queueMicrotask(announceWindowResizeEnd);
      });
      windowDrag = drag;
    }
    if (windowDrag.settle) clearTimeout(windowDrag.settle);
    windowDrag.settle = setTimeout(finishWindowDrag, WINDOW_RESIZE_SETTLE_MS);
  };
  target?.addEventListener('resize', onWindowResize);

  return {
    begin,
    isInProgress() {
      return gestures.size > 0;
    },
    deferUntilEnds(callback) {
      deferred = callback;
    },
    dispose() {
      target?.removeEventListener('resize', onWindowResize);
      if (windowDrag?.settle) clearTimeout(windowDrag.settle);
      windowDrag = null;
      stopListening();
    },
  };
}

// hmr-safe: a re-evaluation builds a fresh gate with no open gesture, and the
// dispose below takes the old one's window listeners with it; the next size
// change asks again.
const gate = createManagerResizeGate(
  typeof window === 'undefined' ? null : window,
  (event, detail) => traceTerminalRenderer(null, event, detail),
  { onWindowResizeEnd: () => window.dispatchEvent(new Event('terminal-panel-resize')) },
);

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => gate.dispose());
}

export function beginManagerResize(owner: string, pointerId: number, onAbandoned: () => void): ManagerResizeGesture {
  return gate.begin(owner, pointerId, onAbandoned);
}

export function isManagerResizeInProgress(): boolean {
  return gate.isInProgress();
}

/** Run `callback` once the last open gesture ends. A later call replaces an earlier one. */
export function deferUntilManagerResizeEnds(callback: () => void): void {
  gate.deferUntilEnds(callback);
}
