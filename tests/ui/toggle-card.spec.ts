/**
 * UI tests for the ToggleCard primitive and its settings-panel wrappers.
 *
 * Coverage:
 * 1. Click-anywhere invariant - clicking the label text fires onChange and
 *    flips aria-checked (the whole point of the refactor).
 * 2. Click-anywhere invariant - clicking the description text also fires
 *    onChange (interior of the button, not just the indicator).
 * 3. Keyboard activation - Space and Enter on a `<button role="switch">` must
 *    fire the click handler.
 * 4. CompactToggleList click-anywhere - clicking a dense row label flips
 *    aria-checked on that row only.
 * 5. Icon variant (McpServerTab) - the optional icon prop path renders an icon
 *    alongside the label.
 * 6. SettingToggleRow filter detach - when search hides the row's searchId the
 *    element is removed from the DOM (not.toBeAttached()).
 * 7. BehaviorTab toggle persistence - clicking a SettingToggleRow saves the
 *    new value to global config via config.set IPC.
 * 8. BrowserAutomationTab master-switch gating - the four dependent toggles
 *    are wrapped in an opacity-40 + inert div when the master switch is off,
 *    and fully interactable when it is on.
 * 9. Info icon variant (BoardManagerDialog Handoff toggle) - the optional
 *    `info` prop renders an aria-hidden Info icon with a title tooltip beside
 *    the label, a ToggleCard without `info` renders no such icon, and
 *    clicking the icon does not flip the switch (stopPropagation).
 *
 * All tests are UI-tier (headless Chromium, no Electron, no PTY).
 * One shared browser+page across the whole file.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
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
  await createProject(page, `ToggleCard Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open settings and navigate to the given tab. */
async function openTab(tabName: string) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: tabName, exact: true }).click();
}

/** Close settings via Escape, clearing search first if active. */
async function closeSettings() {
  const searchInput = page.getByTestId('settings-search');
  if (await searchInput.isVisible().catch(() => false)) {
    const value = await searchInput.inputValue().catch(() => '');
    if (value) {
      await page.keyboard.press('Escape');
      await expect(searchInput).toHaveValue('', { timeout: 1000 });
    }
  }
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

/**
 * Set a global config partial on the mock AND reload the React config store so
 * the UI reflects the new values immediately without a page reload.
 *
 * Background: window.electronAPI.config.set() only mutates the in-memory mock
 * object. The React store holds its own cached copy and only re-fetches when
 * updateConfig() is called (which goes through config.set then refreshConfigs).
 * For test setup we bypass updateConfig, so we must manually trigger loadConfig
 * after mutating the mock to keep the store in sync.
 */
async function setGlobalConfigAndSync(partial: Record<string, unknown>) {
  await page.evaluate((configPartial) => {
    return window.electronAPI.config.set(configPartial);
  }, partial);
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { loadConfig: () => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().loadConfig();
  });
}

// ── Gap 1 + 2: Click-anywhere invariant (ToggleCard) ──────────────────────────
//
// BehaviorTab has two SettingToggleRow cards. "Auto-Focus Idle Sessions" starts
// unchecked (mock default: autoFocusIdleSession = false), which is a reliable
// starting state for click tests.

