/**
 * `useDevicePixelRatio` shares ONE `(resolution: Ndppx)` media query across every subscriber, so a
 * board of priority meters adds one listener, not one per card. When the ratio moves (a window on
 * another monitor, a zoom) the watch must follow it and every meter must redraw. These drive the
 * real store through a fake `window.matchMedia`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeQuery {
  media: string;
  listeners: Set<() => void>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

let queries: FakeQuery[];
let fakeWindow: { devicePixelRatio: number; matchMedia?: (media: string) => FakeQuery };

function liveListenerCount(): number {
  return queries.reduce((total, query) => total + query.listeners.size, 0);
}

/** The ratio moves: fire `change` on every query that still has a listener. */
function moveRatioTo(devicePixelRatio: number): void {
  fakeWindow.devicePixelRatio = devicePixelRatio;
  // Snapshot: the change handler re-watches, which appends a new query that must not fire now.
  for (const query of [...queries]) {
    for (const listener of [...query.listeners]) listener();
  }
}

async function loadStore(): Promise<typeof import('../../src/renderer/hooks/useDevicePixelRatio')> {
  vi.resetModules();
  return import('../../src/renderer/hooks/useDevicePixelRatio');
}

beforeEach(() => {
  queries = [];
  fakeWindow = {
    devicePixelRatio: 1,
    matchMedia: (media: string) => {
      const query: FakeQuery = {
        media,
        listeners: new Set(),
        addEventListener: (_type, listener) => { query.listeners.add(listener); },
        removeEventListener: (_type, listener) => { query.listeners.delete(listener); },
      };
      queries.push(query);
      return query;
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
});

afterEach(() => {
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe('device pixel ratio store', () => {
  it('starts one watch at the current ratio for the first subscriber and none for the second', async () => {
    const { subscribeToDevicePixelRatio } = await loadStore();
    const stopFirst = subscribeToDevicePixelRatio(() => {});
    expect(queries.map((query) => query.media)).toEqual(['(resolution: 1dppx)']);
    const stopSecond = subscribeToDevicePixelRatio(() => {});
    expect(queries).toHaveLength(1);
    expect(liveListenerCount()).toBe(1);
    stopFirst();
    stopSecond();
  });

  it('moves the watch to the new ratio and notifies every subscriber on change', async () => {
    const { subscribeToDevicePixelRatio } = await loadStore();
    const notifyFirst = vi.fn();
    const notifySecond = vi.fn();
    const stopFirst = subscribeToDevicePixelRatio(notifyFirst);
    const stopSecond = subscribeToDevicePixelRatio(notifySecond);

    moveRatioTo(1.5);

    expect(queries.map((query) => query.media)).toEqual(['(resolution: 1dppx)', '(resolution: 1.5dppx)']);
    expect(queries[0].listeners.size).toBe(0);
    expect(queries[1].listeners.size).toBe(1);
    expect(notifyFirst).toHaveBeenCalledTimes(1);
    expect(notifySecond).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });

  it('keeps following the ratio across a second change', async () => {
    const { subscribeToDevicePixelRatio } = await loadStore();
    const notify = vi.fn();
    const stop = subscribeToDevicePixelRatio(notify);
    moveRatioTo(1.5);
    moveRatioTo(2);
    expect(queries[queries.length - 1].media).toBe('(resolution: 2dppx)');
    expect(liveListenerCount()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
    stop();
  });

  it('removes the last listener when the last subscriber leaves, and not before', async () => {
    const { subscribeToDevicePixelRatio } = await loadStore();
    const stopFirst = subscribeToDevicePixelRatio(() => {});
    const stopSecond = subscribeToDevicePixelRatio(() => {});
    stopFirst();
    expect(liveListenerCount()).toBe(1);
    stopSecond();
    expect(liveListenerCount()).toBe(0);
  });

  it('starts a fresh watch for a subscriber that arrives after everyone left', async () => {
    const { subscribeToDevicePixelRatio } = await loadStore();
    subscribeToDevicePixelRatio(() => {})();
    const stop = subscribeToDevicePixelRatio(() => {});
    expect(queries).toHaveLength(2);
    expect(liveListenerCount()).toBe(1);
    stop();
  });

  it('does not throw and starts nothing without matchMedia', async () => {
    delete fakeWindow.matchMedia;
    const { subscribeToDevicePixelRatio } = await loadStore();
    const stop = subscribeToDevicePixelRatio(() => {});
    expect(queries).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });

  it('does not throw and starts nothing without a window', async () => {
    delete (globalThis as { window?: unknown }).window;
    const { subscribeToDevicePixelRatio } = await loadStore();
    const stop = subscribeToDevicePixelRatio(() => {});
    expect(queries).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});
