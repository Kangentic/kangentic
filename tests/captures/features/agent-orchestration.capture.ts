/**
 * The board hover video. The board STILLS this file once shot are the `board` scene now
 * (features/scenes.capture.ts), so the rig and the web build describe that state once; a video
 * needs the dev-server fixture path because its hover pan is choreography, not a state.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { hero } from '../helpers/resolutions';
import { launchCapturePage } from '../helpers/capture-page';
import { buildMarketingPreConfig } from '../helpers/marketing-fixture';
import { getOutputDir } from '../helpers/output-dir';

const OUTPUT_DIR = getOutputDir('agent-orchestration');

const preConfigScript = buildMarketingPreConfig();

test.describe('Agent Orchestration Captures', () => {
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

    const testingColumn = page.locator('[data-swimlane-name="Testing"]');
    await testingColumn.locator('text=Integration test coverage').hover();
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

    // Clean up temp video directory to prevent file locking
    const videoTmpDir = path.join(__dirname, '..', '..', '..', 'captures', '_video-tmp');
    try { fs.rmSync(videoTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
