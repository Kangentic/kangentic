/**
 * The choreography player: plays a scene's `choreography` (tests/captures/scenes.ts) the way a
 * visitor's mouse would, inside the page.
 *
 * A browser gives a script no real pointer, so this one synthesizes the events a real one makes,
 * in the order a browser makes them. Each move hit-tests the point (`elementFromPoint`) and sends
 * the over, out, enter and leave transitions, then a pointermove and its compatibility mousemove; a
 * press sends pointerdown and mousedown, a release pointerup, mouseup and click. That one sequence
 * is what each of the renderer's gesture code reads: dnd-kit's PointerSensor (a primary pointer on
 * button 0, moves on the document), the window manager's title-bar drag (moves inside its frame),
 * React Flow's d3-drag (mouse events with a `view`), the board's link preview (a mouse
 * `pointerenter` and a dwell), and React's hover handlers (built from `pointerover`). A pointerdown
 * the page prevents suppresses the compatibility mouse events until the release, as a browser does.
 * The keyboard is simpler: typed text goes through a field's own value setter and an input event a
 * keystroke at a time, and a key goes to whatever has the focus. A hotkey is held and let go
 * through boot.js's own `__demoBoot.pressCombo`, the one a boot step's `press` uses.
 *
 * Three things a script cannot get from the browser, and what stands in for each:
 *  - `:hover`. Every same-origin `:hover` rule is copied under `[data-demo-hover]`, in the same
 *    parent rule so layer and media order hold, and the attribute is set on the element under the
 *    pointer and its ancestors. A stylesheet that loads later (the diff editor's) is mirrored when
 *    it arrives.
 *  - Pointer capture, which Firefox refuses a pointer it did not make (`installCaptureShim`).
 *  - The pointer itself. A live frame draws one, the product accent arrow, so a menu opening by
 *    itself reads as a visitor's click. It fades in when a cycle starts and out at rest, where it
 *    leaves the page so nothing stays hovered, and a still never draws it.
 *
 * The renderer knows none of this: nothing here is read by `src/renderer`, and the events are the
 * ones any mouse sends. Loaded on demand (demo/choreography-entry.ts), only by a scene that has a
 * choreography and is either a live frame under loop=1 or a still with a pose.
 */
import type { ChoreographyStep, ChoreographyTarget } from '../tests/captures/scenes';

interface Point { x: number; y: number }

export interface ChoreographyOptions {
  /** A still: the pose is played with no pacing and no pointer drawn, and nothing loops. */
  still: boolean;
  /** The scene's `focus`, the region whose form state the rest check reads; null reads the document. */
  focus: string | null;
  /** Whether the rest check compares the board's lanes. Off for a scene whose timeline moves cards on a session's clock. */
  compareLanes: boolean;
}

export interface ChoreographyPlayer {
  /**
   * Plays the steps up to the pose with no pacing and no pointer drawn: the still, and the live
   * frame's first frame. A visitor's own input then lets go of the held gesture, loop or no loop.
   */
  playToPose(): Promise<void>;
  /** Under loop=1: plays the cycle and returns to rest, again and again, until a visitor takes over. */
  startLoop(): void;
  /** A visitor took over before the loop started (boot.js saw their input while the player loaded): nothing plays. */
  stop(): void;
}

/** How long a step's target or its `waitFor` may take to appear before the choreography gives up. */
const STEP_TIMEOUT_MS = 10_000;
/** The pointer's travel between targets, and a drag's carry. */
const TRAVEL_MS = 550;
const DRAG_CARRY_MS = 900;
/** The frames a still spends on a travel: enough for a drag sensor to see movement, none of them timed. */
const STILL_TRAVEL_FRAMES = 8;
/** How long a press is held before its release, live. */
const PRESS_HOLD_MS = 90;
/** The beat between two keystrokes of a typed text, live. */
const KEYSTROKE_MS = 85;
/** Frames the pointer spends homing in on a target that is still moving once it has arrived (a layout animation), and how many still frames end that. */
const SETTLE_FRAMES = 45;
const SETTLED_FRAMES = 3;
/** Pacing after a step that names none. */
const DEFAULT_PACING_MS: Record<string, number> = {
  hover: 900, click: 900, contextmenu: 1200, drag: 900, drop: 900, type: 700, key: 500, choose: 1200, scroll: 700, hotkeyDown: 900, hotkeyUp: 900,
};
/** The rest a visitor sees before the first cycle, and between cycles. */
const FIRST_REST_MS = 2500;
const REST_BETWEEN_CYCLES_MS = 3500;
/**
 * A pose that holds the button down (a card carried over a column) is a hand mid-gesture, and a
 * hand lets go a beat after it reaches the target, never seconds later. So a held drag's pacing is
 * this beat, and a cycle that ends holding one goes straight on to its drop.
 */
const HELD_DRAG_BEAT_MS = 500;
/** A cut's fade each way, and the frames the reset behind it is given to paint before the frame shows again. */
const CUT_FADE_MS = 450;
const CUT_SETTLE_FRAMES = 6;
/** A drag sensor's activation distance is 4 or 5 px; a press then moves past it before the carry. */
const DRAG_ACTIVATION_OFFSET: Point = { x: 10, y: 4 };
/** Where the pointer appears, relative to its first target, so a cycle opens with a visible travel. */
const ENTRY_OFFSET: Point = { x: 140, y: 90 };
const HOVER_ATTRIBUTE = 'data-demo-hover';
/**
 * Stamped on what is checked, selected or pressed when the rest is read, so a step can name the
 * option the frame opened on as a selector (`[data-demo-rest]`), which the scene cannot know: the
 * theme a host passes, for one.
 */
