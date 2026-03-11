import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Settings Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open the App Settings panel by clicking the gear button in the title bar. */
async function openAppSettings() {
  await page.locator('button[title="App Settings"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
}

/** Close any open settings panel via Escape. Clears search first if active. */
async function closeSettings() {
  // If search has text, first Escape clears it; press again to close.
  const searchInput = page.getByTestId('settings-search');
  if (await searchInput.isVisible().catch(() => false)) {
    const searchValue = await searchInput.inputValue().catch(() => '');
    if (searchValue) {
      await page.keyboard.press('Escape');
      await expect(searchInput).toHaveValue('', { timeout: 1000 });
    }
  }
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('App Settings Panel', () => {
  test('titlebar gear opens App Settings panel', async () => {
    await openAppSettings();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
    await expect(page.locator('text=Global')).toBeVisible();
    await closeSettings();
  });

  test('shows Appearance section with Theme', async () => {
    await openAppSettings();
    await expect(page.locator('text=Theme')).toBeVisible();
    await expect(page.locator('text=Color scheme for the interface')).toBeVisible();
    await closeSettings();
  });

  test('shows Agent section with CLI Path, Max Sessions, and Idle Timeout', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.locator('text=CLI Path')).toBeVisible();
    await expect(page.locator('text=Max Concurrent Sessions')).toBeVisible();
    await expect(page.locator('text=When Max Sessions Reached')).toBeVisible();
    await expect(page.getByText('Idle Timeout (minutes)')).toBeVisible();
    await closeSettings();
  });

  test('shows Behavior section with toggles', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Behavior' }).click();
    await expect(page.locator('text=Skip Task Delete Confirmation')).toBeVisible();
    await expect(page.locator('text=Auto-Focus Idle Sessions')).toBeVisible();
    await expect(page.locator('text=Launch All Projects on Startup')).toBeVisible();
    await expect(page.locator('text=Restore Window Position')).toBeVisible();
    await closeSettings();
  });

  test('shows Notifications tab with event grid and delivery settings', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Notifications' }).click();
    // Event rows with Desktop/Toast inline labels
    await expect(page.getByText('Agent Idle')).toBeVisible();
    await expect(page.getByText('Plan Complete')).toBeVisible();
    // Delivery settings
    await expect(page.getByText('Toast Auto-Dismiss')).toBeVisible();
    await expect(page.getByText('Max Visible Toasts')).toBeVisible();
    await closeSettings();
  });

  test('shows Terminal tab with shell, font size, font family, scrollback, and cursor style', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Terminal' }).click();

    await expect(page.getByText('Terminal shell used for agent sessions')).toBeVisible();
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font Family', { exact: true })).toBeVisible();
    await expect(page.getByText('Scrollback Lines')).toBeVisible();
    await expect(page.getByText('Cursor Style')).toBeVisible();
    await expect(page.getByText('Context Bar')).toBeVisible();

    await closeSettings();
  });

  test('shows Git tab with worktree and branch settings', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Git' }).click();

    await expect(page.locator('text=Enable Worktrees')).toBeVisible();
    await expect(page.locator('text=Default Base Branch')).toBeVisible();

    await closeSettings();
  });

  test('Escape key closes panel', async () => {
    await openAppSettings();
    await expect(page.locator('text=Global')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
    await expect(page.locator('text=Global')).not.toBeVisible({ timeout: 2000 });
  });

  test('settings gear shows active state when panel is open', async () => {
    const gearButton = page.locator('button[title="App Settings"]');

    await gearButton.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await expect(gearButton).toHaveClass(/bg-surface-hover/);

    await closeSettings();
  });

  test('CLI path status indicator appears after panel opens', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Agent' }).click();
    // The mock returns { found: true }, so the indicator div has a "Detected:" title
    await expect(page.locator('[title^="Detected:"]')).toBeVisible();
    await closeSettings();
  });

  test('permission strategy dropdown has correct options (no Plan)', async () => {
    await openAppSettings();
    await page.getByRole('button', { name: 'Agent' }).click();

    const permissionsLabel = page.getByText('Permissions', { exact: true });

    // The Permissions select is the one immediately following the "Permissions" label
    // It's inside the same setting row container
    const permSettingRow = permissionsLabel.locator('..').locator('..').locator('..');
    const permSelect = permSettingRow.locator('select');
    const options = permSelect.locator('option');
    const texts = await options.allTextContents();

    expect(texts).toContain('Default (Allowlist)');
    expect(texts).toContain('Accept Edits');
    expect(texts).toContain('Bypass (Unsafe)');
    expect(texts).not.toContain('Manual Approval');
    expect(texts).not.toContain('Plan');

    await closeSettings();
  });

  test('board remains visible behind settings panel', async () => {
    await openAppSettings();
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeAttached();
    await expect(page.locator('[data-swimlane-name="Planning"]')).toBeAttached();
    await closeSettings();
  });
});

