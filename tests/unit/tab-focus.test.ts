/**
 * Pins the Tab flag behind a Tooltip's focus open (src/renderer/utils/tab-focus.ts): set by a
 * capture-phase keydown for Tab, and cleared one task later, by any other key, or by a pointerdown.
 *
 * The module keeps its state at module scope (`tabKeyDownPending`, `installed`), so every test
 * resets the module registry and imports it fresh against its own stubbed `window`. The stub
 * records what is registered and delivers events to it, and its `setTimeout` hands off to the
 * faked global timer so `advanceTimersByTime` runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Listener = (event: unknown) => void;

interface Registration {
  type: string;
  listener: Listener;
  capture: unknown;
}

function stubWindow() {
  const registrations: Registration[] = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: Listener, capture?: unknown) => {
      registrations.push({ type, listener, capture });
    },
    // Resolved on each call, so it reaches the fake timer the test installed.
    setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay),
  });
  const dispatch = (type: string, event: unknown): void => {
    for (const registration of registrations) {
      if (registration.type === type) registration.listener(event);
    }
  };
  return { registrations, dispatch };
}

async function loadTracker() {
  vi.resetModules();
  return import('../../src/renderer/utils/tab-focus');
}

describe('tab-focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is false until a Tab is pressed', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    expect(focusCameFromTab()).toBe(false);
    dispatch('keydown', { key: 'a' });
    expect(focusCameFromTab()).toBe(false);
  });

  it('is true right after a Tab keydown', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab' });
    expect(focusCameFromTab()).toBe(true);
  });

  it('is true right after Shift+Tab, which is also the Tab key', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(focusCameFromTab()).toBe(true);
  });

  it('goes false when the zero-delay timer runs, one task after the key', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab' });
    expect(focusCameFromTab()).toBe(true);
    vi.advanceTimersByTime(0);
    expect(focusCameFromTab()).toBe(false);
  });

  it('goes false when any other key follows the Tab, before the timer runs', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab' });
    dispatch('keydown', { key: 'ArrowDown' });
    expect(focusCameFromTab()).toBe(false);
  });

  it('goes false when a pointerdown follows the Tab, before the timer runs', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab' });
    dispatch('pointerdown', {});
    expect(focusCameFromTab()).toBe(false);
  });

  it('starts a fresh window for the next Tab after one was cleared', async () => {
    const { dispatch } = stubWindow();
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    installTabFocusTracker();
    dispatch('keydown', { key: 'Tab' });
    dispatch('pointerdown', {});
    expect(focusCameFromTab()).toBe(false);
    dispatch('keydown', { key: 'Tab' });
    expect(focusCameFromTab()).toBe(true);
  });

  it('listens for keydown and pointerdown on window, in the capture phase', async () => {
    const { registrations } = stubWindow();
    const { installTabFocusTracker } = await loadTracker();
    installTabFocusTracker();
    expect(registrations.map(({ type, capture }) => ({ type, capture }))).toEqual([
      { type: 'keydown', capture: true },
      { type: 'pointerdown', capture: true },
    ]);
  });

  it('registers each listener once however many times it is installed', async () => {
    const { registrations } = stubWindow();
    const { installTabFocusTracker } = await loadTracker();
    installTabFocusTracker();
    installTabFocusTracker();
    expect(registrations.map(({ type }) => type)).toEqual(['keydown', 'pointerdown']);
  });

  it('installs nothing without a window, and still installs once there is one', async () => {
    const { installTabFocusTracker, focusCameFromTab } = await loadTracker();
    // No window stubbed: the node environment has none, so this must not throw or count as installed.
    expect(() => installTabFocusTracker()).not.toThrow();
    expect(focusCameFromTab()).toBe(false);

    const { registrations, dispatch } = stubWindow();
    installTabFocusTracker();
    expect(registrations).toHaveLength(2);
    dispatch('keydown', { key: 'Tab' });
    expect(focusCameFromTab()).toBe(true);
  });
});