test.describe('ToggleCard click-anywhere invariant', () => {
  // Reset autoFocusIdleSession to its default (false) before each test so the
  // starting state is deterministic regardless of order. Uses the sync helper
  // so the React config store also updates (not just the mock backing store).
  test.beforeEach(async () => {
    await setGlobalConfigAndSync({ autoFocusIdleSession: false });
  });

  test('clicking the label text fires onChange and flips aria-checked', async () => {
    await openTab('Behavior');

    // Scope to the specific ToggleCard by its aria-label.
    const card = page.getByRole('switch', { name: 'Auto-Focus Idle Sessions' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    // Click the label text element inside the button - this is the
    // "click-anywhere" invariant: the whole card, including text, is the target.
    const labelText = card.locator('text=Auto-Focus Idle Sessions').first();
    await labelText.click();

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });

  test('clicking the description text fires onChange and flips aria-checked', async () => {
    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Focus Idle Sessions' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    // Click the description paragraph inside the button.
    const description = card.locator('p').first();
    await description.click();

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });
});

// ── Gap 3: Keyboard activation (Space and Enter) ──────────────────────────────
//
// `<button role="switch">` natively fires click on Space and Enter per the
// HTML spec. The tests focus the card, press the key, and assert aria-checked
// flips. Uses a fresh beforeEach reset so order-independence is guaranteed.

test.describe('ToggleCard keyboard activation', () => {
  test.beforeEach(async () => {
    await setGlobalConfigAndSync({ autoFocusIdleSession: false });
  });

  test('Space toggles the switch', async () => {
    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Focus Idle Sessions' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.focus();
    await page.keyboard.press('Space');

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });

  test('Enter toggles the switch', async () => {
    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Focus Idle Sessions' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.focus();
    await page.keyboard.press('Enter');

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });
});

// ── Gap 4: CompactToggleList click-anywhere (dense rows) ─────────────────────
//
// The Terminal tab Context Bar section renders a CompactToggleList. Each row is
// a `<button role="switch" aria-label="...">` that should toggle when any part
// of the row (including the label text) is clicked.
// "Shell" row (contextBar.showShell) starts checked=true in the mock.

test.describe('CompactToggleList click-anywhere invariant', () => {
  test.beforeEach(async () => {
    await setGlobalConfigAndSync({ contextBar: { showShell: true } });
  });

  test('clicking the row label text flips aria-checked on that row only', async () => {
    await openTab('Terminal');

    // The CompactToggleList item for "Shell" is a button with role="switch".
    const shellRow = page.getByRole('switch', { name: 'Shell', exact: true });
    await expect(shellRow).toHaveAttribute('aria-checked', 'true');

    // Click the label text div inside the button.
    const labelText = shellRow.locator('text=Shell').first();
    await labelText.click();

    await expect(shellRow).toHaveAttribute('aria-checked', 'false');

    // Sibling row (Version) must be unaffected.
    const versionRow = page.getByRole('switch', { name: 'Version', exact: true });
    await expect(versionRow).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });
});

// ── Gap 5: Icon variant (McpServerTab) ────────────────────────────────────────
//
// McpServerTab passes `icon={<Plug className="size-5" />}` to SettingToggleRow,
// which threads it through to ToggleCard's optional icon slot. The icon must be
// visible in the DOM and the card must still function as a switch.

test.describe('ToggleCard icon variant', () => {
  test('MCP Server tab renders icon alongside label in ToggleCard', async () => {
    await openTab('MCP Server');

    const card = page.getByRole('switch', { name: 'Kangentic MCP Server' });
    await expect(card).toBeVisible();

    // The icon is inside a <span class="flex-shrink-0 ..."> that wraps the
    // Lucide Plug SVG. Assert the span exists and contains an svg element.
    const iconSpan = card.locator('span.flex-shrink-0').first();
    await expect(iconSpan).toBeVisible();
    await expect(iconSpan.locator('svg')).toBeVisible();

    await closeSettings();
  });

  test('MCP Server ToggleCard still toggles when icon is present', async () => {
    // Ensure known starting state.
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });

    await openTab('MCP Server');

    const card = page.getByRole('switch', { name: 'Kangentic MCP Server' });
    await expect(card).toHaveAttribute('aria-checked', 'true');

    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'false');

    // Restore for subsequent tests.
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });

    await closeSettings();
  });
});

// ── Gap 6: SettingToggleRow filter detach ─────────────────────────────────────
//
// When the settings search query does not match a row's searchId, SettingToggleRow
// returns null, removing the element from the DOM entirely. Verify with
// not.toBeAttached() against a specific row.
//
// "Auto-Resume Agents on Restart" (searchId: 'agent.autoResumeSessionsOnRestart')
// does NOT appear under the search term "font" (a Terminal-only term).

test.describe('SettingToggleRow filter detach', () => {
  test('searching "font" removes Behavior tab toggles from the DOM', async () => {
    await openTab('Behavior');

    // Confirm the toggle exists before searching.
    const autoResumeSwitch = page.getByRole('switch', { name: 'Auto-Resume Agents on Restart' });
    await expect(autoResumeSwitch).toBeAttached();

    // Enter a search term that matches only Terminal settings.
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('font');

    // The Behavior tab's toggle rows must be detached (SettingToggleRow returns null).
    await expect(autoResumeSwitch).not.toBeAttached();

    await closeSettings();
  });
});

