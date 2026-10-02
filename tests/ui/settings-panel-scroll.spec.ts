/**
 * Every settings tab scrolls at the app's window floor.
 *
 * The window's minimum is 900x600 (`src/main/index.ts`), and at that height the
 * panel shows little more than one card, so any tab whose content or sidebar
 * cannot scroll hides settings the user can never reach. Walks every tab button
 * the panel renders (so a new tab is covered with no edit here), scrolls the
 * content pane to its end, and asserts the last card's bottom edge comes into
 * view. The sidebar gets the same check against its last tab button.
 *
 * Geometry is read inside `page.evaluate` and compared with a pixel of
 * tolerance, never an exact value (cross-platform-parity.md).
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Settings Scroll Test ${Date.now()}`);
  await page.setViewportSize({ width: 900, height: 600 });
});

test.afterAll(async () => {
  await browser?.close();
});

test('every tab and the tab list scroll to their end at the 900x600 window floor', async () => {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

  // The sidebar: 21 tabs do not fit in 600px, so its end has to be reachable.
  const tabList = await page.getByTestId('settings-tab-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    const buttons = list.querySelectorAll('[data-testid^="settings-tab-"]');
    const last = buttons[buttons.length - 1].getBoundingClientRect();
    return {
      overflowY: getComputedStyle(list).overflowY,
      overflows: list.scrollHeight > list.clientHeight,
      lastBottom: last.bottom,
      listBottom: list.getBoundingClientRect().bottom,
    };
  });
  expect(tabList.overflowY).toBe('auto');
  // Non-vacuous: at this height the list really is taller than its box.
  expect(tabList.overflows).toBe(true);
  expect(tabList.lastBottom).toBeLessThanOrEqual(tabList.listBottom + 1);

  const tabIds = await page.locator('[data-testid="settings-tab-list"] [data-testid^="settings-tab-"]').evaluateAll(
    (buttons) => buttons.map((button) => button.getAttribute('data-testid') ?? ''),
  );
  expect(tabIds.length).toBeGreaterThan(15);

  let tallTabs = 0;
  for (const tabId of tabIds) {
    await page.getByTestId(tabId).click();
    await expect(page.locator('[data-testid="settings-content"] section[aria-label]').first()).toBeVisible();
    const content = await page.getByTestId('settings-content').evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
      const cards = Array.from(scroller.querySelectorAll('section[aria-label]'))
        .filter((card) => !card.parentElement?.closest('section[aria-label]'));
      const lastCard = cards[cards.length - 1].getBoundingClientRect();
      return {
        overflowY: getComputedStyle(scroller).overflowY,
        overflows: scroller.scrollHeight > scroller.clientHeight,
        lastCardBottom: lastCard.bottom,
        scrollerBottom: scroller.getBoundingClientRect().bottom,
        horizontalOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
      };
    });
    expect(content.overflowY, `${tabId} content pane`).toBe('auto');
    expect(content.lastCardBottom, `${tabId}: last card reachable`).toBeLessThanOrEqual(content.scrollerBottom + 1);
    expect(content.horizontalOverflow, `${tabId}: no sideways scroll`).toBe(false);
    if (content.overflows) tallTabs += 1;
  }
  // Non-vacuous: most tabs are taller than the pane at this height, so the
  // reach check above really exercised scrolling.
  expect(tallTabs).toBeGreaterThan(5);
});
