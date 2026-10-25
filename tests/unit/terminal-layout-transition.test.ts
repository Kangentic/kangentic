/**
 * The freeze-draw-swap wrapper: a user's layout change runs once, inside an
 * element-scoped View Transition, and the scope stays frozen until every
 * terminal it resized has repainted (or the cap). The unit tier has no DOM, so
 * a fake scope stands in for the element and its `startViewTransition`, which
 * calls the update callback a tick after the call the way the browser does a
 * frame after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTerminalLayoutTransitionOpenFor,
  LAYOUT_TRANSITION_ATTRIBUTE,
  LAYOUT_TRANSITION_CAP_MS,
  LAYOUT_TRANSITION_WATCHDOG_MS,
  runTerminalLayoutChange,
  terminalLayoutTransitionFor,
} from '../../src/renderer/utils/terminal-layout-transition';

interface FakeTransition {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition?: () => void;
}

interface FakeScope {
  isConnected: boolean;
  dataset: Record<string, string>;
  attributes: Map<string, string>;
  dialogOpen: boolean;
  starts: number;
  terminal: object;
  /** The terminal panes' boxes the settle loop reads each frame; a test moves them to stand in for a refit. */
  paneBoxes: Array<{ left: number; top: number; width: number; height: number }>;
  contains(element: unknown): boolean;
  querySelector(selector: string): object | null;
  querySelectorAll(selector: string): Array<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number } }>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  startViewTransition?: (update: () => Promise<void>) => FakeTransition;
}

/** The shield the transition lays over the frozen scope, as the fake document records it. */
interface FakeShield {
  attached: boolean;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  remove(): void;
}

function fakeScope(supportsTransitions = true): FakeScope {
  const scope: FakeScope = {
    isConnected: true,
    dataset: {},
    attributes: new Map(),
    dialogOpen: false,
    starts: 0,
    terminal: {},
    paneBoxes: [{ left: 0, top: 0, width: 400, height: 300 }],
    contains(element) { return element === scope.terminal; },
    querySelector(selector) { return selector === '[data-base-dialog]' && scope.dialogOpen ? {} : null; },
    querySelectorAll() { return scope.paneBoxes.map((box) => ({ getBoundingClientRect: () => box })); },
    setAttribute(name, value) { scope.attributes.set(name, value); },
    removeAttribute(name) { scope.attributes.delete(name); },
    getBoundingClientRect() { return { left: 10, top: 40, width: 800, height: 600 }; },
  };
  if (supportsTransitions) {
    scope.startViewTransition = (update) => {
      scope.starts += 1;
      const done = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(update);
      return { ready: done, finished: done };
    };
  }
  return scope;
}

