import path from 'node:path';
import { test, expect, chromium } from '@playwright/test';
import { launchPage, createProject, waitForViteReady, gotoVite } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Hotkeys Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openHotkeys() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await page.getByTestId('hotkeys-tab').waitFor({ state: 'visible', timeout: 3000 });
}

async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

/** Rebind one row's shortcut by capturing the given key chord. */
async function rebind(rowTestId: string, chord: string, target: Page = page) {
  const row = target.getByTestId(rowTestId);
  await row.getByTestId('key-capture-input').click();
  const box = target.getByTestId('key-capture-box');
  await box.waitFor({ state: 'visible', timeout: 2000 });
  await box.focus();
  await target.keyboard.press(chord);
}

test.describe('Hotkeys settings tab', () => {
  test('appears below the separator with the OS warning banner and group headers', async () => {
    await openHotkeys();
    const tab = page.getByTestId('hotkeys-tab');
    await expect(page.getByTestId('os-hotkey-banner')).toBeVisible();
    // One card per group, titled by its heading. Scoped to the tab so the
    // sidebar's "Terminal" tab button doesn't collide.
    await expect(tab.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'Task detail', exact: true })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
    // Browser shortcuts are registered but hidden from the panel.
    await expect(tab.getByRole('heading', { name: 'Browser', exact: true })).toHaveCount(0);
    await closeSettings();
  });

  test('lists the header-click close binding with its default mouse button', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-panel.closeViaHeaderClick');
    await expect(row).toBeVisible();
    // The default binding renders as a single readable mouse-button segment, and
    // the row is rebindable (a capture input is present).
    await expect(row.getByText('Middle Click')).toBeVisible();
    await expect(row.getByTestId('key-capture-input')).toBeVisible();
    await closeSettings();
  });

  test('terminal (non-rebindable) rows are read-only with no capture input', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-terminal.copy');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('key-capture-input')).toHaveCount(0);
    await closeSettings();
  });

  test('rebinding a shortcut shows a Custom pill and enables reset; reset restores default', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-view.toggleSidebar');
    const resetButton = row.getByTestId('hotkey-reset-view.toggleSidebar');

    await expect(resetButton).toBeDisabled();
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+G');

    await expect(row.getByText('Custom')).toBeVisible();
    await expect(resetButton).toBeEnabled();

    await resetButton.click();
    await expect(row.getByText('Custom')).toHaveCount(0);
    await expect(resetButton).toBeDisabled();
    await closeSettings();
  });

  test('Escape cancels capture without changing the binding', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-view.toggleSidebar');
    await row.getByTestId('key-capture-input').click();
    await page.getByTestId('key-capture-box').waitFor({ state: 'visible', timeout: 2000 });

    await page.keyboard.press('Escape');
    // Back to idle: the Rebind button is visible again and no override was set.
    await expect(row.getByTestId('key-capture-input')).toBeVisible();
    await expect(row.getByText('Custom')).toHaveCount(0);
    await closeSettings();
  });

  test('lists no row for opening a link, since a click on a link is a setting and not a hotkey', async () => {
    await openHotkeys();
    const tab = page.getByTestId('hotkeys-tab');
    // The row that does list a mouse click is there, so an empty match is not an empty tab.
    await expect(tab.getByTestId('hotkey-row-panel.closeViaHeaderClick')).toBeVisible();
    await expect(tab.getByText('Open link in')).toHaveCount(0);
    await expect(tab.locator('[data-testid^="hotkey-row-terminal.openLink"]')).toHaveCount(0);
    await closeSettings();
  });

  test('binding two same-scope actions to one combo flags a conflict on both', async () => {
    await openHotkeys();
    // commandBar.toggle defaults to Mod+Shift+P (global). Rebind view.toggleSidebar
    // (also global) onto the same combo to force a conflict.
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+P');

    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toBeVisible();
    await expect(page.getByTestId('hotkey-conflict-commandBar.toggle')).toBeVisible();
    // One combo is shared, so the summary is singular, with its count in a pill
    // after the text.
    const summary = page.getByTestId('hotkey-conflict-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Conflict detected');
    await expect(summary).not.toContainText('Conflicts detected');
    await expect(summary.getByTestId('hotkey-conflict-count')).toHaveText('1');

    // Clean up so later tests start from defaults.
    await page.getByTestId('hotkey-reset-view.toggleSidebar').click();
    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toHaveCount(0);
    await closeSettings();
  });

  test('flags a combo already in use by another app (probe)', async () => {
    // Make the probe report commandBar.toggle's default combo as taken.
    await page.evaluate(() => {
      (window as unknown as { __mockProbeGlobal: Record<string, string> }).__mockProbeGlobal = {
        'Mod+Shift+P': 'taken',
      };
    });
    await openHotkeys();
    await expect(page.getByTestId('hotkey-taken-commandBar.toggle')).toBeVisible();
    await closeSettings();
    await page.evaluate(() => {
      delete (window as unknown as { __mockProbeGlobal?: Record<string, string> }).__mockProbeGlobal;
    });
  });

  test('Reset all to defaults clears every override', async () => {
    await openHotkeys();
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+G');
    await expect(page.getByTestId('hotkey-row-view.toggleSidebar').getByText('Custom')).toBeVisible();

    await page.getByTestId('hotkeys-reset-all').click();
    await page.getByRole('button', { name: 'Reset all', exact: true }).click();

    await expect(page.getByTestId('hotkey-row-view.toggleSidebar').getByText('Custom')).toHaveCount(0);
    await closeSettings();
  });

  test('the previous-terminal rows ship unbound, read Not set, and can be bound', async () => {
    await openHotkeys();
    for (const id of ['session.cyclePrev', 'session.cycleAllPrev']) {
      const combo = page.getByTestId(`hotkey-row-${id}`).getByTestId('key-combo');
      await expect(combo).toHaveText('Not set');
      await expect(combo).toHaveAttribute('data-unbound', 'true');
    }
    // The bound cycle keys draw their chips. The backtick key is shown as a backtick.
    await expect(page.getByTestId('hotkey-row-project.cycleNext').getByTestId('key-combo')).toHaveAttribute('aria-label', 'Ctrl+`');

    const row = page.getByTestId('hotkey-row-session.cyclePrev');
    await rebind('hotkey-row-session.cyclePrev', 'Control+Shift+Y');
    await expect(row.getByText('Custom')).toBeVisible();
    await expect(row.getByTestId('key-combo')).toHaveAttribute('aria-label', 'Ctrl+Shift+Y');

    await row.getByTestId('hotkey-reset-session.cyclePrev').click();
    await expect(row.getByTestId('key-combo')).toHaveText('Not set');
    await closeSettings();
  });

  test('a rebind pressed as Ctrl+Tab clashes with the Ctrl+Tab cycle default', async () => {
    // Off macOS the capture records a physical Ctrl+Tab as Mod+Tab; the tab folds
    // Mod into Ctrl, so it still lands on session.cycleNext's literal Ctrl+Tab.
    await openHotkeys();
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Tab');

    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toBeVisible();
    await expect(page.getByTestId('hotkey-conflict-session.cycleNext')).toBeVisible();

    await page.getByTestId('hotkey-reset-view.toggleSidebar').click();
    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toHaveCount(0);
    await closeSettings();
  });
});

