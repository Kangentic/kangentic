/**
 * The app icon badge as each platform draws it. What a user loses without these: a
 * taskbar count that stays on after the last waiting agent answers, a stale count
 * that lands after a newer one, an overlay that never comes back after Explorer
 * restarts, a badge put on a main window that was rebuilt and destroyed, and a Dock
 * or launcher count that is not the number waiting.
 *
 * Tier: Unit. The real display runs over a fake window and a stand-in electron `app`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const electronApp = vi.hoisted(() => ({ setBadgeCount: vi.fn() }));
vi.mock('electron', () => ({ app: electronApp, nativeImage: {} }));

const overlay = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../src/main/notifications/badge-overlay-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/notifications/badge-overlay-image')>()),
  loadOverlayImage: overlay.load,
}));

import { createAppBadgeDisplay } from '../../src/main/notifications/app-badge-display';

class FakeWindow {
  destroyed = false;
  readonly webContents = {};
  readonly setOverlayIcon = vi.fn();
  readonly listeners = new Map<string, Array<() => void>>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(eventName: string, listener: () => void): void {
    this.listeners.set(eventName, [...(this.listeners.get(eventName) ?? []), listener]);
  }
  emit(eventName: string): void {
    for (const listener of this.listeners.get(eventName) ?? []) listener();
  }
  get listenerCounts(): Record<string, number> {
    return Object.fromEntries([...this.listeners].map(([eventName, listeners]) => [eventName, listeners.length]));
  }
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

const originalPlatform = process.platform;
function forcePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  electronApp.setBadgeCount.mockClear();
  overlay.load.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  forcePlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe('createAppBadgeDisplay on Windows', () => {
  const imageForThree = { label: 'image-for-3' };

  beforeEach(() => {
    forcePlatform('win32');
    overlay.load.mockImplementation(async (_webContents: unknown, label: string) => ({ label: `image-for-${label}` }));
  });

  it('draws the count as an overlay with a description naming how many wait', async () => {
    const window = new FakeWindow();
    createAppBadgeDisplay(() => asBrowserWindow(window)).show(3);
    await settle();

    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(window.setOverlayIcon).toHaveBeenCalledWith(imageForThree, expect.stringContaining('3'));
    expect(electronApp.setBadgeCount).not.toHaveBeenCalled();
  });

  it('clears the overlay when the count falls to 0, without drawing anything', async () => {
    const window = new FakeWindow();
    const display = createAppBadgeDisplay(() => asBrowserWindow(window));
    display.show(3);
    await settle();
    overlay.load.mockClear();

    display.show(0);

    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(overlay.load).not.toHaveBeenCalled();
  });

  it('does not apply a slow draw for 3 after the count has fallen to 0', async () => {
    const window = new FakeWindow();
    let finishDrawing: (image: unknown) => void = () => undefined;
    overlay.load.mockImplementationOnce(() => new Promise((resolve) => { finishDrawing = resolve; }));
    const display = createAppBadgeDisplay(() => asBrowserWindow(window));

    display.show(3);
    display.show(0);
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '');

    finishDrawing(imageForThree);
    await settle();

    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(window.setOverlayIcon).not.toHaveBeenCalledWith(imageForThree, expect.anything());
  });

  it('clears the overlay when the draw fails, and reports it', async () => {
    const window = new FakeWindow();
    overlay.load.mockRejectedValueOnce(new Error('renderer gone'));

    createAppBadgeDisplay(() => asBrowserWindow(window)).show(2);
    await settle();

    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(console.error).toHaveBeenCalled();
  });

  it('does not clear a newer count when an older draw fails', async () => {
    const window = new FakeWindow();
    let failOlderDraw: (error: Error) => void = () => undefined;
    overlay.load.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOlderDraw = reject; }));
    const display = createAppBadgeDisplay(() => asBrowserWindow(window));

    display.show(2);
    display.show(4);
    await settle();
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith({ label: 'image-for-4' }, expect.any(String));

    failOlderDraw(new Error('late failure'));
    await settle();

    expect(window.setOverlayIcon).toHaveBeenLastCalledWith({ label: 'image-for-4' }, expect.any(String));
  });

  it('puts the same overlay back when the window shows or takes focus, with listeners attached once', async () => {
    const window = new FakeWindow();
    const display = createAppBadgeDisplay(() => asBrowserWindow(window));
    display.show(3);
    await settle();
    display.show(3);
    await settle();
    display.show(3);
    await settle();
    expect(window.listenerCounts).toEqual({ show: 1, focus: 1 });
    window.setOverlayIcon.mockClear();

    window.emit('show');
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(imageForThree, expect.stringContaining('3'));

    window.emit('focus');
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(2);
  });

  it('attaches no listener before the first overlay, since there is nothing to put back', async () => {
    const window = new FakeWindow();
    createAppBadgeDisplay(() => asBrowserWindow(window)).show(0);
    await settle();

    expect(window.listenerCounts).toEqual({});
  });

  it('puts the next count on a rebuilt main window and attaches its listeners there, not on the destroyed one', async () => {
    const oldWindow = new FakeWindow();
    const newWindow = new FakeWindow();
    let currentWindow = oldWindow;
    const display = createAppBadgeDisplay(() => asBrowserWindow(currentWindow));
    display.show(1);
    await settle();
    expect(oldWindow.listenerCounts).toEqual({ show: 1, focus: 1 });

    oldWindow.destroyed = true;
    currentWindow = newWindow;
    display.show(2);
    await settle();

    expect(newWindow.setOverlayIcon).toHaveBeenCalledWith({ label: 'image-for-2' }, expect.stringContaining('2'));
    expect(newWindow.listenerCounts).toEqual({ show: 1, focus: 1 });
    expect(oldWindow.listenerCounts).toEqual({ show: 1, focus: 1 });
    expect(oldWindow.setOverlayIcon).toHaveBeenCalledTimes(1);
  });
});

describe('createAppBadgeDisplay off Windows', () => {
  it.each<NodeJS.Platform>(['darwin', 'linux'])('sets the system badge count on %s and draws no overlay', (platform) => {
    forcePlatform(platform);
    const window = new FakeWindow();
    const display = createAppBadgeDisplay(() => asBrowserWindow(window));

    display.show(4);
    display.show(0);

    expect(electronApp.setBadgeCount.mock.calls).toEqual([[4], [0]]);
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
    expect(overlay.load).not.toHaveBeenCalled();
  });
});
