/** A dnd-kit KeyboardSensor that arms only on keyboard-placed focus and lets go
 *  when the user's intent moves elsewhere.
 *
 *  The stock `KeyboardSensor` starts a drag on any Space or Enter that reaches a
 *  sortable node, and every sortable here is `tabindex="0"`, so a mouse press
 *  focuses it. A pointer drag leaves the card focused (dnd-kit swallows the
 *  post-drag click, so no window opens and nothing takes focus back), and the
 *  next Enter picks the card up. That drag then ends only on a keydown that
 *  reaches `document` or on a window resize / visibilitychange: clicks and focus
 *  moves do not end it, and xterm stops every key it consumes, so once the user
 *  clicks into a terminal the DragOverlay ghost is stuck until the window is
 *  covered. Measured on the dogfooding board: 8m48s.
 *
 *  Two changes, both in this class so the sites that register a keyboard sensor
 *  (six today, pinned by the unit test) cannot drift:
 *
 *  1. The activator refuses a node whose focus the pointer (or a script) placed.
 *     Focus origin is tracked here rather than read from `:focus-visible`,
 *     because Chromium flips its "had keyboard event" bit BEFORE it dispatches
 *     the keydown: measured on a card focused by a real press, `:focus-visible`
 *     read false before the key and true inside the very first capture
 *     listener of the Space that followed, so a `:focus-visible` gate would
 *     have let that pickup through. Only a Tab or arrow keydown arms the
 *     tracker: those are the keys whose DEFAULT action moves focus. A focus
 *     that follows any other key is a script (`BaseDialog`'s `trapFocus`
 *     restores the opener on close, so Enter to confirm a dialog over a
 *     mouse-focused card hands focus straight back to the card), and a script
 *     focus must not arm a drag.
 *  2. A keyboard drag cancels on a pointer press anywhere or on focus landing
 *     outside the dragged node (a terminal taking focus is the case that
 *     shipped). dnd-kit has no imperative cancel and a synthetic Escape would
 *     reach every other Escape listener in the app, so the subclass calls the
 *     sensor's own `onCancel` after detaching the base listeners.
 *
 *  The `keydown` listener below is not an app shortcut. It records that a
 *  focus-moving key is in flight, and it consumes Escape only while a keyboard
 *  drag is in flight: the transient in-gesture cancel that
 *  `keybindings-registry.md` already exempts for `useWindowDrag` and
 *  BrowserPane's Inspect. See `.claude/rules/keyboard-drag-intent.md`.
 */

import type React from 'react';
import { KeyboardSensor } from '@dnd-kit/core';
import type { Activators, KeyboardSensorOptions, KeyboardSensorProps } from '@dnd-kit/core';

// ---------------------------------------------------------------------------
// Focus-origin tracking, as a pure reducer so the unit tier can drive it.
// ---------------------------------------------------------------------------

export interface FocusOriginState {
  /** A Tab or arrow keydown is in flight: a focusin inside its task was placed
   *  by that key's default action. Cleared by a macrotask, never a microtask,
   *  because the browser moves focus AFTER the keydown listeners have run and
   *  their microtasks have drained. */
  keyboardMovePending: boolean;
  /** The element whose CURRENT focus the keyboard placed, or null when the
   *  pointer or a script did. */
  keyboardFocused: EventTarget | null;
}

export type FocusOriginEvent =
  | { type: 'keydown'; key: string }
  | { type: 'pending-expired' }
  | { type: 'focusin'; target: EventTarget | null }
  | { type: 'pointerdown' };

export const INITIAL_FOCUS_ORIGIN: FocusOriginState = {
  keyboardMovePending: false,
  keyboardFocused: null,
};

/** The keys whose default action moves focus (Tab, and the arrows inside a
 *  roving-tabindex composite). Everything else that moves focus is a script. */
export function movesFocusByDefault(key: string): boolean {
  return key === 'Tab' || key.startsWith('Arrow');
}

