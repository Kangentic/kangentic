/**
 * An agent's screenshot of a pane nobody can see. The measurement behind the hold
 * is in `src/main/browser/cdp/guest-capture-hold.ts`; no unit tier has a composited
 * guest, so these pin the shape it depends on: the hold covers both the guest and
 * the host, it overlaps the capture, it ends with it, and it stays off the one host
 * where it would leak.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));

import { BrowserWindow, type WebContents } from 'electron';
import { holdGuestRendering } from '../../src/main/browser/cdp/guest-capture-hold';
import { captureScreenshot, SCREENSHOT_TIMEOUT_MS } from '../../src/main/browser/cdp/cdp';

interface HostState {
  minimized?: boolean;
  visible?: boolean;
}

function hostWindow({ minimized = false, visible = true }: HostState = {}): void {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
    isMinimized: () => minimized,
    isVisible: () => visible,
  } as never);
}

/**
 * A guest whose `capturePage` calls settle as the test decides. The host's calls
 * behave like the guest's unless `hostCapturePage` says otherwise.
 */
function fakeGuest(
  capturePage: () => Promise<unknown>,
  sendCommand: () => Promise<unknown> = async () => ({ data: 'PNG' }),
  hostCapturePage: () => Promise<unknown> = capturePage,
) {
  const capturePageSpy = vi.fn(capturePage);
  const hostCapturePageSpy = vi.fn(hostCapturePage);
  const guest = {
    hostWebContents: { isDestroyed: () => false, capturePage: hostCapturePageSpy },
    isDestroyed: () => false,
    capturePage: capturePageSpy,
    debugger: { sendCommand },
  } as unknown as WebContents;
  return { guest, capturePageSpy, hostCapturePageSpy };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(BrowserWindow.fromWebContents).mockReset();
});

