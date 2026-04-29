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
  test('titlebar gear opens Settings panel with all 10 tabs when project is open', async () => {
    await openSettings();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // All 10 tabs should be visible (5 project + 5 system)
    await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Layout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Privacy' })).toBeVisible();

    await closeSettings();
  });

  test('shows Theme tab with color scheme selector', async () => {
    await openSettings();
    await expect(page.locator('text=Color scheme for the interface')).toBeVisible();
    await closeSettings();
  });

  test('shows Agent section with CLI Path and Idle Timeout', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.getByText('Claude Code Path')).toBeVisible();
    await expect(page.getByText('Idle Timeout (minutes)')).toBeVisible();
    await closeSettings();
  });

  test('shows Behavior section with session limits and toggles', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Behavior' }).click();
    await expect(page.locator('text=Max Concurrent Sessions')).toBeVisible();
    await expect(page.locator('text=When Max Sessions Reached')).toBeVisible();
    await expect(page.locator('text=Auto-Focus Idle Sessions')).toBeVisible();
    await expect(page.locator('text=Auto-Resume Agents on Restart')).toBeVisible();
    await closeSettings();
  });

  test('shows Layout tab with density, width, visibility, and animation settings', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Layout' }).click();
    await expect(page.locator('text=Card Density')).toBeVisible();
    await expect(page.locator('text=Column Width')).toBeVisible();
    await expect(page.getByText('Terminal Panel', { exact: true })).toBeVisible();
    await expect(page.getByText('Status Bar', { exact: true })).toBeVisible();
    await expect(page.locator('text=Board Search Bar')).toBeVisible();
    await expect(page.locator('text=Restore Window Position')).toBeVisible();
    await expect(page.locator('text=Animations')).toBeVisible();
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

  test('Terminal tab Context Bar section exposes Rate Limits toggle', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Rate Limits', { exact: true })).toBeVisible();
    await expect(page.getByText('Claude 5h / weekly quota bars')).toBeVisible();
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
    // The mock returns { found: true }, so the refresh button has a "Re-detect agent" title
    await expect(page.locator('[title="Re-detect agent"]')).toBeVisible();
    await closeSettings();
  });

  test('permission mode dropdown shows agent-specific modes for Claude Code', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();

    // Find the Permissions setting row by its description text, then locate its select
    const permDescription = page.getByText('How the agent handles tool approvals');
    const permSettingRow = permDescription.locator('..').locator('..').locator('..');
    const permSelect = permSettingRow.locator('select');
    const options = permSelect.locator('option');
    const texts = await options.allTextContents();

    expect(texts).toEqual([
      'Plan (Read-Only)',
      "Don't Ask (Deny Unless Allowed)",
      'Default (Allowlist)',
      'Accept Edits',
      'Auto (Classifier)',
      'Bypass (Unsafe)',
    ]);

    await closeSettings();
  });

  test('permission mode dropdown shows Kimi-specific modes after switching to Kimi agent', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();

    // Switch default agent to Kimi via the Default Agent select.
    const defaultAgentDescription = page.getByText('Which agent CLI to use for new sessions');
    const defaultAgentRow = defaultAgentDescription.locator('..').locator('..').locator('..');
    const agentSelect = defaultAgentRow.locator('select');
    await agentSelect.selectOption({ label: 'Kimi Code' });

    // Cleanup MUST run even if the assertions below throw - otherwise a
    // failing assertion would leak the Kimi-default into subsequent tests
    // and produce confusing cascading failures. try/finally is the only
    // way to guarantee restoration in Playwright tests that mutate shared
    // app state (this test fixture uses module-scoped page + beforeAll).
    try {
      const permDescription = page.getByText('How the agent handles tool approvals');
      const permSettingRow = permDescription.locator('..').locator('..').locator('..');
      const permSelect = permSettingRow.locator('select');

      await expect.poll(async () => {
        const options = permSelect.locator('option');
        return options.allTextContents();
      }, { timeout: 3000 }).toEqual([
        'Plan (Read-Only)',
        'Default (Confirm Actions)',
        'YOLO (Skip Confirmations)',
      ]);

      // The Kimi adapter declares "default" as its defaultPermission.
      // After switching the agent, the permission mode should be set to "default".
      await expect(permSelect).toHaveValue('default');
    } finally {
      // Restore to Claude so later tests are unaffected.
      await agentSelect.selectOption({ label: 'Claude Code' });
      await closeSettings();
    }
  });

  test('permission mode dropdown shows OpenCode-specific modes after switching to OpenCode agent', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent' }).click();

    // Switch default agent to OpenCode via the Default Agent select.
    const defaultAgentDescription = page.getByText('Which agent CLI to use for new sessions');
    const defaultAgentRow = defaultAgentDescription.locator('..').locator('..').locator('..');
    const agentSelect = defaultAgentRow.locator('select');
    await agentSelect.selectOption({ label: 'OpenCode' });

    // Cleanup MUST run even if the assertions below throw - otherwise a
    // failing assertion would leak the OpenCode-default into subsequent tests
    // and produce confusing cascading failures. try/finally is the only
    // way to guarantee restoration in Playwright tests that mutate shared
    // app state (this test fixture uses module-scoped page + beforeAll).
    try {
      const permDescription = page.getByText('How the agent handles tool approvals');
      const permSettingRow = permDescription.locator('..').locator('..').locator('..');
      const permSelect = permSettingRow.locator('select');

      // OpenCode exposes exactly 2 modes: Plan and Build (trimmed from the
      // original 4-entry Claude-shaped list). Verify exact order and no extras.
      await expect.poll(async () => {
        const options = permSelect.locator('option');
        return options.allTextContents();
      }, { timeout: 3000 }).toEqual([
        'Plan',
        'Build',
      ]);

      // The OpenCode adapter declares "acceptEdits" as its defaultPermission.
      // After switching the agent, the permission mode should be set to "acceptEdits".
      await expect(permSelect).toHaveValue('acceptEdits');
    } finally {
      // Restore to Claude so later tests are unaffected.
      await agentSelect.selectOption({ label: 'Claude Code' });
      await closeSettings();
    }
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
    await expect(page.getByText('Give agents tools to interact with your board')).toBeVisible();

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
  test('sidebar context menu opens Settings panel', async () => {
    // Right-click the project row to open the context menu
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.click({ button: 'right' });

    const settingsItem = page.locator('.fixed.bg-surface-raised').locator('text=Project Settings');
    await expect(settingsItem).toBeVisible();
    await settingsItem.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    await closeSettings();
  });

  test('shows all tabs including per-project and shared settings', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // All tabs visible (no separate project panel with fewer tabs)
    await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Layout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();

    // Agent tab should show agent-specific settings
    await page.getByRole('button', { name: 'Agent' }).click();
    await expect(page.getByText('Claude Code Path')).toBeVisible();

    await closeSettings();
  });

  test('Escape closes settings', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
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
    await expect(page.getByText('Agent CLI version')).toBeVisible();
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

    // Should return to normal view (Theme tab is default but font search
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

    // Theme sidebar tab should have a match count badge (name includes count)
    const themeTab = page.getByRole('button', { name: 'Theme 1' });
    await expect(themeTab).not.toHaveClass(/opacity-40/);

    // Terminal sidebar tab should be dimmed (no matches for "theme")
    const terminalTab = page.getByRole('button', { name: 'Terminal', exact: true }).first();
    await expect(terminalTab).toHaveClass(/opacity-40/);

    await closeSettings();
  });

  test('search works from sidebar gear icon', async () => {
    const projectRow = page.locator('[role="button"]').filter({ hasText: 'Settings Test' }).first();
    await projectRow.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    const searchInput = page.getByTestId('settings-search');
    await expect(searchInput).toBeVisible();

    await searchInput.fill('worktree');
    await expect(page.getByText('Enable Worktrees')).toBeVisible();

    await closeSettings();
  });
});
