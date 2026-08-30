/**
 * UI coverage for the renderer-side feature-usage telemetry call sites.
 *
 * Three renderer call sites report feature adoption over IPC via
 * window.electronAPI.analytics.trackFeatureUsed(<feature>):
 *   - SettingsPanel.tsx fires 'settings' on mount.
 *   - useSearchPalette.ts's open() fires 'quick_find'.
 *   - usage-dashboard-store.ts's open() fires 'usage_dashboard'.
 *
 * The headless mock (mock-electron-api.js) records every call into
 * window.__mockTrackFeatureUsedCalls, but nothing read it back: a typo'd
 * feature string at any call site ships silently, since main-process
 * validation just drops an unrecognized name (isKnownAnalyticsFeature in
 * src/main/analytics/usage.ts) rather than throwing. Each test below opens
 * the surface through its real user-facing trigger and asserts the exact
 * literal was recorded.
 *
 * Each test launches its own browser/project (no cross-test state), so the
 * file opts into parallel mode like search-palette.spec.ts and
 * usage-dashboard.spec.ts.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

/** Read the mock's feature-usage call log (empty array if nothing fired yet). */
async function getTrackedFeatures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const mockWindow = window as unknown as { __mockTrackFeatureUsedCalls?: string[] };
    return mockWindow.__mockTrackFeatureUsedCalls ?? [];
  });
}

test.describe('Feature usage telemetry', () => {
  test('opening Settings records the settings feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Settings ${Date.now()}`);

      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('settings');
    } finally {
      await browser.close();
    }
  });

  test('opening Quick Find records the quick_find feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Quick Find ${Date.now()}`);

      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette').waitFor({ state: 'visible', timeout: 3000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('quick_find');
    } finally {
      await browser.close();
    }
  });

  test('opening the usage dashboard records the usage_dashboard feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Usage Dashboard ${Date.now()}`);

      await page.locator('[data-testid="usage-stats-button"]').click();
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 5000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('usage_dashboard');
    } finally {
      await browser.close();
    }
  });
});
