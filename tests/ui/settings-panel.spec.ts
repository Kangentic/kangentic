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

/** Open the Settings panel by clicking the gear button in the title bar. */
async function openSettings() {
  await page.locator('button[title="Settings"]').click();
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

test.describe('Settings Panel', () => {
  test('titlebar gear opens Settings panel with all 9 tabs when project is open', async () => {
    await openSettings();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // All 9 tabs should be visible (5 project + 4 system)
    await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Privacy' })).toBeVisible();

    await closeSettings();
  });

  test('shows Appearance section with Theme', async () => {
    await openSettings();
    await expect(page.locator('text=Theme')).toBeVisible();
    await expect(page.locator('text=Color scheme for the interface')).toBeVisible();
    await closeSettings();
  });

  test('shows Agent section with CLI Path, Max Sessions, and Idle Timeout', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.locator('text=CLI Path')).toBeVisible();
    await expect(page.locator('text=Max Concurrent Sessions')).toBeVisible();
    await expect(page.locator('text=When Max Sessions Reached')).toBeVisible();
    await expect(page.getByText('Idle Timeout (minutes)')).toBeVisible();
    await closeSettings();
  });

  test('shows Behavior section with toggles', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Behavior' }).click();
    await expect(page.locator('text=Skip Task Delete Confirmation')).toBeVisible();
    await expect(page.locator('text=Auto-Focus Idle Sessions')).toBeVisible();
    await expect(page.locator('text=Launch All Projects on Startup')).toBeVisible();
    await expect(page.locator('text=Restore Window Position')).toBeVisible();
    await closeSettings();
  });

  test('shows Notifications tab with event grid and delivery settings', async () => {
    await openSettings();
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
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    await expect(page.getByText('Terminal shell used for agent sessions')).toBeVisible();
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font Family', { exact: true })).toBeVisible();
    await expect(page.getByText('Scrollback Lines')).toBeVisible();
    await expect(page.getByText('Cursor Style')).toBeVisible();
    await expect(page.getByText('Context Bar')).toBeVisible();

    await closeSettings();
  });

  test('shows Git tab with worktree and branch settings', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Git' }).click();

    await expect(page.locator('text=Enable Worktrees')).toBeVisible();
    await expect(page.locator('text=Default Base Branch')).toBeVisible();

    await closeSettings();
  });

  test('Escape key closes panel', async () => {
    await openSettings();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('settings gear shows active state when panel is open', async () => {
    const gearButton = page.locator('button[title="Settings"]');

    await gearButton.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await expect(gearButton).toHaveClass(/bg-surface-hover/);

    await closeSettings();
  });

  test('CLI path status indicator appears after panel opens', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();
    // The mock returns { found: true }, so the indicator div has a "Detected:" title
    await expect(page.locator('[title^="Detected:"]')).toBeVisible();
    await closeSettings();
  });

  test('permission mode dropdown has all five Claude Code modes', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();

    const permissionsLabel = page.getByText('Permissions', { exact: true });

    // The Permissions select is the one immediately following the "Permissions" label
    // It's inside the same setting row container
    const permSettingRow = permissionsLabel.locator('..').locator('..').locator('..');
    const permSelect = permSettingRow.locator('select');
    const options = permSelect.locator('option');
    const texts = await options.allTextContents();

    expect(texts).toEqual([
      'Plan',
      "Don't Ask (Deny Unless Allowed)",
      'Default (Allowlist)',
      'Accept Edits',
      'Bypass (Unsafe)',
    ]);

    await closeSettings();
  });

  test('board remains visible behind settings panel', async () => {
    await openSettings();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeAttached();
    await expect(page.locator('[data-swimlane-name="Planning"]')).toBeAttached();
    await closeSettings();
  });

  test('shows MCP Server tab with toggle, tools list, and how it works', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'MCP Server' }).click();

    // Banner with toggle should be visible
    await expect(page.getByText('Kangentic MCP Server')).toBeVisible();
    await expect(page.getByText('Give Claude Code agents tools to interact with your board')).toBeVisible();

    // Tools list should be visible (spot-check a few)
    await expect(page.getByText('Create Task')).toBeVisible();
    await expect(page.getByText('Board Summary')).toBeVisible();
    await expect(page.getByText('Session History')).toBeVisible();

    // How It Works section
    await expect(page.getByText('How It Works')).toBeVisible();

    await closeSettings();
  });
});

test.describe('Project Settings via Sidebar', () => {
  test('sidebar gear icon opens Settings panel', async () => {
    // Hover over the project row to reveal the gear icon
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();

    const gearButton = page.locator('button[title="Project settings"]').first();
    await expect(gearButton).toBeVisible();
    await gearButton.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    await closeSettings();
  });

  test('shows all tabs including per-project and shared settings', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.hover();
    await page.locator('button[title="Project settings"]').first().click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // All tabs visible (no separate project panel with fewer tabs)
    await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();

    // Agent tab should show ALL settings (no more filtering)
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.locator('text=CLI Path')).toBeVisible();
    await expect(page.locator('text=Max Concurrent Sessions')).toBeVisible();

    await closeSettings();
  });

  test('Escape closes settings', async () => {
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

test.describe('Shared Settings Tooltip', () => {
  test('Behavior tab has tooltip "Applies to all projects"', async () => {
    await openSettings();
    const behaviorTab = page.getByRole('button', { name: 'Behavior' });
    await expect(behaviorTab).toHaveAttribute('title', 'Applies to all projects');
    await closeSettings();
  });
});

test.describe('Settings Search', () => {
  test('search bar is visible in Settings', async () => {
    await openSettings();
    await expect(page.getByTestId('settings-search')).toBeVisible();
    await closeSettings();
  });

  test('searching "font" shows Font Size and Font Family from Terminal tab', async () => {
    await openSettings();
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
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('context bar');

    // Context bar toggles should be visible
    await expect(page.getByText('Detected shell name')).toBeVisible();
    await expect(page.getByText('Claude Code version')).toBeVisible();
    await expect(page.getByText('Usage bar and percentage')).toBeVisible();

    await closeSettings();
  });

  test('searching "theme" shows appearance theme setting', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('theme');

    await expect(page.getByText('Color scheme for the interface')).toBeVisible();

    // Should NOT show terminal settings
    await expect(page.getByText('Terminal text size in pixels')).not.toBeVisible();

    await closeSettings();
  });

  test('searching "worktree" shows git worktree settings', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('worktree');

    await expect(page.getByText('Enable Worktrees')).toBeVisible();
    await expect(page.getByText('Auto-cleanup')).toBeVisible();

    await closeSettings();
  });

  test('searching nonsense shows empty state', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('xyznonexistent');

    await expect(page.getByText('No settings found')).toBeVisible();

    await closeSettings();
  });

  test('clearing search returns to normal tab view', async () => {
    await openSettings();
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
    await openSettings();
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
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('theme');

    // Appearance sidebar tab should have a match count badge (name includes count)
    const appearanceTab = page.getByRole('button', { name: 'Appearance 1' });
    await expect(appearanceTab).not.toHaveClass(/opacity-40/);

    // Terminal sidebar tab should be dimmed (no matches for "theme")
    const terminalTab = page.getByRole('button', { name: 'Terminal', exact: true }).first();
    await expect(terminalTab).toHaveClass(/opacity-40/);

    await closeSettings();
  });

  test('search works from sidebar gear icon', async () => {
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
