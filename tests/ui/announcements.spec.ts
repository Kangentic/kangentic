/**
 * UI tests for the in-app announcements surface: the dismissible banner strip
 * above the board content, the "Learn more" dialog (markdown body, QR image,
 * external-link buttons), and dismissal persistence into global config
 * (dismissedAnnouncementIds).
 *
 * The active list is driven through the mock's eager
 * `__mockFireAnnouncementsChanged(active)` hook, which feeds the same
 * `announcements.onChanged` push App.tsx subscribes to at mount. Each test
 * seeds its own announcements with UNIQUE ids: dismissals persist in the
 * mock's global config for the life of the worker's page, so reusing an id
 * across tests would leak a dismissal into a later test.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady } from './helpers';
import type { Browser, Page } from '@playwright/test';
import type { AppConfig } from '../../src/shared/types';
import type { Announcement } from '../../src/shared/announcements';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Announcements Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

function makeAnnouncement(overrides: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: `Title for ${overrides.id}`,
    body: `Body for ${overrides.id}`,
    links: [],
    ...overrides,
  };
}

/** An archive entry as the mock stores it, mirroring AnnouncementArchiveEntry. */
interface HistoryEntry {
  announcement: Announcement;
  firstSeenAt: string;
  readAt: string | null;
}

function makeHistoryEntry(
  announcement: Announcement,
  overrides: Partial<Omit<HistoryEntry, 'announcement'>> = {},
): HistoryEntry {
  return {
    announcement,
    firstSeenAt: new Date().toISOString(),
    readAt: null,
    ...overrides,
  };
}

/**
 * Fires the announcements-changed push once App.tsx's subscriber is attached.
 * Firing before the mount-effect subscription registers would be a silent
 * no-op (the eager mock hook tolerates zero listeners), so wait for it.
 *
 * The push carries `{ active, history }`. Omitting `history` lets the mock
 * derive one unread entry per active announcement, which is what a real poll
 * produces; pass it explicitly to model already-read or no-longer-active
 * entries. Each fire REPLACES the history wholesale, so a test's badge count
 * never inherits from an earlier test on the same worker page.
 */
async function fireAnnouncements(
  active: Announcement[],
  history?: HistoryEntry[],
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() =>
      (window as unknown as { __mockAnnouncementsChangedListeners: unknown[] })
        .__mockAnnouncementsChangedListeners.length))
    .toBeGreaterThan(0);
  await page.evaluate(({ activeList, historyList }) => {
    (window as unknown as {
      __mockFireAnnouncementsChanged: (active: unknown[], history?: unknown[]) => void;
    }).__mockFireAnnouncementsChanged(activeList, historyList);
  }, {
    activeList: active as unknown as unknown[],
    historyList: history as unknown as unknown[] | undefined,
  });
}

async function getGlobalConfig(): Promise<AppConfig> {
  return page.evaluate(async () => window.electronAPI.config.getGlobal());
}