export function nextFocusOrigin(state: FocusOriginState, event: FocusOriginEvent): FocusOriginState {
  switch (event.type) {
    case 'keydown':
      return movesFocusByDefault(event.key) ? { ...state, keyboardMovePending: true } : state;
    case 'pending-expired':
      return { ...state, keyboardMovePending: false };
    case 'focusin':
      if (state.keyboardMovePending) return { ...state, keyboardFocused: event.target };
      // Chromium re-fires focusin on the same element when the window regains
      // focus (alt-tab back), with no key involved. That is not a new placement,
      // so a keyboard-placed focus survives it.
      if (event.target === state.keyboardFocused) return state;
      return { ...state, keyboardFocused: null };
    case 'pointerdown':
      // A press on the already-focused node re-asserts it as pointer-placed
      // (no focusin follows, so nothing else would record that), and a press
      // anywhere else is followed by a focusin that decides afresh.
      return { ...state, keyboardFocused: null };
  }
}

// hmr-safe: transient focus classification; the next Tab or focusin re-derives it, and the re-keyed DndContext re-runs setup.
let focusOrigin: FocusOriginState = INITIAL_FOCUS_ORIGIN;
// hmr-safe: the DndContexts that hold the tracker; each re-keyed context tears down and sets up again.
let trackerConsumers = 0;
// hmr-safe: a 0ms timer; the old module's teardown clears its own.
let pendingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
// hmr-safe: the old module's listeners are removed by the old context's teardown, which closes over this.
let uninstallTracker: (() => void) | null = null;

/** The keyboard drag in flight, if any. Registered by the sensor's constructor
 *  and released on every exit path (the wrapped onEnd / onCancel), so the
 *  tracker's Escape handler below knows whether there is a gesture to cancel.
 *  `dispose` is the exit with no DndContext to tell: a context that unmounts
 *  mid-drag fires no dragEnd / dragCancel, and its sensor's document listeners
 *  would otherwise outlive it. */
interface ActiveKeyboardDrag {
  cancel(): void;
  dispose(): void;
  cancelCodes: readonly string[];
  isAimedAt(target: EventTarget | null): boolean;
}
// hmr-safe: a re-keyed DndContext drops the drag with it; nothing outlives the old module's instance.
let activeKeyboardDrag: ActiveKeyboardDrag | null = null;

function dispatchFocusOrigin(event: FocusOriginEvent): void {
  focusOrigin = nextFocusOrigin(focusOrigin, event);
}

function armPendingExpiry(): void {
  if (pendingExpiryTimer !== null) clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = setTimeout(() => {
    pendingExpiryTimer = null;
    dispatchFocusOrigin({ type: 'pending-expired' });
  }, 0);
}

function installTracker(): void {
  const onKeyDown = (event: KeyboardEvent) => {
    dispatchFocusOrigin({ type: 'keydown', key: event.key });
    if (focusOrigin.keyboardMovePending) armPendingExpiry();
    // The in-gesture Escape beats every dismissal the key would otherwise
    // reach, the shape `useWindowDrag` and BrowserPane's Inspect cancel already
    // use (keybindings-registry.md). BaseDialog and the settings panel dismiss on
    // a bubble-phase document Escape; PrioritiesPopover and the combobox menus
    // dismiss on a CAPTURE-phase one registered when they open. This listener
    // is registered by `setup()`, which DndContext runs as a child effect of
    // whatever hosts it, so it is earlier in document's capture list than a
    // host's own listener and `stopImmediatePropagation` reaches it first. A
    // per-instance listener registered at pickup never could. Without this, the
    // Escape that cancelled a lifted Board Manager row also closed the Board
    // Manager under it. Consumed only when the key is aimed at the dragged node
    // (or at body, once a remount moved the node out from under focus); a
    // terminal's Escape is never touched, since focus entering the terminal
    // ended the drag already.
    const drag = activeKeyboardDrag;
    if (drag && drag.cancelCodes.includes(event.code) && drag.isAimedAt(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      drag.cancel();
    }
  };
  const onFocusIn = (event: FocusEvent) => dispatchFocusOrigin({ type: 'focusin', target: event.target });
  const onPointerDown = () => dispatchFocusOrigin({ type: 'pointerdown' });
  // Capture phase on document: the classification must be recorded before any
  // handler on the path (xterm stops propagation of the keys it consumes) and
  // before React's root listener runs the sortable's own onKeyDown activator.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  uninstallTracker = () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    if (pendingExpiryTimer !== null) clearTimeout(pendingExpiryTimer);
    pendingExpiryTimer = null;
    focusOrigin = INITIAL_FOCUS_ORIGIN;
    activeKeyboardDrag = null;
    uninstallTracker = null;
  };
}