test.describe('Project Settings Panel', () => {
  test('sidebar gear icon opens Project Settings panel', async () => {
    // Hover over the project row to reveal the gear icon
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();

    const gearButton = page.locator('button[title="Project settings"]').first();
    await expect(gearButton).toBeVisible();
    await gearButton.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // Should show "Settings" header with project name subtitle
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    await closeSettings();
  });

  test('shows Appearance, Terminal, Agent, and Git sections', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();
    await page.locator('button[title="Project settings"]').first().click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // Appearance tab (default)
    await expect(page.locator('text=Theme')).toBeVisible();

    // Terminal tab
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.getByText('Shell', { exact: true })).toBeVisible();
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();

    // Agent tab
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.getByText('Permissions', { exact: true })).toBeVisible();

    // Git tab
    await page.getByRole('button', { name: 'Git' }).click();
    await expect(page.locator('text=Enable Worktrees')).toBeVisible();
    await expect(page.locator('text=Auto-cleanup')).toBeVisible();

    await closeSettings();
  });

  test('does NOT show app-only settings', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();
    await page.locator('button[title="Project settings"]').first().click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // Agent tab -- should NOT have CLI Path, Max Sessions, etc.
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.locator('text=CLI Path')).not.toBeVisible();
    await expect(page.locator('text=Max Concurrent Sessions')).not.toBeVisible();

    // Behavior tab should not exist
    await expect(page.getByRole('button', { name: 'Behavior' })).not.toBeVisible();

    await closeSettings();
  });

  test('Escape closes project settings', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();
    await page.locator('button[title="Project settings"]').first().click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    const header = page.locator('h2:has-text("Settings")');
    await expect(header).toBeVisible();

    await page.keyboard.press('Escape');
    await header.waitFor({ state: 'hidden', timeout: 2000 });
    await expect(header).not.toBeVisible({ timeout: 2000 });
  });
});

test.describe('Settings Search', () => {
  test('search bar is visible in App Settings', async () => {
    await openAppSettings();
    await expect(page.getByTestId('settings-search')).toBeVisible();
    await closeSettings();
  });

  test('searching "font" shows Font Size and Font Family from Terminal tab', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('font');

    // Should show Terminal tab group header and font settings
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font Family', { exact: true })).toBeVisible();

    // Should NOT show unrelated settings like Theme
    await expect(page.getByText('Color scheme for the interface')).not.toBeVisible();

    await closeSettings();
  });

  test('searching "context bar" shows context bar toggles', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('context bar');

    // Context bar toggles should be visible
    await expect(page.getByText('Detected shell name')).toBeVisible();
    await expect(page.getByText('Claude Code version')).toBeVisible();
    await expect(page.getByText('Usage bar and percentage')).toBeVisible();

    await closeSettings();
  });

  test('searching "theme" shows appearance theme setting', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('theme');

    await expect(page.getByText('Color scheme for the interface')).toBeVisible();

    // Should NOT show terminal settings
    await expect(page.getByText('Terminal text size in pixels')).not.toBeVisible();

    await closeSettings();
  });

  test('searching "worktree" shows git worktree settings', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('worktree');

    await expect(page.getByText('Enable Worktrees')).toBeVisible();
    await expect(page.getByText('Auto-cleanup')).toBeVisible();

    await closeSettings();
  });

  test('searching nonsense shows empty state', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('xyznonexistent');

    await expect(page.getByText('No settings found')).toBeVisible();

    await closeSettings();
  });

  test('clearing search returns to normal tab view', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');

    // Search for something
    await searchInput.fill('font');
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();

    // Clear search
    await searchInput.fill('');

    // Should return to normal view (Appearance tab is default but font search
    // was in Terminal only, so auto-switch should land on Terminal)
    await expect(page.getByText('Terminal shell used for agent sessions')).toBeVisible();

    await closeSettings();
  });

  test('Escape clears search before closing panel', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('font');

    // First Escape should clear search, not close panel
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-search')).toHaveValue('');
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // Second Escape closes panel
    await closeSettings();
  });

  test('zero-match tabs are dimmed during search', async () => {
    await openAppSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('theme');

    // Appearance sidebar tab should have a match count badge (name includes count)
    const appearanceTab = page.getByRole('button', { name: 'Appearance 1' });
    await expect(appearanceTab).not.toHaveClass(/opacity-40/);

    // Terminal sidebar tab should be dimmed (no matches for "theme")
    const terminalTab = page.getByRole('button', { name: 'Terminal' }).first();
    await expect(terminalTab).toHaveClass(/opacity-40/);

    await closeSettings();
  });

  test('search works in Project Settings panel', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();
    await page.locator('button[title="Project settings"]').first().click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    const searchInput = page.getByTestId('settings-search');
    await expect(searchInput).toBeVisible();

    await searchInput.fill('worktree');
    await expect(page.getByText('Enable Worktrees')).toBeVisible();

    await closeSettings();
  });
});
