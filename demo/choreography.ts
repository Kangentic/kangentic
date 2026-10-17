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
 *
 * Three things a script cannot get from the browser, and what stands in for each:
 *  - `:hover`. Every same-origin `:hover` rule is copied under `[data-demo-hover]`, in the same
 *    parent rule so layer and media order hold, and the attribute is set on the element under the
 *    pointer and its ancestors. A stylesheet that loads later (the diff editor's) is mirrored when
 *    it arrives.
 *  - Pointer capture, which Firefox refuses a pointer it did not make (`installCaptureShim`).
 *  - The pointer itself. A live frame draws one, the product accent arrow, so a menu opening by
 *    itself reads as a visitor's click. It fades in when a cycle starts and out at rest, and a still
 *    never draws it.
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
  /** Plays the steps up to the pose with no pacing and no pointer drawn: the still, and the live frame's first frame. */
  playToPose(): Promise<void>;
  /** Under loop=1: plays the cycle and returns to rest, again and again, until a visitor takes over. */
  startLoop(): void;
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
/** Pacing after a step that names none. */
const DEFAULT_PACING_MS: Record<string, number> = { hover: 900, click: 900, contextmenu: 1200, drag: 900 };
/** The rest a visitor sees before the first cycle, and between cycles. */
const FIRST_REST_MS = 2500;
const REST_BETWEEN_CYCLES_MS = 3500;
/** A drag sensor's activation distance is 4 or 5 px; a press then moves past it before the carry. */
const DRAG_ACTIVATION_OFFSET: Point = { x: 10, y: 4 };
/** Where the pointer appears, relative to its first target, so a cycle opens with a visible travel. */
const ENTRY_OFFSET: Point = { x: 140, y: 90 };
const HOVER_ATTRIBUTE = 'data-demo-hover';
/** One pointer, the mouse. Chromium and WebKit keep pointer id 1 for it. */
const POINTER_ID = 1;

/**
 * Pointer capture, for a pointer the browser did not make. The window manager captures the pointer
 * a drag's pointerdown reported (`setPointerCapture` in useWindowDrag.ts). Chromium and WebKit
 * ignore a capture of a pointer that is not pressed for real, but Firefox throws NotFoundError for
 * every id until real input has reached the page, and a site frame is `inert`, so none ever does.
 * A capture that throws for the synthetic pointer's id is therefore a no-op, which is what the other
 * two engines do with it: the player dispatches every event to the element under the point, where
 * a captured one would go during a drag that follows the pointer. A real pointer's capture never
 * throws, so it is untouched.
 */
let captureShimInstalled = false;
function installCaptureShim(): void {
  if (captureShimInstalled) return;
  captureShimInstalled = true;
  const prototype = Element.prototype;
  const setCapture = prototype.setPointerCapture;
  const releaseCapture = prototype.releasePointerCapture;
  prototype.setPointerCapture = function (this: Element, pointerId: number): void {
    try {
      setCapture.call(this, pointerId);
    } catch (error) {
      if (pointerId !== POINTER_ID) throw error;
    }
  };
  prototype.releasePointerCapture = function (this: Element, pointerId: number): void {
    try {
      releaseCapture.call(this, pointerId);
    } catch (error) {
      if (pointerId !== POINTER_ID) throw error;
    }
  };
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

async function resolveTarget(target: ChoreographyTarget): Promise<Point> {
  if (typeof target !== 'string') return { x: target.x * window.innerWidth, y: target.y * window.innerHeight };
  const element = await waitForElement(target);
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

// ---------------------------------------------------------------- the player

/** Nearest common ancestor of two elements: where a click lands after a press and a release on different ones. */
function commonAncestor(first: Element, second: Element): Element {
  let candidate: Element | null = first;
  while (candidate && !candidate.contains(second)) candidate = candidate.parentElement;
  return candidate ?? document.documentElement;
}

/** Where a step sends the pointer first; null for the pose. */
function targetOf(step: ChoreographyStep): ChoreographyTarget | null {
  if ('hover' in step) return step.hover;
  if ('click' in step) return step.click;
  if ('contextmenu' in step) return step.contextmenu;
  if ('drag' in step) return step.drag.from;
  return null;
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
  const rate = Math.max(1, Number(window.__demoChoreographyRate) || 1);
  installCaptureShim();
  let point: Point | null = null;
  let current: Element | null = null;
  let buttons = 0;
  let pressedOn: Element | null = null;
  let compatibilitySuppressed = false;
  let stopped = false;
  let instant = true;
  let cursor: { element: HTMLElement; ring: HTMLElement } | null = null;
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

  function setHoverChain(next: Element | null): void {
    const previousChain = chainOf(current);
    const nextChain = chainOf(next);
    for (const element of previousChain) if (!nextChain.includes(element)) element.removeAttribute(HOVER_ATTRIBUTE);
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
    if (cursor) cursor.element.style.transform = `translate(${at.x - CURSOR_TIP.x}px, ${at.y - CURSOR_TIP.y}px)`;
    const next = document.elementFromPoint(at.x, at.y);
    const init = pointerInit(at, {}, previous);
    transition(next, init);
    const target = next ?? document.documentElement;
    sendPointer('pointermove', target, init);
    sendMouse('mousemove', target, init);
  }

  async function travel(to: Point, durationMs: number): Promise<void> {
    if (stopped) return;
    const from = point ?? { x: to.x + ENTRY_OFFSET.x, y: to.y + ENTRY_OFFSET.y };
    if (instant) {
      for (let frame = 1; frame <= STILL_TRAVEL_FRAMES; frame++) {
        const progress = frame / STILL_TRAVEL_FRAMES;
        moveTo({ x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress });
        await nextFrame();
      }
      return;
    }
    const duration = durationMs / rate;
    const startedAt = performance.now();
    for (;;) {
      if (stopped) return;
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      const eased = easeInOut(progress);
      moveTo({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
      if (progress >= 1) return;
      await nextFrame();
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
    if (!point) return;
    const target = document.elementFromPoint(point.x, point.y) ?? document.documentElement;
    buttons = button === 0 ? 1 : 2;
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
    const target = document.elementFromPoint(point.x, point.y) ?? document.documentElement;
    buttons = 0;
    const init = pointerInit(point, { button }, point);
    sendPointer('pointerup', target, init);
    sendMouse('mouseup', target, init);
    compatibilitySuppressed = false;
    if (button === 0 && pressedOn) sendMouse('click', commonAncestor(pressedOn, target), { ...init, detail: 1 });
    if (button === 2) sendMouse('contextmenu', target, init);
    pressedOn = null;
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

  async function play(step: ChoreographyStep): Promise<void> {
    if (stopped) return;
    if ('pose' in step) return;
    let kind = 'hover';
    if ('hover' in step) {
      await travel(await resolveTarget(step.hover), TRAVEL_MS);
    } else if ('click' in step) {
      kind = 'click';
      await travel(await resolveTarget(step.click), TRAVEL_MS);
      await pressAndRelease(0);
    } else if ('contextmenu' in step) {
      kind = 'contextmenu';
      await travel(await resolveTarget(step.contextmenu), TRAVEL_MS);
      await pressAndRelease(2);
    } else if ('drag' in step) {
      kind = 'drag';
      const from = await resolveTarget(step.drag.from);
      await travel(from, TRAVEL_MS);
      press(0);
      await travel({ x: from.x + DRAG_ACTIVATION_OFFSET.x, y: from.y + DRAG_ACTIVATION_OFFSET.y }, TRAVEL_MS / 3);
      await travel(await resolveTarget(step.drag.to), DRAG_CARRY_MS);
      if (!step.drag.hold) release(0);
    }
    if (step.waitFor) await waitForElement(step.waitFor);
    await pace(step.ms ?? DEFAULT_PACING_MS[kind]);
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
    const layers = Array.from(document.querySelectorAll('[data-dismissable-layer], [role="dialog"]'))
      .map((layer) => layer.getAttribute('data-testid') ?? layer.tagName.toLowerCase()).sort();
    parts.push(`layers:${layers.join(',')}`);
    const region = (options.focus ? document.querySelector(options.focus) : null) ?? document.body;
    for (const field of Array.from(region.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))) {
      // A terminal's helper textarea carries whatever the replay last typed, which is not the form.
      if (field.closest('.xterm')) continue;
      const value = field instanceof HTMLInputElement && field.type === 'checkbox' ? String(field.checked) : field.value;
      parts.push(`${field.getAttribute('data-testid') ?? field.name}=${value}`);
    }
    for (const element of Array.from(region.querySelectorAll('[aria-checked], [aria-selected], [aria-expanded], [aria-pressed]'))) {
      if (element.closest('.xterm')) continue;
      const state = ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed']
        .map((attribute) => element.getAttribute(attribute) ?? '').join('/');
      parts.push(`${element.getAttribute('data-testid') ?? element.tagName.toLowerCase()}:${state}`);
    }
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

  function showCursor(visible: boolean): void {
    if (!cursor) return;
    cursor.element.style.opacity = visible ? '1' : '0';
  }

  /** A visitor took over: stop for the frame's life, let go of anything held, and take the pointer away. */
  function stop(): void {
    if (stopped) return;
    if (buttons !== 0) release(buttons === 2 ? 2 : 0);
    stopped = true;
    transition(null, pointerInit(point ?? { x: 0, y: 0 }, {}, point));
    cursor?.element.remove();
    cursor = null;
    setState('stopped');
  }

  async function playToPose(): Promise<void> {
    installHoverMirror();
    instant = true;
    if (poseIndex < 0) return;
    for (const step of steps.slice(0, poseIndex)) await play(step);
  }

  async function loop(): Promise<void> {
    const afterPose = poseIndex < 0 ? steps : steps.slice(poseIndex + 1);
    // A choreography that is only a pose holds it: there is nothing to play back to it with.
    if (afterPose.length === 0) {
      setState('rest');
      return;
    }
    const cycle = poseIndex < 0 ? steps : [...afterPose, ...steps.slice(0, poseIndex)];
    installHoverMirror();
    instant = false;
    const rest = restSignature();
    cursor = createCursor();
    // The pointer enters beside the cycle's first target, so the first thing it does is travel.
    if (!point) {
      const target = cycle.map(targetOf).find((candidate): candidate is ChoreographyTarget => candidate !== null);
      if (target !== undefined) {
        const at = await resolveTarget(target);
        moveTo({ x: at.x + ENTRY_OFFSET.x, y: at.y + ENTRY_OFFSET.y });
      }
    } else {
      moveTo(point);
    }
    setState('rest');
    await delay(FIRST_REST_MS / rate);
    while (!stopped) {
      setState('playing');
      showCursor(true);
      for (const step of cycle) {
        if (stopped) return;
        await play(step);
      }
      if (stopped) return;
      showCursor(false);
      cycles += 1;
      const now = restSignature();
      if (now !== rest) {
        console.error(`[kangentic-demo] the choreography did not return to rest after cycle ${cycles}: ${firstDifference(rest, now)}`);
        stop();
        return;
      }
      setState('rest');
      await delay(REST_BETWEEN_CYCLES_MS / rate);
    }
  }

  function startLoop(): void {
    // Only a real hand stops it: the events above are untrusted, a visitor's are not.
    const takeOver = (event: Event): void => { if (event.isTrusted) stop(); };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, takeOver, { capture: true, passive: true });
    loop().catch((error: unknown) => {
      console.error('[kangentic-demo] the choreography stopped:', error instanceof Error ? error.message : String(error));
      stop();
    });
  }

  return { playToPose, startLoop };
}