// ── Gap 7: BehaviorTab SettingToggleRow persistence ──────────────────────────
//
// Clicking a SettingToggleRow must persist the new value to global config via
// the config.set IPC (window.electronAPI.config.set). Verified by reading back
// config.getGlobal() after the click.
//
// Pattern mirrors browser-settings.spec.ts "toggling Enable Browser Pane persists".

test.describe('BehaviorTab SettingToggleRow persistence', () => {
  test.afterEach(async () => {
    // Restore all three toggles to their mock defaults.
    await setGlobalConfigAndSync({
      autoFocusIdleSession: false,
      agent: { autoResumeSessionsOnRestart: false },
      skipBoardConfigConfirm: false,
    });
  });

  test('clicking Auto-Focus Idle Sessions persists autoFocusIdleSession to global config', async () => {
    // Ensure clean starting state.
    await setGlobalConfigAndSync({ autoFocusIdleSession: false });

    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Focus Idle Sessions' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'true');

    // Poll config.getGlobal() until the IPC call propagates.
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { autoFocusIdleSession: boolean }).autoFocusIdleSession;
    }, { timeout: 3000 }).toBe(true);

    // Click again - must flip back and persist false.
    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { autoFocusIdleSession: boolean }).autoFocusIdleSession;
    }, { timeout: 3000 }).toBe(false);

    await closeSettings();
  });

  test('clicking Auto-Resume Agents on Restart persists agent.autoResumeSessionsOnRestart', async () => {
    await setGlobalConfigAndSync({ agent: { autoResumeSessionsOnRestart: false } });

    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Resume Agents on Restart' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'true');

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { agent: { autoResumeSessionsOnRestart: boolean } }).agent.autoResumeSessionsOnRestart;
    }, { timeout: 3000 }).toBe(true);

    await closeSettings();
  });

  test('clicking Auto-Apply Board Config Changes persists skipBoardConfigConfirm to global config', async () => {
    // skipBoardConfigConfirm starts false (mock default).
    await setGlobalConfigAndSync({ skipBoardConfigConfirm: false });

    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-Apply Board Config Changes' });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    // Toggle on - must persist true.
    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'true');

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { skipBoardConfigConfirm: boolean }).skipBoardConfigConfirm;
    }, { timeout: 3000 }).toBe(true);

    // Toggle off - must persist false.
    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { skipBoardConfigConfirm: boolean }).skipBoardConfigConfirm;
    }, { timeout: 3000 }).toBe(false);

    await closeSettings();
  });
});

// ── Gap 8: BrowserAutomationTab master-switch gating ──────────────────────
//
// When the master "Enable Browser Automation" switch is off, the four dependent
// capability toggles (Allow Interaction, Allow Navigation, Allow Eval, Restrict
// Navigation to Localhost) are wrapped in a div that gains the `opacity-40`
// class and the HTML `inert` attribute. This communicates visually that the
// toggles are disabled and prevents accidental interaction while preserving
// their stored values so re-enabling restores prior choices.
//
// `inert` is used only in BrowserAutomationTab in the entire renderer, so
// `page.locator('[inert]')` is an unambiguous selector for this wrapper div.
// The equivalent McpServerTab gating is deliberately untested (it predates
// this commit); we guard the new gating here so a refactor cannot silently
// drop the wrapper without a test catching it.