test.describe('Announcements banner and dialog', () => {
  test('banner shows the pushed announcement title and clears when the feed empties', async () => {
    const announcement = makeAnnouncement({ id: `banner-basic-${Date.now()}` });
    await fireAnnouncements([announcement]);

    const banner = page.locator('[data-testid="announcement-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(announcement.title);

    // A retracted feed (announcement removed or expired upstream) clears the
    // banner without any user action.
    await fireAnnouncements([]);
    await expect(banner).toHaveCount(0);
  });

  test('Learn more opens the dialog with markdown, sections, per-link QR, and recorded external link', async () => {
    const id = `dialog-${Date.now()}`;
    const announcement = makeAnnouncement({
      id,
      title: 'Kangentic Mobile status',
      body: 'Status of **both platforms** below.',
      sections: [
        { heading: 'iOS: in App Store review', body: 'Nothing to do yet.' },
        {
          heading: 'Android: closed testing',
          body: 'Two steps to join.',
          links: [{ label: 'Become a tester', url: 'https://play.google.com/apps/testing/com.kangentic.mobile', qr: true }],
        },
      ],
      links: [{ label: 'Read the blog post', url: 'https://kangentic.com/blog' }],
    });
    await fireAnnouncements([announcement]);

    await page.locator('[data-testid="announcement-learn-more"]').click();
    const dialog = page.locator('[data-testid="announcement-dialog"]');
    await expect(dialog).toBeVisible();

    // MarkdownRenderer output, not raw markdown: the ** delimiters became a tag.
    await expect(dialog.locator('strong', { hasText: 'both platforms' })).toBeVisible();

    // Both sections render with their headings, in authored order.
    const sections = dialog.locator('[data-testid="announcement-section"]');
    await expect(sections).toHaveCount(2);
    await expect(sections.nth(0)).toContainText('iOS: in App Store review');
    await expect(sections.nth(1)).toContainText('Android: closed testing');

    // Exactly ONE QR: the qr-flagged section link. The plain announcement-level
    // link renders as a pill only - QR is per-link opt-in, not a default.
    const qrImages = dialog.locator('[data-testid="announcement-qr"]');
    await expect(qrImages).toHaveCount(1);
    await expect(qrImages).toHaveAttribute('src', /^data:/);
    await expect(dialog.locator('[data-testid="announcement-link"]')).toHaveCount(2);

    await page.evaluate(() => {
      window.__openedExternalUrls = [];
    });
    await sections.nth(1).locator('[data-testid="announcement-link"]').click();
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual(['https://play.google.com/apps/testing/com.kangentic.mobile']);

    await dialog.locator('[data-testid="announcement-close"]').click();
    await expect(dialog).toHaveCount(0);

    // Leave no banner behind for tests sharing this worker's page.
    await fireAnnouncements([]);
  });

  test('the dialog auto-closes when its announcement leaves the active set, with no Close click', async () => {
    const announcement = makeAnnouncement({ id: `dialog-retract-${Date.now()}` });
    await fireAnnouncements([announcement]);

    await page.locator('[data-testid="announcement-learn-more"]').click();
    const dialog = page.locator('[data-testid="announcement-dialog"]');
    await expect(dialog).toBeVisible();

    // The feed retracts the announcement (expired or withdrawn upstream)
    // without the user ever clicking Close. receiveActive must reconcile the
    // open dialog against the new active set and close it.
    await fireAnnouncements([]);
    await expect(dialog).toHaveCount(0);
  });

  test('a realistic multi-QR sectioned announcement fits the dialog without a scrollbar', async () => {
    // Authoring contract: an announcement must never scroll. The QR grid lays
    // multiple QRs side by side precisely so this holds; this assertion is the
    // tripwire against a layout change quietly re-stacking them. Asserted at a
    // common desktop size, since the safety-valve scroll is still allowed on
    // very small windows.
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 1920, height: 1080 });
    try {
      const announcement = makeAnnouncement({
        id: `no-scroll-${Date.now()}`,
        title: 'Kangentic Mobile is almost here - iOS in review, Android in beta',
        body: 'The mobile companion app is on its way to both stores. Here is where each platform stands, and how you can help.',
        sections: [
          {
            heading: 'iOS: in App Store review',
            body: 'The iOS app has been submitted and is with Apple for review. Nothing to do yet - we will post a new announcement here the moment it is live on the App Store.',
          },
          {
            heading: 'Android: open for beta testers',
            body: 'Help us test on Android - two steps: join the testers group, then become a tester and install the app. Use the Google account your phone Play Store is signed into.',
            links: [
              { label: 'Join the testers Google Group', url: 'https://groups.google.com/g/kangentic-testers', qr: true },
              { label: 'Become a tester on Google Play', url: 'https://play.google.com/apps/testing/com.kangentic.mobile', qr: true },
            ],
          },
          {
            heading: 'After installing: pair your desktop',
            body: 'Enable Mobile Bridge in Settings and click Pair a Device, then scan the QR with the app.',
            links: [{ label: 'Kangentic Mobile docs', url: 'https://kangentic.com/mobile/' }],
          },
        ],
      });
      await fireAnnouncements([announcement]);

      await page.locator('[data-testid="announcement-learn-more"]').click();
      const content = page.locator('[data-testid="announcement-dialog-content"]');
      await expect(content).toBeVisible();
      // Both QRs render side by side (the grid), and the content area does not
      // overflow its box. +1 tolerates sub-pixel rounding differences between
      // Windows and CI's headless Linux.
      await expect(page.locator('[data-testid="announcement-qr"]')).toHaveCount(2);
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeLessThanOrEqual(1);

      await page.locator('[data-testid="announcement-close"]').click();
      await fireAnnouncements([]);
    } finally {
      if (originalViewport) await page.setViewportSize(originalViewport);
    }
  });

  test('dismiss persists the id to global config and promotes the next announcement', async () => {
    const stamp = Date.now();
    const first = makeAnnouncement({ id: `dismiss-first-${stamp}`, priority: 5 });
    const second = makeAnnouncement({ id: `dismiss-second-${stamp}` });
    await fireAnnouncements([first, second]);

    const banner = page.locator('[data-testid="announcement-banner"]');
    await expect(banner).toContainText(first.title);

    await page.locator('[data-testid="announcement-dismiss"]').click();

    // The next non-dismissed announcement takes the single banner slot.
    await expect(banner).toContainText(second.title);
    await expect
      .poll(async () => (await getGlobalConfig()).dismissedAnnouncementIds)
      .toContain(first.id);

    await page.locator('[data-testid="announcement-dismiss"]').click();
    await expect(banner).toHaveCount(0);
    await expect
      .poll(async () => (await getGlobalConfig()).dismissedAnnouncementIds)
      .toContain(second.id);

    // The prune-on-write in computeDismissedIdsAfterDismiss must RETAIN a
    // previously-dismissed id whose announcement is still in the active set
    // (only ids that dropped out of the active feed get pruned). Both `first`
    // and `second` are still active, so both dismissed ids should survive
    // the second dismissal's write.
    expect((await getGlobalConfig()).dismissedAnnouncementIds).toContain(first.id);
  });
});

