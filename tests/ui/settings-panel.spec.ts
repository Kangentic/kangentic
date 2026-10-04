import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';
import { MCP_SERVER_DOCS_URL, MCP_TOOL_CATEGORIES, MCP_TOOL_MANIFEST, mcpToolDocsUrl } from '../../src/shared/mcp-tool-manifest';

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

/**
 * Close any open settings panel via Escape, innermost layer first: an open
 * combobox menu consumes the first Escape (see combobox-escape-layering.spec.ts),
 * a search query clears on the next, and only then does the panel close.
 */
async function closeSettings() {
  // "Open" is read off the chevron, whose aria-label flips on the same render
  // as the menu state. The popover element is the wrong signal: a menu just
  // closed by a click stays mounted for its exit animation, and its exit class
  // lands a render later, so an extra press aimed at it would reach the panel.
  // Scoped to the panel so a menu leaked elsewhere on the shared page is not
  // mistaken for this panel's own state.
  const openChevron = page.getByTestId('settings-panel').locator('button[aria-label="Close dropdown"]').first();
  if (await openChevron.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(openChevron).toBeHidden({ timeout: 2000 });
  }
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
    await expect(page.getByTestId('settings-tab-list').getByRole('button', { name: 'Task', exact: true })).toBeVisible();
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

  test('shows Theme tab with the swatch grid', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    // The row's testid, not its copy: the description is product text that changes.
    await expect(page.getByTestId('setting-row-theme')).toBeVisible();
    await expect(page.getByTestId('theme-grid')).toBeVisible();
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
    await expect(page.getByText('When max sessions are reached', { exact: true })).toBeVisible();
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

  test('shows Board tab with width and config sync settings, and no longer Animations', async () => {
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Board' }).click();
    await expect(page.getByText('Column width', { exact: true })).toBeVisible();
    // Config Sync section: moved here from Behavior - it is board data
    // reconciliation (kangentic.json), not session/window behavior.
    await expect(page.locator('text=Auto-Apply Board Config Changes')).toBeVisible();
    await expect(page.getByText('Terminal panel', { exact: true })).toBeVisible();
    await expect(page.getByText('Status bar', { exact: true })).toBeVisible();
    // Animations LEFT for the Performance tab: it toggles .no-motion on <html>,
    // so it is app-wide rendering and never was board chrome. Asserted absent
    // here as well as present there, so a half-done move fails on one side.
    await expect(page.getByTestId('setting-row-animationsEnabled')).toHaveCount(0);
    await closeSettings();
  });

  test('shows Performance tab with graphics acceleration and the Animations row moved from Board', async () => {
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Performance' }).click();
    await expect(page.getByTestId('setting-row-graphicsAccelerationEnabled')).toBeVisible();
    await expect(page.getByTestId('setting-row-animationsEnabled')).toBeVisible();
    // The callout is for an install Kangentic downgraded itself. This fixture
    // is a normal one, so it must stay quiet.
    await expect(page.getByTestId('graphics-acceleration-notice')).toHaveCount(0);
    await closeSettings();
  });

  test('shows Task tab with card density, card preview, ticket numbers, and context bar settings', async () => {
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.locator('text=Card Density')).toBeVisible();
    // Card Preview choice (cardPreview) - goes RED if its row is removed from
    // TaskTab.tsx, while leaving all other assertions green.
    await expect(page.locator('text=Card Preview')).toBeVisible();
    await expect(page.getByTestId('card-preview-choice').getByRole('radio', { name: 'Latest' })).toHaveAttribute('aria-checked', 'true');
    // Ticket Numbers toggle row (showTaskNumbers) - goes RED if its CardToggleRow is
    // removed from TaskTab.tsx, while leaving all other assertions green.
    await expect(page.locator('text=Ticket Numbers')).toBeVisible();
    await expect(page.getByText('Context Bar')).toBeVisible();
    await closeSettings();
  });

  test('shows Changes tab with diff scope, whitespace, collapse, sort, and flat-list settings', async () => {
    // diffViewMode itself is exercised end-to-end (including that the Changes
    // tab mounts and drives the shared config key) by
    // diff-view-mode-preference.spec.ts. This test's unique value is the other
    // five rows on ChangesTab.tsx, which had no render-level assertion of their
    // own before (only the sidebar tab BUTTON's visibility was checked).
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Changes' }).click();
    await expect(page.locator('text=Default Diff Scope')).toBeVisible();
    await expect(page.locator('text=Ignore Whitespace')).toBeVisible();
    // Collapse Unchanged Regions toggle row - goes RED if the CardToggleRow
    // is removed from ChangesTab.tsx, while leaving all other assertions green.
    await expect(page.locator('text=Collapse Unchanged Regions')).toBeVisible();
    await expect(page.locator('text=File Sort')).toBeVisible();
    await expect(page.locator('text=Flat File List')).toBeVisible();
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
    await expect(page.getByText('Agent Crash')).toBeVisible();
    await expect(page.getByText('Plan Complete')).toBeVisible();
    // Delivery settings
    await expect(page.getByText('Toast Auto-Dismiss')).toBeVisible();
    await expect(page.getByText('Max Visible Toasts')).toBeVisible();
    await closeSettings();
  });

  test('Agent Crash notification choice writes to notifications.desktop/toasts.onAgentCrash in global config, not the project override', async () => {
    // NotifyChannelRow (NotificationsTab.tsx) is the write path shared by all
    // four Events rows; Agent Crash is the row this change added, so it is
    // the natural row to pin the shared behavior against. The structural
    // parity checks in settings-tab-scope-parity.test.ts (e/f/g) are pure
    // regex scans over NotificationsTab.tsx - they never execute the
    // component, so none of them prove the choice actually writes the
    // config path it claims, that it writes to GLOBAL config (not the
    // project override, per settings-tab-scope.md), or that it leaves the
    // other three event rows' values untouched. This is UI-tier coverage
    // against the mock config, the same fidelity as the Terminal font-size
    // and Word-delete-on-Backspace persistence tests above - not a real
    // config.json round trip.
    await openSettings();
    await page.getByRole('button', { name: 'Notifications' }).click();

    // A four-option segmented control (Off / Desktop / Toast / Both).
    const option = (value: string) => page.getByTestId(`notify-channel-onAgentCrash-${value}`);

    type NotificationsConfig = {
      notifications: {
        desktop: { onAgentIdle: boolean; onAgentCrash: boolean; onPlanComplete: boolean; onSpawnStalled: boolean };
        toasts: { onAgentIdle: boolean; onAgentCrash: boolean; onPlanComplete: boolean; onSpawnStalled: boolean; durationSeconds: number; maxCount: number };
      };
    };
    const readGlobalNotifications = async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as NotificationsConfig).notifications;
    };

    // mock-electron-api.js seeds onAgentCrash true on both channels, so the
    // choice starts on "Both". Capture the full baseline (including the
    // three sibling event rows and the Delivery numbers) before mutating,
    // so a shallow-merge bug that wipes siblings has something to be caught
    // against.
    const baseline = await readGlobalNotifications();
    expect(baseline.desktop.onAgentCrash).toBe(true);
    expect(baseline.toasts.onAgentCrash).toBe(true);
    await expect(option('both')).toHaveAttribute('aria-checked', 'true');

    // "Desktop": desktop stays true, toasts flips to false. Asserting both
    // channels (not just one) rules out a handler that sets both from a
    // single-channel selection.
    await option('desktop').click();
    await expect.poll(async () => (await readGlobalNotifications()).desktop.onAgentCrash, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => (await readGlobalNotifications()).toasts.onAgentCrash, { timeout: 3000 }).toBe(false);
    // Read direction: the control must reflect the new committed value, not
    // just the write succeeding underneath it.
    await expect(option('desktop')).toHaveAttribute('aria-checked', 'true');

    const afterWrite = await readGlobalNotifications();
    expect(afterWrite.desktop.onAgentIdle).toBe(baseline.desktop.onAgentIdle);
    expect(afterWrite.desktop.onPlanComplete).toBe(baseline.desktop.onPlanComplete);
    expect(afterWrite.desktop.onSpawnStalled).toBe(baseline.desktop.onSpawnStalled);
    expect(afterWrite.toasts.onAgentIdle).toBe(baseline.toasts.onAgentIdle);
    expect(afterWrite.toasts.onPlanComplete).toBe(baseline.toasts.onPlanComplete);
    expect(afterWrite.toasts.onSpawnStalled).toBe(baseline.toasts.onSpawnStalled);
    expect(afterWrite.toasts.durationSeconds).toBe(baseline.toasts.durationSeconds);
    expect(afterWrite.toasts.maxCount).toBe(baseline.toasts.maxCount);

    // Events rows are notifications.* - a global-only (system-tab) scope.
    // The project override must never receive this write.
    const projectOverrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
    expect((projectOverrides as { notifications?: { desktop?: { onAgentCrash?: boolean } } } | null)?.notifications?.desktop?.onAgentCrash).toBeUndefined();

    // Restore so later tests in this shared-page file are unaffected.
    await option('both').click();
    await expect.poll(async () => (await readGlobalNotifications()).desktop.onAgentCrash, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => (await readGlobalNotifications()).toasts.onAgentCrash, { timeout: 3000 }).toBe(true);

    await closeSettings();
  });

  test('shows Terminal tab with shell, font size, font family, cursor style, and backspace behavior', async () => {
    // Terminal is a SYSTEM (global-only) tab: these fields no longer save to
    // the project override, they save to global config.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    await expect(page.getByTestId('setting-row-terminal.shell')).toBeVisible();
    await expect(page.getByText('Font size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font family', { exact: true })).toBeVisible();
    await expect(page.getByText('Cursor style', { exact: true })).toBeVisible();
    // Word delete on Backspace (terminal.backspaceSendsCtrlH) - goes RED if the
    // CardToggleRow is removed from TerminalTab.tsx, while leaving all other
    // assertions here green.
    await expect(page.getByText('Word delete on Backspace')).toBeVisible();
    // Scrollback Lines was removed (the live xterm scrollback cap is now a
    // fixed internal constant, TERMINAL_SCROLLBACK_LINES in useTerminal.ts,
    // not a user setting). Pin the row's absence by testid so a re-added
    // row or registry entry is caught even if the label text changes.
    await expect(page.locator('[data-testid="setting-row-terminal.scrollbackLines"]')).toHaveCount(0);

    await closeSettings();
  });

  test('Terminal tab font size writes to global config, not the project override', async () => {
    // terminal.fontSize (and shell/fontFamily/cursorStyle) moved
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

  /** Records every numeric terminal.fontSize passed to config.set into window.__fontSizeWrites. */
  async function recordFontSizeWrites() {
    await page.evaluate(() => {
      const configApi = window.electronAPI.config as unknown as { set: (partial: unknown) => Promise<unknown> };
      const originalSet = configApi.set;
      const fontSizeWrites: number[] = [];
      const recorder = window as unknown as {
        __fontSizeWrites: number[];
        __restoreConfigSet: () => void;
      };
      recorder.__fontSizeWrites = fontSizeWrites;
      recorder.__restoreConfigSet = () => { configApi.set = originalSet; };
      configApi.set = (partial: unknown) => {
        const fontSize = (partial as { terminal?: { fontSize?: unknown } } | null)?.terminal?.fontSize;
        if (typeof fontSize === 'number') fontSizeWrites.push(fontSize);
        return originalSet(partial);
      };
    });
  }

  async function readFontSizeWrites() {
    return page.evaluate(() => (window as unknown as { __fontSizeWrites: number[] }).__fontSizeWrites);
  }

  async function readGlobalFontSize() {
    const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
    return (globalConfig as { terminal: { fontSize: number } }).terminal.fontSize;
  }

  test('Terminal tab font size never commits a value below its range while one is typed', async () => {
    // Typing "12" passes through "1". The field used to commit every keystroke,
    // so every mounted terminal ran at 1px for a moment, which crashes xterm's
    // WebGL renderer (DESKTOP-1J/1K) and refits every PTY. fill() would set "12"
    // in one step and skip the "1", so this types it.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await recordFontSizeWrites();

    try {
      const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('12');
      // The field shows what was typed, mid-entry included.
      await expect(fontSizeInput).toHaveValue('12');
      await fontSizeInput.blur();

      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(12);
      const writes = await readFontSizeWrites();
      // Positive control: the typing did write, so the check below is not vacuous.
      expect(writes).toContain(12);
      expect(writes.filter((fontSize) => fontSize < 8)).toEqual([]);

      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreConfigSet: () => void }).__restoreConfigSet());
      await closeSettings();
    }
  });

  test('Terminal tab font size never commits a value above its range while one is typed', async () => {
    // Typing "100" passes through "10", which is in range, and then reaches
    // "100", which is not. Typing "40" is out of range at both keystrokes.
    // Goes RED if the `fontSize <= TERMINAL_FONT_SIZE_MAX` clause is removed
    // from FontSizeField.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await recordFontSizeWrites();

    try {
      const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
      await expect(fontSizeInput).toHaveValue('14');

      // "40" (and the "4" before it) is never in range, so nothing is written.
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('40');
      await expect(fontSizeInput).toHaveValue('40');
      await fontSizeInput.blur();
      await expect(fontSizeInput).toHaveValue('14');
      expect(await readFontSizeWrites()).toEqual([]);
      expect(await readGlobalFontSize()).toBe(14);

      // "100": "1" is below the range, "10" is in range and commits, "100"
      // is above the range and does not.
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('100');
      await expect(fontSizeInput).toHaveValue('100');
      await fontSizeInput.blur();

      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(10);
      const writes = await readFontSizeWrites();
      expect(writes).toEqual([10]);
      expect(writes.filter((fontSize) => fontSize > 32)).toEqual([]);
      expect(writes.filter((fontSize) => fontSize < 8)).toEqual([]);
      // Blur puts back the committed value, not the rejected "100".
      await expect(fontSizeInput).toHaveValue('10');

      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreConfigSet: () => void }).__restoreConfigSet());
      await closeSettings();
    }
  });

  test('Terminal tab font size restores the committed value on blur after an out-of-range or empty entry', async () => {
    // The draft shows what was typed while the field is focused, even when it
    // was rejected. Blur drops the draft so the field shows the real setting
    // again. Goes RED if `onBlur={() => setDraft(null)}` is removed from
    // FontSizeField.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await recordFontSizeWrites();

    try {
      const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
      await expect(fontSizeInput).toHaveValue('14');

      // Out of range: shown while typed, not written, replaced on blur.
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('5');
      await expect(fontSizeInput).toHaveValue('5');
      expect(await readFontSizeWrites()).toEqual([]);
      await fontSizeInput.blur();
      await expect(fontSizeInput).toHaveValue('14');
      expect(await readGlobalFontSize()).toBe(14);

      // Cleared to empty: shown empty while focused, not written, replaced on blur.
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.press('Backspace');
      await expect(fontSizeInput).toHaveValue('');
      expect(await readFontSizeWrites()).toEqual([]);
      await fontSizeInput.blur();
      await expect(fontSizeInput).toHaveValue('14');
      expect(await readGlobalFontSize()).toBe(14);
      expect(await readFontSizeWrites()).toEqual([]);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreConfigSet: () => void }).__restoreConfigSet());
      await closeSettings();
    }
  });

  test('Terminal tab font size marks a rejected value and drops its draft when the setting changes from outside', async () => {
    // A rejected keystroke used to be silent, and a held draft hid a change made
    // elsewhere (another window, an agent, a hand-edited config) until blur.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    try {
      await expect(fontSizeInput).toHaveValue('14');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');

      const readBorderColor = () => fontSizeInput.evaluate((element) => getComputedStyle(element).borderTopColor);
      await fontSizeInput.click();
      const focusedBorderColor = await readBorderColor();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('5');
      await expect(fontSizeInput).toHaveValue('5');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');
      // The warning border really paints, over the focus border it competes with.
      await expect.poll(readBorderColor).not.toBe(focusedBorderColor);
      // The range is said inline, not only in a hover tooltip, and the input
      // points at it for a screen reader.
      const rangeMessage = page.getByTestId('terminal-font-size-range');
      await expect(rangeMessage).toHaveText('Use 8 to 32.');
      const rangeMessageId = await rangeMessage.getAttribute('id');
      await expect(fontSizeInput).toHaveAttribute('aria-describedby', rangeMessageId ?? '');

      // Still focused, the setting moves from outside the field.
      await page.evaluate(async () => {
        const stores = (window as unknown as {
          __zustandStores: { config: { getState: () => { updateConfig: (partial: { terminal: { fontSize: number } }) => Promise<unknown> } } };
        }).__zustandStores;
        await stores.config.getState().updateConfig({ terminal: { fontSize: 18 } });
      });
      await expect(fontSizeInput).toBeFocused();
      await expect(fontSizeInput).toHaveValue('18');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');
      await expect(rangeMessage).toHaveCount(0);

      // A value typed after that is a fresh draft against 18, and it commits.
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('16');
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(16);
      await expect(fontSizeInput).toHaveValue('16');
    } finally {
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  /**
   * Holds every terminal.fontSize config.set until the test releases it, so the test
   * decides when each round trip lands. The store's `updateConfig` is not optimistic:
   * it awaits config.set and then refreshes, so the field's `value` prop moves only
   * after a release. A held call has not touched the mock config yet.
   */
  async function holdFontSizeWrites() {
    await page.evaluate(() => {
      const configApi = window.electronAPI.config as unknown as { set: (partial: unknown) => Promise<unknown> };
      const originalSet = configApi.set;
      const heldSets: Array<{ fontSize: number; released: boolean; release: () => Promise<void> }> = [];
      const holder = window as unknown as {
        __heldFontSizeSets: typeof heldSets;
        __restoreConfigSet: () => void;
      };
      holder.__heldFontSizeSets = heldSets;
      holder.__restoreConfigSet = () => { configApi.set = originalSet; };
      configApi.set = (partial: unknown) => {
        const fontSize = (partial as { terminal?: { fontSize?: unknown } } | null)?.terminal?.fontSize;
        if (typeof fontSize !== 'number') return originalSet(partial);
        return new Promise((resolve, reject) => {
          const held = {
            fontSize,
            released: false,
            release: () => {
              held.released = true;
              return originalSet(partial).then(resolve, reject);
            },
          };
          heldSets.push(held);
        });
      };
    });
  }

  async function readHeldFontSizes() {
    return page.evaluate(() => (window as unknown as { __heldFontSizeSets: Array<{ fontSize: number }> })
      .__heldFontSizeSets.map((held) => held.fontSize));
  }

  /** Lands one held set (it writes the mock config and resolves the store's await). */
  async function releaseHeldFontSizeSet(index: number) {
    await page.evaluate((heldIndex) => (window as unknown as {
      __heldFontSizeSets: Array<{ release: () => Promise<void> }>;
    }).__heldFontSizeSets[heldIndex].release(), index);
  }

  /** The font size the renderer's config store holds, which is what the field's value prop reads. */
  async function readStoreFontSize() {
    return page.evaluate(() => (window as unknown as {
      __zustandStores: { config: { getState: () => { globalConfig: { terminal: { fontSize: number } } } } };
    }).__zustandStores.config.getState().globalConfig.terminal.fontSize);
  }

  /** Waits two frames, so a store change has been rendered before the field is read. */
  async function waitForRender() {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }

  /** Lands anything still held, then puts the real config.set back. */
  async function releaseAndRestoreConfigSet() {
    await page.evaluate(async () => {
      const holder = window as unknown as {
        __heldFontSizeSets: Array<{ released: boolean; release: () => Promise<void> }>;
        __restoreConfigSet: () => void;
      };
      for (const held of holder.__heldFontSizeSets) {
        if (!held.released) await held.release();
      }
      holder.__restoreConfigSet();
    });
  }

  test('Terminal tab font size keeps its draft while the store steps through several in-flight commits', async () => {
    // The store reaches each commit one round trip at a time. With 10 and 16 both
    // in flight, the store landing on 10 must not drop the "16" the user typed,
    // or the field flashes "10" under the cursor. Goes RED if FontSizeField tracks
    // only the latest commit (a single-slot pending value) instead of the list.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await holdFontSizeWrites();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    try {
      await expect(fontSizeInput).toHaveValue('14');
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      // "1" is out of range and writes nothing, "10" commits and is held.
      await fontSizeInput.pressSequentially('10');
      await expect.poll(readHeldFontSizes).toEqual([10]);
      // Backspace leaves "1": rejected, and the held 10 stays in flight.
      await fontSizeInput.press('Backspace');
      await expect(fontSizeInput).toHaveValue('1');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');
      await fontSizeInput.pressSequentially('6');
      await expect(fontSizeInput).toHaveValue('16');
      await expect.poll(readHeldFontSizes).toEqual([10, 16]);
      // Nothing has landed, so the store still holds the starting value.
      expect(await readStoreFontSize()).toBe(14);

      // The first commit lands and the store moves to 10, a value the draft did not type last.
      await releaseHeldFontSizeSet(0);
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(10);
      await waitForRender();
      await expect(fontSizeInput).toHaveValue('16');
      await expect(fontSizeInput).toBeFocused();

      // The second lands and the store catches up to what is on screen.
      await releaseHeldFontSizeSet(1);
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(16);
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(16);
      await waitForRender();
      await expect(fontSizeInput).toHaveValue('16');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');
    } finally {
      await releaseAndRestoreConfigSet();
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  test('Terminal tab font size keeps a commit in flight across a rejected keystroke', async () => {
    // "10" commits and is still in flight when "100" is typed and rejected. When the
    // held commit lands, the draft must survive it: the rejected "100" stays on
    // screen and marked invalid while focused, and blur puts back the committed 10.
    // Goes RED if a rejected keystroke clears the pending commits.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await holdFontSizeWrites();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    try {
      await expect(fontSizeInput).toHaveValue('14');
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('10');
      await expect.poll(readHeldFontSizes).toEqual([10]);
      await fontSizeInput.pressSequentially('0');
      await expect(fontSizeInput).toHaveValue('100');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');
      // The rejected "100" wrote nothing.
      expect(await readHeldFontSizes()).toEqual([10]);

      await releaseHeldFontSizeSet(0);
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(10);
      await waitForRender();
      await expect(fontSizeInput).toHaveValue('100');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');
      await expect(fontSizeInput).toBeFocused();

      await fontSizeInput.blur();
      await expect(fontSizeInput).toHaveValue('10');
      expect(await readGlobalFontSize()).toBe(10);
    } finally {
      await releaseAndRestoreConfigSet();
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  test('Terminal tab font size drops commits the store has already passed, so a later outside change to one is not hidden', async () => {
    // 10 and 16 are both in flight and the store lands on each in turn. The next
    // keystroke re-slices the pending list, which drops the settled 10. When the
    // setting then moves to 10 from outside, 10 is no longer one of the draft's own
    // values, so the field must show it. Goes RED if the settled values are kept
    // (`const stillPending = inFlight`): 10 still matches, and the stale "160"
    // stays on screen, marked invalid.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await holdFontSizeWrites();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    try {
      await expect(fontSizeInput).toHaveValue('14');
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('10');
      await expect.poll(readHeldFontSizes).toEqual([10]);
      await fontSizeInput.press('Backspace');
      await fontSizeInput.pressSequentially('6');
      await expect(fontSizeInput).toHaveValue('16');
      await expect.poll(readHeldFontSizes).toEqual([10, 16]);

      // Both land, in order, so the store ends on 16 with 10 behind it.
      await releaseHeldFontSizeSet(0);
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(10);
      await releaseHeldFontSizeSet(1);
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(16);
      await waitForRender();
      await expect(fontSizeInput).toHaveValue('16');

      // A rejected keystroke re-slices the pending list against the store's 16.
      await fontSizeInput.pressSequentially('0');
      await expect(fontSizeInput).toHaveValue('160');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');

      // The setting moves to 10 from outside. Nothing is held any more, so the
      // real config.set goes back before the store is driven.
      await releaseAndRestoreConfigSet();
      await page.evaluate(async () => {
        const stores = (window as unknown as {
          __zustandStores: { config: { getState: () => { updateConfig: (partial: { terminal: { fontSize: number } }) => Promise<unknown> } } };
        }).__zustandStores;
        await stores.config.getState().updateConfig({ terminal: { fontSize: 10 } });
      });
      await expect.poll(readStoreFontSize, { timeout: 3000 }).toBe(10);
      await expect(fontSizeInput).toHaveValue('10');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');
      await expect(page.getByTestId('terminal-font-size-range')).toHaveCount(0);
      await expect(fontSizeInput).toBeFocused();
    } finally {
      await releaseAndRestoreConfigSet();
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  test('Terminal tab font size rejects 7 and 33 and commits 8 and 32, the edges of its range', async () => {
    // The range is 8 to 32 inclusive. Goes RED if the lower bound becomes `>`
    // (8 stops committing) or the upper bound becomes `<` (32 stops committing).
    // Typing "33" and "32" both pass through "3", which is below the range and
    // writes nothing, so the writes list shows only the final value.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await recordFontSizeWrites();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    const rangeMessage = page.getByTestId('terminal-font-size-range');
    const clearRecordedWrites = () => page.evaluate(() => {
      (window as unknown as { __fontSizeWrites: number[] }).__fontSizeWrites.length = 0;
    });
    const typeReplacing = async (text: string) => {
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially(text);
      await expect(fontSizeInput).toHaveValue(text);
    };

    try {
      await expect(fontSizeInput).toHaveValue('14');

      // One under and one over: shown and marked while focused, never written,
      // and blur puts back the committed 14.
      for (const rejected of ['7', '33']) {
        await clearRecordedWrites();
        await typeReplacing(rejected);
        await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');
        await expect(rangeMessage).toHaveText('Use 8 to 32.');
        expect(await readFontSizeWrites()).toEqual([]);
        await fontSizeInput.blur();
        await expect(fontSizeInput).toHaveValue('14');
        expect(await readGlobalFontSize()).toBe(14);
        expect(await readFontSizeWrites()).toEqual([]);
      }

      // Both edges commit, and are not marked invalid.
      for (const accepted of [8, 32]) {
        await clearRecordedWrites();
        await typeReplacing(String(accepted));
        await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(accepted);
        await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');
        await expect(rangeMessage).toHaveCount(0);
        expect(await readFontSizeWrites()).toEqual([accepted]);
        await fontSizeInput.blur();
        await expect(fontSizeInput).toHaveValue(String(accepted));
      }
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreConfigSet: () => void }).__restoreConfigSet());
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  test('Terminal tab font size does not bring a rejected draft back when the setting returns to the value it was typed against', async () => {
    // The draft is dropped, not merely hidden, once the store moves to a value it
    // neither saw nor committed. Kept, "5" would reappear (marked invalid) the
    // moment the setting came back to 14. Goes RED if the
    // `if (draft !== null && liveDraft === null) setDraft(null)` line is removed.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontSizeInput = page.locator('[data-testid="setting-row-terminal.fontSize"] input');
    const setFontSizeFromOutside = (fontSize: number) => page.evaluate(async (nextFontSize) => {
      const stores = (window as unknown as {
        __zustandStores: { config: { getState: () => { updateConfig: (partial: { terminal: { fontSize: number } }) => Promise<unknown> } } };
      }).__zustandStores;
      await stores.config.getState().updateConfig({ terminal: { fontSize: nextFontSize } });
    }, fontSize);

    try {
      await expect(fontSizeInput).toHaveValue('14');
      await fontSizeInput.click();
      await fontSizeInput.press('ControlOrMeta+a');
      await fontSizeInput.pressSequentially('5');
      await expect(fontSizeInput).toHaveValue('5');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'true');

      // Still focused, the setting moves away from the value the draft saw.
      await setFontSizeFromOutside(18);
      await expect(fontSizeInput).toHaveValue('18');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');

      // And back to it. The old draft must not match 14 again.
      await setFontSizeFromOutside(14);
      await expect(fontSizeInput).toHaveValue('14');
      await expect(fontSizeInput).toHaveAttribute('aria-invalid', 'false');
      await expect(page.getByTestId('terminal-font-size-range')).toHaveCount(0);
      await expect(fontSizeInput).toBeFocused();
    } finally {
      // Restore so later tests are unaffected.
      await fontSizeInput.fill('14');
      await fontSizeInput.blur();
      await expect.poll(readGlobalFontSize, { timeout: 3000 }).toBe(14);
      await closeSettings();
    }
  });

  test('Terminal tab Font Family offers detected system fonts and accepts a typed value', async () => {
    // FontResolver is mocked (mock-electron-api.js font.getAvailable) to a
    // fixed list so this stays deterministic across dev machines and CI.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontFamilyRow = page.locator('[data-testid="setting-row-terminal.fontFamily"]');
    const fontFamilyInput = fontFamilyRow.locator('[data-testid="terminal-font-family"]');
    await fontFamilyInput.click();
    await expect(page.getByTestId('terminal-font-family-option-Consolas')).toBeVisible();

    await page.getByTestId('terminal-font-family-option-Consolas').click();
    await expect(fontFamilyInput).toHaveValue('Consolas');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
    }, { timeout: 3000 }).toBe('Consolas');

    // A font not in the detected list is still a valid typed value - the
    // picker must never block entry when detection misses (or fails on) a
    // font the user actually wants.
    await fontFamilyInput.fill('Custom Handwritten Font');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
    }, { timeout: 3000 }).toBe('Custom Handwritten Font');

    // Restore so later tests are unaffected.
    await fontFamilyInput.fill('Menlo, Consolas, "Courier New", monospace');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
    }, { timeout: 3000 }).toBe('Menlo, Consolas, "Courier New", monospace');

    await closeSettings();
  });

  test('Terminal tab Font Family shows the live-cleared value, not the stale committed one, while the async config round trip is still pending', async () => {
    // Regression test for FontCombobox's `filterText` sentinel fix. `value`
    // is committed through an ASYNC config-store round trip (updateConfig
    // awaits config.set, then re-fetches, before globalConfig.terminal.fontFamily
    // updates), so a just-cleared field must display the live edit rather than
    // falling back to the stale committed value while that round trip is still
    // in flight. The mock's config.set() normally resolves within the same
    // microtask turn (no real IPC latency), which collapses the race window to
    // nothing observable - so this test patches config.set() with an
    // artificial delay to create a real, deterministic window to observe the
    // mid-flight display value against.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontFamilyRow = page.locator('[data-testid="setting-row-terminal.fontFamily"]');
    const fontFamilyInput = fontFamilyRow.locator('[data-testid="terminal-font-family"]');

    // Establish a known starting value before slowing the round trip.
    await fontFamilyInput.click();
    await page.getByTestId('terminal-font-family-option-Consolas').click();
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
    }, { timeout: 3000 }).toBe('Consolas');

    try {
      // Artificially slow config.set() so the async round trip has a real,
      // observable window. The real preload IPC round trip is normally too
      // fast for Playwright to reliably catch mid-flight; this mock is a
      // synchronous in-memory function with no such latency by default.
      await page.evaluate(() => {
        const original = window.electronAPI.config.set;
        (window as unknown as { __originalConfigSet: typeof original }).__originalConfigSet = original;
        window.electronAPI.config.set = (partial: Parameters<typeof original>[0]) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(original(partial)), 1000);
          });
      });

      await fontFamilyInput.click();
      // selectText + Backspace (not fill()) so a snap-back-to-stale-value
      // shows up as a wrong `.inputValue()` read rather than a fill()
      // actionability timeout - the assertion below is the sole discriminator
      // either way.
      await fontFamilyInput.selectText();
      await fontFamilyInput.press('Backspace');

      // Mid-flight: read a single snapshot (never a retrying `toHaveValue`,
      // which would just wait out the delay and pass on buggy code too). The
      // input must already show the live (cleared) edit...
      const displayedRightAfterClear = await fontFamilyInput.inputValue();
      expect(displayedRightAfterClear).toBe('');
      // ...while the config's committed value is still the OLD one, proving
      // this is genuinely observing the async gap and not a resolved update.
      const midFlightConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      expect((midFlightConfig as { terminal: { fontFamily: string } }).terminal.fontFamily).toBe('Consolas');

      // Once the round trip actually completes, the cleared value persists
      // (no snap-back either during or after the round trip).
      await expect.poll(async () => {
        const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
        return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
      }, { timeout: 3000 }).toBe('');
      expect(await fontFamilyInput.inputValue()).toBe('');
    } finally {
      await page.evaluate(() => {
        const patched = window as unknown as { __originalConfigSet?: typeof window.electronAPI.config.set };
        if (patched.__originalConfigSet) {
          window.electronAPI.config.set = patched.__originalConfigSet;
          delete patched.__originalConfigSet;
        }
      });

      // Restore so later tests are unaffected, even if an assertion above threw.
      await fontFamilyInput.fill('Menlo, Consolas, "Courier New", monospace');
      await expect.poll(async () => {
        const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
        return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
      }, { timeout: 3000 }).toBe('Menlo, Consolas, "Courier New", monospace');

      await closeSettings();
    }
  });

  test('Terminal tab Font Family filters suggestions as you type and shows an empty state for no matches', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontFamilyRow = page.locator('[data-testid="setting-row-terminal.fontFamily"]');
    const fontFamilyInput = fontFamilyRow.locator('[data-testid="terminal-font-family"]');

    await fontFamilyInput.click();
    await fontFamilyInput.fill('Con');

    // Mock font list (mock-electron-api.js font.getAvailable): Cascadia Code,
    // Consolas, Courier New, Fira Code, JetBrains Mono, Menlo. "Con" narrows
    // to Consolas only (case-insensitive substring match) - none of the other
    // five fonts contain "con".
    await expect(page.getByTestId('terminal-font-family-option-Consolas')).toBeVisible();
    await expect(page.getByTestId('terminal-font-family-option-Cascadia Code')).toHaveCount(0);
    await expect(page.getByTestId('terminal-font-family-option-Courier New')).toHaveCount(0);
    await expect(page.getByTestId('terminal-font-family-option-Fira Code')).toHaveCount(0);
    await expect(page.getByTestId('terminal-font-family-option-JetBrains Mono')).toHaveCount(0);
    await expect(page.getByTestId('terminal-font-family-option-Menlo')).toHaveCount(0);

    await fontFamilyInput.fill('zzzznomatch');
    await expect(page.getByText('No fonts match "zzzznomatch"')).toBeVisible();

    // Restore so later tests are unaffected.
    await fontFamilyInput.fill('Menlo, Consolas, "Courier New", monospace');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { fontFamily: string } }).terminal.fontFamily;
    }, { timeout: 3000 }).toBe('Menlo, Consolas, "Courier New", monospace');

    await closeSettings();
  });

  test('Terminal tab Font Family dropdown closes when clicking outside', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontFamilyRow = page.locator('[data-testid="setting-row-terminal.fontFamily"]');
    const fontFamilyInput = fontFamilyRow.locator('[data-testid="terminal-font-family"]');

    await fontFamilyInput.click();
    await expect(page.getByTestId('terminal-font-family-option-Consolas')).toBeVisible();

    // Click something else within the panel, outside the combobox - the
    // capture-phase mousedown listener should close the dropdown.
    await page.locator('h2:has-text("Settings")').click();

    await expect(page.getByTestId('terminal-font-family-option-Consolas')).toHaveCount(0);

    await closeSettings();
  });

  test('Terminal tab Font Family keyboard: ArrowDown moves focus into the option list, Escape closes it', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const fontFamilyRow = page.locator('[data-testid="setting-row-terminal.fontFamily"]');
    const fontFamilyInput = fontFamilyRow.locator('[data-testid="terminal-font-family"]');

    await fontFamilyInput.click();
    // "Cascadia Code" is first in the mock font list, so it's the first
    // navigable suggestion.
    const firstOption = page.getByTestId('terminal-font-family-option-Cascadia Code');
    await expect(firstOption).toBeVisible();

    await fontFamilyInput.press('ArrowDown');
    await expect(firstOption).toBeFocused();

    await firstOption.press('Escape');
    await expect(firstOption).toHaveCount(0);

    await closeSettings();
  });

  test('Task tab Context Bar section exposes Rate Limits toggle', async () => {
    await openSettings();
    await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Context bar', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Rate limits', exact: true })).toBeVisible();
    // The row's description sits behind its info icon.
    await expect(page.getByRole('button', { name: 'About Rate limits: Claude 5h / weekly quota bars' })).toBeVisible();
    await closeSettings();
  });

  test('toggling Word delete on Backspace persists terminal.backspaceSendsCtrlH to global config, not the project override', async () => {
    // DEFAULT_CONFIG.terminal.backspaceSendsCtrlH is false on all platforms
    // (src/shared/types.ts) - opt-in, so existing users never feel a Backspace
    // behavior change they didn't ask for - so the switch starts unchecked
    // with no prior setup. Terminal is a SYSTEM (global-only) tab, so this
    // pins the actual write path, not just the UI copy.
    await openSettings();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();

    const toggle = page.getByRole('switch', { name: 'Word delete on Backspace' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { backspaceSendsCtrlH: boolean } }).terminal.backspaceSendsCtrlH;
    }, { timeout: 3000 }).toBe(true);

    const projectOverrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
    expect((projectOverrides as { terminal?: { backspaceSendsCtrlH?: boolean } } | null)?.terminal?.backspaceSendsCtrlH).toBeUndefined();

    // Toggle back off, restoring the default state so later tests in this
    // shared-page file are unaffected.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { terminal: { backspaceSendsCtrlH: boolean } }).terminal.backspaceSendsCtrlH;
    }, { timeout: 3000 }).toBe(false);

    await closeSettings();
  });

  test('shows Git tab with worktree and branch settings', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Git' }).click();

    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();
    await expect(page.getByText('Default base branch', { exact: true })).toBeVisible();

    await closeSettings();
  });

  test('toggling Auto-refresh PRs persists git.prAutoRefresh to the project override', async () => {
    // DEFAULT_CONFIG.git.prAutoRefresh is true (src/shared/types.ts).
    // Project creation seeds a full overridable-settings snapshot (see
    // pickOverridableSubset), so this shared-page project already carries an
    // explicit `true` for this key - the switch starts checked either way.
    // GitTab is a PROJECT tab: the write goes through updateProject -> the
    // project override, not global config. This pins the actual write path,
    // not just the UI copy - settings-tab-scope-parity.test.ts only proves the
    // registry id and tab pairing exist, not that the row's onChange closure
    // names the right key at the right nesting level. Red-green while writing
    // it: a wrong key OR a wrong scope (updateProject swapped for updateGlobal)
    // both fail the aria-checked assertion here, because the seeded project
    // override always wins the merge over a global write; the
    // getProjectOverrides() poll below still documents the intended target.
    await openSettings();
    await page.getByRole('button', { name: 'Git' }).click();

    const toggle = page.getByRole('switch', { name: 'Auto-refresh PRs' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => {
      const overrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
      return (overrides as { git?: { prAutoRefresh?: boolean } } | null)?.git?.prAutoRefresh;
    }, { timeout: 3000 }).toBe(false);

    // Restore so later tests in this shared-page file are unaffected (this
    // file resets nothing between tests, unlike browser-settings.spec.ts).
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => {
      const overrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
      return (overrides as { git?: { prAutoRefresh?: boolean } } | null)?.git?.prAutoRefresh;
    }, { timeout: 3000 }).toBe(true);

    await closeSettings();
  });

  test('toggling Count merge bypass as ready persists git.prBypassCountsAsReady to the project override', async () => {
    // The mirror of the branch-policies test above for the sibling row, with
    // the default flipped: DEFAULT_CONFIG.git.prBypassCountsAsReady is TRUE
    // (src/shared/types.ts), so the seeded project override carries an
    // explicit `true` and the switch starts checked. The write goes through
    // updateProject -> the project override; the seeded override always wins
    // the merge over a global write, so a wrong scope fails the aria-checked
    // assertion here as well as the getProjectOverrides() poll.
    await openSettings();
    await page.getByRole('button', { name: 'Git' }).click();

    const toggle = page.getByRole('switch', { name: 'Count merge bypass as ready' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => {
      const overrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
      return (overrides as { git?: { prBypassCountsAsReady?: boolean } } | null)?.git?.prBypassCountsAsReady;
    }, { timeout: 3000 }).toBe(false);

    // Restore so later tests in this shared-page file are unaffected.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => {
      const overrides = await page.evaluate(() => window.electronAPI.config.getProjectOverrides());
      return (overrides as { git?: { prBypassCountsAsReady?: boolean } } | null)?.git?.prBypassCountsAsReady;
    }, { timeout: 3000 }).toBe(true);

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

    // The open Combobox menu consumes the first Escape itself (see
    // combobox-escape-layering.spec.ts); closeSettings() below presses once
    // for the menu and again for the panel, so no separate close is needed.
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

    // The card header: its switch and one line saying what the server does
    await expect(page.getByRole('switch', { name: 'MCP server' })).toBeVisible();
    await expect(page.getByText('Give agents tools to work with your board.')).toBeVisible();

    // No user-tunable task-creation cap anymore (it is now a fixed internal backstop).
    await expect(page.getByText('Max Tasks Per Session')).toHaveCount(0);

    // The docs come first, as a row of their own.
    await expect(page.getByTestId('mcp-docs-row')).toContainText('Documentation');

    // The tools render from MCP_TOOL_MANIFEST, one collapsible tile per category,
    // every one open on arrival. Each tile's header names the group and its count.
    for (const category of MCP_TOOL_CATEGORIES) {
      const toolCount = MCP_TOOL_MANIFEST.filter((tool) => tool.category === category.id).length;
      const toggle = page.getByTestId(`mcp-tool-group-${category.id}-toggle`);
      await expect(toggle).toContainText(category.label);
      await expect(toggle).toContainText(String(toolCount));
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    // A representative tool from each group. Backlog tools and the unified Search
    // tool live under Board. Scoped to each group: short names like "Search" also
    // appear elsewhere in the panel, and `exact: true` keeps "Move Task" from
    // matching "Move Task to Project".
    const group = (categoryId: string) => page.getByTestId(`mcp-tool-group-${categoryId}`);
    await expect(group('tasks').getByText('Create Task')).toBeVisible();
    await expect(group('tasks').getByText('Move Task', { exact: true })).toBeVisible();
    await expect(group('tasks').getByText('Delete Task')).toBeVisible();
    await expect(group('board').getByText('List Backlog')).toBeVisible();
    await expect(group('board').getByText('Search', { exact: true })).toBeVisible();
    await expect(group('sessions').getByText('Session History')).toBeVisible();
    await expect(group('browser').getByText('Bounding Box')).toBeVisible();
    await expect(group('diagnostics').getByText('Tail Logs', { exact: true })).toBeVisible();
    await expect(group('diagnostics').getByText('Query Database', { exact: true })).toBeVisible();
    await expect(group('diagnostics').getByText('List Worktrees', { exact: true })).toBeVisible();

    // One cell per manifest entry. Pinning the cell count to the manifest length
    // is the red-green anchor: dropping a tool, or a category that fails to
    // render, fails here, and a newly-added tool is covered for free.
    await expect(page.getByTestId('mcp-tool-cell')).toHaveCount(MCP_TOOL_MANIFEST.length);

    // Each cell deep-links to its docs entry, and the docs row opens the page.
    // Patch the mock's no-op openExternal to record URLs, click both, and assert
    // what they opened.
    await page.evaluate(() => {
      window.__openedExternalUrls = [];
      window.electronAPI.shell.openExternal = async function (url: string) {
        window.__openedExternalUrls?.push(url);
      };
    });
    await page.getByTestId('mcp-tool-cell').filter({ hasText: 'Create Task' }).click();
    await page.getByTestId('mcp-docs-link').click();
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual([mcpToolDocsUrl('kangentic_create_task'), MCP_SERVER_DOCS_URL]);
    // Restore the mock's default no-op so this patch does not leak into later tests
    // on the shared page (matches mock-electron-api.js shell.openExternal).
    await page.evaluate(() => {
      window.electronAPI.shell.openExternal = async function () {
        return;
      };
    });

    // "How it works" is the card header's info tooltip now, not a section.
    await expect(page.getByRole('button', { name: /^About MCP server: Each agent session gets a local MCP server/ })).toBeVisible();

    await closeSettings();
  });

  test('MCP Server tool groups collapse one at a time and all open again on the next visit', async () => {
    await openSettings();
    // By test id: Settings reopens to the last tab, and when that is MCP Server
    // the card's "About MCP server" info button also matches the tab's name.
    await page.getByTestId('settings-tab-mcpServer').click();

    // A closed group keeps its cells mounted (they animate shut) but hidden, so
    // the counts read visible cells only.
    const visibleCells = page.locator('[data-testid="mcp-tool-cell"]:visible');
    const boardToggle = page.getByTestId('mcp-tool-group-board-toggle');
    const boardBody = page.getByTestId('mcp-tool-group-board-body');
    const boardCount = MCP_TOOL_MANIFEST.filter((tool) => tool.category === 'board').length;
    await expect(boardBody).toBeVisible();
    await expect(visibleCells).toHaveCount(MCP_TOOL_MANIFEST.length);

    // Closing Board hides only its tools.
    await boardToggle.click();
    await expect(boardToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(boardBody).toBeHidden();
    await expect(visibleCells).toHaveCount(MCP_TOOL_MANIFEST.length - boardCount);

    await boardToggle.click();
    await expect(boardToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(boardBody).toBeVisible();
    await expect(visibleCells).toHaveCount(MCP_TOOL_MANIFEST.length);

    // Closed again, then the panel closes. Settings reopens to the MCP Server
    // tab, and a collapse is not remembered, so every group is open.
    await boardToggle.click();
    await expect(boardBody).toBeHidden();
    await closeSettings();
    await openSettings();
    await expect(page.getByTestId('mcp-tool-group-board-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(visibleCells).toHaveCount(MCP_TOOL_MANIFEST.length);

    // Reset to General so later tests start from a known tab.
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await closeSettings();
  });

  test('reopens to the last viewed tab after closing', async () => {
    await openSettings();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();
    await closeSettings();

    // Reopening returns to Git, not the first tab.
    await openSettings();
    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();

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
    await expect(page.getByText('Font size', { exact: true })).toBeVisible();
    await expect(page.getByText('Font family', { exact: true })).toBeVisible();

    // Should NOT show unrelated settings like Theme
    await expect(page.getByTestId('setting-row-theme')).not.toBeVisible();

    await closeSettings();
  });

  test('searching "context bar" shows context bar toggles', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('context bar');

    // Context bar toggles should be visible
    await expect(page.getByTestId('setting-row-contextBar.showShell')).toBeVisible();
    await expect(page.getByTestId('setting-row-contextBar.showVersion')).toBeVisible();
    await expect(page.getByTestId('setting-row-contextBar.showProgressBar')).toBeVisible();

    await closeSettings();
  });

  test('searching "theme" shows appearance theme setting', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('theme');

    await expect(page.getByTestId('setting-row-theme')).toBeVisible();

    // Should NOT show terminal settings
    await expect(page.getByTestId('setting-row-terminal.fontSize')).toHaveCount(0);

    await closeSettings();
  });

  test('searching a theme name finds the Theme picker', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('peach');

    // Every theme's name is a keyword on the Theme row, so the row is the one hit.
    await expect(page.getByTestId('setting-row-theme')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Theme 1' })).toBeVisible();
    await expect(page.getByTestId('setting-row-terminal.fontSize')).toHaveCount(0);

    await closeSettings();
  });

  test('searching "worktree" shows git worktree settings', async () => {
    await openSettings();
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('worktree');

    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();
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
    await expect(page.getByText('Font size', { exact: true })).toBeVisible();

    // Clear search
    await searchInput.fill('');

    // Should return to normal view (General tab is default but font search
    // was in Terminal only, so auto-switch should land on Terminal)
    await expect(page.getByTestId('setting-row-terminal.shell')).toBeVisible();

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

    // Theme sidebar tab should have a match count badge (name includes count): the
    // tab label is a searchable field, so every row on the tab matches "theme".
    const themeTab = page.getByRole('button', { name: 'Theme 2' });
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
    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();

    await closeSettings();
  });
});
