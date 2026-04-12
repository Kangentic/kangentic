import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { hero, inline } from '../helpers/resolutions';
import { launchCapturePage } from '../helpers/capture-page';
import { buildMarketingPreConfig } from '../helpers/marketing-fixture';

const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'captures', 'task-detail');
const THEMES = ['dark', 'light'] as const;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const preConfigScript = buildMarketingPreConfig();

test.describe('Task Detail Captures', () => {
  // Task detail with active agent session (Executing column — shows terminal + context bar)
  for (const theme of THEMES) {
    test(`executing task detail - ${theme}`, async () => {
      const { browser, page } = await launchCapturePage({
        resolution: hero,
        theme,
        preConfigScript,
      });

      // Click the "Extract auth middleware" task in Executing column
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      const taskCard = executingColumn.locator('text=Extract auth middleware');
      await taskCard.click();

      // Wait for detail panel to open and terminal to load scrollback
      await page.waitForTimeout(4000);

      await page.screenshot({
        path: path.join(OUTPUT_DIR, `executing-${theme}-hero.png`),
        fullPage: false,
      });

      await browser.close();
    });
  }

  // Task detail with thinking agent (Planning column — shows thinking state)
  for (const theme of THEMES) {
    test(`planning task detail - ${theme}`, async () => {
      const { browser, page } = await launchCapturePage({
        resolution: hero,
        theme,
        preConfigScript,
      });

      // Click the "Fix WebSocket reconnection" task in Planning column
      const planningColumn = page.locator('[data-swimlane-name="Planning"]');
      const taskCard = planningColumn.locator('text=Fix WebSocket reconnection');
      await taskCard.click();

      // Wait for detail panel to open
      await page.waitForTimeout(4000);

      await page.screenshot({
        path: path.join(OUTPUT_DIR, `planning-${theme}-hero.png`),
        fullPage: false,
      });

      await browser.close();
    });
  }

  // Task detail at inline resolution for docs
  test('executing task detail - dark inline', async () => {
    const { browser, page } = await launchCapturePage({
      resolution: inline,
      theme: 'dark',
      preConfigScript,
    });

    const executingColumn = page.locator('[data-swimlane-name="Executing"]');
    const taskCard = executingColumn.locator('text=Extract auth middleware');
    await taskCard.click();
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'executing-dark-inline.png'),
      fullPage: false,
    });

    await browser.close();
  });

  // Code Review task with PR badge visible
  for (const theme of THEMES) {
    test(`review task detail - ${theme}`, async () => {
      const { browser, page } = await launchCapturePage({
        resolution: hero,
        theme,
        preConfigScript,
      });

      // Click the "Add rate limiting" task in Code Review (has PR #42 badge)
      const reviewColumn = page.locator('[data-swimlane-name="Code Review"]');
      const taskCard = reviewColumn.locator('text=Add rate limiting');
      await taskCard.click();
      await page.waitForTimeout(4000);

      await page.screenshot({
        path: path.join(OUTPUT_DIR, `review-${theme}-hero.png`),
        fullPage: false,
      });

      await browser.close();
    });
  }
});
