/**
 * Two holds in the web demo that make a poster and its live frame one frame, both in classic
 * scripts that cannot be imported, so each is lifted out and run in node:vm with a fake page:
 *
 *   - demo/boot.js `waitForTerminalGridsToHold`: ready waits until every terminal's canvas size has
 *     held 250 ms (cap 2000 ms), and a frame with no terminal host is ready at once. A host that
 *     lifted its poster on a terminal still fitting its grid would show a different grid.
 *   - demo/webview-shim.js `load()`: the Browser pane's guest reports loaded (the
 *     `data-demo-guest-loaded` attribute, then dom-ready) only after its faces are in, and a load
 *     replaced before its faces resolved never reports.
 *
 * tests/demo/static-demo.spec.ts fails if the attribute never lands; it cannot see the order.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BOOT = fs.readFileSync(path.join(REPO_ROOT, 'demo', 'boot.js'), 'utf8');
const SHIM = fs.readFileSync(path.join(REPO_ROOT, 'demo', 'webview-shim.js'), 'utf8');

/** The text from `start` up to (not including) `end`, failing loudly when either marker moved. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`could not lift ${start} .. ${end} out of boot.js`);
  return source.slice(from, to);
}

interface GridHarness {
  /** Sets the canvas sizes the fake document reports; null means no terminal host at all. */
  setCanvasWidths(widths: string[] | null): void;
  /** Runs the function, then advances the fake clock one 16 ms frame at a time to `untilMs`. */
  run(untilMs: number, onFrame?: (nowMs: number) => void): { resolvedAt: number | null };
}

