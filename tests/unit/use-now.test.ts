/**
 * Unit coverage for the `enabled` argument of useNow
 * (src/renderer/hooks/useNow.ts).
 *
 * The board card's wait tip passes `isIdle && Boolean(activityReason)` so that a
 * card with nothing to count does not keep a 1 s timer alive. The contract:
 *
 *   - `enabled` false: no interval is scheduled, and the value holds.
 *   - `enabled` flips to true: the 1 s tick starts, and the FIRST tick brings
 *     the value up to date (nothing re-reads the clock before it).
 *   - `enabled` flips back to false, or the component unmounts: the interval is
 *     cleared.
 *   - `enabled` omitted: the timer runs (the default is true).
 *
 * The vitest config has no DOM environment and no @testing-library/react, so
 * this follows conversation-window-bridge.test.ts: `react` is mocked with a
 * small harness that keeps useState slots and runs useEffect the way React does
 * (after the render, cleanup first, only when the deps changed). An always-run
 * useEffect would hide the deps contract, which is why the harness compares
 * them. Time comes from vitest's fake timers, which fake Date as well.
 *
 * Red-green: drop the `if (!enabled)` guard and the disabled case fails (a timer
 * is scheduled); drop `enabled` from the effect's deps and the flip cases fail
 * (the effect never re-runs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({
  stateSlots: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup: unknown }>,
  effectIndex: 0,
  queued: [] as Array<() => void>,
}));

function sameDeps(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return false;
  return next.every((dependency, index) => Object.is(dependency, previous[index]));
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const withHarnessHooks = {
    ...actual,
    useState: <Value,>(initial: Value | (() => Value)) => {
      const slot = harness.stateIndex++;
      if (!(slot in harness.stateSlots)) {
        harness.stateSlots[slot] = typeof initial === 'function' ? (initial as () => Value)() : initial;
      }
      const setValue = (next: Value): void => {
        harness.stateSlots[slot] = next;
      };
      return [harness.stateSlots[slot] as Value, setValue] as const;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const slot = harness.effectIndex++;
      const previous = harness.effects[slot];
      if (previous && sameDeps(previous.deps, deps)) return;
      harness.queued.push(() => {
        if (typeof previous?.cleanup === 'function') previous.cleanup();
        harness.effects[slot] = { deps, cleanup: effect() };
      });
    },
  };
  return { ...withHarnessHooks, default: withHarnessHooks };
});

import { useNow } from '../../src/renderer/hooks/useNow';

const START_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const TICK_MS = 1000;

/** One render of the hook, then its queued effects. Returns the value the render read. */
function render(enabled?: boolean): number {
  harness.stateIndex = 0;
  harness.effectIndex = 0;
  harness.queued = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the harness stands in for React's renderer: `react` is mocked, so this call is the render
  const value = useNow(TICK_MS, enabled);
  for (const run of harness.queued) run();
  return value;
}

/** Run every effect's cleanup, as React does when the component unmounts. */
function unmount(): void {
  for (const effect of harness.effects) {
    if (typeof effect?.cleanup === 'function') effect.cleanup();
  }
  harness.effects = [];
}

describe('useNow enabled argument', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    harness.stateSlots = [];
    harness.effects = [];
    harness.queued = [];
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
  });

  it('schedules no interval while disabled, and the value holds', () => {
    expect(render(false)).toBe(START_MS);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5 * TICK_MS);
    expect(render(false)).toBe(START_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the tick when enabled flips to true, and the first tick brings the value up to date', () => {
    render(false);
    vi.advanceTimersByTime(5 * TICK_MS);

    // Enabling re-reads nothing: the value waits for the first tick.
    expect(render(true)).toBe(START_MS);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(TICK_MS - 1);
    expect(render(true)).toBe(START_MS);

    vi.advanceTimersByTime(1);
    expect(render(true)).toBe(START_MS + 6 * TICK_MS);

    vi.advanceTimersByTime(TICK_MS);
    expect(render(true)).toBe(START_MS + 7 * TICK_MS);
  });

  it('clears the interval when enabled flips back to false, and the value holds', () => {
    render(true);
    vi.advanceTimersByTime(2 * TICK_MS);
    expect(render(true)).toBe(START_MS + 2 * TICK_MS);
    expect(vi.getTimerCount()).toBe(1);

    expect(render(false)).toBe(START_MS + 2 * TICK_MS);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5 * TICK_MS);
    expect(render(false)).toBe(START_MS + 2 * TICK_MS);
  });

  it('runs the timer when enabled is omitted', () => {
    expect(render()).toBe(START_MS);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(TICK_MS);
    expect(render()).toBe(START_MS + TICK_MS);
  });

  it('clears the interval when the component unmounts', () => {
    render(true);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