function wasFocusedByKeyboard(node: EventTarget): boolean {
  return focusOrigin.keyboardFocused === node;
}

// ---------------------------------------------------------------------------
// The sensor.
// ---------------------------------------------------------------------------

/** The two private members of dnd-kit's KeyboardSensor the cancel path reaches.
 *  Both are `private` in its `.d.ts`, so this interface is the one cast target
 *  in the file (three sites reach it), and
 *  `tests/unit/intent-keyboard-sensor.test.ts` pins that they still exist. */
interface KeyboardSensorInternals {
  listeners: {
    add(eventName: string, handler: EventListener, options?: AddEventListenerOptions): void;
  };
  detach(): void;
}

function stockKeyDownActivator(): Activators<KeyboardSensorOptions>[number] {
  const activator = KeyboardSensor.activators.find((candidate) => candidate.eventName === 'onKeyDown');
  if (!activator) {
    throw new Error('IntentKeyboardSensor: @dnd-kit/core KeyboardSensor no longer declares an onKeyDown activator to delegate to.');
  }
  return activator;
}

export class IntentKeyboardSensor extends KeyboardSensor {
  // No instance fields, on purpose: dnd-kit's constructor assigns `props`,
  // `listeners`, `windowListeners` and `referenceCoordinates`, and a subclass
  // field initializer of the same name runs after `super()` and would clobber
  // the registry the cancel below relies on.

  static activators: Activators<KeyboardSensorOptions> = [
    {
      eventName: 'onKeyDown',
      handler: (event: React.KeyboardEvent, options, context) => {
        // The focused element must be the sortable node itself. Every site here
        // spreads the listeners on the node with no `setActivatorNodeRef`, so
        // the stock handler would also lift the card when a focusable CHILD
        // (a compact card's delete button) takes Space, and prevent the button's
        // own activation while doing it. The child keeps its key.
        if (event.target !== event.currentTarget) return false;
        if (!wasFocusedByKeyboard(event.currentTarget)) {
          // The stock handler swallowed Space as the pickup. Keep it inert on a
          // pointer-focused node rather than letting it page-scroll the lane.
          if (event.nativeEvent.code === 'Space') event.preventDefault();
          return false;
        }
        return stockKeyDownActivator().handler(event, options, context);
      },
    },
  ];

  /** DndContext runs this on mount and the returned teardown on unmount, once
   *  per sensor class, so the tracker lives exactly as long as a context using
   *  this sensor is mounted. Ref-counted: the board and the Board Manager
   *  dialog mount at the same time. */
  static setup(): () => void {
    trackerConsumers += 1;
    if (trackerConsumers === 1) installTracker();
    return () => {
      // A context that unmounts mid-drag (the Board Manager closed by its X
      // with a row lifted, a view switch with a card lifted) fires no
      // dragEnd / dragCancel. Without this the dead sensor kept its document
      // listeners AND its registration, and the next Escape on the board, aimed
      // at body where focus lands after a dialog closes, was swallowed by a
      // dialog the user had already closed. Disposing whatever is registered is
      // safe: one focus means one keyboard drag, and a live one in another
      // context would already have been cancelled by the focus move or the
      // press that unmounted this one.
      activeKeyboardDrag?.dispose();
      trackerConsumers -= 1;
      if (trackerConsumers === 0) uninstallTracker?.();
    };
  }