function gridHarness(): GridHarness {
  let nowMs = 0;
  let widths: string[] | null = null;
  const frames: Array<() => void> = [];
  const sandbox = {
    document: {
      querySelector: (selector: string) => (selector === '[data-terminal-host]' && widths !== null ? {} : null),
      querySelectorAll: () => (widths ?? []).map((width) => ({ style: { width, height: '100px' } })),
    },
    window: { requestAnimationFrame: (callback: () => void) => { frames.push(callback); return 0; } },
    Date: { now: () => nowMs },
    Promise,
    result: undefined as unknown,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${between(BOOT, 'var TERMINAL_HOLD_MS', 'function notifyParent')}; this.waitForTerminalGridsToHold = waitForTerminalGridsToHold;`, sandbox);
  const wait = (sandbox as unknown as { waitForTerminalGridsToHold: () => Promise<void> }).waitForTerminalGridsToHold;
  return {
    setCanvasWidths(next) { widths = next; },
    run(untilMs, onFrame) {
      const outcome: { resolvedAt: number | null } = { resolvedAt: null };
      void wait().then(() => { outcome.resolvedAt = nowMs; });
      const drain = (): void => {
        while (nowMs <= untilMs) {
          const pending = frames.splice(0);
          if (pending.length === 0) return;
          nowMs += 16;
          onFrame?.(nowMs);
          pending.forEach((callback) => callback());
        }
      };
      drain();
      return outcome;
    },
  };
}

/** Let promise reactions run (resolvedAt is stamped in a microtask). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('boot.js waitForTerminalGridsToHold', () => {
  it('resolves at once for a frame with no terminal host', async () => {
    const harness = gridHarness();
    harness.setCanvasWidths(null);
    const outcome = harness.run(5000);
    await flush();
    expect(outcome.resolvedAt).toBe(0);
  });

  it('waits until 250 ms after the last grid change', async () => {
    const harness = gridHarness();
    harness.setCanvasWidths(['1000px']);
    let lastChangeAt = 0;
    const outcome = harness.run(5000, (nowMs) => {
      // The grid keeps changing until 600 ms, as a terminal fitting over a few frames does.
      if (nowMs <= 600 && nowMs % 160 < 16) {
        harness.setCanvasWidths([`${1000 + nowMs}px`]);
        lastChangeAt = nowMs;
      }
    });
    await flush();
    expect(outcome.resolvedAt).not.toBeNull();
    expect(outcome.resolvedAt as number).toBeGreaterThanOrEqual(lastChangeAt + 250);
    expect(outcome.resolvedAt as number).toBeLessThan(lastChangeAt + 250 + 100);
    expect(lastChangeAt).toBeGreaterThan(0);
  });

  it('resolves at the 2000 ms cap for a grid that never settles', async () => {
    const harness = gridHarness();
    harness.setCanvasWidths(['1000px']);
    let counter = 0;
    const outcome = harness.run(10_000, () => { counter += 1; harness.setCanvasWidths([`${1000 + counter}px`]); });
    await flush();
    expect(outcome.resolvedAt).not.toBeNull();
    expect(outcome.resolvedAt as number).toBeGreaterThanOrEqual(2000);
    expect(outcome.resolvedAt as number).toBeLessThan(2100);
  });

  it('runs before markReady in the ready chain', () => {
    const chainAt = BOOT.indexOf('chain = chain.then(waitForTerminalGridsToHold);');
    const readyAt = BOOT.indexOf('markReady();', chainAt);
    expect(chainAt).toBeGreaterThan(0);
    expect(readyAt).toBeGreaterThan(chainAt);
  });
});

interface ShimHarness {
  frame: { attributes: Set<string>; onload: (() => void) | null };
  events: string[];
  /** Resolvers of every dressGuestFonts call, in order. */
  fontResolvers: Array<() => void>;
  load(url: string): void;
}

function shimHarness(): ShimHarness {
  const attributes = new Set<string>();
  const frame = {
    attributes,
    onload: null as (() => void) | null,
    contentDocument: {},
    contentWindow: null,
    style: { cssText: '' },
    setAttribute: (name: string) => { attributes.add(name); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    set src(_value: string) { /* the test fires onload itself */ },
  };
  const events: string[] = [];
  const fontResolvers: Array<() => void> = [];
  const webview: Record<string, unknown> = {
    tagName: 'WEBVIEW',
    style: {},
    getAttribute: () => 'http://localhost:5173/',
    appendChild: () => undefined,
    querySelectorAll: () => [],
    dispatchEvent: (event: { type: string }) => { events.push(event.type); },
  };
  const sandbox: Record<string, unknown> = {
    window: {
      __demoGuestPages: { 'http://localhost:5173/': 'guest.html' },
      __demoBoot: {
        dressGuestFonts: () => new Promise<void>((resolve) => { fontResolvers.push(resolve); }),
      },
    },
    document: {
      readyState: 'complete',
      documentElement: webview,
      createElement: () => frame,
    },
    getComputedStyle: () => ({ display: 'block' }),
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    MutationObserver: class { observe(): void { /* nothing mounts later in this test */ } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox);
  return {
    frame,
    events,
    fontResolvers,
    load: (url) => (webview.loadURL as (target: string) => void)(url),
  };
}

describe('webview-shim load()', () => {
  it('reports the guest loaded only after its faces resolve', async () => {
    const harness = shimHarness();
    harness.frame.onload?.();
    await flush();
    expect(harness.frame.attributes.has('data-demo-guest-loaded')).toBe(false);
    expect(harness.events).not.toContain('dom-ready');
    harness.fontResolvers[0]();
    await flush();
    expect(harness.frame.attributes.has('data-demo-guest-loaded')).toBe(true);
    expect(harness.events[0]).toBe('dom-ready');
  });

  it('never reports a load that a second load replaced before its faces resolved', async () => {
    const harness = shimHarness();
    harness.frame.onload?.();
    harness.load('http://localhost:5173/');
    harness.frame.onload?.();
    await flush();
    expect(harness.fontResolvers).toHaveLength(2);
    // The first load's faces resolve late.
    harness.fontResolvers[0]();
    await flush();
    expect(harness.events).toHaveLength(0);
    expect(harness.frame.attributes.has('data-demo-guest-loaded')).toBe(false);
    harness.fontResolvers[1]();
    await flush();
    expect(harness.events.filter((type) => type === 'dom-ready')).toHaveLength(1);
    expect(harness.frame.attributes.has('data-demo-guest-loaded')).toBe(true);
  });
});
