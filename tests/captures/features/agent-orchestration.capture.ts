import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { ALL_RESOLUTIONS, hero } from '../helpers/resolutions';
import { launchCapturePage } from '../helpers/capture-page';
import { buildMarketingPreConfig } from '../helpers/marketing-fixture';

const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'captures', 'agent-orchestration');
const THEMES = ['dark', 'light'] as const;

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const preConfigScript = buildMarketingPreConfig();

test.describe('Agent Orchestration Captures', () => {
  for (const theme of THEMES) {
    for (const resolution of ALL_RESOLUTIONS) {
      test(`${theme} ${resolution.name}`, async () => {
        const { browser, page } = await launchCapturePage({
          resolution,
          theme,
          preConfigScript,
          hideTerminal: true,
        });

        await page.screenshot({
          path: path.join(OUTPUT_DIR, `${theme}-${resolution.name}.png`),
          fullPage: false,
        });

        await browser.close();
      });
    }
  }

  test('dark interaction video', async () => {
    test.setTimeout(60_000);

    const { browser, context, page } = await launchCapturePage({
      resolution: hero,
      theme: 'dark',
      video: true,
      preConfigScript,
    });

    // Pan across the board — hover over columns left to right
    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await todoColumn.locator('text=Add user auth flow').hover();
    await page.waitForTimeout(600);

    const planningColumn = page.locator('[data-swimlane-name="Planning"]');
    await planningColumn.locator('text=Fix WebSocket reconnection').hover();
    await page.waitForTimeout(600);

    const executingColumn = page.locator('[data-swimlane-name="Executing"]');
    await executingColumn.locator('text=Extract auth middleware').hover();
    await page.waitForTimeout(600);

    await executingColumn.locator('text=Generate API client types').hover();
    await page.waitForTimeout(600);

    const reviewColumn = page.locator('[data-swimlane-name="Code Review"]');
    await reviewColumn.locator('text=Add rate limiting').hover();
    await page.waitForTimeout(600);

    const testsColumn = page.locator('[data-swimlane-name="Tests"]');
    await testsColumn.locator('text=Integration test coverage').hover();
    await page.waitForTimeout(800);

    // Close context to finalize video
    const videoPath = await page.video()?.path();
    await context.close();
    await browser.close();

    // Move video from temp dir to output
    if (videoPath && fs.existsSync(videoPath)) {
      const dest = path.join(OUTPUT_DIR, 'dark-interaction.webm');
      fs.copyFileSync(videoPath, dest);
    }
  });
});
