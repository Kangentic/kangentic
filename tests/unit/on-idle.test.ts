/**
 * Unit tests for src/renderer/utils/on-idle.ts.
 *
 * vitest runs this suite in the default 'node' environment (no jsdom in this
 * project's vitest.config.ts), so `window` is not a real global here. We stub
 * `globalThis.window` per test, mirroring the pattern used by
 * tests/unit/terminal-clipboard-osc52.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onIdle } from '../../src/renderer/utils/on-idle';

describe('onIdle', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
    vi.useRealTimers();
  });

  it('calls window.requestIdleCallback when it is available, without falling back to a timer', () => {
    const requestIdleCallback = vi.fn();
    // @ts-expect-error -- minimal window stub carrying only what onIdle reads
    globalThis.window = { requestIdleCallback };
    const callback = vi.fn();

    onIdle(callback);

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(requestIdleCallback).toHaveBeenCalledWith(callback);
    // The callback itself is only invoked by requestIdleCallback, never by onIdle directly.
    expect(callback).not.toHaveBeenCalled();
  });

  it('falls back to setTimeout when window.requestIdleCallback is absent', () => {
    vi.useFakeTimers();
    // @ts-expect-error -- minimal window stub with no requestIdleCallback
    globalThis.window = {};
    const callback = vi.fn();

    onIdle(callback);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
