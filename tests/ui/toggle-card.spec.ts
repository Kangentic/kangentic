/**
 * UI tests for the settings card switches (SettingsCard headers and
 * CardToggleRow tiles), plus the board manager's ToggleCard info icon.
 *
 * Coverage:
 * 1. Click-anywhere invariant - clicking a tile's label text flips its switch.
 * 2. Click-anywhere invariant - clicking empty space in the tile also flips it.
 * 3. Keyboard activation - Space and Enter on a `<button role="switch">` must
 *    fire the click handler.
 * 4. Context bar rows - clicking one row's label flips that row only.
 * 5. Card header (McpServerTab) - the icon, the header switch, a header click,
 *    the info icon, one right edge for every switch on a tab, one left
 *    edge for a card's icon and its tiles' content, and the same insets on a
 *    group tile's header (McpServerTab's tool groups).
 * 6. Filter detach - when search hides a row's searchId the element is removed
 *    from the DOM (not.toBeAttached()).
 * 7. Persistence - clicking a CardToggleRow saves the new value to global
 *    config via config.set IPC.
 * 8. BrowserAutomationTab master-switch gating - the dependent switches show
 *    only while the master switch is on.
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
import { MCP_TOOL_CATEGORIES, MCP_TOOL_MANIFEST } from '../../src/shared/mcp-tool-manifest';

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

/** Open settings and navigate to the given tab. Scoped to the settings
 *  sidebar - some tab names (e.g. "Board") collide with buttons elsewhere
 *  in the app chrome (the board/backlog view-toggle behind the panel). */
async function openTab(tabName: string) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: tabName, exact: true }).click();
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

// ── Gap 1 + 2: Click-anywhere invariant (CardToggleRow tiles) ─────────────────
//
// Behavior's Sessions card holds CardToggleRow tiles. "Auto-focus idle sessions"
// starts unchecked (mock default: autoFocusIdleSession = false), which is a
// reliable starting state for click tests. The whole tile is the click target.