test.describe('Hotkeys settings tab: an override for an action that is gone', () => {
  const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
  const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

  test('is not a customisation: Reset to default stays disabled until a real hotkey is rebound', async () => {
    // The two link-click hotkeys were removed, but a config saved earlier still
    // names one. It binds nothing, so the pill must not offer a Reset for it.
    await waitForViteReady(VITE_URL);
    const staleBrowser = await chromium.launch({ headless: true });
    try {
      const context = await staleBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
      const stalePage = await context.newPage();
      await stalePage.addInitScript({ path: MOCK_SCRIPT });
      await stalePage.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var timestamp = new Date().toISOString();
          state.projects.push({
            id: 'proj-stale-hotkey', name: 'Stale Hotkey Test', path: '/mock/stale-hotkey', github_url: null,
            default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
          });
          state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
            state.swimlanes.push(Object.assign({}, lane, { id: 'lane-stale-' + index, position: index, created_at: timestamp }));
          });
          Object.assign(state.config, { hotkeyOverrides: { 'terminal.openLinkInDefaultBrowser': 'Mod+Shift+Mouse:Left' } });
          return { currentProjectId: 'proj-stale-hotkey' };
        });
      `);
      await gotoVite(stalePage, VITE_URL);
      await stalePage.waitForLoadState('load');
      await stalePage.locator('[data-testid="settings-button"]').click();
      await stalePage.getByRole('button', { name: 'Hotkeys', exact: true }).click();
      await stalePage.getByTestId('hotkeys-tab').waitFor({ state: 'visible', timeout: 5000 });

      // The stale override really is in the config the tab reads.
      const stored = await stalePage.evaluate(async () => (await window.electronAPI.config.getGlobal()).hotkeyOverrides);
      expect(stored).toEqual({ 'terminal.openLinkInDefaultBrowser': 'Mod+Shift+Mouse:Left' });

      const resetAll = stalePage.getByTestId('hotkeys-reset-all');
      await expect(resetAll).toBeDisabled();
      // Not vacuous: no row is Custom, and a real rebind turns the pill on.
      await expect(stalePage.getByTestId('hotkeys-tab').getByText('Custom')).toHaveCount(0);
      await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+G', stalePage);
      await expect(stalePage.getByTestId('hotkey-row-view.toggleSidebar').getByText('Custom')).toBeVisible();
      await expect(resetAll).toBeEnabled();
    } finally {
      await staleBrowser.close();
    }
  });
});