test.describe('Announcements megaphone and history', () => {
  const megaphone = () => page.locator('[data-testid="announcements-button"]');
  const badge = () => page.locator('[data-testid="announcements-unread-badge"]');
  const historyDialog = () => page.locator('[data-testid="announcement-history-dialog"]');
  const historyRows = () => page.locator('[data-testid="announcement-history-row"]');

  test('the megaphone badges unread entries and clears as each is read', async () => {
    const stamp = Date.now();
    const unread = makeAnnouncement({ id: `badge-unread-${stamp}` });
    const alsoUnread = makeAnnouncement({ id: `badge-unread-2-${stamp}` });
    const alreadyRead = makeAnnouncement({ id: `badge-read-${stamp}` });
    await fireAnnouncements([unread, alsoUnread, alreadyRead], [
      makeHistoryEntry(unread),
      makeHistoryEntry(alsoUnread),
      makeHistoryEntry(alreadyRead, { readAt: new Date().toISOString() }),
    ]);

    // Two of three unread. The button itself is permanent, the badge is not.
    await expect(megaphone()).toBeVisible();
    await expect(badge()).toContainText('2');

    await megaphone().click();
    await expect(historyDialog()).toBeVisible();
    await expect(historyRows()).toHaveCount(3);

    // Reading one drops the count without waiting on an IPC round-trip.
    await historyRows().first().click();
    await expect(page.locator('[data-testid="announcement-dialog"]')).toBeVisible();
    await expect(badge()).toContainText('1');

    // The history list stays up underneath, so closing returns to it.
    await page.locator('[data-testid="announcement-close"]').click();
    await expect(historyDialog()).toBeVisible();
    await expect(historyRows().first()).toHaveAttribute('data-unread', 'false');

    await historyRows().nth(1).click();
    await page.locator('[data-testid="announcement-close"]').click();
    // Nothing unread left: the badge unmounts entirely rather than showing 0.
    await expect(badge()).toHaveCount(0);
    await expect(megaphone()).toBeVisible();

    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await expect(historyDialog()).toHaveCount(0);
    await fireAnnouncements([]);
  });

  test('history lists announcements that are no longer active, and the banner never showed', async () => {
    const stamp = Date.now();
    const retired = makeAnnouncement({ id: `history-retired-${stamp}`, title: 'Retired announcement' });
    // Empty active list with a non-empty archive: exactly the state of a fresh
    // launch before the first poll, and of an announcement deleted upstream.
    await fireAnnouncements([], [makeHistoryEntry(retired, { readAt: new Date().toISOString() })]);

    await expect(page.locator('[data-testid="announcement-banner"]')).toHaveCount(0);

    await megaphone().click();
    await expect(historyRows()).toHaveCount(1);
    await expect(historyRows().first()).toContainText('Retired announcement');
    // The row opens the announcement, so it carries a disclosure chevron, and it
    // is drawn WITHOUT hovering (ui-conventions.md bans hover-only affordances).
    // Asserted with no preceding hover, which is the whole point of the check.
    await expect(historyRows().first().locator('svg')).toBeVisible();
    // toBeVisible() reads box size and visibility/display, NOT computed
    // opacity, so it would still pass against the `opacity-0
    // group-hover:opacity-100` reveal ui-conventions.md actually bans. Read the
    // opacity back explicitly, still with no hover, or the ban is unpinned.
    await expect
      .poll(() => historyRows().first().locator('svg')
        .evaluate((element) => Number(getComputedStyle(element).opacity)))
      .toBeGreaterThan(0);
    // last:border-b-0: the sole row draws no trailing rule, so a one-entry
    // archive does not read as a section header over a blank panel.
    await expect(historyRows().first()).toHaveCSS('border-bottom-width', '0px');

    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await fireAnnouncements([]);
  });

  test('an announcement opened from history survives a poll that drops it', async () => {
    // The trap this feature had to design around: receiveActive closes an open
    // dialog whose announcement left the active set, and loadActive routes
    // through it too, so in dev this fires on EVERY renderer edit. A
    // history-opened dialog must be exempt.
    const stamp = Date.now();
    const expired = makeAnnouncement({ id: `history-survives-${stamp}`, title: 'Opened from history' });
    await fireAnnouncements([expired]);

    await megaphone().click();
    await historyRows().first().click();
    const dialog = page.locator('[data-testid="announcement-dialog"]');
    await expect(dialog).toBeVisible();

    // The feed drops it entirely while the dialog is open.
    await fireAnnouncements([], [makeHistoryEntry(expired, { readAt: new Date().toISOString() })]);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Opened from history');

    await page.locator('[data-testid="announcement-close"]').click();
    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await fireAnnouncements([]);
  });

  test('Escape closes only the layered announcement dialog, leaving the history list up', async () => {
    // Both dialogs register a bubble-phase Escape listener on `document`, and
    // the first registered (the history list) would otherwise win, dismissing
    // the LIST and orphaning the announcement on top of nothing.
    const announcement = makeAnnouncement({ id: `history-escape-${Date.now()}` });
    await fireAnnouncements([announcement]);

    await megaphone().click();
    await historyRows().first().click();
    const dialog = page.locator('[data-testid="announcement-dialog"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(historyDialog()).toBeVisible();

    // A second Escape, now unsuppressed, closes the list.
    await page.keyboard.press('Escape');
    await expect(historyDialog()).toHaveCount(0);
    await fireAnnouncements([]);
  });

  test('a dismissed announcement stays unread, so the badge keeps counting it', async () => {
    // Dismissed hides the banner; read silences the badge. They are separate
    // states in separate stores, and dismissing must not imply reading.
    const stamp = Date.now();
    const first = makeAnnouncement({ id: `badge-dismissed-${stamp}`, priority: 5 });
    const second = makeAnnouncement({ id: `badge-dismissed-2-${stamp}` });
    await fireAnnouncements([first, second]);
    await expect(badge()).toContainText('2');

    await page.locator('[data-testid="announcement-dismiss"]').click();
    await expect(page.locator('[data-testid="announcement-banner"]')).toContainText(second.title);
    // Banner moved on, badge did not: the first is dismissed but still unread.
    await expect(badge()).toContainText('2');

    await page.locator('[data-testid="announcement-dismiss"]').click();
    await expect(page.locator('[data-testid="announcement-banner"]')).toHaveCount(0);
    // Both dismissed, neither opened. The megaphone is now the ONLY way to
    // reach them, and it still says there are two unread.
    await expect(badge()).toContainText('2');

    await megaphone().click();
    await expect(historyRows()).toHaveCount(2);
    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await fireAnnouncements([]);
  });

  test('the banner marks read durably even before the local archive has loaded', async () => {
    // Mount fires loadActive() and loadHistory() together without awaiting, so
    // after a renderer reload the banner (served from main's already-warm
    // cachedActive) can render and be clicked while the archive read is still
    // in flight. Modelled here as active-with-empty-history. The mark-read IPC
    // must still go out, or that read is silently lost forever: main owns the
    // durable archive and the renderer's copy is only a cache.
    const announcement = makeAnnouncement({ id: `read-before-history-${Date.now()}` });
    await page.evaluate(() => {
      (window as unknown as { __mockAnnouncementMarkReadCalls: string[] })
        .__mockAnnouncementMarkReadCalls = [];
    });
    await fireAnnouncements([announcement], []);
    await expect(badge()).toHaveCount(0);

    await page.locator('[data-testid="announcement-learn-more"]').click();
    await expect(page.locator('[data-testid="announcement-dialog"]')).toBeVisible();

    await expect
      .poll(() => page.evaluate(() =>
        (window as unknown as { __mockAnnouncementMarkReadCalls: string[] })
          .__mockAnnouncementMarkReadCalls))
      .toEqual([announcement.id]);

    await page.locator('[data-testid="announcement-close"]').click();
    await fireAnnouncements([]);
  });

  test('the badge stays clear of its neighbours and never clips a 2-digit count', async () => {
    // The badge is overlaid on a 20px glyph inside a 32px button, so its size
    // and offsets are bounded on every side: too big or pulled too far and it
    // either buries the megaphone (the bug this replaced), clips off the top of
    // the title bar, or lands on Quick Find.
    const stamp = Date.now();
    await fireAnnouncements([], Array.from({ length: 12 }, (_unused, index) =>
      makeHistoryEntry(makeAnnouncement({ id: `badge-geometry-${stamp}-${index}` }))));
    await expect(badge()).toContainText('12');

    const boxes = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="announcements-button"]');
      const badge = document.querySelector('[data-testid="announcements-unread-badge"]');
      const badgeElement = badge?.querySelector('span');
      // Read the neighbour off the DOM rather than naming it: this button has
      // moved along the row before, and the invariant is about whatever
      // actually sits to its right, not about one specific control.
      const neighbour = button?.nextElementSibling ?? null;
      return {
        button: button ? button.getBoundingClientRect().toJSON() : null,
        badge: badge ? badge.getBoundingClientRect().toJSON() : null,
        neighbour: neighbour ? neighbour.getBoundingClientRect().toJSON() : null,
        clipped: badgeElement
          ? badgeElement.scrollWidth > badgeElement.clientWidth + 1
          : true,
      };
    });

    if (!boxes.button || !boxes.badge || !boxes.neighbour) throw new Error('missing element');
    // A 2-digit count widens the pill rather than clipping its own text.
    expect(boxes.clipped).toBe(false);
    // Stays inside the title bar rather than being cut off at the top.
    expect(boxes.badge.top).toBeGreaterThanOrEqual(0);
    // Does not reach into whatever button sits to its right.
    expect(boxes.badge.right).toBeLessThanOrEqual(boxes.neighbour.left);
    // Still small relative to the glyph it sits on, so the megaphone reads.
    expect(boxes.badge.height).toBeLessThanOrEqual(16);

    await fireAnnouncements([]);
  });

  test('the history list grows to its content, then caps and scrolls', async () => {
    // The dialog is max-h, not a fixed height, so a one-entry archive is a
    // small box rather than a mostly-empty 60vh one. This pins both ends of
    // that: it must still cap and scroll once the archive is long.
    const stamp = Date.now();
    const one = makeAnnouncement({ id: `scroll-one-${stamp}` });
    await fireAnnouncements([], [makeHistoryEntry(one, { readAt: new Date().toISOString() })]);
    await megaphone().click();

    const viewportHeight = page.viewportSize()?.height ?? 0;
    const dialogHeight = async () =>
      (await historyDialog().boundingBox())?.height ?? 0;

    const shortHeight = await dialogHeight();
    expect(shortHeight).toBeLessThan(viewportHeight * 0.3);
    // ...but not so small it reads as a toast. Asserted on the LIST, which is the
    // element carrying the floor, so this still fails if the min-h is dropped after
    // a header redesign changes the dialog root's height. clientHeight, not
    // boundingBox: the dialog's entrance animation scales the content box from
    // 0.96, and a bounding rect is the TRANSFORMED one, so a mid-flight read is
    // 150 * 0.96 = 144 and the assertion would flake on animation timing.
    await expect
      .poll(() => page.locator('[data-testid="announcement-history-list"]')
        .evaluate((element) => element.clientHeight))
      .toBeGreaterThanOrEqual(150);
    // Nothing to scroll at one entry.
    await expect
      .poll(() => page.locator('[data-testid="announcement-history-list"]')
        .evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBe(0);

    // A full archive (the cap is 50) must not grow the dialog past 60vh.
    await fireAnnouncements([], Array.from({ length: 50 }, (_unused, index) =>
      makeHistoryEntry(makeAnnouncement({ id: `scroll-many-${stamp}-${index}` }))));
    await expect(historyRows()).toHaveCount(50);
    // The trailing rule is dropped on the LAST row ONLY. Asserted against a
    // populated list because the one-entry case alone cannot tell
    // `last:border-b-0` apart from having dropped `border-b` outright, which
    // would un-separate all 50.
    await expect(historyRows().first()).toHaveCSS('border-bottom-width', '1px');
    await expect(historyRows().nth(49)).toHaveCSS('border-bottom-width', '0px');

    const tallHeight = await dialogHeight();
    expect(tallHeight).toBeGreaterThan(shortHeight);
    // +2 tolerates sub-pixel rounding between Windows and CI's headless Linux.
    expect(tallHeight).toBeLessThanOrEqual(viewportHeight * 0.6 + 2);
    await expect
      .poll(() => page.locator('[data-testid="announcement-history-list"]')
        .evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(0);

    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await fireAnnouncements([]);
  });

  test('the Developer tab seed button fills every announcement surface at once', async () => {
    // The dev trigger exists because the real poll needs the network and a
    // 10-second wait, and the live feed usually holds a single entry - not
    // enough to exercise a badge count, a multi-row history, or a history entry
    // that has left the active set. It renders only under __KANGENTIC_DEV__,
    // which the UI tier's Vite dev server sets.
    await fireAnnouncements([], []);
    await expect(badge()).toHaveCount(0);

    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'Developer', exact: true }).click();
    await page.locator('[data-testid="dev-trigger-announcements-feed"]').click();
    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 3000 });

    // Two active announcements: the banner takes the higher-priority one...
    await expect(page.locator('[data-testid="announcement-banner"]'))
      .toContainText('Kangentic Mobile is almost here');
    // ...both are unread, so the badge counts exactly those two...
    await expect(badge()).toContainText('2');

    // ...and history carries a third that is NOT active, which only the local
    // archive can produce.
    await megaphone().click();
    await expect(historyRows()).toHaveCount(3);
    await expect(historyRows().nth(2)).toContainText('Command Terminal');
    await expect(historyRows().nth(2)).toHaveAttribute('data-unread', 'false');
    await expect(historyRows().nth(0)).toHaveAttribute('data-unread', 'true');

    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await fireAnnouncements([]);
  });

  test('the megaphone button toggles its own history dialog closed on a second activation', async () => {
    // Isolated page (own browser context), not the shared per-worker `page`
    // above: `historyOpen` is a single global boolean, shared by every test
    // this file's `mode: 'parallel'` may schedule concurrently against that
    // shared page. Every OTHER test in this block closes the dialog through
    // the deterministic `[aria-label="Close dialog"]` button, which always
    // closes regardless of ambient state; re-pressing the SAME toggle control
    // is not idempotent that way; its outcome depends on whatever the shared
    // boolean happens to be at that instant. That is genuinely racy against a
    // concurrently-scheduled sibling also opening/closing the dialog -
    // confirmed empirically: a full-file run observed the dialog already open
    // before this test's own first action. A dedicated page removes the
    // shared boolean entirely, following the same isolation this file already
    // uses for "Announcements mount-time pull" below.
    //
    // A real MOUSE click could not exercise the close path either way: once
    // the history dialog is open, BaseDialog's own `fixed inset-0 z-50`
    // backdrop covers the whole viewport, including the title bar, so a click
    // at the megaphone's screen coordinates lands on the backdrop (confirmed
    // via document.elementFromPoint), not the button, and would be swallowed
    // by the backdrop's own click-to-close instead of ever reaching the
    // button's onClick. A keyboard activation (Enter on the focused button)
    // bypasses hit-testing entirely and reaches the button's handler directly
    // - the only real-user-reachable path (a keyboard user tabbed here) that
    // actually proves the button's own open-vs-close ternary, rather than
    // merely observing the backdrop's independent dismissal.
    const announcement = makeAnnouncement({ id: `toggle-${Date.now()}` });
    const historyEntry = makeHistoryEntry(announcement, { readAt: new Date().toISOString() });

    await waitForViteReady(VITE_URL);
    const isolatedBrowser = await chromium.launch({ headless: true });
    try {
      const context = await isolatedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
      const isolatedPage = await context.newPage();

      await isolatedPage.addInitScript({ path: MOCK_SCRIPT });
      await isolatedPage.goto(VITE_URL);
      await isolatedPage.waitForLoadState('load');
      await isolatedPage.waitForSelector('text=Kangentic', { timeout: 15000 });

      // Push the archive over the changed feed, same as fireAnnouncements()
      // does for the shared page above, but scoped to isolatedPage: wait for
      // App.tsx's mount-effect subscriber to attach before firing, since an
      // earlier push is a silent no-op.
      await expect
        .poll(() => isolatedPage.evaluate(() =>
          (window as unknown as { __mockAnnouncementsChangedListeners: unknown[] })
            .__mockAnnouncementsChangedListeners.length))
        .toBeGreaterThan(0);
      await isolatedPage.evaluate((entry) => {
        (window as unknown as {
          __mockFireAnnouncementsChanged: (active: unknown[], history?: unknown[]) => void;
        }).__mockFireAnnouncementsChanged([], [entry]);
      }, historyEntry as unknown as Record<string, unknown>);

      const isolatedMegaphone = isolatedPage.locator('[data-testid="announcements-button"]');
      const isolatedHistoryDialog = isolatedPage.locator('[data-testid="announcement-history-dialog"]');

      await isolatedMegaphone.press('Enter');
      await expect(isolatedHistoryDialog).toBeVisible();

      await isolatedMegaphone.press('Enter');
      await expect(isolatedHistoryDialog).toHaveCount(0);
    } finally {
      await isolatedBrowser.close();
    }
  });

  test('the megaphone shows an empty state when nothing has ever been archived', async () => {
    await fireAnnouncements([], []);

    await megaphone().click();
    const empty = page.locator('[data-testid="announcement-history-empty"]');
    await expect(empty).toBeVisible();
    await expect(historyRows()).toHaveCount(0);
    await expect(badge()).toHaveCount(0);
    // The empty state carries the same floor as the list, so the panel does not
    // shrink below panel size on the one state that has no content at all.
    // clientHeight for the same reason as the sizing test above: the entrance
    // animation scales the box, so a bounding rect reads short mid-flight.
    await expect
      .poll(() => empty.evaluate((element) => element.clientHeight))
      .toBeGreaterThanOrEqual(150);

    await historyDialog().locator('[aria-label="Close dialog"]').click();
    await expect(historyDialog()).toHaveCount(0);
  });
});