test.describe('CardToggleRow click-anywhere invariant', () => {
  // Reset autoFocusIdleSession to its default (false) before each test so the
  // starting state is deterministic regardless of order. Uses the sync helper
  // so the React config store also updates (not just the mock backing store).
  test.beforeEach(async () => {
    await setGlobalConfigAndSync({ autoFocusIdleSession: false });
  });

  test('clicking the label text flips the row\'s switch', async () => {
    await openTab('Behavior');

    const toggle = page.getByRole('switch', { name: 'Auto-focus idle sessions', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // The switch's parent is the tile; its label text is a sibling of the switch.
    const tile = toggle.locator('..');
    await tile.getByText('Auto-focus idle sessions', { exact: true }).click();

    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });

  test('clicking empty space in the tile flips the row\'s switch', async () => {
    await openTab('Behavior');

    const toggle = page.getByRole('switch', { name: 'Auto-focus idle sessions', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // The tile's top padding, over no text and no control.
    const tile = toggle.locator('..');
    const box = await tile.boundingBox();
    expect(box).not.toBeNull();
    await tile.click({ position: { x: (box?.width ?? 0) / 2, y: 3 } });

    await expect(toggle).toHaveAttribute('aria-checked', 'true');

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

    const card = page.getByRole('switch', { name: 'Auto-focus idle sessions', exact: true });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.focus();
    await page.keyboard.press('Space');

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });

  test('Enter toggles the switch', async () => {
    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-focus idle sessions', exact: true });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.focus();
    await page.keyboard.press('Enter');

    await expect(card).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });
});

// ── Gap 4: Context bar rows click-anywhere ───────────────────────────────────
//
// The Task tab's Context bar card renders one CardToggleRow tile per stat.
// Clicking a row's label flips that row and no other.
// "Shell name" (contextBar.showShell) starts checked=true in the mock.

test.describe('Context bar rows click-anywhere invariant', () => {
  test.beforeEach(async () => {
    await setGlobalConfigAndSync({ contextBar: { showShell: true } });
  });

  test('clicking the row label text flips aria-checked on that row only', async () => {
    await openTab('Task');

    const shellRow = page.getByRole('switch', { name: 'Shell name', exact: true });
    await expect(shellRow).toHaveAttribute('aria-checked', 'true');

    await shellRow.locator('..').getByText('Shell name', { exact: true }).click();

    await expect(shellRow).toHaveAttribute('aria-checked', 'false');

    // Sibling row (Version) must be unaffected.
    const versionRow = page.getByRole('switch', { name: 'Version', exact: true });
    await expect(versionRow).toHaveAttribute('aria-checked', 'true');

    await closeSettings();
  });
});

// ── Gap 5: Settings card with an icon (McpServerTab) ──────────────────────────
//
// McpServerTab is a SettingsCard: an icon, the title and description, and the
// master switch in the header, with the tool list inside while it is on. The
// icon must render, and the header switch must toggle the tool list.

test.describe('Settings card header', () => {
  test('MCP Server card renders its icon and a named switch in the header', async () => {
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });
    await openTab('MCP Server');

    const card = page.locator('section[aria-label="MCP server"]');
    await expect(card).toBeVisible();
    await expect(card.locator('svg').first()).toBeVisible();
    await expect(page.getByRole('switch', { name: 'MCP server' })).toBeVisible();

    await closeSettings();
  });

  test('MCP Server header switch toggles and hides the tool list while off', async () => {
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });

    await openTab('MCP Server');

    const toggle = page.getByRole('switch', { name: 'MCP server' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('mcp-tool-group-tasks')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('mcp-tool-group-tasks')).toHaveCount(0);

    // Restore for subsequent tests.
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });

    await closeSettings();
  });

  test('a click anywhere on the header flips its switch, but a click on its info icon does not', async () => {
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });
    await openTab('MCP Server');

    const card = page.locator('section[aria-label="MCP server"]');
    const toggle = page.getByRole('switch', { name: 'MCP server' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await card.locator('h3').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // The info icon is a control of its own: reading "How it works" must not
    // change the setting.
    await card.getByRole('button', { name: /^About MCP server/ }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await card.locator('p').first().click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });
    await closeSettings();
  });

  test('every switch on a tab ends on one right edge, header switches included', async () => {
    // The header's right inset is computed from the tiles' inset plus their
    // right padding (settings-card.tsx), so a header switch lines up with the
    // tile switches below it. Measured on Git: the Worktrees header switch,
    // its two tile switches, and every other card's.
    await openTab('Git');
    await expect(page.getByRole('switch', { name: 'Worktrees' })).toBeVisible();
    const rightEdges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('section[aria-label] [role="switch"]'))
        .map((element) => element.getBoundingClientRect().right),
    );
    expect(rightEdges.length).toBeGreaterThan(3);
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1);
    await closeSettings();
  });

  test('a card\'s icon and its tiles\' content start on one left edge', async () => {
    // Tiles used to sit 40px in, so each label stood right of the card's icon,
    // on the title's line. A tile and the header's click target now
    // share one inset (settings-card.tsx `TILE_INSET_PX`), so the icon's column
    // and the first tile's first content element begin at the same x. Measured on
    // every Git card that has a body: Branches, Worktrees and Pull requests.
    await setGlobalConfigAndSync({ git: { worktreesEnabled: true } });
    await openTab('Git');
    await expect(page.getByRole('switch', { name: 'Worktrees', exact: true })).toBeVisible();
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="settings-panel"] section[aria-label]')).flatMap((card) => {
        const iconColumn = card.children[0]?.querySelector('span[aria-hidden="true"]');
        const firstTile = card.children[1]?.children[0];
        const firstContent = firstTile?.firstElementChild;
        if (!iconColumn || !firstContent) return [];
        return [{
          label: card.getAttribute('aria-label') ?? '',
          iconLeft: iconColumn.getBoundingClientRect().left,
          contentLeft: firstContent.getBoundingClientRect().left,
        }];
      }),
    );
    // Pins that the measurement found the cards, so an empty or renamed DOM
    // cannot pass this vacuously.
    expect(cards.map((card) => card.label)).toEqual(expect.arrayContaining(['Branches', 'Worktrees', 'Pull requests']));
    // A real tolerance, not zero: sub-pixel rounding differs by platform. The old
    // 40px indent put the two edges 24px apart, far outside it.
    for (const card of cards) {
      expect(Math.abs(card.iconLeft - card.contentLeft), `${card.label}: icon left ${card.iconLeft}, tile content left ${card.contentLeft}`).toBeLessThanOrEqual(1.5);
    }
    await closeSettings();
  });

  test('a group tile\'s header keeps the tile edges for its content and clears them with its hover fill', async () => {
    // A CardGroupTile (MCP Server's tool groups) is not a plain tile: its
    // header button sits 4px inside the tile and pads 12px, so the content
    // lands on the tiles' 16px inset by arithmetic of its own. The measurement
    // above reads the first tile of a card, which on this tab is the docs row,
    // so nothing else checks a group's header. Three things, per group: the
    // label starts on the card icon's left edge, the chevron ends on the header
    // switch's right edge, and the button (the hover fill) stands off the tile's
    // edges and off the first item below it. Every edge is read in one
    // evaluate, relative to another edge, and polled until the panel settles.
    await setGlobalConfigAndSync({ mcpServer: { enabled: true } });
    await openTab('MCP Server');
    await expect(page.getByTestId('mcp-tool-group-tasks')).toBeVisible();

    const expectedGroups = MCP_TOOL_CATEGORIES
      .filter((category) => MCP_TOOL_MANIFEST.some((tool) => tool.category === category.id))
      .map((category) => category.id);
    const EDGE_TOLERANCE_PX = 1.5;
    const MIN_HOVER_FILL_INSET_PX = 2;
    const MIN_HOVER_FILL_GAP_PX = 6;

    await expect.poll(() => page.evaluate(({ tolerance, minInset, minGap }) => {
      const card = document.querySelector('[data-testid="settings-panel"] section[aria-label="MCP server"]');
      const iconColumn = card?.children[0]?.querySelector('span[aria-hidden="true"]');
      const headerSwitch = card?.querySelector('[role="switch"]');
      if (!card || !iconColumn || !headerSwitch) {
        return { groups: [], violations: ['the MCP server card, its icon column or its header switch is missing'] };
      }
      const iconLeft = iconColumn.getBoundingClientRect().left;
      const switchRight = headerSwitch.getBoundingClientRect().right;

      const violations: string[] = [];
      const groups = Array.from(card.querySelectorAll('section[data-testid^="mcp-tool-group-"]'));
      const groupNames = groups.map((group) => (group.getAttribute('data-testid') ?? '').replace('mcp-tool-group-', ''));
      for (const group of groups) {
        const name = (group.getAttribute('data-testid') ?? '').replace('mcp-tool-group-', '');
        const toggle = group.querySelector('button[aria-expanded]');
        const label = toggle?.firstElementChild;
        const chevron = toggle?.querySelector('.card-group-chevron');
        if (!toggle || !label || !chevron) {
          violations.push(`${name}: the toggle, its label or its chevron is missing`);
          continue;
        }
        const tileBox = group.getBoundingClientRect();
        const toggleBox = toggle.getBoundingClientRect();
        const labelLeft = label.getBoundingClientRect().left;
        const chevronRight = chevron.getBoundingClientRect().right;
        if (Math.abs(labelLeft - iconLeft) > tolerance) violations.push(`${name}: label left ${labelLeft} is not the card icon's left ${iconLeft}`);
        if (Math.abs(chevronRight - switchRight) > tolerance) violations.push(`${name}: chevron right ${chevronRight} is not the header switch's right ${switchRight}`);
        const leftInset = toggleBox.left - tileBox.left;
        const rightInset = tileBox.right - toggleBox.right;
        if (leftInset < minInset) violations.push(`${name}: the hover fill is ${leftInset}px from the tile's left edge`);
        if (rightInset < minInset) violations.push(`${name}: the hover fill is ${rightInset}px from the tile's right edge`);
        // An open group's first item: the fill must not run into it. A closed
        // group's items are collapsed to no height, so there is nothing to clear.
        if (toggle.getAttribute('aria-expanded') === 'true') {
          const firstItem = group.querySelector('[data-testid="mcp-tool-cell"]');
          const gap = firstItem ? firstItem.getBoundingClientRect().top - toggleBox.bottom : NaN;
          if (!(gap >= minGap)) violations.push(`${name}: the hover fill is ${gap}px above the first item`);
        }
      }
      return { groups: groupNames, violations };
    }, { tolerance: EDGE_TOLERANCE_PX, minInset: MIN_HOVER_FILL_INSET_PX, minGap: MIN_HOVER_FILL_GAP_PX }), { timeout: 5000 })
      // The group list pins that the scan found every group, so a renamed
      // testid cannot pass it vacuously.
      .toEqual({ groups: expectedGroups, violations: [] });
    await closeSettings();
  });

  test('a header\'s click target is tile-shaped and stands apart from the first tile', async () => {
    // The header's hover fill used to run edge to edge and straight into the
    // first tile, in the same fill, so a hovered header merged with the option
    // below it. Its click target is now inset like a tile, with a tile gap under
    // it. Measured on Git's Worktrees card, whose header has a switch.
    await setGlobalConfigAndSync({ git: { worktreesEnabled: true } });
    await openTab('Git');
    const headerSwitch = page.getByRole('switch', { name: 'Worktrees', exact: true });
    await expect(headerSwitch).toBeVisible();
    const geometry = await headerSwitch.evaluate((switchElement) => {
      const target = switchElement.parentElement as HTMLElement;
      const card = target.closest('section') as HTMLElement;
      const firstTile = card.children[1].children[0] as HTMLElement;
      const targetRect = target.getBoundingClientRect();
      const tileRect = firstTile.getBoundingClientRect();
      return {
        leftDelta: Math.abs(targetRect.left - tileRect.left),
        rightDelta: Math.abs(targetRect.right - tileRect.right),
        gap: tileRect.top - targetRect.bottom,
        hoverFill: target.className.includes('hover:bg-'),
      };
    });
    // The hover fill lives on the measured element, so the geometry is the fill's.
    expect(geometry.hoverFill).toBe(true);
    expect(geometry.leftDelta).toBeLessThan(1);
    expect(geometry.rightDelta).toBeLessThan(1);
    expect(geometry.gap).toBeGreaterThanOrEqual(4);
    await closeSettings();
  });

  test('a header whose prerequisite is off still flips, and turns the prerequisite on', async () => {
    await setGlobalConfigAndSync({ knowledgeGraph: { indexingEnabled: false, enabled: false } });
    await openTab('Knowledge Graph');

    const card = page.locator('section[aria-label="Knowledge Graph"]');
    // The description stays; a tag after the title names the prerequisite.
    await expect(card).toContainText('Needs indexing');
    await expect(card).toContainText('Finds your work by meaning and answers questions.');
    // Never a dead end: a click on the header turns the feature and its index on.
    await card.locator('h3').click();
    await expect(page.getByRole('switch', { name: 'Knowledge Graph' })).toHaveAttribute('aria-checked', 'true');
    await expect(card).not.toContainText('Needs indexing');

    await setGlobalConfigAndSync({ knowledgeGraph: { indexingEnabled: true, enabled: false } });
    await closeSettings();
  });
});

