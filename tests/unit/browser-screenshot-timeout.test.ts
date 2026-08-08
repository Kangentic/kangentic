/**
 * `Page.captureScreenshot` waits for a composited frame, so it never resolves
 * when the guest is not being composited. Measured on Electron 41 during live
 * testing: a MINIMIZED host window hangs, and so does a fully OCCLUDED one - and
 * an occluded window is indistinguishable from a visible one through Electron's
 * main-process API, so no precondition check can cover it. The un-settled
 * command also wedges that guest's CDP queue, so a single screenshot at the
 * wrong moment bricks the pane for the rest of the session.
 *
 * This bound is therefore the real guarantee, not a nicety: the tool call fails
 * cleanly with an actionable message instead of hanging forever.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

import type { WebContents } from 'electron';
// The bound is imported, not restated: a test that hardcoded it would stop
// reaching the real timeout the moment the constant moved, and then hang on a
// never-settling race until vitest's own timeout instead of failing clearly.
import { captureScreenshot, ScreenshotNotComposited, SCREENSHOT_TIMEOUT_MS } from '../../src/main/browser/cdp/cdp';

/** A guest whose `sendCommand` behaves as configured. */
function fakeGuest(sendCommand: (method: string) => Promise<unknown>): WebContents {
  return { debugger: { sendCommand } } as unknown as WebContents;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('captureScreenshot timeout', () => {
  it('rejects with an actionable error when no frame is ever produced', async () => {
    vi.useFakeTimers();
    // Never settles: exactly what a non-composited guest does.
    const guest = fakeGuest(() => new Promise<never>(() => {}));

    const pending = captureScreenshot(guest);
    const assertion = expect(pending).rejects.toBeInstanceOf(ScreenshotNotComposited);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    await assertion;
  });

  it('names the cause and a next step the agent can act on', async () => {
    vi.useFakeTimers();
    const guest = fakeGuest(() => new Promise<never>(() => {}));

    const pending = captureScreenshot(guest);
    const assertion = expect(pending).rejects.toThrow(/not being composited/);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    await assertion;
  });

  it('returns the image untouched when a frame arrives in time', async () => {
    const guest = fakeGuest(async () => ({ data: 'BASE64PNG' }));
    await expect(captureScreenshot(guest)).resolves.toBe('BASE64PNG');
  });

  it('does not leave a pending timer behind on the success path', async () => {
    vi.useFakeTimers();
    const guest = fakeGuest(async () => ({ data: 'BASE64PNG' }));

    await expect(captureScreenshot(guest)).resolves.toBe('BASE64PNG');
    // A leaked 5s timer per screenshot would keep the event loop churning for
    // every capture an agent takes.
    expect(vi.getTimerCount()).toBe(0);
  });
});