test.describe('Announcements mount-time pull', () => {
  // This test manages its own browser/page (not the shared per-worker one
  // above): it needs window.__mockActiveAnnouncements seeded BEFORE React
  // mounts, which requires a SECOND addInitScript registered after the
  // mock's own (the mock sets __mockActiveAnnouncements = [] eagerly at
  // bootstrap; addInitScript calls run in registration order, so registering
  // the seed after the mock script lets it overwrite that default before
  // page.goto ever runs the app bundle). Never fires
  // __mockFireAnnouncementsChanged: the whole point is proving the PULL path
  // (App.tsx's mount-effect loadActive()) works with no push at all.
  test('the banner shows an announcement that was already active before the renderer mounted, with no push', async () => {
    const announcement = makeAnnouncement({ id: `mount-pull-${Date.now()}`, title: 'Seeded before mount' });

    await waitForViteReady(VITE_URL);
    const isolatedBrowser = await chromium.launch({ headless: true });
    try {
      const context = await isolatedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
      const isolatedPage = await context.newPage();

      await isolatedPage.addInitScript({ path: MOCK_SCRIPT });
      await isolatedPage.addInitScript((seeded) => {
        (window as unknown as { __mockActiveAnnouncements: unknown[] }).__mockActiveAnnouncements = [seeded];
      }, announcement as unknown as Record<string, unknown>);

      await isolatedPage.goto(VITE_URL);
      await isolatedPage.waitForLoadState('load');
      await isolatedPage.waitForSelector('text=Kangentic', { timeout: 15000 });

      const banner = isolatedPage.locator('[data-testid="announcement-banner"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(announcement.title);
    } finally {
      await isolatedBrowser.close();
    }
  });

  // Sibling to the banner test above, proving the OTHER half of mount-time
  // Pattern B: the local ARCHIVE pull (loadHistory()), not the active-list pull
  // (loadActive()). This is what keeps the megaphone badge correct at boot and
  // while offline, before any poll (and therefore any announcements:changed
  // push) has ever landed - seed window.__mockAnnouncementHistory only, never
  // fire __mockFireAnnouncementsChanged, and confirm the badge still counts the
  // seeded unread entries.
  test('the megaphone badges an archive that was already recorded before the renderer mounted, with no push', async () => {
    const stamp = Date.now();
    const firstUnread = makeAnnouncement({ id: `mount-pull-history-1-${stamp}` });
    const secondUnread = makeAnnouncement({ id: `mount-pull-history-2-${stamp}` });
    const alreadyRead = makeAnnouncement({ id: `mount-pull-history-3-${stamp}` });
    const seededHistory = [
      makeHistoryEntry(firstUnread),
      makeHistoryEntry(secondUnread),
      makeHistoryEntry(alreadyRead, { readAt: new Date().toISOString() }),
    ];

    await waitForViteReady(VITE_URL);
    const isolatedBrowser = await chromium.launch({ headless: true });
    try {
      const context = await isolatedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
      const isolatedPage = await context.newPage();

      await isolatedPage.addInitScript({ path: MOCK_SCRIPT });
      await isolatedPage.addInitScript((seeded) => {
        (window as unknown as { __mockAnnouncementHistory: unknown[] }).__mockAnnouncementHistory = seeded;
      }, seededHistory as unknown as Record<string, unknown>[]);

      await isolatedPage.goto(VITE_URL);
      await isolatedPage.waitForLoadState('load');
      await isolatedPage.waitForSelector('text=Kangentic', { timeout: 15000 });

      const isolatedMegaphone = isolatedPage.locator('[data-testid="announcements-button"]');
      await expect(isolatedMegaphone).toBeVisible();
      const isolatedBadge = isolatedPage.locator('[data-testid="announcements-unread-badge"]');
      await expect(isolatedBadge).toContainText('2');
    } finally {
      await isolatedBrowser.close();
    }
  });
});