// ── Gap 6: CardToggleRow filter detach ────────────────────────────────────────
//
// When the settings search query does not match a row's searchId, CardToggleRow
// returns null, removing the element from the DOM entirely. Verify with
// not.toBeAttached() against a specific row.
//
// "Auto-resume agents on restart" (searchId: 'agent.autoResumeSessionsOnRestart')
// does NOT appear under the search term "font" (a Terminal-only term).

test.describe('CardToggleRow filter detach', () => {
  test('searching "font" removes Behavior tab toggles from the DOM', async () => {
    await openTab('Behavior');

    // Confirm the toggle exists before searching.
    const autoResumeSwitch = page.getByRole('switch', { name: 'Auto-resume agents on restart', exact: true });
    await expect(autoResumeSwitch).toBeAttached();

    // Enter a search term that matches only Terminal settings.
    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('font');

    // The Behavior tab's toggle rows must be detached (CardToggleRow returns null).
    await expect(autoResumeSwitch).not.toBeAttached();

    await closeSettings();
  });
});

// ── Gap 7: CardToggleRow persistence ─────────────────────────────────────────
//
// Clicking a CardToggleRow must persist the new value to global config via
// the config.set IPC (window.electronAPI.config.set). Verified by reading back
// config.getGlobal() after the click.
//
// Pattern mirrors browser-settings.spec.ts "toggling Browser pane persists".

