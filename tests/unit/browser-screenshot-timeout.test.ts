/**
 * `Page.captureScreenshot` waits for a composited frame, so it never resolves
 * when the guest is not being composited. `holdGuestRendering` keeps a guest
 * drawing behind a covered or minimized host, and whatever it does not reach, a
 * host hidden outright above all, still has no frame to hand back.
 *
 * This bound is therefore the real guarantee, not a nicety: the tool call fails
 * cleanly with an actionable message instead of hanging forever.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

import { BrowserWindow, type WebContents } from 'electron';
// The bound is imported, not restated: a test that hardcoded it would stop
// reaching the real timeout the moment the constant moved, and then hang on a
// never-settling race until vitest's own timeout instead of failing clearly.
import { captureScreenshot, ScreenshotNotComposited, SCREENSHOT_TIMEOUT_MS } from '../../src/main/browser/cdp/cdp';

/** A guest whose `sendCommand` behaves as configured. */
function fakeGuest(sendCommand: (method: string) => Promise<unknown>): WebContents {
  return { debugger: { sendCommand } } as unknown as WebContents;
}

/**
 * A guest inside a host window in the given state, whose capture never settles.
 * The hold's own `capturePage` calls answer, so a visible or minimized host arms it.
 */
function guestInHost(hostWindowState: { minimized: boolean; visible: boolean }): WebContents {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
    isMinimized: () => hostWindowState.minimized,
    isVisible: () => hostWindowState.visible,
  } as unknown as BrowserWindow);
  return {
    hostWebContents: { isDestroyed: () => false, capturePage: async () => ({}) },
    isDestroyed: () => false,
    capturePage: async () => ({}),
    debugger: { sendCommand: () => new Promise<never>(() => {}) },
  } as unknown as WebContents;
}

/** Time a capture out and hand back what it rejected with. */
async function timedOutError(guest: WebContents): Promise<unknown> {
  vi.useFakeTimers();
  const settledError = captureScreenshot(guest).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
  return settledError;
}

afterEach(() => {
  vi.useRealTimers();
  // The fakeGuest cases below rely on no host window, so a guestInHost case must not leak one.
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
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

  it('does not tell the agent Kangentic is out of sight when its window is visible (DESKTOP-46)', async () => {
    // Every Windows event of DESKTOP-46 had the host visible, and the agent told
    // the user to bring back a window that was already in front of them.
    const error = await timedOutError(guestInHost({ minimized: false, visible: true }));

    expect(error).toMatchObject({ name: 'ScreenshotNotComposited', hostState: 'visible' });
    const message = (error as Error).message;
    expect(message).not.toMatch(/not showing|is showing again|not being composited/);
    expect(message).toContain(`within ${SCREENSHOT_TIMEOUT_MS / 1000}s`);
    expect(message).toMatch(/query_dom, query_all and click/);
  });

  it.each([
    { label: 'minimized', hostWindowState: { minimized: true, visible: false } },
    { label: 'hidden', hostWindowState: { minimized: false, visible: false } },
  ])('still says Kangentic is not showing when its window is $label', async ({ label, hostWindowState }) => {
    const error = await timedOutError(guestInHost(hostWindowState));

    expect(error).toMatchObject({ name: 'ScreenshotNotComposited', hostState: label });
    const message = (error as Error).message;
    expect(message).toMatch(/not being composited/);
    expect(message).toMatch(/Kangentic is showing again/);
    expect(message).toMatch(/query_dom, query_all and click/);
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
