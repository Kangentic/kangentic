/**
 * Guards for the main-process announcements poller (src/main/announcements.ts),
 * mirroring updater-init-guard.test.ts:
 *
 * - initAnnouncements always registers its handlers (invoke never rejects
 *   with `No handler registered`), and under NODE_ENV=test schedules nothing,
 *   so no test run ever touches the network.
 * - checkAnnouncements degrades silently on every failure mode (network
 *   error, non-200, garbage JSON, unusable feed) and only pushes the changed
 *   event when the filtered active list actually changed.
 * - the local archive persists across polls, so history outlives an
 *   announcement leaving the feed, and mark-read stamps it idempotently.
 *
 * Module state (cachedActive, timers) is per-import, so each test re-imports
 * a fresh module via vi.resetModules() + dynamic import. configDir is
 * redirected to a temp dir per test, since a successful poll writes the
 * archive sidecar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const originalDataDir = process.env.KANGENTIC_DATA_DIR;

/** The archive sidecar inside the current temp data dir. */
function archivePath(): string {
  return path.join(process.env.KANGENTIC_DATA_DIR as string, 'announcements-archive.json');
}

describe('announcements poller', () => {
  let tempDataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mocks.electronMock.ipcMain.handle.mockReset();
    fakeWindowSend.mockReset();
    delete process.env.KANGENTIC_ANNOUNCEMENTS_URL;
    // A successful poll now writes the announcements archive under configDir.
    // Redirect configDir at a temp dir BEFORE importFreshModule so the
    // vi.resetModules() re-import of src/main/config/paths picks it up, and no
    // test ever writes into the developer's real %APPDATA%/kangentic.
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'announcements-poller-test-'));
    process.env.KANGENTIC_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDataDir === undefined) {
      delete process.env.KANGENTIC_DATA_DIR;
    } else {
      process.env.KANGENTIC_DATA_DIR = originalDataDir;
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
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
    const [channel, payload] = fakeWindowSend.mock.calls[0] as [
      string,
      { active: Array<{ id: string }>; history: Array<{ announcement: { id: string } }> },
    ];
    expect(channel).toBe(IPC.ANNOUNCEMENTS_CHANGED);
    // One push carries both halves, since they derive from this same poll.
    expect(payload.active.map((announcement) => announcement.id)).toEqual(['a1']);
    // History is fed from the FILTERED active list, so an announcement this
    // client was never targeted by never enters its archive.
    expect(payload.history.map((entry) => entry.announcement.id)).toEqual(['a1']);
    // ANNOUNCEMENTS_GET stays the bare active array (a zero-I/O read of the
    // in-memory cache); history has its own channel.
    expect(getHandlerResult()).toEqual(payload.active);

    // Identical feed on the next poll: no second push.
    await checkAnnouncements();
    expect(fakeWindowSend).toHaveBeenCalledTimes(1);

    // A failed poll keeps the last-known list rather than clearing it.
    fetchMock.mockRejectedValue(new Error('offline'));
    await checkAnnouncements();
    expect(getHandlerResult()).toEqual(payload.active);
  });

  it('persists the archive so history survives a restart and an emptied feed', async () => {
    process.env.NODE_ENV = 'test';
    const { initAnnouncements, updateAnnouncementsWindow, checkAnnouncements } = await importFreshModule();
    initAnnouncements(fakeWindow);
    updateAnnouncementsWindow(fakeWindow);

    fetchMock.mockResolvedValue(okJsonResponse({
      announcements: [{ id: 'a1', title: 'T', body: 'B' }],
    }));
    await checkAnnouncements();

    // Written to the configDir sidecar, unread.
    const stored = JSON.parse(fs.readFileSync(archivePath(), 'utf-8')) as Array<{
      announcement: { id: string };
      firstSeenAt: string;
      readAt: string | null;
    }>;
    expect(stored.map((entry) => entry.announcement.id)).toEqual(['a1']);
    expect(stored[0].readAt).toBeNull();
    expect(stored[0].firstSeenAt).toEqual(expect.any(String));

    // The announcement is pulled upstream. The active list empties, but the
    // archive keeps it, which is the whole reason history is a local file.
    fetchMock.mockResolvedValue(okJsonResponse({ announcements: [] }));
    await checkAnnouncements();

    const [, secondPayload] = fakeWindowSend.mock.calls[1] as [
      string,
      { active: unknown[]; history: Array<{ announcement: { id: string } }> },
    ];
    expect(secondPayload.active).toEqual([]);
    expect(secondPayload.history.map((entry) => entry.announcement.id)).toEqual(['a1']);
  });

  it('stamps readAt through the mark-read handler, idempotently', async () => {
    process.env.NODE_ENV = 'test';
    const { initAnnouncements, checkAnnouncements } = await importFreshModule();
    initAnnouncements(fakeWindow);

    fetchMock.mockResolvedValue(okJsonResponse({
      announcements: [{ id: 'a1', title: 'T', body: 'B' }],
    }));
    await checkAnnouncements();

    const markRead = mocks.electronMock.ipcMain.handle.mock.calls.find(
      (candidate) => candidate[0] === IPC.ANNOUNCEMENTS_MARK_READ,
    );
    if (!markRead) throw new Error('ANNOUNCEMENTS_MARK_READ handler was not registered');
    const invokeMarkRead = markRead[1] as (event: unknown, id: string) => void;

    invokeMarkRead(null, 'a1');
    const afterFirst = JSON.parse(fs.readFileSync(archivePath(), 'utf-8')) as Array<{ readAt: string | null }>;
    expect(afterFirst[0].readAt).toEqual(expect.any(String));

    // Re-reading an announcement must not rewrite when it was first read.
    invokeMarkRead(null, 'a1');
    const afterSecond = JSON.parse(fs.readFileSync(archivePath(), 'utf-8')) as Array<{ readAt: string | null }>;
    expect(afterSecond[0].readAt).toBe(afterFirst[0].readAt);

    // An unknown id is a no-op, not a throw: mark-read is fire-and-forget and
    // the archive may have pruned the entry.
    expect(() => invokeMarkRead(null, 'never-archived')).not.toThrow();
  });

  it('does not push to a destroyed window but still advances the cache for a later pull', async () => {
    process.env.NODE_ENV = 'test';
    const { initAnnouncements, updateAnnouncementsWindow, checkAnnouncements } = await importFreshModule();
    initAnnouncements(fakeWindow);

    // A window can be destroyed between poll cycles (e.g. macOS closed the
    // last window and the dock icon hasn't recreated one yet). Give this
    // fake its own send spy so it can't be confused with fakeWindow's.
    const destroyedSend = vi.fn();
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: destroyedSend },
    } as unknown as Electron.BrowserWindow;
    updateAnnouncementsWindow(destroyedWindow);

    const feed = { announcements: [{ id: 'a1', title: 'T', body: 'B' }] };
    fetchMock.mockResolvedValue(okJsonResponse(feed));

    await checkAnnouncements();

    // No push to a destroyed window's webContents.
    expect(destroyedSend).not.toHaveBeenCalled();
    // But the cache still advances, so ANNOUNCEMENTS_GET reflects the fresh
    // list the moment a new renderer mounts and pulls it (the "mount-time
    // pull" UI spec's path). A change that moved `cachedActive = active`
    // inside the isDestroyed guard would leave this stale until the feed
    // changed again on a later poll.
    expect(getHandlerResult()).toEqual([{ id: 'a1', title: 'T', body: 'B', links: [] }]);
  });

  it('writes the archive even when the push window is destroyed', async () => {
    // checkAnnouncements folds and writes the archive ABOVE the isDestroyed
    // guard (like cachedActive), so a destroyed window never leaves the
    // archive behind the feed. Nothing else pins that placement: moving the
    // archive fold/write inside the isDestroyed guard passes every other
    // test in this file.
    process.env.NODE_ENV = 'test';
    const { initAnnouncements, updateAnnouncementsWindow, checkAnnouncements } = await importFreshModule();
    initAnnouncements(fakeWindow);

    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    } as unknown as Electron.BrowserWindow;
    updateAnnouncementsWindow(destroyedWindow);

    const feed = { announcements: [{ id: 'a1', title: 'T', body: 'B' }] };
    fetchMock.mockResolvedValue(okJsonResponse(feed));

    await checkAnnouncements();

    expect(fs.existsSync(archivePath())).toBe(true);
    const stored = JSON.parse(fs.readFileSync(archivePath(), 'utf-8')) as Array<{
      announcement: { id: string };
    }>;
    expect(stored.map((entry) => entry.announcement.id)).toEqual(['a1']);
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