const REST_ATTRIBUTE = 'data-demo-rest';
/** The exit classes useOverlayPhase puts on a dialog, popover, panel or Command Terminal that is closing. */
const CLOSING_LAYER = '.overlay-content-out, .overlay-popover-out, .overlay-panel-out, .overlay-command-bar-out';
/** Surfaces whose own fields are not a form the rest check reads: a terminal and the diff editor. */
const EDITOR_SURFACES = '.xterm, .monaco-editor';
/** One pointer, the mouse. Chromium and WebKit keep pointer id 1 for it. */
const POINTER_ID = 1;

/**
 * Pointer capture, for a pointer the browser did not make. The window manager captures the pointer
 * a drag's pointerdown reported (`setPointerCapture` in useWindowDrag.ts) and then reads the moves
 * and the release from its own frame, wherever the pointer is. No browser captures a pointer that
 * is not pressed for real: Chromium and WebKit ignore the call, and Firefox throws NotFoundError for
 * every id until real input has reached the page (a site frame is `inert`, so none ever does). So
 * for the synthetic pointer's id the capture is kept here instead: the call never throws, the
 * element is recorded, `hasPointerCapture` reports it, and the player sends that pointer's events
 * to it until it is released or the button comes up, as a browser does for a captured pointer. It
 * acts only while the synthetic pointer is pressed; any other call, a visitor's own included, goes
 * straight through to the browser.
 */
let capturedBy: Element | null = null;
let syntheticPressed = false;
let captureShimInstalled = false;
function installCaptureShim(): void {
  if (captureShimInstalled) return;
  captureShimInstalled = true;
  const prototype = Element.prototype;
  const setCapture = prototype.setPointerCapture;
  const releaseCapture = prototype.releasePointerCapture;
  const hasCapture = prototype.hasPointerCapture;
  prototype.setPointerCapture = function (this: Element, pointerId: number): void {
    if (pointerId !== POINTER_ID || !syntheticPressed) {
      setCapture.call(this, pointerId);
      return;
    }
    try {
      setCapture.call(this, pointerId);
    } catch {
      // Firefox's refusal; the capture is kept below either way.
    }
    capturedBy = this;
  };
  prototype.releasePointerCapture = function (this: Element, pointerId: number): void {
    if (pointerId !== POINTER_ID || capturedBy !== this) {
      releaseCapture.call(this, pointerId);
      return;
    }
    try {
      releaseCapture.call(this, pointerId);
    } catch {
      // As above.
    }
    capturedBy = null;
  };
  prototype.hasPointerCapture = function (this: Element, pointerId: number): boolean {
    return hasCapture.call(this, pointerId) || (pointerId === POINTER_ID && capturedBy === this);
  };
}

/** The element the synthetic pointer is captured to, while it is still in the document. */
function captureTarget(): Element | null {
  return capturedBy && capturedBy.isConnected ? capturedBy : null;
}

declare global {
  interface Window {
    /** A test's pacing divisor (set by an init script). Never read from the URL. */
    __demoChoreographyRate?: number;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function easeInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

/** Wait, frame by frame, for a selector to match; a frame loop arms no timer, so a still can use it. */
async function waitForElement(selector: string): Promise<Element> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const element = document.querySelector(selector);
    if (element) return element;
    if (Date.now() > deadline) throw new Error(`the choreography waited ${STEP_TIMEOUT_MS / 1000}s for ${selector}`);
    await nextFrame();
  }
}

function centreOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The overflow values a visitor's wheel scrolls. A `hidden` box scrolls only from a script. */
const WHEEL_SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);

/**
 * The box a wheel over the element scrolls on one axis: the nearest ancestor whose overflow on that
 * axis lets a visitor scroll it and whose content overflows it there. Null when none does.
 */
function scrollContainerOf(element: Element, axis: 'vertical' | 'horizontal'): Element | null {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const scrolls = axis === 'vertical'
      ? WHEEL_SCROLLABLE.has(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight
      : WHEEL_SCROLLABLE.has(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
    if (scrolls) return ancestor;
  }
  return null;
}

/** Where a scroll container's content shows, in viewport coordinates, inside its borders and scrollbars. */
function visibleBoxOf(scroller: Element): { top: number; left: number; width: number; height: number } {
  // The frame's own viewport: its root's rect is the whole document, which moves as it scrolls.
  if (scroller === document.scrollingElement) return { top: 0, left: 0, width: scroller.clientWidth, height: scroller.clientHeight };
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top + scroller.clientTop, left: rect.left + scroller.clientLeft, width: scroller.clientWidth, height: scroller.clientHeight };
}

/**
 * How far to scroll so a span shows in a box, as `scrollIntoView`'s `nearest` does: nothing when it
 * shows already or covers the box, else the least distance, which brings in the edge that is out
 * when the span fits and the other edge when it does not. Exported for its unit test.
 */
export function nearestOffset(start: number, end: number, boxStart: number, boxEnd: number): number {
  if ((start >= boxStart && end <= boxEnd) || (start < boxStart && end > boxEnd)) return 0;
  const fits = end - start <= boxEnd - boxStart;
  const startIsOut = start < boxStart;
  if (fits) return startIsOut ? start - boxStart : end - boxEnd;
  return startIsOut ? end - boxEnd : start - boxStart;
}

/**
 * Scroll an element to the middle of the boxes a wheel over it would scroll, and nothing else:
 * centred vertically, and horizontally moved the least distance that shows it. Never
 * `scrollIntoView`, which scrolls every box above the element, `overflow: hidden` ones too, and in
 * an embedded frame carries on through the iframe into the page embedding it, so that page moved
 * under its reader with no input.
 */