  constructor(props: KeyboardSensorProps) {
    // Checked before super() so a renamed internal fails before the drag has
    // started, rather than leaving one running with no way to cancel it.
    const prototype = KeyboardSensor.prototype as unknown as Partial<KeyboardSensorInternals>;
    if (typeof prototype.detach !== 'function') {
      throw new Error('IntentKeyboardSensor: @dnd-kit/core KeyboardSensor no longer has detach(); the cancel-on-intent path needs it.');
    }
    // Every exit path runs through onEnd or onCancel (a Space/Enter/Tab drop,
    // Escape, resize, visibilitychange, and the cancels below), so wrapping the
    // two is what lets the tracker's Escape handler know when there is no
    // longer a drag to cancel. `registration` is filled in after super().
    let registration: ActiveKeyboardDrag | null = null;
    const release = () => {
      if (registration !== null && activeKeyboardDrag === registration) activeKeyboardDrag = null;
    };
    super({
      ...props,
      onEnd: () => { release(); props.onEnd(); },
      onCancel: () => { release(); props.onCancel(); },
    });
    const internals = this as unknown as Partial<KeyboardSensorInternals>;
    const listeners = internals.listeners;
    if (!listeners || typeof listeners.add !== 'function') {
      throw new Error('IntentKeyboardSensor: @dnd-kit/core KeyboardSensor no longer keeps its document listeners in `listeners`; the cancel-on-intent path needs it.');
    }

    // detach() then onCancel(), not the base handleCancel(event): that calls
    // event.preventDefault(), and a prevented pointerdown suppresses the compat
    // mousedown, which is what focuses the terminal the user just clicked.
    // DndContext clears activeRef synchronously inside onCancel, so the same
    // press can go on to start a pointer drag on another card.
    // Detach and release, telling no one: the exit for a context that has
    // already unmounted (see setup's teardown).
    const dispose = () => {
      const sensor = this as unknown as KeyboardSensorInternals;
      sensor.detach();
      // dnd-kit attaches its own keydown listener on a 0ms timer after pickup.
      // Neither trigger below can fire inside that one task (the pickup moves
      // no focus and a press cannot land within it), but a cancel that did
      // would leave that late listener bound to this dead sensor, whose onEnd
      // reads the LIVE drag context and could drop a later drag. This timer
      // is queued after dnd-kit's, so it runs after the attach and clears it.
      setTimeout(() => sensor.detach(), 0);
      release();
    };
    const cancel = () => {
      dispose();
      props.onCancel();
    };
    const node = () => props.activeNode.node.current;
    registration = {
      cancel,
      dispose,
      cancelCodes: props.options.keyboardCodes?.cancel ?? ['Escape'],
      // The dragged node while it exists. Body counts only once the node is
      // gone (deleted mid-drag, so the ref reads null and focus fell to body);
      // body is also where focus lands after any dialog closes, and a live drag
      // must not claim an Escape from there. Read at event time: a card that
      // remounts in another lane mid-drag registers a new node under the ref.
      isAimedAt: (target) => {
        const current = node();
        if (current === null) return target === document.body;
        return target instanceof Node && current.contains(target);
      },
    };
    activeKeyboardDrag = registration;

    // Registered through the base's own registry so detach() removes them on
    // every exit path.
    listeners.add('pointerdown', cancel, { capture: true });
    listeners.add(
      'focusin',
      (event: Event) => {
        const current = node();
        if (current && event.target instanceof Node && current.contains(event.target)) return;
        cancel();
      },
      { capture: true },
    );
  }
}