describe('holdGuestRendering', () => {
  it('keeps asking for as long as the capture runs, and stops when it ends', async () => {
    // One call before the capture is the version that failed: it passed a plain
    // capture and hung a clip, a full page and a jpeg on a minimized host, because
    // it had finished before they needed frames.
    vi.useFakeTimers();
    hostWindow({ minimized: true, visible: false });
    const { guest, capturePageSpy, hostCapturePageSpy } = fakeGuest(async () => ({}));

    const hold = holdGuestRendering(guest);
    expect(hold).toMatchObject({ outcome: 'armed', hostState: 'minimized' });
    await vi.advanceTimersByTimeAsync(100);
    expect(capturePageSpy.mock.calls.length).toBeGreaterThan(3);
    expect(hostCapturePageSpy.mock.calls.length).toBeGreaterThan(3);

    hold.end();
    const guestAtEnd = capturePageSpy.mock.calls.length;
    const hostAtEnd = hostCapturePageSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(capturePageSpy).toHaveBeenCalledTimes(guestAtEnd);
    expect(hostCapturePageSpy).toHaveBeenCalledTimes(hostAtEnd);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks for the guest to show and never for the system to stay awake', () => {
    vi.useFakeTimers();
    hostWindow();
    const { guest, capturePageSpy } = fakeGuest(async () => ({}));

    holdGuestRendering(guest).end();

    expect(capturePageSpy).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1, height: 1 },
      { stayHidden: false, stayAwake: false },
    );
  });

  it('holds the host without showing it, and never asks the system to stay awake', () => {
    // Guest alone hung every capture in the real app with the renderer hidden. A
    // host held with `stayHidden: false` worked, and flipped Kangentic's own
    // `visibilityState` four times inside one capture.
    vi.useFakeTimers();
    hostWindow();
    const { guest, hostCapturePageSpy } = fakeGuest(async () => ({}));

    holdGuestRendering(guest).end();

    expect(hostCapturePageSpy).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1, height: 1 },
      { stayHidden: true, stayAwake: false },
    );
  });

  it('runs behind a covered host, which still reports itself visible', () => {
    vi.useFakeTimers();
    hostWindow({ visible: true });
    const { guest, capturePageSpy } = fakeGuest(async () => ({}));
    const hold = holdGuestRendering(guest);
    hold.end();
    expect(capturePageSpy).toHaveBeenCalled();
    expect(hold).toMatchObject({ outcome: 'armed', hostState: 'visible' });
  });

  it('stays off a host hidden outright, where a call would never settle', () => {
    // Measured: every `capturePage` hung here, and each keeps its capturer count
    // until the window shows again. Only the quit path and macOS Cmd+H reach it.
    vi.useFakeTimers();
    hostWindow({ visible: false, minimized: false });
    const { guest, capturePageSpy, hostCapturePageSpy } = fakeGuest(async () => ({}));

    const hold = holdGuestRendering(guest);
    hold.end();

    expect(hold).toMatchObject({ outcome: 'skipped_hidden', hostState: 'hidden' });
    expect(capturePageSpy).not.toHaveBeenCalled();
    expect(hostCapturePageSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds nothing when the host has no window to read, since that reads as hidden', () => {
    vi.useFakeTimers();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never);
    const { guest, capturePageSpy, hostCapturePageSpy } = fakeGuest(async () => ({}));

    const hold = holdGuestRendering(guest);
    hold.end();

    expect(hold).toMatchObject({ outcome: 'skipped_hidden', hostState: 'none' });
    expect(capturePageSpy).not.toHaveBeenCalled();
    expect(hostCapturePageSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops stacking calls that are not settling', async () => {
    // A host hidden mid-capture would otherwise add a call every interval until
    // the capture's own 5s bound, each holding a count nothing can release.
    vi.useFakeTimers();
    hostWindow();
    const { guest, capturePageSpy, hostCapturePageSpy } = fakeGuest(() => new Promise(() => undefined));

    const hold = holdGuestRendering(guest);
    await vi.advanceTimersByTimeAsync(1000);
    hold.end();

    expect(capturePageSpy).toHaveBeenCalledTimes(2);
    expect(hostCapturePageSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows a call that rejects, since the capture reports its own result', async () => {
    vi.useFakeTimers();
    hostWindow();
    const { guest, capturePageSpy } = fakeGuest(() => Promise.reject(new Error('no surface')));

    const hold = holdGuestRendering(guest);
    await vi.advanceTimersByTimeAsync(40);
    hold.end();

    expect(capturePageSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('passes straight through for a surface with no host: a lane, or Kangentic itself', () => {
    const capturePage = vi.fn();
    const hold = holdGuestRendering({ capturePage } as unknown as WebContents);
    hold.end();
    expect(capturePage).not.toHaveBeenCalled();
    expect(hold).toMatchObject({ outcome: 'no_host', hostState: 'none' });
  });
});

describe('captureScreenshot holds the guest for the capture', () => {
  it('starts before the capture and ends with it', async () => {
    vi.useFakeTimers();
    hostWindow({ minimized: true, visible: false });
    const order: string[] = [];
    const { guest, capturePageSpy } = fakeGuest(
      async () => { order.push('hold'); },
      async () => { order.push('capture'); return { data: 'PNG' }; },
    );

    await expect(captureScreenshot(guest)).resolves.toBe('PNG');

    expect(order[0]).toBe('hold');
    expect(order).toContain('capture');
    const atEnd = capturePageSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(capturePageSpy).toHaveBeenCalledTimes(atEnd);
  });

  it('ends the hold when the debugger throws synchronously', async () => {
    vi.useFakeTimers();
    hostWindow();
    const { guest, capturePageSpy } = fakeGuest(async () => ({}), () => { throw new Error('debugger detached'); });

    await expect(captureScreenshot(guest)).rejects.toThrow('debugger detached');

    const atEnd = capturePageSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(capturePageSpy).toHaveBeenCalledTimes(atEnd);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the hold when the capture times out', async () => {
    vi.useFakeTimers();
    hostWindow();
    const { guest, capturePageSpy } = fakeGuest(async () => ({}), () => new Promise(() => undefined));

    const pending = captureScreenshot(guest);
    // The error carries what the hold did, for the driver's report (DESKTOP-46).
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ScreenshotNotComposited',
      message: expect.stringMatching(/drew no frame/),
      hold: 'armed',
      hostState: 'visible',
      hostHold: 'settled',
      guestHold: 'settled',
    });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    await assertion;

    const atEnd = capturePageSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(capturePageSpy).toHaveBeenCalledTimes(atEnd);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a capture that timed out says whether the hold was answered (DESKTOP-46)', () => {
  // The second DESKTOP-46 event armed the hold on a visible host and still got no
  // frame. These tell "the host compositor stopped" (the hold's own calls never
  // returned) from "the hold was answered and CDP's capture still hung".
  const NEVER = (): Promise<unknown> => new Promise(() => undefined);
  const ANSWERED = async (): Promise<unknown> => ({});

  /** `hostState: null` is a host with no window to read. */
  async function timeOut(
    guestCapturePage: () => Promise<unknown>,
    hostCapturePage: () => Promise<unknown>,
    hostState: HostState | null = {},
  ) {
    vi.useFakeTimers();
    if (hostState) hostWindow(hostState);
    else vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    const { guest } = fakeGuest(guestCapturePage, NEVER, hostCapturePage);
    const pending = captureScreenshot(guest);
    const settledError = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    return settledError;
  }

  it.each([
    { label: 'neither side answered', guest: NEVER, host: NEVER, guestHold: 'none', hostHold: 'none' },
    { label: 'both sides answered', guest: ANSWERED, host: ANSWERED, guestHold: 'settled', hostHold: 'settled' },
    { label: 'only the guest answered', guest: ANSWERED, host: NEVER, guestHold: 'settled', hostHold: 'none' },
    { label: 'only the host answered', guest: NEVER, host: ANSWERED, guestHold: 'none', hostHold: 'settled' },
  ] as const)('reports $label', async ({ guest, host, guestHold, hostHold }) => {
    await expect(timeOut(guest, host)).resolves.toMatchObject({
      name: 'ScreenshotNotComposited',
      hold: 'armed',
      hostHold,
      guestHold,
    });
  });

  it('counts a hold call that rejected as answered, since the compositor returned', async () => {
    const rejected = (): Promise<unknown> => Promise.reject(new Error('no surface'));
    await expect(timeOut(rejected, rejected)).resolves.toMatchObject({ hostHold: 'settled', guestHold: 'settled' });
  });

  it('carries the settlement on a minimized host too, the other armed case', async () => {
    await expect(timeOut(ANSWERED, NEVER, { minimized: true })).resolves.toMatchObject({
      hold: 'armed',
      hostState: 'minimized',
      hostHold: 'none',
      guestHold: 'settled',
    });
  });

  it.each([
    { label: 'a host window hidden outright', hostState: { visible: false }, expectedHostState: 'hidden' },
    { label: 'a host with no window', hostState: null, expectedHostState: 'none' },
  ] as const)('reports none on both sides for a hold that never armed: $label', async ({ hostState, expectedHostState }) => {
    // Both hold calls would answer, so `none` can only come from the hold never arming.
    await expect(timeOut(ANSWERED, ANSWERED, hostState)).resolves.toMatchObject({
      hold: 'skipped_hidden',
      hostState: expectedHostState,
      hostHold: 'none',
      guestHold: 'none',
    });
  });
});