const asElement = (scope: FakeScope) => scope as unknown as HTMLElement;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runTerminalLayoutChange', () => {
  let shields: FakeShield[] = [];
  beforeEach(() => {
    shields = [];
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 5));
    vi.stubGlobal('document', {
      getAnimations: () => [],
      createElement: (): FakeShield => {
        const shield: FakeShield = {
          attached: false,
          style: { cssText: '' },
          setAttribute: () => {},
          remove: () => { shield.attached = false; },
        };
        shields.push(shield);
        return shield;
      },
      body: { appendChild: (shield: FakeShield) => { shield.attached = true; } },
    });
    vi.stubGlobal('KeyframeEffect', class {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the change at once where the browser has no scoped transitions, or there is no scope', () => {
    const change = vi.fn();
    runTerminalLayoutChange(asElement(fakeScope(false)), change);
    expect(change).toHaveBeenCalledTimes(1);
    runTerminalLayoutChange(null, change);
    expect(change).toHaveBeenCalledTimes(2);
  });

  it('runs the change at once while the window is hidden, where no frame would show a freeze', () => {
    vi.stubGlobal('document', { ...(document as unknown as Record<string, unknown>), visibilityState: 'hidden' });
    const scope = fakeScope();
    const change = vi.fn();
    runTerminalLayoutChange(asElement(scope), change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(scope.starts).toBe(0);
    expect(shields).toHaveLength(0);
  });

  it('runs the change at once while a dialog is open in the scope', () => {
    const scope = fakeScope();
    scope.dialogOpen = true;
    const change = vi.fn();
    runTerminalLayoutChange(asElement(scope), change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(scope.starts).toBe(0);
  });

  it('runs the change once, inside the transition, and marks the scope while it is open', async () => {
    const scope = fakeScope();
    const change = vi.fn();
    runTerminalLayoutChange(asElement(scope), change);
    // Not yet: the browser captures the old frame first, then calls back.
    expect(change).not.toHaveBeenCalled();
    expect(scope.attributes.get(LAYOUT_TRANSITION_ATTRIBUTE)).toBe('open');
    await tick(100);
    expect(change).toHaveBeenCalledTimes(1);
    expect(scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)).toBe(false);
  });

  it('lays a shield over the frozen scope for the length of the freeze, so a click cannot fall through', async () => {
    // The browser leaves a frozen scope out of hit testing: a click there would
    // reach whatever is behind it (the panel's backdrop hides the panel).
    const scope = fakeScope();
    runTerminalLayoutChange(asElement(scope), () => {});
    expect(shields).toHaveLength(1);
    expect(shields[0].attached).toBe(true);
    expect(shields[0].style.cssText).toContain('left:10px;top:40px;width:800px;height:600px');
    await tick(100);
    expect(shields[0].attached).toBe(false);
  });

  it('takes the shield down at the cut, when the new state is on screen, not when the browser finishes', async () => {
    // A terminal still drawing its frame can hold the finish off; a click by
    // then aims at the new state the user sees.
    const scope = fakeScope();
    let finish: () => void = () => {};
    scope.startViewTransition = (update) => {
      scope.starts += 1;
      const ready = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(update);
      const finished = ready.then(() => new Promise<void>((resolve) => { finish = resolve; }));
      return { ready, finished };
    };
    runTerminalLayoutChange(asElement(scope), () => {});
    expect(scope.attributes.get(LAYOUT_TRANSITION_ATTRIBUTE)).toBe('open');
    await tick(100);
    expect(shields[0].attached).toBe(false);
    expect(scope.attributes.get(LAYOUT_TRANSITION_ATTRIBUTE)).toBe('shown');
    finish();
    await tick(5);
    expect(scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)).toBe(false);
  });

  it('joins a second change to the open transition rather than starting another', async () => {
    const scope = fakeScope();
    const first = vi.fn();
    const second = vi.fn();
    runTerminalLayoutChange(asElement(scope), first);
    runTerminalLayoutChange(asElement(scope), second);
    await tick(100);
    expect(scope.starts).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('holds the scope until a terminal it resized has repainted', async () => {
    const scope = fakeScope();
    let settleRepaint: () => void = () => {};
    const repaint = new Promise<void>((resolve) => { settleRepaint = resolve; });
    let finishedAt = 0;
    runTerminalLayoutChange(asElement(scope), () => {
      // The terminal under the scope refits inside the change and reports it.
      expect(isTerminalLayoutTransitionOpenFor(scope.terminal as Element)).toBe(true);
      terminalLayoutTransitionFor(scope.terminal as Element)?.awaitRepaint(repaint);
    });
    const startedAt = performance.now();
    await tick(120);
    expect(scope.attributes.get(LAYOUT_TRANSITION_ATTRIBUTE)).toBe('open');
    settleRepaint();
    while (scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)) {
      await tick(5);
      finishedAt = performance.now();
    }
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(120);
    expect(finishedAt - startedAt).toBeLessThan(LAYOUT_TRANSITION_CAP_MS);
  });

  it('tears the freeze down by the watchdog when the browser never reports it finished', async () => {
    // A shield left up would take every click on the panel, so the end cannot
    // hang on the browser alone. Both shapes: the callback runs and finished
    // never settles, and the browser never calls back at all.
    for (const callsBack of [true, false]) {
      const scope = fakeScope();
      const skipped = vi.fn();
      scope.startViewTransition = (update) => {
        scope.starts += 1;
        if (callsBack) setTimeout(() => { void update(); }, 0);
        return { ready: new Promise<void>(() => {}), finished: new Promise<void>(() => {}), skipTransition: skipped };
      };
      const change = vi.fn();
      runTerminalLayoutChange(asElement(scope), change);
      await tick(LAYOUT_TRANSITION_CAP_MS + 100);
      expect(scope.attributes.get(LAYOUT_TRANSITION_ATTRIBUTE)).toBe('open');
      await tick(LAYOUT_TRANSITION_WATCHDOG_MS - LAYOUT_TRANSITION_CAP_MS + 100);
      expect(scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)).toBe(false);
      expect(shields.at(-1)?.attached).toBe(false);
      expect(skipped).toHaveBeenCalledTimes(1);
      // The change still ran, once, whether or not the browser called back.
      expect(change).toHaveBeenCalledTimes(1);
      // And the scope takes a new change as a new transition.
      runTerminalLayoutChange(asElement(scope), () => {});
      expect(scope.starts).toBe(2);
    }
  });

  it('holds while a terminal pane under the scope is still moving, though nothing registered a repaint', async () => {
    // A maximize reaches its terminals in hops a frame apart (the panel box, the
    // layer's container size, the windows, each terminal's observer), and only
    // the last hop registers anything. Ending on one quiet frame showed the panel
    // maximized with its terminals still at the old size.
    const scope = fakeScope();
    let hopsLeft = 6;
    let framesAfterLastHop = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(() => {
      if (hopsLeft > 0) {
        hopsLeft -= 1;
        scope.paneBoxes = [{ left: 0, top: 0, width: 400 + (6 - hopsLeft) * 50, height: 300 }];
      } else {
        framesAfterLastHop += 1;
      }
      callback();
    }, 5));
    runTerminalLayoutChange(asElement(scope), () => {});
    while (scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)) await tick(2);
    expect(hopsLeft).toBe(0);
    expect(framesAfterLastHop).toBeGreaterThanOrEqual(2);
  });

  it('a terminal outside any transition reports nothing', () => {
    expect(isTerminalLayoutTransitionOpenFor({} as Element)).toBe(false);
    expect(terminalLayoutTransitionFor({} as Element)).toBeNull();
  });

  it('shows the new layout by the cap even if a repaint never comes', async () => {
    const scope = fakeScope();
    runTerminalLayoutChange(asElement(scope), () => {
      terminalLayoutTransitionFor(scope.terminal as Element)?.awaitRepaint(new Promise<void>(() => {}));
    });
    await tick(LAYOUT_TRANSITION_CAP_MS + 150);
    expect(scope.attributes.has(LAYOUT_TRANSITION_ATTRIBUTE)).toBe(false);
  });
});
