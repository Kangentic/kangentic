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

/**
 * Fires the announcements-changed push once App.tsx's subscriber is attached.
 * Firing before the mount-effect subscription registers would be a silent
 * no-op (the eager mock hook tolerates zero listeners), so wait for it.
 */
async function fireAnnouncements(active: Announcement[]): Promise<void> {
  await expect
    .poll(() => page.evaluate(() =>
      (window as unknown as { __mockAnnouncementsChangedListeners: unknown[] })
        .__mockAnnouncementsChangedListeners.length))
    .toBeGreaterThan(0);
  await page.evaluate((activeList) => {
    (window as unknown as { __mockFireAnnouncementsChanged: (active: unknown[]) => void })
      .__mockFireAnnouncementsChanged(activeList);
  }, active as unknown as unknown[]);
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
});