function scrollIntoMiddle(element: Element, behavior: ScrollBehavior): void {
  // Measured once, before either axis moves.
  const rect = element.getBoundingClientRect();
  const vertical = scrollContainerOf(element, 'vertical');
  const horizontal = scrollContainerOf(element, 'horizontal');
  let top = 0;
  let left = 0;
  if (vertical) {
    const box = visibleBoxOf(vertical);
    top = vertical.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2;
  }
  if (horizontal) {
    const box = visibleBoxOf(horizontal);
    left = horizontal.scrollLeft + nearestOffset(rect.left, rect.right, box.left, box.left + box.width);
  }
  // One call for one box: a second smooth scroll on an element cancels the first one's animation.
  if (vertical && vertical === horizontal) {
    vertical.scrollTo({ top, left, behavior });
    return;
  }
  vertical?.scrollTo({ top, behavior });
  horizontal?.scrollTo({ left, behavior });
}

async function resolveTarget(target: ChoreographyTarget): Promise<Point> {
  if (typeof target !== 'string') return { x: target.x * window.innerWidth, y: target.y * window.innerHeight };
  return centreOf(await waitForElement(target));
}

/**
 * A target's centre as it is now, measured again on every call, so the pointer follows an element
 * a layout animation is still moving (a group collapsing above it, a popover sliding in). An
 * element that is replaced is found again by its selector; one that is gone keeps its last centre.
 */
async function locate(target: ChoreographyTarget): Promise<() => Point> {
  if (typeof target !== 'string') {
    const fixed = await resolveTarget(target);
    return () => fixed;
  }
  let element = await waitForElement(target);
  let last = centreOf(element);
  return () => {
    if (!element.isConnected) element = document.querySelector(target) ?? element;
    if (element.isConnected) last = centreOf(element);
    return last;
  };
}

/** A scene's hotkey goes through boot.js's own press, so a boot step and a choreography hold the same button the same way. */
interface DemoBootHotkeys {
  pressCombo(combo: string): void;
  releaseCombo(combo: string): void;
}

function demoBoot(): DemoBootHotkeys {
  const boot = (window as unknown as { __demoBoot?: DemoBootHotkeys }).__demoBoot;
  if (!boot) throw new Error('the choreography presses a hotkey, and boot.js has not published __demoBoot');
  return boot;
}

/**
 * One keystroke into a field, in a browser's order: keydown, beforeinput, the edit, input, keyup.
 * A handler that prevents the keydown or the beforeinput keeps the edit out, as a real key's would.
 * The value goes through the prototype's own setter, which is the one React's value tracking
 * watches, so a controlled input reads it as typed (the approach Testing Library's user-event takes).
 */
function keystrokeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string, inputType: 'insertText' | 'deleteContentBackward', data: string | null): void {
  const key = data ?? 'Backspace';
  const keyInit: KeyboardEventInit = { key, code: data === null ? 'Backspace' : '', bubbles: true, cancelable: true, composed: true };
  const typed = field.dispatchEvent(new KeyboardEvent('keydown', keyInit))
    && field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data }));
  if (typed) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, value); else field.value = value;
    field.setSelectionRange?.(value.length, value.length);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, inputType, data }));
  }
  field.dispatchEvent(new KeyboardEvent('keyup', keyInit));
}

/** Whether the visitor asked their system for less motion; a choreography then holds at rest, as WCAG 2.2.2's pause asks. */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------- :hover, mirrored

const mirroredSheets = new WeakSet<CSSStyleSheet>();
/** `:hover`, but not an escaped one inside a class name (`.hover\:bg-x` carries none, an arbitrary variant might). */
const HOVER_PSEUDO = /(^|[^\\]):hover/g;

/**
 * Copy each rule that reads `:hover` beside itself, under the attribute instead, in the same parent
 * so cascade layers and media queries hold. Walked back to front so an insertion never shifts a
 * rule still to visit.
 */
function mirrorHoverRules(rules: CSSRuleList, parent: CSSStyleSheet | CSSGroupingRule): void {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule instanceof CSSStyleRule) {
      HOVER_PSEUDO.lastIndex = 0;
      if (HOVER_PSEUDO.test(rule.cssText)) {
        try {
          parent.insertRule(rule.cssText.replace(HOVER_PSEUDO, `$1[${HOVER_ATTRIBUTE}]`), index + 1);
        } catch {
          // A rule this engine cannot re-parse (a vendor prefix it does not know) keeps its real hover only.
        }
      }
    } else if (rule instanceof CSSGroupingRule) {
      mirrorHoverRules(rule.cssRules, rule);
    }
  }
}

function mirrorStylesheet(sheet: CSSStyleSheet): void {
  if (mirroredSheets.has(sheet)) return;
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return; // Not readable yet (a link still loading) or not same-origin; a later scan retries it.
  }
  mirroredSheets.add(sheet);
  mirrorHoverRules(rules, sheet);
}

let hoverMirrorInstalled = false;
function installHoverMirror(): void {
  if (hoverMirrorInstalled) return;
  hoverMirrorInstalled = true;
  const scan = (): void => { for (const sheet of Array.from(document.styleSheets)) mirrorStylesheet(sheet); };
  scan();
  // A lazy chunk's stylesheet arrives as a <style> or a <link> that loads later.
  new MutationObserver(scan).observe(document.head, { childList: true });
  document.addEventListener('load', scan, true);
}

// ---------------------------------------------------------------- the pointer the frame draws

const CURSOR_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45))">'
  + '<path d="M4 2 L4 19 L8.5 15 L11.5 21.5 L14 20.4 L11 14 L17 14 Z" fill="var(--color-accent, #c0562f)" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"></path></svg>';
/** The arrow's tip sits at (4, 2) in its 24px box. */
const CURSOR_TIP: Point = { x: 4, y: 2 };