test.describe('Behavior/Board tab CardToggleRow persistence', () => {
  test.afterEach(async () => {
    // Restore all three toggles to their mock defaults.
    await setGlobalConfigAndSync({
      autoFocusIdleSession: false,
      agent: { autoResumeSessionsOnRestart: false },
      skipBoardConfigConfirm: false,
    });
  });

  test('clicking Auto-focus idle sessions persists autoFocusIdleSession to global config', async () => {
    // Ensure clean starting state.
    await setGlobalConfigAndSync({ autoFocusIdleSession: false });

    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-focus idle sessions', exact: true });
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

  test('clicking Auto-resume agents on restart persists agent.autoResumeSessionsOnRestart', async () => {
    await setGlobalConfigAndSync({ agent: { autoResumeSessionsOnRestart: false } });

    await openTab('Behavior');

    const card = page.getByRole('switch', { name: 'Auto-resume agents on restart', exact: true });
    await expect(card).toHaveAttribute('aria-checked', 'false');

    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'true');

    await expect.poll(async () => {
      const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
      return (globalConfig as { agent: { autoResumeSessionsOnRestart: boolean } }).agent.autoResumeSessionsOnRestart;
    }, { timeout: 3000 }).toBe(true);

    await closeSettings();
  });

  test('clicking Auto-apply board config changes persists skipBoardConfigConfirm to global config', async () => {
    // skipBoardConfigConfirm starts false (mock default). Lives in the Board
    // tab's Config Sync section, not Behavior - it is board data reconciliation,
    // not session/window behavior.
    await setGlobalConfigAndSync({ skipBoardConfigConfirm: false });

    await openTab('Board');

    const card = page.getByRole('switch', { name: 'Auto-apply board config changes', exact: true });
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
// The capability switches (Allow interaction, Allow navigation, Only localhost,
// Allow eval) sit inside the Browser automation card and show only while its
// master switch is on: off means hidden, not greyed out. Their stored values
// are kept, so switching it back on restores the prior choices. Only localhost
// nests under Allow navigation and hides with it, since it does nothing
// without navigation.

test.describe('BrowserAutomationTab master-switch gating', () => {
  test.afterEach(async () => {
    // Restore defaults so subsequent tests start from a known state.
    await setGlobalConfigAndSync({ browserAutomation: { enabled: true, allowNavigation: true } });
  });

  test('capability switches are hidden while the master switch is off', async () => {
    await setGlobalConfigAndSync({ browserAutomation: { enabled: false } });
    await openTab('Agent Browser');

    const masterSwitch = page.getByRole('switch', { name: 'Browser automation' });
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Allow interaction' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Allow eval' })).toHaveCount(0);

    await closeSettings();
  });

  test('capability switches show while the master switch is on, with Only localhost under navigation', async () => {
    await setGlobalConfigAndSync({ browserAutomation: { enabled: true, allowNavigation: true } });
    await openTab('Agent Browser');

    const masterSwitch = page.getByRole('switch', { name: 'Browser automation' });
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Allow interaction' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Only localhost' })).toBeVisible();

    // Only localhost narrows navigation, so it hides once navigation is off.
    await page.getByRole('switch', { name: 'Allow navigation' }).click();
    await expect(page.getByRole('switch', { name: 'Only localhost' })).toHaveCount(0);

    await closeSettings();
  });

  test('a click on a row\'s label or description flips that row\'s switch only', async () => {
    await setGlobalConfigAndSync({ browserAutomation: { enabled: true, allowNavigation: true, allowEval: false } });
    await openTab('Agent Browser');

    const card = page.locator('section[aria-label="Browser automation"]');
    const evalSwitch = page.getByRole('switch', { name: 'Allow eval' });
    const interactionSwitch = page.getByRole('switch', { name: 'Allow interaction' });
    const masterSwitch = page.getByRole('switch', { name: 'Browser automation' });
    const interactionBefore = await interactionSwitch.getAttribute('aria-checked');
    await expect(evalSwitch).toHaveAttribute('aria-checked', 'false');

    await card.getByText('Allow eval', { exact: true }).click();
    await expect(evalSwitch).toHaveAttribute('aria-checked', 'true');
    // Neither a sibling row nor the card's own header switch moved.
    await expect(interactionSwitch).toHaveAttribute('aria-checked', interactionBefore ?? '');
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'true');

    await setGlobalConfigAndSync({ browserAutomation: { allowEval: false } });
    await closeSettings();
  });
});

