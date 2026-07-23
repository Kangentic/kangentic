import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';
import { MCP_TOOL_MANIFEST, mcpToolDocsUrl } from '../../src/shared/mcp-tool-manifest';

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
  await page.locator('[data-testid="settings-button"]').click();
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
  test('titlebar gear opens Settings panel with project and system tabs when project is open', async () => {
    await openSettings();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // Representative sample across project tabs (General, Theme, Agent, Git,
    // Shortcuts) and system tabs (Board, Changes, Terminal, Behavior,
    // Hotkeys, MCP Server, Notifications, Privacy). Terminal is a SYSTEM tab
    // (global-only: shell/font/colors/context bar), not a project tab - there
    // is no separate per-project Terminal tab. "Board" is scoped to the
    // settings sidebar because the board/backlog view-toggle behind the panel
    // is also labeled "Board" (see the MCP Server tools-list test below for the
    // same class of collision).
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeVisible();
    await expect(page.getByTestId('settings-tab-list').getByRole('button', { name: 'Board' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hotkeys', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Privacy' })).toBeVisible();

    // System tabs are further grouped into tiers: Core (no header - the
    // first, unlabeled group), Advanced, and Other (Privacy, Developer).
    const tabList = page.getByTestId('settings-tab-list');
    await expect(tabList.getByText('Advanced', { exact: true })).toBeVisible();
    await expect(tabList.getByText('Other', { exact: true })).toBeVisible();

    await closeSettings();
  });

  test('shows Theme tab with color scheme selector', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(page.locator('text=Color scheme for the interface')).toBeVisible();
    await closeSettings();
  });

  test('shows Agent section with CLI Path', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByText('Claude Code Path')).toBeVisible();
    await closeSettings();
  });

  test('shows Behavior section with session limits and toggles', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Behavior' }).click();
    await expect(page.locator('text=Max Concurrent Sessions')).toBeVisible();
    await expect(page.locator('text=When Max Sessions Reached')).toBeVisible();
    await expect(page.locator('text=Auto-Focus Idle Sessions')).toBeVisible();
    await expect(page.locator('text=Auto-Resume Agents on Restart')).toBeVisible();
    // Idle Timeout moved here from the Agent tab: it is a flat, agent-agnostic
    // session-lifecycle setting, not a per-agent one.
    await expect(page.getByText('Idle Timeout (minutes)')).toBeVisible();
    // Windows section: task-window light-dismiss + app window position restore,
    // merged from the old separate Task Windows / App Window sections.
    await expect(page.locator('text=Close on Outside Click')).toBeVisible();
    await expect(page.locator('text=Restore Window Position')).toBeVisible();
    await closeSettings();
  });

  test('shows Board tab with density, width, visibility, config sync, and animation settings', async () => {
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Board' }).click();
    await expect(page.locator('text=Card Density')).toBeVisible();
    await expect(page.locator('text=Column Width')).toBeVisible();
    // Ticket Numbers toggle row (showTaskNumbers) - goes RED if SettingToggleRow is
    // removed from BoardTab.tsx, while leaving all other assertions green.
    await expect(page.locator('text=Ticket Numbers')).toBeVisible();
    // Config Sync section: moved here from Behavior - it is board data
    // reconciliation (kangentic.json), not session/window behavior.
    await expect(page.locator('text=Auto-Apply Board Config Changes')).toBeVisible();
    await expect(page.getByText('Terminal Panel', { exact: true })).toBeVisible();
    await expect(page.getByText('Status Bar', { exact: true })).toBeVisible();
    await expect(page.locator('text=Animations')).toBeVisible();
    await closeSettings();
  });

  test('Terminal tab Terminal Colors offers customizable background, foreground, and cursor swatches', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const colorsRow = page.locator('[data-testid="setting-row-terminal.colors"]');
    await expect(colorsRow.getByTestId('terminal-color-swatch-background')).toBeVisible();
    await expect(colorsRow.getByTestId('terminal-color-swatch-foreground')).toBeVisible();
    await expect(colorsRow.getByTestId('terminal-color-swatch-cursor')).toBeVisible();

    // Opening a swatch shows the shared color picker popover.
    await colorsRow.getByTestId('terminal-color-swatch-background').click();
    await expect(page.getByTitle('Custom color')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTitle('Custom color')).toHaveCount(0);

    await expect(colorsRow.getByTestId('terminal-colors-reset-all')).toBeVisible();

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

  test('shows Terminal tab with shell, font size, font family, scrollback, cursor style, and backspace behavior', async () => {
    // Terminal is a SYSTEM (global-only) tab: these fields no longer save to
    // the project override, they save to global config.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    await expect(page.getByText('Terminal shell used for agent sessions')).toBeVisible();
    await expect(page.getByText('Font Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font Family', { exact: true })).toBeVisible();
    await expect(page.getByText('Scrollback Lines')).toBeVisible();
    await expect(page.getByText('Cursor Style')).toBeVisible();
    // Word delete on Backspace (terminal.backspaceSendsCtrlH) - goes RED if the
    // SettingToggleRow is removed from TerminalTab.tsx, while leaving all other
    // assertions here green.
    await expect(page.getByText('Word delete on Backspace')).toBeVisible();
    await expect(page.getByText('Context Bar')).toBeVisible();

    await closeSettings();
  });

  test('Terminal tab font size writes to global config, not the project override', async () => {
    // terminal.fontSize (and shell/fontFamily/scrollbackLines/cursorStyle) moved
    // from project-overridable to global-only. This pins the actual write
    // path, not just the UI copy.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontSizeRow = page.locator('[data-testid="setting-row-terminal.fontSize"]');
    const fontSizeInput = fontSizeRow.locator('input');
    await fontSizeInput.fill('22');
    await fontSizeInput.blur();

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontSize: number } }).terminal.fontSize;
    }, { timeout: 3000 }).toBe(22);

    const projectOverrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
    expect((projectOverrides as { terminal?: { fontSize?: number } } | null)?.terminal?.fontSize).toBeUndefined();

    // Restore so later tests are unaffected.
    await fontSizeInput.fill('14');
    await fontSizeInput.blur();
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontSize: number } }).terminal.fontSize;
    }, { timeout: 3000 }).toBe(14);

    await closeSettings();
  });

  test('Terminal tab Context Bar section exposes Rate Limits toggle', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Context Bar')).toBeVisible();
    await expect(page.getByText('Rate Limits', { exact: true })).toBeVisible();
    await expect(page.getByText('Claude 5h / weekly quota bars')).toBeVisible();
    await closeSettings();
  });

  test('toggling Word delete on Backspace persists terminal.backspaceSendsCtrlH to global config, not the project override', async () => {
    // DEFAULT_CONFIG.terminal.backspaceSendsCtrlH is true on all platforms
    // (src/shared/types.ts), so the switch starts checked with no prior setup.
    // Terminal is a SYSTEM (global-only) tab, so this pins the actual write
    // path, not just the UI copy.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const toggle = page.getByRole('switch', { name: 'Word delete on Backspace' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { backspaceSendsCtrlH: boolean } }).terminal.backspaceSendsCtrlH;
    }, { timeout: 3000 }).toBe(false);

    const projectOverrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
    expect((projectOverrides as { terminal?: { backspaceSendsCtrlH?: boolean } } | null)?.terminal?.backspaceSendsCtrlH).toBeUndefined();

    // Toggle back on, restoring the default state so later tests in this
    // shared-page file are unaffected.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { backspaceSendsCtrlH: boolean } }).terminal.backspaceSendsCtrlH;
    }, { timeout: 3000 }).toBe(true);

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
    const gearButton = page.locator('[data-testid="settings-button"]');

    await gearButton.click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await expect(gearButton).toHaveClass(/bg-surface-hover/);

    await closeSettings();
  });

  test('CLI path status indicator appears after panel opens', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    // The mock returns { found: true }, so the refresh button has a "Re-detect agent" title
    await expect(page.locator('[title="Re-detect agent"]')).toBeVisible();
    await closeSettings();
  });

  test('permission mode dropdown shows agent-specific modes for Claude Code', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();

    // Permission mode is a Combobox (input + dropdown, not a native <select>):
    // open it and read the option rows.
    const permInput = page.locator('input[data-testid="agent-permission-mode"]');
    await permInput.click();
    const texts = await page.locator('[data-combobox-option]').allTextContents();

    expect(texts).toEqual([
      'Plan (Read-Only)',
      "Don't Ask (Deny Unless Allowed)",
      'Default (Allowlist)',
      'Accept Edits',
      'Auto (Classifier)',
      'Bypass (Unsafe)',
    ]);

    // The Combobox's Escape handler doesn't stop propagation, so a single
    // Escape (fired by closeSettings() below) closes both the popover and
    // the whole panel in one press - no separate close needed here.
    await closeSettings();
  });

  test('permission mode dropdown shows Kimi-specific modes after switching to Kimi agent', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();

    // Switch default agent to Kimi via the Default Agent combobox.
    const agentInput = page.locator('input[data-testid="project-default-agent"]');
    await agentInput.click();
    await page.locator('[data-testid="project-default-agent-option-kimi"]').click();

    // Cleanup MUST run even if the assertions below throw - otherwise a
    // failing assertion would leak the Kimi-default into subsequent tests
    // and produce confusing cascading failures. try/finally is the only
    // way to guarantee restoration in Playwright tests that mutate shared
    // app state (this test fixture uses module-scoped page + beforeAll).
    try {
      const permRow = page.locator('div:has(> input[data-testid="agent-permission-mode"])');
      const permInput = page.locator('input[data-testid="agent-permission-mode"]');

      await expect.poll(async () => {
        await permInput.click();
        const texts = await page.locator('[data-combobox-option]').allTextContents();
        // Close via the chevron toggle, not Escape: the Settings panel itself
        // closes on Escape (see "Escape key closes panel" above), so pressing
        // it here would tear down the whole panel instead of just this popover.
        await permRow.locator('button[title="Close dropdown"]').click();
        return texts;
      }, { timeout: 3000 }).toEqual([
        'Plan (Read-Only)',
        'Default (Confirm Actions)',
        'YOLO (Skip Confirmations)',
      ]);

      // The Kimi adapter declares "default" as its defaultPermission. After
      // switching the agent, the permission mode should be set to "default"
      // - shown here as its label, since the Combobox displays the resolved
      // option's label, not its raw value.
      await expect(permInput).toHaveValue('Default (Confirm Actions)');
    } finally {
      // Restore to Claude so later tests are unaffected.
      await agentInput.click();
      await page.locator('[data-testid="project-default-agent-option-claude"]').click();
      await closeSettings();
    }
  });

  test('permission mode dropdown shows OpenCode-specific modes after switching to OpenCode agent', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();

    // Switch default agent to OpenCode via the Default Agent combobox.
    const agentInput = page.locator('input[data-testid="project-default-agent"]');
    await agentInput.click();
    await page.locator('[data-testid="project-default-agent-option-opencode"]').click();

    // Cleanup MUST run even if the assertions below throw - otherwise a
    // failing assertion would leak the OpenCode-default into subsequent tests
    // and produce confusing cascading failures. try/finally is the only
    // way to guarantee restoration in Playwright tests that mutate shared
    // app state (this test fixture uses module-scoped page + beforeAll).
    try {
      const permRow = page.locator('div:has(> input[data-testid="agent-permission-mode"])');
      const permInput = page.locator('input[data-testid="agent-permission-mode"]');

      // OpenCode exposes exactly 2 modes: Plan and Build (trimmed from the
      // original 4-entry Claude-shaped list). Verify exact order and no extras.
      await expect.poll(async () => {
        await permInput.click();
        const texts = await page.locator('[data-combobox-option]').allTextContents();
        // Close via the chevron toggle, not Escape - see the Kimi test above.
        await permRow.locator('button[title="Close dropdown"]').click();
        return texts;
      }, { timeout: 3000 }).toEqual([
        'Plan',
        'Build',
      ]);

      // The OpenCode adapter declares "acceptEdits" as its defaultPermission.
      // After switching the agent, the permission mode should be set to
      // "acceptEdits" - shown here as its label (see the Kimi test above).
      await expect(permInput).toHaveValue('Build');
    } finally {
      // Restore to Claude so later tests are unaffected.
      await agentInput.click();
      await page.locator('[data-testid="project-default-agent-option-claude"]').click();
      await closeSettings();
    }
  });

  test('board remains visible behind settings panel', async () => {
    await openSettings();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeAttached();
    await expect(page.locator('[data-swimlane-name="Planning"]')).toBeAttached();
    await closeSettings();
  });

  test('shows MCP Server tab with toggle, grouped tools list, and how it works', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'MCP Server' }).click();

    // Banner with toggle should be visible
    await expect(page.getByText('Kangentic MCP Server')).toBeVisible();
    await expect(page.getByText('Give agents tools to interact with your board')).toBeVisible();

    // No user-tunable task-creation cap anymore (it is now a fixed internal backstop).
    await expect(page.getByText('Max Tasks Per Session')).toHaveCount(0);

    // The tools list renders from MCP_TOOL_MANIFEST, grouped by category as pills.
    // Spot-check each section header by its heading role (short labels like "Board"
    // are substrings of tool names AND collide with the board view-toggle button
    // behind the panel) plus a representative tool from each group. Backlog tools
    // and the unified Search tool live under Board; sessions under Sessions. "Search"
    // needs `exact: true` - without it, the substring match also hits "Search Tasks".
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
    await expect(page.getByText('Create Task')).toBeVisible();
    // exact: true - without it, the substring match also hits "Move Task to Project".
    await expect(page.getByText('Move Task', { exact: true })).toBeVisible();
    await expect(page.getByText('Delete Task')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
    await expect(page.getByText('List Backlog')).toBeVisible();
    await expect(page.getByText('Search', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(page.getByText('Session History')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser Automation', exact: true })).toBeVisible();
    await expect(page.getByText('Bounding Box')).toBeVisible();

    // The complete catalogue (including the dev-leaning diagnostics group) is now
    // rendered as pills, one per manifest entry. Pinning the pill count to the
    // manifest length is the red-green anchor: dropping a tool, or a category that
    // fails to render, fails here, and a newly-added tool is covered for free.
    await expect(page.getByTestId('mcp-tool-pill')).toHaveCount(MCP_TOOL_MANIFEST.length);
    // The diagnostics tools that the panel used to omit now appear under their header.
    await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
    await expect(page.getByText('Tail Logs', { exact: true })).toBeVisible();
    await expect(page.getByText('Query Database', { exact: true })).toBeVisible();
    await expect(page.getByText('List Worktrees', { exact: true })).toBeVisible();

    // Each pill deep-links to its docs section. Patch the mock's no-op openExternal
    // to record the URL, click one pill, and assert it opened the derived docs URL.
    await page.evaluate(() => {
      window.__openedExternalUrls = [];
      window.electronAPI.shell.openExternal = async function (url: string) {
        window.__openedExternalUrls?.push(url);
      };
    });
    await page.getByTestId('mcp-tool-pill').filter({ hasText: 'Create Task' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual([mcpToolDocsUrl('kangentic_create_task')]);
    // Restore the mock's default no-op so this patch does not leak into later tests
    // on the shared page (matches mock-electron-api.js shell.openExternal).
    await page.evaluate(() => {
      window.electronAPI.shell.openExternal = async function () {
        return;
      };
    });

    // How It Works section
    await expect(page.getByText('How It Works')).toBeVisible();

    await closeSettings();
  });

  test('reopens to the last viewed tab after closing', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.getByText('Enable Worktrees')).toBeVisible();
    await closeSettings();

    // Reopening returns to Git, not the first tab.
    await openSettings();
    await expect(page.getByText('Enable Worktrees')).toBeVisible();

    // Reset to General so later tests start from a known tab.
    await page.getByRole('button', { name: 'General', exact: true }).click();
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
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git' })).toBeVisible();
    await expect(page.getByTestId('settings-tab-list').getByRole('button', { name: 'Board' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behavior' })).toBeVisible();

    // Agent tab should show agent-specific settings
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
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

    // Should return to normal view (General tab is default but font search
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

    // Theme sidebar tab should have a match count badge (name includes count).
    const themeTab = page.getByRole('button', { name: 'Theme 1' });
    await expect(themeTab).not.toHaveClass(/opacity-40/);

    // General sidebar tab should be dimmed (no matches for "theme" - it only
    // holds Project Location now that Theme is its own tab).
    const generalTab = page.getByRole('button', { name: 'General', exact: true });
    await expect(generalTab).toHaveClass(/opacity-40/);

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
