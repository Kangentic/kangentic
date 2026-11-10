/**
 * The Settings tab rail.
 *
 * What only a browser proves: no tab name wraps, in English or in a language with longer names,
 * because the rail is as wide as its longest label; the content column keeps the one width the
 * settings cards are drawn for; a search's match counts do not move the panel; and the panel
 * still fits the 900x600 floor. The rail was a fixed 176px, where "Browser automation" took two
 * lines. All geometry is read in the page and compared relatively, never against a font's pixels.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

/** The session's language, set the way main reports it, before the app loads. */
function inLanguage(locale: string): (page: Page) => Promise<void> {
  return (page) => page.addInitScript((displayLanguage) => {
    const mockWindow = window as unknown as {
      __mockShippedLocales: string[];
      __mockPreConfigure: (configure: (state: { config: Record<string, unknown> }) => Record<string, unknown>) => void;
    };
    mockWindow.__mockShippedLocales = ['en', displayLanguage];
    mockWindow.__mockPreConfigure((state) => {
      state.config.displayLanguage = displayLanguage;
      state.config.hasAnsweredLanguageSuggestion = true;
      return {};
    });
  }, locale);
}

async function openSettings(page: Page): Promise<void> {
  await createProject(page, `settings-rail-${Date.now()}`);
  await page.locator('[data-testid="settings-button"]').click();
  await page.getByTestId('settings-panel').waitFor({ state: 'visible', timeout: 5000 });
  await panelSettled(page);
}

/** The panel slides in from the right: wait until its right edge sits on the window's. */
async function panelSettled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="settings-panel"]')!.getBoundingClientRect();
    return Math.abs(panel.right - window.innerWidth);
  }), { timeout: 5000 }).toBeLessThan(1);
}

interface RailGeometry {
  /** Each tab's label height over the shortest one's: 1 for a label on one line. */
  labelLines: Array<{ tab: string | null; lines: number }>;
  railWidth: number;
  contentWidth: number;
  panelLeft: number;
  panelRight: number;
  viewportWidth: number;
}

function railGeometry(page: Page): Promise<RailGeometry> {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="settings-tab-list"]')!;
    const labels = [...rail.querySelectorAll('[data-testid^="settings-tab-"]')].map((tab) => ({
      tab: tab.getAttribute('data-testid'),
      height: tab.querySelector('span span')!.getBoundingClientRect().height,
    }));
    const oneLine = Math.min(...labels.map((label) => label.height));
    const panel = document.querySelector('[data-testid="settings-panel"]')!.getBoundingClientRect();
    return {
      labelLines: labels.map((label) => ({ tab: label.tab, lines: Math.round(label.height / oneLine) })),
      railWidth: rail.getBoundingClientRect().width,
      contentWidth: document.querySelector('[data-testid="settings-content"]')!.getBoundingClientRect().width,
      panelLeft: panel.left,
      panelRight: panel.right,
      viewportWidth: window.innerWidth,
    };
  });
}

test.describe('Settings tab rail', () => {
  for (const locale of ['en', 'ru', 'de']) {
    test(`no tab name wraps (${locale}), and the content column keeps its width`, async () => {
      const { browser, page } = await launchPage({ beforeLoad: inLanguage(locale) });
      try {
        await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale);
        await openSettings(page);
        const geometry = await railGeometry(page);
        expect(geometry.labelLines.filter((label) => label.lines > 1)).toEqual([]);
        // The cards' one-line budgets are measured against this column; a real tolerance for
        // a scrollbar that takes room on one platform and none on another.
        expect(geometry.contentWidth).toBeGreaterThan(520);
        expect(geometry.contentWidth).toBeLessThan(548);
        expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      } finally {
        await browser.close();
      }
    });
  }

  test('a search draws its match counts without moving the rail or the panel', async () => {
    const { browser, page } = await launchPage();
    try {
      await openSettings(page);
      const before = await railGeometry(page);
      await page.getByTestId('settings-search').fill('a');
      await expect(page.locator('[data-testid^="settings-search-count-"]').first()).toBeVisible();
      const during = await railGeometry(page);
      expect(Math.abs(during.railWidth - before.railWidth)).toBeLessThan(1);
      expect(Math.abs(during.panelLeft - before.panelLeft)).toBeLessThan(1);
      expect(during.labelLines.filter((label) => label.lines > 1)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('fits the window at the 900x600 floor in the longest language', async () => {
    const { browser, page } = await launchPage({ beforeLoad: inLanguage('ru') });
    try {
      await openSettings(page);
      await page.setViewportSize({ width: 900, height: 600 });
      await panelSettled(page);
      const geometry = await railGeometry(page);
      expect(geometry.panelLeft).toBeGreaterThanOrEqual(-1);
      expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.labelLines.filter((label) => label.lines > 1)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
