/**
 * Unit tests for the announcements store (`src/renderer/stores/announcements-store.ts`).
 *
 * tests/ui/announcements.spec.ts already exercises this store end to end
 * through the real TitleBar / AnnouncementBanner / AnnouncementDialog
 * components and a headless mock-electron-api, including markRead firing
 * over IPC and a banner-opened dialog closing when its announcement leaves
 * the active set. Two things stay structurally unreachable from that tier,
 * mirroring exactly why updater-store.test.ts exists for the sibling store:
 *
 *   - `markRead`'s `.catch(() => undefined)` swallow of a rejected IPC call.
 *     The UI mock's markRead always resolves, so no UI assertion can tell
 *     the difference between a present `.catch()` and a missing one - only
 *     an ACTUALLY-rejecting promise plus an `unhandledRejection` listener
 *     can observe that.
 *   - `receiveActive`'s `dialogSource: keptDialog ? dialogSource : null`
 *     line. `reconcileOpenDialog` itself (which announcement to keep) is
 *     fully covered as a pure function in announcements-archive.test.ts, but
 *     `dialogSource` is renderer store state Playwright cannot read
 *     directly - only the visible dialogAnnouncement is observable through
 *     the DOM.
 *
 * window.electronAPI.announcements is stubbed globally before importing the
 * store (Node, non-jsdom unit tier), following the same
 * stub-then-import-after pattern as updater-store.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Announcement, AnnouncementArchiveEntry } from '../../src/shared/announcements';

const markReadMock = vi.fn();
(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    announcements: {
      getActive: vi.fn(),
      getHistory: vi.fn(),
      markRead: markReadMock,
    },
  },
};

// Imported after the stub so the store module sees it.
import { useAnnouncementsStore } from '../../src/renderer/stores/announcements-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAnnouncement(overrides: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: `Title ${overrides.id}`,
    body: `Body ${overrides.id}`,
    links: [],
    ...overrides,
  };
}

function makeEntry(
  announcement: Announcement,
  overrides: Partial<Omit<AnnouncementArchiveEntry, 'announcement'>> = {},
): AnnouncementArchiveEntry {
  return {
    announcement,
    firstSeenAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    readAt: null,
    ...overrides,
  };
}

function resetStore(): void {
  useAnnouncementsStore.setState({
    active: [],
    history: [],
    dialogAnnouncement: null,
    dialogSource: null,
    historyOpen: false,
  });
}

beforeEach(() => {
  resetStore();
  // Restore a well-behaved markRead before every test, so a test that swaps
  // in a rejecting implementation (below) never leaks into a sibling test.
  markReadMock.mockReset().mockResolvedValue(undefined);
  (window as unknown as {
    electronAPI: { announcements: { markRead: (announcementId: string) => Promise<void> } };
  }).electronAPI.announcements.markRead = markReadMock;
});

// ---------------------------------------------------------------------------
// markRead() - the IPC failure path
// ---------------------------------------------------------------------------

describe('markRead()', () => {
  it('swallows a rejected markRead IPC call instead of leaving it unhandled', async () => {
    // A plain rejecting function, not `vi.fn().mockRejectedValue(...)`: a mock
    // built that way instruments its own returned promise for mock.results
    // tracking, which itself attaches a handler and would mask a missing
    // `.catch()` in the store - the assertion below would pass either way.
    const rejectingMarkRead = () => Promise.reject(new Error('disk full'));
    (window as unknown as {
      electronAPI: { announcements: { markRead: () => Promise<void> } };
    }).electronAPI.announcements.markRead = rejectingMarkRead;
    const announcement = makeAnnouncement({ id: 'a1' });
    useAnnouncementsStore.setState({ history: [makeEntry(announcement)] });

    // markRead() does not await the IPC call, so a synchronous
    // throw/not-throw assertion here would pass whether or not the
    // rejection is actually caught. Listen for Node's 'unhandledRejection'
    // instead: it only fires if the store's `.catch(() => undefined)` is
    // missing or broken, which is the real thing this test guards.
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      useAnnouncementsStore.getState().markRead('a1');

      // Cross a macrotask boundary so Node's unhandled-rejection check
      // (which runs after the microtask queue drains) has a chance to fire
      // before we assert on it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// receiveActive() - dialogSource reconciliation
// ---------------------------------------------------------------------------

describe('receiveActive()', () => {
  it('clears dialogSource when a banner-opened dialog is reconciled away', () => {
    const announcement = makeAnnouncement({ id: 'a1' });
    useAnnouncementsStore.setState({
      dialogAnnouncement: announcement,
      dialogSource: 'banner',
    });

    // The new active list no longer carries a1: reconcileOpenDialog closes a
    // banner-opened dialog whose announcement left the feed.
    useAnnouncementsStore.getState().receiveActive([]);

    expect(useAnnouncementsStore.getState().dialogAnnouncement).toBeNull();
    expect(useAnnouncementsStore.getState().dialogSource).toBeNull();
  });

  it('preserves dialogSource when a history-opened dialog survives the same reconciliation', () => {
    const announcement = makeAnnouncement({ id: 'a1' });
    useAnnouncementsStore.setState({
      dialogAnnouncement: announcement,
      dialogSource: 'history',
    });

    // Same input (a1 absent from the new active list) as the banner case
    // above, but a history-opened dialog is exempt: it must survive with its
    // source intact.
    useAnnouncementsStore.getState().receiveActive([]);

    expect(useAnnouncementsStore.getState().dialogAnnouncement).toEqual(announcement);
    expect(useAnnouncementsStore.getState().dialogSource).toBe('history');
  });
});