function createCursor(): { element: HTMLElement; ring: HTMLElement } {
  const element = document.createElement('div');
  element.setAttribute('data-demo-cursor', '');
  element.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 300ms ease;will-change:transform';
  element.innerHTML = CURSOR_SVG;
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:-13px;top:-15px;width:34px;height:34px;border-radius:50%;box-sizing:border-box;border:2px solid var(--color-accent, #c0562f);opacity:0;pointer-events:none';
  element.appendChild(ring);
  document.body.appendChild(element);
  return { element, ring };
}

/**
 * What a cut fades the frame to: the app's own surface, over everything it draws, dialogs and
 * menus portaled to the body included. `pointer-events: none` keeps it out of `elementFromPoint`, so
 * the reset behind it presses what it names.
 */
function createVeil(): HTMLElement {
  const veil = document.createElement('div');
  veil.setAttribute('data-demo-veil', '');
  veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:0;background:var(--color-surface, #18181b);transition-property:opacity;transition-timing-function:ease';
  document.body.appendChild(veil);
  // A transition runs from the element's last computed style, which a new element has none of, so
  // the first cut would jump to opaque. Reading the style computes it at 0.
  void getComputedStyle(veil).opacity;
  return veil;
}

// ---------------------------------------------------------------- the player

/** Nearest common ancestor of two elements: where a click lands after a press and a release on different ones. */
function commonAncestor(first: Element, second: Element): Element {
  let candidate: Element | null = first;
  while (candidate && !candidate.contains(second)) candidate = candidate.parentElement;
  return candidate ?? document.documentElement;
}

/**
 * Where a step sends the pointer first; null for a step that leaves it where it is (the pose, a
 * key, a hotkey, a scroll, typing into the field that has the focus). A typed step names its field
 * here, so a cycle that opens on one shows the pointer beside it.
 */
function targetOf(step: ChoreographyStep): ChoreographyTarget | null {
  if ('hover' in step) return step.hover;
  if ('click' in step) return step.click;
  if ('contextmenu' in step) return step.contextmenu;
  if ('drag' in step) return step.drag.from;
  if ('type' in step && document.activeElement !== document.querySelector(step.type.into)) return step.type.into;
  if ('choose' in step) return step.choose.in;
  return null;
}

/** The gesture a step makes, for its default pacing. */
function kindOf(step: ChoreographyStep): string {
  for (const kind of Object.keys(DEFAULT_PACING_MS)) if (kind in step) return kind;
  return 'hover';
}

/** The element and its ancestors, innermost first. */
function chainOf(element: Element | null): Element[] {
  const chain: Element[] = [];
  for (let current = element; current; current = current.parentElement) chain.push(current);
  return chain;
}

const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable="true"]';

export function createChoreography(steps: ChoreographyStep[], options: ChoreographyOptions): ChoreographyPlayer {
  const poseIndex = steps.findIndex((step) => 'pose' in step);
  // Any positive rate: a test slows the pacing too, to land a press mid-travel.
  const configuredRate = Number(window.__demoChoreographyRate);
  const rate = configuredRate > 0 ? configuredRate : 1;
  installCaptureShim();
  let point: Point | null = null;
  let current: Element | null = null;
  let buttons = 0;
  let pressedOn: Element | null = null;
  let compatibilitySuppressed = false;
  let stopped = false;
  let instant = true;
  let cursor: { element: HTMLElement; ring: HTMLElement } | null = null;
  let veil: HTMLElement | null = null;
  /** Between a cut and the frame showing again: the reset plays unpaced and the pointer is not drawn. */
  let cutting = false;
  let cycles = 0;

  const root = document.documentElement;
  const setState = (state: 'rest' | 'playing' | 'stopped'): void => {
    root.setAttribute('data-demo-choreography', state);
    root.setAttribute('data-demo-cycles', String(cycles));
  };

  function pointerInit(at: Point, extra: Partial<PointerEventInit>, previous: Point | null): PointerEventInit {
    return {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y,
      movementX: previous ? at.x - previous.x : 0, movementY: previous ? at.y - previous.y : 0,
      button: 0, buttons, pointerId: POINTER_ID, pointerType: 'mouse', isPrimary: true,
      width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      ...extra,
    };
  }

  function sendPointer(type: string, target: Element, init: PointerEventInit): boolean {
    return target.dispatchEvent(new PointerEvent(type, init));
  }

  function sendMouse(type: string, target: Element, init: MouseEventInit): boolean {
    if (compatibilitySuppressed && type !== 'click' && type !== 'contextmenu') return true;
    return target.dispatchEvent(new MouseEvent(type, init));
  }

  /**
   * Mark the element under the pointer and its ancestors, and unmark every other. Read from the
   * document rather than from the last chain: a hovered element the page removed (a dialog that
   * closed under the pointer) no longer leads back to the ancestors it marked.
   */
  function setHoverChain(next: Element | null): void {
    const nextChain = chainOf(next);
    for (const element of Array.from(document.querySelectorAll(`[${HOVER_ATTRIBUTE}]`))) {
      if (!nextChain.includes(element)) element.removeAttribute(HOVER_ATTRIBUTE);
    }
    for (const element of nextChain) element.setAttribute(HOVER_ATTRIBUTE, '');
  }

  /** The over, out, enter and leave a browser sends when the element under the pointer changes. */
  function transition(next: Element | null, init: PointerEventInit): void {
    if (next === current) return;
    const previous = current;
    const previousChain = chainOf(previous);
    const nextChain = chainOf(next);
    if (previous) {
      sendPointer('pointerout', previous, { ...init, relatedTarget: next });
      sendMouse('mouseout', previous, { ...init, relatedTarget: next });
      for (const element of previousChain) {
        if (nextChain.includes(element)) break;
        sendPointer('pointerleave', element, { ...init, bubbles: false, cancelable: false, relatedTarget: next });
        sendMouse('mouseleave', element, { ...init, bubbles: false, cancelable: false, relatedTarget: next });
      }
    }
    if (next) {
      sendPointer('pointerover', next, { ...init, relatedTarget: previous });
      sendMouse('mouseover', next, { ...init, relatedTarget: previous });
      const entered = nextChain.filter((element) => !previousChain.includes(element)).reverse();
      for (const element of entered) {
        sendPointer('pointerenter', element, { ...init, bubbles: false, cancelable: false, relatedTarget: previous });
        sendMouse('mouseenter', element, { ...init, bubbles: false, cancelable: false, relatedTarget: previous });
      }
    }
    setHoverChain(next);
    current = next;
  }

  function moveTo(at: Point): void {
    const previous = point;
    point = at;
    drawCursorAt(at);
    const init = pointerInit(at, {}, previous);
    // A captured pointer's events go to the element that captured it, which stays its hover target.
    const captured = captureTarget();
    if (captured) {
      sendPointer('pointermove', captured, init);
      sendMouse('mousemove', captured, init);
      return;
    }
    const next = document.elementFromPoint(at.x, at.y);
    transition(next, init);
    const target = next ?? document.documentElement;
    sendPointer('pointermove', target, init);
    sendMouse('mousemove', target, init);
  }

  /**
   * Travel to a target, then stay on it while it is still moving: each frame re-measures it, so a
   * click lands on a control a collapsing group above it is still carrying, and a press waits for
   * the control to come to rest under the pointer.
   */
  async function travel(to: Point | (() => Point), durationMs: number): Promise<void> {
    if (stopped) return;
    const destination = typeof to === 'function' ? to : () => to;
    const first = destination();
    const from = point ?? { x: first.x + ENTRY_OFFSET.x, y: first.y + ENTRY_OFFSET.y };
    if (instant) {
      for (let frame = 1; frame <= STILL_TRAVEL_FRAMES; frame++) {
        const progress = frame / STILL_TRAVEL_FRAMES;
        const end = destination();
        moveTo({ x: from.x + (end.x - from.x) * progress, y: from.y + (end.y - from.y) * progress });
        await nextFrame();
      }
    } else {
      const duration = durationMs / rate;
      const startedAt = performance.now();
      for (;;) {
        if (stopped) return;
        const progress = Math.min(1, (performance.now() - startedAt) / duration);
        const eased = easeInOut(progress);
        const end = destination();
        moveTo({ x: from.x + (end.x - from.x) * eased, y: from.y + (end.y - from.y) * eased });
        if (progress >= 1) break;
        await nextFrame();
      }
    }
    let still = 0;
    for (let frame = 0; frame < SETTLE_FRAMES && still < SETTLED_FRAMES && !stopped; frame++) {
      await nextFrame();
      const end = destination();
      if (point && Math.abs(end.x - point.x) < 0.5 && Math.abs(end.y - point.y) < 0.5) {
        still += 1;
      } else {
        still = 0;
        moveTo(end);
      }
    }
  }

  /** What a browser does with focus on a press it was not told to ignore: a text field takes it, and a field the press left loses it. */
  function settleFocus(target: Element): void {
    const field = target.closest(TEXT_FIELD);
    if (field instanceof HTMLElement && !(field instanceof HTMLInputElement && field.disabled)) {
      field.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.matches(TEXT_FIELD) && !active.contains(target)) active.blur();
  }

  function press(button: 0 | 2): void {
    // A visitor who took over mid-travel owns the page now: a step still in flight presses nothing.
    if (!point || stopped) return;
    const target = document.elementFromPoint(point.x, point.y) ?? document.documentElement;
    buttons = button === 0 ? 1 : 2;
    syntheticPressed = true;
    pressedOn = target;
    const init = pointerInit(point, { button }, point);
    const allowed = sendPointer('pointerdown', target, init);
    // A pointerdown the page cancels takes the mouse events with it until the release, as in a browser.
    compatibilitySuppressed = !allowed;
    if (sendMouse('mousedown', target, init) && !compatibilitySuppressed) settleFocus(target);
    if (cursor && !instant) {
      cursor.ring.animate([{ transform: 'scale(0.4)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }], { duration: 420, easing: 'ease-out' });
    }
  }

  function release(button: 0 | 2): void {
    if (!point || buttons === 0) return;
    const hit = document.elementFromPoint(point.x, point.y) ?? document.documentElement;
    const captured = captureTarget();
    const target = captured ?? hit;
    buttons = 0;
    const init = pointerInit(point, { button }, point);
    sendPointer('pointerup', target, init);
    sendMouse('mouseup', target, init);
    compatibilitySuppressed = false;
    syntheticPressed = false;
    if (button === 0 && pressedOn) sendMouse('click', commonAncestor(pressedOn, target), { ...init, detail: 1 });
    if (button === 2) sendMouse('contextmenu', target, init);
    pressedOn = null;
    // The button coming up ends a capture, as a browser releases it implicitly after pointerup. The
    // click goes first: the Pointer Events spec has a click fired before lostpointercapture.
    if (captured && capturedBy === captured) {
      capturedBy = null;
      sendPointer('lostpointercapture', captured, { ...init, bubbles: true, cancelable: false });
    }
  }

  async function pace(milliseconds: number): Promise<void> {
    if (instant || stopped) return;
    await delay(milliseconds / rate);
  }

  async function pressAndRelease(button: 0 | 2): Promise<void> {
    press(button);
    if (instant) await nextFrame(); else await delay(PRESS_HOLD_MS / rate);
    release(button);
  }

  async function keystroke(): Promise<void> {
    if (!instant && !stopped) await delay(KEYSTROKE_MS / rate);
  }

  /** Back to what the field and the text share, one deletion a keystroke, then on, one character a keystroke. */
  async function typeInto(selector: string, text: string): Promise<void> {
    const field = await waitForElement(selector);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      throw new Error(`the choreography types only into an input or a textarea, and ${selector} is neither`);
    }
    if (document.activeElement !== field) {
      await travel(await locate(selector), TRAVEL_MS);
      await pressAndRelease(0);
      if (stopped) return;
      if (document.activeElement !== field) field.focus({ preventScroll: true });
    }
    const value = field.value;
    let shared = 0;
    while (shared < value.length && shared < text.length && value[shared] === text[shared]) shared += 1;
    while (field.value.length > shared && !stopped) {
      const before = field.value;
      keystrokeInto(field, before.slice(0, -1), 'deleteContentBackward', null);
      await keystroke();
      // A field that keeps its text through a Backspace would hold this loop, and in a still or a
      // cut's reset, where a keystroke waits for nothing, no other script would run again.
      if (!stopped && field.value === before) throw new Error(`${selector} kept its text through a Backspace`);
    }
    for (const character of text.slice(shared)) {
      if (stopped) return;
      keystrokeInto(field, field.value + character, 'insertText', character);
      await keystroke();
    }
  }

  /**
   * A native select picked: the pointer clicks the field, as a visitor's does, and the value is
   * set through the element's own setter with the input and change events a pick sends. The
   * browser's option list is its own window, which no page can draw, so it never shows.
   */
  async function chooseIn(selector: string, value: string): Promise<void> {
    await travel(await locate(selector), TRAVEL_MS);
    await pressAndRelease(0);
    if (stopped) return;
    const field = await waitForElement(selector);
    if (!(field instanceof HTMLSelectElement)) throw new Error(`the choreography chooses only in a select, and ${selector} is not one`);
    if (!Array.from(field.options).some((option) => option.value === value)) {
      throw new Error(`${selector} offers no option "${value}"`);
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(field, value); else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** One key on whatever has the focus, which is where a keyboard's events go; it bubbles to the handlers above it. */
  function pressKey(key: string): void {
    const target = document.activeElement ?? document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true }));
    }
  }

  /** Bring an element to the middle of its scroll container, only that one, and wait for the scroll to finish. */
  async function scrollTo(selector: string): Promise<void> {
    const element = await waitForElement(selector);
    // The page is the visitor's once they take over, so a scroll still on its way stays put.
    if (stopped) return;
    scrollIntoMiddle(element, instant ? 'auto' : 'smooth');
    let previous = centreOf(element);
    let still = 0;
    for (let frame = 0; frame < SETTLE_FRAMES * 2 && still < SETTLED_FRAMES; frame++) {
      await nextFrame();
      const now = centreOf(element);
      still = Math.abs(now.y - previous.y) < 0.5 && Math.abs(now.x - previous.x) < 0.5 ? still + 1 : 0;
      previous = now;
    }
  }

  async function play(step: ChoreographyStep): Promise<void> {
    if (stopped) return;
    // The loop plays a cut itself, around the steps after it.
    if ('pose' in step || 'cut' in step) return;
    if ('hover' in step) {
      await travel(await locate(step.hover), TRAVEL_MS);
    } else if ('click' in step) {
      await travel(await locate(step.click), TRAVEL_MS);
      await pressAndRelease(0);
    } else if ('contextmenu' in step) {
      await travel(await locate(step.contextmenu), TRAVEL_MS);
      await pressAndRelease(2);
    } else if ('drag' in step) {
      const from = await resolveTarget(step.drag.from);
      await travel(from, TRAVEL_MS);
      press(0);
      await travel({ x: from.x + DRAG_ACTIVATION_OFFSET.x, y: from.y + DRAG_ACTIVATION_OFFSET.y }, TRAVEL_MS / 3);
      // Measured once, where the drop target is before the carry: a sortable list moves its items
      // out of the dragged one's way, and a pointer that chased the target would chase that.
      const to = 'by' in step.drag
        ? { x: from.x + step.drag.by.x * window.innerWidth, y: from.y + step.drag.by.y * window.innerHeight }
        : await resolveTarget(step.drag.to);
      await travel(to, DRAG_CARRY_MS);
      if (!step.drag.hold) release(0);
    } else if ('drop' in step) {
      if (buttons === 0) throw new Error('the choreography drops a drag no step is holding');
      release(0);
    } else if ('type' in step) {
      await typeInto(step.type.into, step.type.text);
    } else if ('key' in step) {
      pressKey(step.key);
    } else if ('choose' in step) {
      await chooseIn(step.choose.in, step.choose.value);
    } else if ('scroll' in step) {
      await scrollTo(step.scroll);
    } else if ('hotkeyDown' in step) {
      demoBoot().pressCombo(step.hotkeyDown);
    } else if ('hotkeyUp' in step) {
      demoBoot().releaseCombo(step.hotkeyUp);
    }
    if (stopped) return;
    if (step.waitFor) await waitForElement(step.waitFor);
    await pace(step.ms ?? ('drag' in step && step.drag.hold ? HELD_DRAG_BEAT_MS : DEFAULT_PACING_MS[kindOf(step)]));
  }

  /**
   * What "back at rest" means: the lanes' cards in order, the open dialogs and layers, and inside
   * the scene's focus every form value and the selection and expansion states. Taken at ready and
   * compared after every cycle, so a choreography that drifts is caught rather than compounded.
   */
  function restSignature(): string {
    const parts: string[] = [];
    if (options.compareLanes) {
      for (const lane of Array.from(document.querySelectorAll('[data-swimlane-name]'))) {
        const cards = Array.from(lane.querySelectorAll('[data-task-id]')).map((card) => card.getAttribute('data-task-id'));
        parts.push(`${lane.getAttribute('data-swimlane-name')}:${cards.join(',')}`);
      }
    }
    // A layer playing its exit animation is already closed: a boot step's last click can leave one
    // closing as the frame turns ready, and it is gone a moment later.
    const layers = Array.from(document.querySelectorAll('[data-dismissable-layer], [role="dialog"]'))
      .filter((layer) => !layer.matches(CLOSING_LAYER) && !layer.closest(CLOSING_LAYER) && !layer.querySelector(`:scope > :is(${CLOSING_LAYER})`))
      .map((layer) => layer.getAttribute('data-testid') ?? layer.tagName.toLowerCase()).sort();
    parts.push(`layers:${layers.join(',')}`);
    const region = (options.focus ? document.querySelector(options.focus) : null) ?? document.body;
    for (const field of Array.from(region.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))) {
      // A terminal's helper textarea carries whatever the replay last typed, and the diff editor's
      // mounts when its lazy chunk lands; neither is the form.
      if (field.closest(EDITOR_SURFACES)) continue;
      const value = field instanceof HTMLInputElement && field.type === 'checkbox' ? String(field.checked) : field.value;
      parts.push(`${field.getAttribute('data-testid') ?? field.name}=${value}`);
    }
    for (const element of Array.from(region.querySelectorAll('[aria-checked], [aria-selected], [aria-expanded], [aria-pressed]'))) {
      if (element.closest(EDITOR_SURFACES)) continue;
      const state = ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed']
        .map((attribute) => element.getAttribute(attribute) ?? '').join('/');
      parts.push(`${element.getAttribute('data-testid') ?? element.tagName.toLowerCase()}:${state}`);
    }
    // A text field a cycle leaves focused draws its focus ring, which the poster does not.
    const active = document.activeElement;
    const focusedField = active instanceof Element && active.matches(TEXT_FIELD) && !active.closest(EDITOR_SURFACES)
      ? active.getAttribute('data-testid') ?? active.getAttribute('placeholder') ?? active.tagName.toLowerCase()
      : 'none';
    parts.push(`text focus:${focusedField}`);
    return parts.join('\n');
  }

  function firstDifference(expected: string, actual: string): string {
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index++) {
      if (expectedLines[index] !== actualLines[index]) return `expected "${expectedLines[index] ?? ''}", found "${actualLines[index] ?? ''}"`;
    }
    return 'no line differs';
  }

  /** Draw the pointer's arrow with its tip on a point. */
  function drawCursorAt(at: Point): void {
    if (cursor) cursor.element.style.transform = `translate(${at.x - CURSOR_TIP.x}px, ${at.y - CURSOR_TIP.y}px)`;
  }

  /** Show the pointer, once it has somewhere to be: a cycle of keys and hotkeys alone never draws one. */
  function showCursor(visible: boolean): void {
    if (!cursor) return;
    cursor.element.style.opacity = visible && point && !cutting ? '1' : '0';
  }

  /**
   * Fade the veil to an opacity and wait until it is there: a timer can fire a frame before the
   * transition lands, and a reset that started then would show its first edit through the veil.
   */
  async function fadeVeil(opacity: number): Promise<void> {
    veil ??= createVeil();
    const fading = veil;
    fading.style.transitionDuration = `${CUT_FADE_MS / rate}ms`;
    fading.style.opacity = String(opacity);
    await delay(CUT_FADE_MS / rate);
    for (let frame = 0; frame < SETTLE_FRAMES && !stopped && getComputedStyle(fading).opacity !== String(opacity); frame++) await nextFrame();
  }

  /**
   * Where a cut is, on `<html data-demo-cut>`: fading `out`, playing its `reset` behind the opaque
   * veil, or fading back `in`. A test reads it to tell the reset's changes from the story's.
   */
  function markCut(phase: 'out' | 'reset' | 'in' | null): void {
    if (phase) document.documentElement.setAttribute('data-demo-cut', phase);
    else document.documentElement.removeAttribute('data-demo-cut');
  }

  /** The cut: the pointer goes, the frame fades out, and the steps after it play at once behind the veil. */
  async function cutAway(): Promise<void> {
    cutting = true;
    markCut('out');
    showCursor(false);
    await fadeVeil(1);
    instant = true;
    if (!stopped) markCut('reset');
  }

  /**
   * Back from the cut: the reset's last layer closes and paints, the pointer leaves the page, and
   * it is placed beside the next cycle's first target, so that cycle opens with a visible travel as
   * the first one does. Then the frame fades back in.
   */
  async function cutBack(cycle: ChoreographyStep[]): Promise<void> {
    await closingLayersGone();
    for (let frame = 0; frame < CUT_SETTLE_FRAMES; frame++) await nextFrame();
    leave();
    point = null;
    await placeBeside(cycle);
    instant = false;
    if (stopped) return;
    markCut('in');
    await fadeVeil(0);
    cutting = false;
    if (!stopped) markCut(null);
  }

  /**
   * At rest the pointer leaves the page, as a mouse moved off the window does: hover styles and
   * tooltips close, and the frame is the poster's. A pose is the exception, since what it holds
   * (a hover, a drag) is the poster.
   */
  function leave(): void {
    if (current && poseIndex < 0) transition(null, pointerInit(point ?? { x: 0, y: 0 }, {}, point));
  }

  /** A visitor took over: stop for the frame's life, let go of anything held, and take the pointer away. */
  function stop(): void {
    if (stopped) return;
    if (buttons !== 0) release(buttons === 2 ? 2 : 0);
    stopped = true;
    transition(null, pointerInit(point ?? { x: 0, y: 0 }, {}, point));
    cursor?.element.remove();
    cursor = null;
    // A visitor who takes over during a cut gets the page back in view, where the reset left it.
    veil?.remove();
    veil = null;
    cutting = false;
    markCut(null);
    setState('stopped');
  }

  /**
   * Only a real hand ends it: the events above are untrusted, a visitor's are not. Armed as soon as
   * a pose holds the pointer, in every frame, since a held drag in a frame that does not loop (the
   * site's take-control dialog, a still for a visitor who prefers reduced motion) would otherwise
   * stay held for good. A listener arms no timer, so a still stays deterministic.
   */
  let watching = false;
  function watchForVisitor(): void {
    if (watching) return;
    watching = true;
    const takeOver = (event: Event): void => { if (event.isTrusted) stop(); };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, takeOver, { capture: true, passive: true });
  }

  async function playToPose(): Promise<void> {
    installHoverMirror();
    instant = true;
    if (poseIndex < 0) return;
    watchForVisitor();
    for (const step of steps.slice(0, poseIndex)) await play(step);
  }

  /**
   * Whether the frame is where someone can see it: its tab in front and, in an embedding page,
   * some of it inside that page's viewport. An observer on the root in a frame reports against the
   * top-level viewport, so a loop frame scrolled out of sight finishes its cycle and then waits.
   */
  let inViewport = true;
  function watchViewport(): void {
    if (typeof IntersectionObserver !== 'function') return;
    new IntersectionObserver((entries) => {
      for (const entry of entries) inViewport = entry.isIntersecting;
    }).observe(document.documentElement);
  }

  async function whenOnScreen(): Promise<void> {
    while (!stopped && (document.visibilityState === 'hidden' || !inViewport)) await delay(250);
  }

  /** A boot step's last click can leave a popover playing its exit as the frame turns ready; the rest is taken once it is gone. */
  async function closingLayersGone(): Promise<void> {
    for (let frame = 0; frame < SETTLE_FRAMES * 3 && document.querySelector(CLOSING_LAYER); frame++) await nextFrame();
  }

  /**
   * Put the pointer beside the first target the steps name, so the first thing it does is travel.
   * Placed, not moved: no event goes out, so nothing under that point hovers.
   */
  async function placeBeside(upcoming: ChoreographyStep[]): Promise<void> {
    if (point) return;
    const target = upcoming.map(targetOf).find((candidate): candidate is ChoreographyTarget => candidate !== null);
    if (target === undefined) return;
    const at = await resolveTarget(target);
    // stop() takes the cursor away; one that came while the target resolved places nothing.
    if (stopped || !cursor) return;
    point = { x: at.x + ENTRY_OFFSET.x, y: at.y + ENTRY_OFFSET.y };
    drawCursorAt(point);
  }

  async function loop(): Promise<void> {
    // A visitor who took over before ready (during the pose) ended it for the frame's life.
    if (stopped) return;
    const afterPose = poseIndex < 0 ? steps : steps.slice(poseIndex + 1);
    // A choreography that is only a pose holds it: there is nothing to play back to it with. A
    // visitor who asked their system for less motion gets the rest, held, which is the pause
    // WCAG 2.2.2 asks of motion that starts by itself.
    if (afterPose.length === 0 || prefersReducedMotion()) {
      setState('rest');
      return;
    }
    const cycle = poseIndex < 0 ? steps : [...afterPose, ...steps.slice(0, poseIndex)];
    // A cut's reset runs from the cut to the end of the steps after the pose; the steps up to the
    // pose then play in view, since they make the poster's gesture.
    const cutIndex = cycle.findIndex((step) => 'cut' in step);
    const resetEnd = afterPose.length;
    const afterReset = cycle.slice(resetEnd);
    installHoverMirror();
    watchViewport();
    instant = false;
    cursor = createCursor();
    await placeBeside(cycle);
    if (stopped || !cursor) return;
    if (point) drawCursorAt(point);
    leave();
    setState('rest');
    await delay(FIRST_REST_MS / rate);
    // The rest is read after the opening rest, not at ready: a panel the ready element does not wait
    // for (a file tree, a closing menu whose exit starts a frame after the click) has landed by then.
    await closingLayersGone();
    const rest = restSignature();
    for (const chosen of Array.from(document.querySelectorAll('[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"]'))) {
      chosen.setAttribute(REST_ATTRIBUTE, '');
    }
    while (!stopped) {
      await whenOnScreen();
      if (stopped) return;
      setState('playing');
      showCursor(true);
      for (let index = 0; index < cycle.length; index++) {
        if (stopped) return;
        if (index === cutIndex) await cutAway(); else await play(cycle[index]);
        if (cutting && index === resetEnd - 1) await cutBack(afterReset.length > 0 ? afterReset : cycle);
        // A step that placed the pointer for the first time (a typed field's click) shows it.
        showCursor(true);
      }
      if (stopped) return;
      // A held drag's beat was its pacing; the hand holding it keeps its pointer into the drop.
      const holding = buttons !== 0;
      if (!holding) showCursor(false);
      leave();
      cycles += 1;
      const now = restSignature();
      if (now !== rest) {
        console.error(`[kangentic-demo] the choreography did not return to rest after cycle ${cycles}: ${firstDifference(rest, now)}`);
        stop();
        return;
      }
      setState('rest');
      await delay((holding ? 0 : REST_BETWEEN_CYCLES_MS) / rate);
    }
  }

  function startLoop(): void {
    watchForVisitor();
    loop().catch((error: unknown) => {
      // A step still waiting when a visitor took over gives up on its own later; that is no fault.
      if (stopped) return;
      console.error('[kangentic-demo] the choreography stopped:', error instanceof Error ? error.message : String(error));
      stop();
    });
  }

  return { playToPose, startLoop, stop };
}
