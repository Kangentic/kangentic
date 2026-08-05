/**
 * Guards for the main-process announcements poller (src/main/announcements.ts),
 * mirroring updater-init-guard.test.ts:
 *
 * - initAnnouncements always registers the GET handler (invoke never rejects
 *   with `No handler registered`), and under NODE_ENV=test schedules nothing,
 *   so no test run ever touches the network.
 * - checkAnnouncements degrades silently on every failure mode (network
 *   error, non-200, garbage JSON, unusable feed) and only pushes the changed
 *   event when the filtered active list actually changed.
 *
 * Module state (cachedActive, timers) is per-import, so each test re-imports
 * a fresh module via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  electronMock: {
    app: { getVersion: () => '0.32.1' },
    BrowserWindow: class {},
    ipcMain: { handle: vi.fn() },
  },
}));

vi.mock('electron', () => mocks.electronMock);

import { IPC } from '../../src/shared/ipc-channels';

const fakeWindowSend = vi.fn();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: fakeWindowSend },
} as unknown as Electron.BrowserWindow;

const fetchMock = vi.fn();

async function importFreshModule() {
  vi.resetModules();
  return import('../../src/main/announcements');
}

/** The registered ANNOUNCEMENTS_GET handler's current return value. */
function getHandlerResult(): unknown {
  const call = mocks.electronMock.ipcMain.handle.mock.calls.find(
    (candidate) => candidate[0] === IPC.ANNOUNCEMENTS_GET,
  );
  if (!call) throw new Error('ANNOUNCEMENTS_GET handler was not registered');
  return (call[1] as () => unknown)();
}

function okJsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

const originalNodeEnv = process.env.NODE_ENV;

describe('announcements poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mocks.electronMock.ipcMain.handle.mockReset();
    fakeWindowSend.mockReset();
    delete process.env.KANGENTIC_ANNOUNCEMENTS_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('registers the GET handler but schedules nothing under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const { initAnnouncements } = await importFreshModule();

    initAnnouncements(fakeWindow);

    expect(getHandlerResult()).toEqual([]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('schedules the initial check outside test env', async () => {
    process.env.NODE_ENV = 'development';
    fetchMock.mockResolvedValue(okJsonResponse({ announcements: [] }));
    const { initAnnouncements, stopAnnouncementTimers } = await importFreshModule();

    initAnnouncements(fakeWindow);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The recurring 4-hour interval is created INSIDE the initial setTimeout
    // callback (checkInterval, src/main/announcements.ts), so it only exists
    // after the advance above fires that callback. stopAnnouncementTimers must
    // clear checkInterval too, not just the already-fired checkTimeout: advance
    // past a full interval and confirm no second fetch happened.
    stopAnnouncementTimers();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000; // mirrors CHECK_INTERVAL_MS
    vi.advanceTimersByTime(FOUR_HOURS_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves silently on a network error and pushes nothing', async () => {
    const { checkAnnouncements } = await importFreshModule();
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'));

    await expect(checkAnnouncements()).resolves.toBeUndefined();
    expect(fakeWindowSend).not.toHaveBeenCalled();
  });

  it('resolves silently on a non-200 response', async () => {
    const { checkAnnouncements } = await importFreshModule();
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);

    await expect(checkAnnouncements()).resolves.toBeUndefined();
    expect(fakeWindowSend).not.toHaveBeenCalled();
  });

  it('treats garbage JSON and an unusable feed like a network failure', async () => {
    const { checkAnnouncements } = await importFreshModule();

    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response);
    await expect(checkAnnouncements()).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(okJsonResponse(['bare', 'array']));
    await expect(checkAnnouncements()).resolves.toBeUndefined();

    expect(fakeWindowSend).not.toHaveBeenCalled();
  });

  it('caches the filtered active list and pushes only on change', async () => {
    process.env.NODE_ENV = 'test';
    const { initAnnouncements, updateAnnouncementsWindow, checkAnnouncements } = await importFreshModule();
    initAnnouncements(fakeWindow);
    // The test-env init path registers the handler but never wires the push
    // window; attach it explicitly so the change-push is observable.
    updateAnnouncementsWindow(fakeWindow);

    const feed = {
      announcements: [
        { id: 'a1', title: 'T', body: 'B' },
        // Filtered out for this client: version floor above the mocked 0.32.1.
        { id: 'future-only', title: 'T', body: 'B', minVersion: '99.0.0' },
      ],
    };
    fetchMock.mockResolvedValue(okJsonResponse(feed));

    await checkAnnouncements();
    expect(fakeWindowSend).toHaveBeenCalledTimes(1);
    const [channel, active] = fakeWindowSend.mock.calls[0] as [string, unknown[]];
    expect(channel).toBe(IPC.ANNOUNCEMENTS_CHANGED);
    expect((active as Array<{ id: string }>).map((announcement) => announcement.id)).toEqual(['a1']);
    expect(getHandlerResult()).toEqual(active);

    // Identical feed on the next poll: no second push.
    await checkAnnouncements();
    expect(fakeWindowSend).toHaveBeenCalledTimes(1);

    // A failed poll keeps the last-known list rather than clearing it.
    fetchMock.mockRejectedValue(new Error('offline'));
    await checkAnnouncements();
    expect(getHandlerResult()).toEqual(active);
  });

  it('honors the KANGENTIC_ANNOUNCEMENTS_URL override', async () => {
    const { checkAnnouncements } = await importFreshModule();
    process.env.KANGENTIC_ANNOUNCEMENTS_URL = 'https://localhost:9999/fixture.json';
    fetchMock.mockResolvedValue(okJsonResponse({ announcements: [] }));

    await checkAnnouncements();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://localhost:9999/fixture.json',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