// ── Gap 9: Info icon variant (BoardManagerDialog Handoff toggle) ─────────────
//
// ToggleCard's optional `info` prop renders an aria-hidden Info icon beside the
// label, with the info text as its `title` tooltip. Clicking the icon must NOT
// flip the switch (the icon's onClick calls stopPropagation). The Board
// Manager's "Hand off context when the agent changes" toggle (Handoff section) is the
// sole current usage; "Auto-spawn" in the same dialog has no `info` and is the
// negative case. "Auto-spawn" was renamed "Start an agent here" (2026-07-26).

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

    const handoffSwitch = page.getByRole('switch', { name: 'Hand off context when the agent changes' });
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

    const autoSpawnSwitch = page.getByRole('switch', { name: 'Start an agent here' });
    await expect(autoSpawnSwitch).toBeVisible();
    await expect(autoSpawnSwitch.locator('span[title]')).toHaveCount(0);

    await closeManager();
  });

  test('clicking the info icon does not toggle the switch', async () => {
    await openManagerByHeader('Code Review');

    const handoffSwitch = page.getByRole('switch', { name: 'Hand off context when the agent changes' });
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'false');

    await handoffSwitch.locator('span[title]').click();

    // stopPropagation on the icon's onClick must prevent the click from
    // bubbling to the parent switch button.
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'false');

    // Sanity: clicking the label text (not the icon) still flips it, proving
    // the switch itself is wired correctly and the prior click was a no-op
    // specifically because of the icon, not some other reason.
    await handoffSwitch.locator('text=Hand off context when the agent changes').first().click();
    await expect(handoffSwitch).toHaveAttribute('aria-checked', 'true');

    // Discard the dirty change on close (closeManager accepts the confirm).
    await closeManager();
  });
});
