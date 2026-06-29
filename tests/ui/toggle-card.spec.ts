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

// ── HOLE 2: McpServerTab Task Creation Limit input lower-bound guard ──────────
//
// The number input's onChange was tightened from `!Number.isNaN(value)` to
// `Number.isInteger(value) && value >= 1`. This prevents persisting 0, negatives,
// or non-integers as mcpServer.maxTaskCreatePerLaunch - a value of 0 would make
// makeTaskCounter(0) block ALL task creation for the launch.
//
// Red-green: revert the onChange guard in McpServerTab.tsx back to
// `!Number.isNaN(value)` - the "zero does not persist" test fails because 0
// passes !isNaN and config.mcpServer.maxTaskCreatePerLaunch becomes 0 instead
// of staying at INITIAL_LIMIT.

test.describe('McpServerTab Task Creation Limit input guard', () => {
  const INITIAL_LIMIT = 50;

  test.beforeEach(async () => {
    // Ensure a known starting state: MCP enabled, limit = 50.
    await setGlobalConfigAndSync({
      mcpServer: { enabled: true, maxTaskCreatePerLaunch: INITIAL_LIMIT },
    });
  });

  test.afterEach(async () => {
    // Restore so subsequent tests from other describe blocks start clean.
    await setGlobalConfigAndSync({
      mcpServer: { enabled: true, maxTaskCreatePerLaunch: INITIAL_LIMIT },
    });
  });

  test('valid integer >= 1 persists to global config', async () => {
    await openTab('MCP Server');

    // The only number input in the MCP Server tab is the Task Creation Limit.
    const limitInput = page.locator('input[type="number"]');
    await limitInput.fill('25');

    // Poll until the IPC call propagates through the config store.
    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { mcpServer?: { maxTaskCreatePerLaunch?: number } }).mcpServer?.maxTaskCreatePerLaunch;
    }, { timeout: 3000 }).toBe(25);

    await closeSettings();
  });

  test('zero does not persist to global config', async () => {
    // Red-green: revert guard to `!Number.isNaN(value)` and this fails -
    // 0 passes !isNaN so it is persisted, but we assert INITIAL_LIMIT still holds.
    await openTab('MCP Server');

    const limitInput = page.locator('input[type="number"]');
    await limitInput.fill('0');

    // Intentional fixed wait: we cannot poll for non-occurrence. The onChange
    // handler is synchronous; 500ms covers React re-render latency on slow CI.
    await page.waitForTimeout(500);
    const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
    expect(
      (globalConfig as { mcpServer?: { maxTaskCreatePerLaunch?: number } }).mcpServer?.maxTaskCreatePerLaunch,
    ).toBe(INITIAL_LIMIT);

    await closeSettings();
  });

  test('negative value does not persist to global config', async () => {
    // -1 passes !Number.isNaN but fails the `>= 1` guard.
    await openTab('MCP Server');

    const limitInput = page.locator('input[type="number"]');
    await limitInput.fill('-1');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(500);
    const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
    expect(
      (globalConfig as { mcpServer?: { maxTaskCreatePerLaunch?: number } }).mcpServer?.maxTaskCreatePerLaunch,
    ).toBe(INITIAL_LIMIT);

    await closeSettings();
  });

  test('non-integer decimal does not persist to global config', async () => {
    // 2.5 is >= 1 but is not an integer. This isolates the `Number.isInteger`
    // half of the guard, which the zero and negative cases (both < 1) do not
    // exercise.
    //
    // Red-green: drop `Number.isInteger(value) &&` from the McpServerTab.tsx
    // onChange guard (leaving just `value >= 1`) and this fails - 2.5 persists
    // instead of staying at INITIAL_LIMIT.
    await openTab('MCP Server');

    const limitInput = page.locator('input[type="number"]');
    await limitInput.fill('2.5');

    // Intentional fixed wait - cannot poll for non-occurrence.
    await page.waitForTimeout(500);
    const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
    expect(
      (globalConfig as { mcpServer?: { maxTaskCreatePerLaunch?: number } }).mcpServer?.maxTaskCreatePerLaunch,
    ).toBe(INITIAL_LIMIT);

    await closeSettings();
  });
});