test.describe('BrowserAutomationTab master-switch gating', () => {
  test.afterEach(async () => {
    // Restore enabled:true so subsequent tests start from a known state.
    await setGlobalConfigAndSync({ browserAutomation: { enabled: true } });
  });

  test('sub-toggle wrapper gains opacity-40 and inert when master switch is off', async () => {
    await setGlobalConfigAndSync({ browserAutomation: { enabled: false } });
    await openTab('Agent Browser');

    // Master switch must be unchecked.
    const masterSwitch = page.getByRole('switch', { name: 'Enable Browser Automation' });
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'false');

    // The wrapper div around the four dependent toggles must be dimmed (opacity-40)
    // and non-interactive (inert). inert is the only usage of that attribute in the
    // renderer, so the locator is unambiguous.
    const inertWrapper = page.locator('[inert]');
    await expect(inertWrapper).toBeAttached();
    await expect(inertWrapper).toHaveClass(/opacity-40/);

    await closeSettings();
  });

  test('sub-toggle wrapper has no opacity-40 or inert when master switch is on', async () => {
    await setGlobalConfigAndSync({ browserAutomation: { enabled: true } });
    await openTab('Agent Browser');

    // Master switch must be checked.
    const masterSwitch = page.getByRole('switch', { name: 'Enable Browser Automation' });
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'true');

    // No inert wrapper present when the master is on.
    await expect(page.locator('[inert]')).not.toBeAttached();

    // The Allow Interaction sub-toggle must be visible and interactable (in the
    // accessibility tree, not behind an inert barrier).
    await expect(page.getByRole('switch', { name: 'Allow Interaction' })).toBeVisible();

    await closeSettings();
  });
});

// ── Gap 9: Info icon variant (BoardManagerDialog Handoff toggle) ─────────────
//
// ToggleCard's optional `info` prop renders an aria-hidden Info icon beside the
// label, with the info text as its `title` tooltip. Clicking the icon must NOT
// flip the switch (the icon's onClick calls stopPropagation). The Board
// Manager's "Receive context from prior agent" toggle (Handoff section) is the
// sole current usage; "Auto-spawn" in the same dialog has no `info` and is the
// negative case.

test.describe('ToggleCard info icon', () => {
  async function openManagerByHeader(columnName: string) {
    const column = page.locator(`[data-swimlane-name="${columnName}"]`);
    await column.locator(`text=${columnName}`).click();
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
  }

  async function closeManager() {
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const cancelBtn = dialog.getByRole('button', { name: 'Cancel' });
    await cancelBtn.click();
    // Accept any discard confirm that may appear (a test may have left a dirty draft).
    const discardBtn = page.locator('button', { hasText: 'Discard' });
    if (await discardBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await discardBtn.click();
    }
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  }

  test('a ToggleCard with `info` renders an Info icon with the expected title', async () => {
    await openManagerByHeader('Code Review'); // auto_spawn=true, so Handoff renders inline

    const handoffSwitch = page.getByRole('switch', { name: 'Receive context from prior agent' });
    await expect(handoffSwitch).toBeVisible();

    // ToggleIndicator is also an aria-hidden span but carries no `title`, so
    // span[title] uniquely selects the info icon within the switch button.
    const infoSpan = handoffSwitch.locator('span[title]');
    await expect(infoSpan).toHaveCount(1);
    await expect(infoSpan).toHaveAttribute('title', /Kangentic injects the previous session's transcript as the first message/);
    await expect(infoSpan.locator('svg')).toBeVisible();

    await closeManager();
  });

  test('a ToggleCard without `info` renders no Info icon', async () => {
    await openManagerByHeader('Code Review');

    const autoSpawnSwitch = page.getByRole('switch', { name: 'Auto-spawn' });
    await expect(autoSpawnSwitch).toBeVisible();
    await expect(autoSpawnSwitch.locator('span[title]')).toHaveCount(0);

    await closeManager();
  });

  test('clicking the info icon does not toggle the switch', async () => {
    await openManagerByHeader('Code Review');

    const handoffSwitch = page.getByRole('switch', { name: 'Receive context from prior agent' });
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'false');

    await handoffSwitch.locator('span[title]').click();

    // stopPropagation on the icon's onClick must prevent the click from
    // bubbling to the parent switch button.
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'false');

    // Sanity: clicking the label text (not the icon) still flips it, proving
    // the switch itself is wired correctly and the prior click was a no-op
    // specifically because of the icon, not some other reason.
    await handoffSwitch.locator('text=Receive context from prior agent').first().click();
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'true');

    // Discard the dirty change on close (closeManager accepts the confirm).
    await closeManager();
  });
});
