/**
 * UI tests for three popovers migrated from an in-flow `absolute top-full ...
 * z-50` div to `OverlayPopover` + `portal` + `usePopoverPosition({ strategy:
 * 'fixed' })`, per .claude/rules/popover-escapes-clipping.md. All three had
 * zero prior coverage.
 *
 *   - PromotePopover (src/renderer/components/backlog/PromotePopover.tsx):
 *     mounts anchored to the per-row "Move to board" button in BacklogView's
 *     DataTable. With drag-to-reorder enabled (the default), the row itself
 *     renders through DataTable's SortableRow, whose own <td> is NOT
 *     overflow-hidden - the clip instead comes from the table's scrollable
 *     wrapper (DataTable.tsx's `overflow-auto` scroll container), since an
 *     absolutely-positioned dropdown anchored to the row (position: relative)
 *     extends past the row without growing the scroll container's
 *     scrollHeight, so it was clipped and unreachable rather than scrollable
 *     into view. (The CompletedTasksDialog mount below, which does not set
 *     `sortableEnabled`, takes DataTable's other virtualized branch, whose
 *     <td> IS `overflow-hidden` directly - DataTable.tsx:331.)
 *   - RestorePopover (src/renderer/components/dialogs/completed-tasks/RestorePopover.tsx):
 *     mounts anchored to the per-row "Restore to board" button inside
 *     CompletedTasksDialog's DataTable, whose <td> is directly
 *     `overflow-hidden` (DataTable.tsx:331) - the worst case, clipped to a
 *     single ~40px row.
 *   - ShortcutsTab's Presets menu (src/renderer/components/settings/tabs/ShortcutsTab.tsx):
 *     mounts inside the settings panel's `overflow-y-auto` tab body
 *     (settings/shared.tsx:207).
 *
 * Each component needed the same fix twice over: portal + fixed strategy for
 * positioning, and a capture-phase outside-click handler that checks BOTH the
 * menu ref and the trigger ref (once portaled, the menu is no longer a DOM
 * descendant of the trigger's own wrapper, so a single-ref check reads any
 * click inside the menu as "outside" and dismisses it).
 *
 * None of PromotePopover/RestorePopover/the Presets menu has an in-menu
 * "expand in place" control like ModelCombobox's pinned-versions toggle
 * (see combobox-portal-clipping.spec.ts), so the "click inside doesn't
 * dismiss" test here instead clicks the popover's own non-interactive label
 * text (the "Move to" / "Restore to" header, or a preset category header) -
 * a plain text node with no onClick, so a click landing on it is a clean
 * DOM-containment discriminator: OverlayPopover's fixed two-ref check reads
 * it as "inside" (popoverRef contains it) and leaves the menu open, while a
 * reverted single-ref check (only the trigger ref) reads it as "outside" and
 * dismisses.
 *
 * Red-green verified (see the report for this change): reverting the
 * two-ref outside-click check to a single ref reproduces a genuinely
 * different failure per component, confirmed empirically rather than
 * assumed from combobox-portal-clipping.spec.ts's docstring:
 *   - PromotePopover / RestorePopover close on `mousedown` (capture phase).
 *     Reverting to a single (trigger-only) ref reds BOTH the "click inside
 *     doesn't dismiss" test AND the "selecting still works" test - the
 *     synchronous mousedown-triggered close beats the option button's own
 *     click, so the selection silently no-ops. Both tests are independent
 *     regression guards for the two-ref fix here.
 *   - ShortcutsTab's Presets menu closes on `pointerdown` (capture phase).
 *     The same single-ref reversion reds only the "click inside doesn't
 *     dismiss" test; "selecting still works" stays green, because
 *     OverlayPopover keeps the node mounted through its ~100ms exit
 *     animation (`--popover-exit-duration`) and the preset button's own
 *     click event still lands before it unmounts. For this component the
 *     select test is forward-behavior coverage (the click reaches through
 *     the portal and commits), not an independent regression guard for the
 *     ref fix - matching combobox-portal-clipping.spec.ts's documented
 *     reasoning for its pointerdown-adjacent case.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForBoard, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// ---------------------------------------------------------------------------
// PromotePopover (backlog row action)
// ---------------------------------------------------------------------------

const PROMOTE_PROJECT_ID = 'proj-promote-popover-clip';
const PROMOTE_BACKLOG_ITEM_ID = 'backlog-promote-popover-clip';

async function launchWithBacklogItem(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROMOTE_PROJECT_ID}',
        name: 'Promote Popover Clip Test',
        path: '/mock/promote-popover-clip',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-ppc-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
      });

      state.backlogTasks.push({
        id: '${PROMOTE_BACKLOG_ITEM_ID}',
        title: 'Promote Popover Clip Task',
        description: 'Backlog item used to reproduce the clipped Move-to-board dropdown.',
        priority: 0,
        labels: [],
        position: 0,
        assignee: null,
        due_date: null,
        item_type: null,
        external_id: null,
        external_source: null,
        external_url: null,
        sync_status: null,
        external_metadata: null,
        attachment_count: 0,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROMOTE_PROJECT_ID}' };
    });
  `);

  // Spy on backlog.promote so the "selecting still works" test can assert the
  // committed payload without racing the optimistic local-store removal.
  await page.addInitScript(`
    window.__backlogPromoteCalls = [];
    var originalPromote = null;
    var promoteCheckInterval = setInterval(function () {
      if (window.electronAPI && window.electronAPI.backlog && window.electronAPI.backlog.promote && !originalPromote) {
        originalPromote = window.electronAPI.backlog.promote;
        window.electronAPI.backlog.promote = async function (input) {
          window.__backlogPromoteCalls.push({ backlogTaskIds: input.backlogTaskIds, targetSwimlaneId: input.targetSwimlaneId });
          return originalPromote(input);
        };
        clearInterval(promoteCheckInterval);
      }
    }, 10);
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readBacklogPromoteCalls(page: Page): Promise<Array<{ backlogTaskIds: string[]; targetSwimlaneId: string }>> {
  return page.evaluate(() => (window as unknown as {
    __backlogPromoteCalls: Array<{ backlogTaskIds: string[]; targetSwimlaneId: string }>;
  }).__backlogPromoteCalls ?? []);
}

/** Switch to the Backlog view and open the row's Move-to-board popover. */
async function openPromotePopover(page: Page): Promise<void> {
  // Explicit load rather than trusting the initial-mount project-open path:
  // BacklogView renders nothing until `hydrated` is true, and `hydrated`
  // only flips inside loadBacklog()'s own success/catch branches.
  await page.evaluate(async () => {
    const stores = (window as unknown as {
      __zustandStores?: { backlog: { getState: () => { loadBacklog: () => Promise<void> } } };
    }).__zustandStores;
    await stores?.backlog.getState().loadBacklog();
  });
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="backlog-task-row"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[data-testid="move-to-board-btn"]').click();
  await page.locator('[data-testid="promote-popover"]').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('PromotePopover (backlog row action)', () => {
  test('portal escapes the backlog view container', async () => {
    const { browser, page } = await launchWithBacklogItem();
    try {
      await openPromotePopover(page);

      // Portal proof: the menu must not be a descendant of the backlog
      // view's own subtree. This is the load-bearing structural assertion -
      // Playwright's boundingBox()/toBeVisible() both ignore ancestor
      // overflow clipping, so a geometry read would pass even against a
      // fully clipped, unreachable menu.
      const escapedBacklogView = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="backlog-view"]');
        const menuElement = document.querySelector('[data-testid="promote-popover"]');
        return !!container && !!menuElement && !container.contains(menuElement);
      });
      expect(escapedBacklogView).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a click on the popover header does not count as outside and does not dismiss the menu', async () => {
    const { browser, page } = await launchWithBacklogItem();
    try {
      await openPromotePopover(page);

      const menu = page.locator('[data-testid="promote-popover"]');
      // Plain non-interactive label with no onClick: the honest discriminator
      // for the two-ref outside-click fix. A single-ref (trigger-only) check
      // would read this as "outside" and dismiss; the current two-ref check
      // (menuRef OR triggerRef) reads it as "inside" and leaves the menu open.
      await menu.getByText('Move to', { exact: true }).click();

      // Intentional fixed wait: asserts a NON-occurrence (the menu must not
      // dismiss). Also required for the assertion to discriminate at all -
      // OverlayPopover keeps the node mounted through its ~100ms exit
      // animation, so an immediate toBeVisible() would pass even against a
      // menu on its way out. 400ms clears --popover-exit-duration (100ms)
      // with margin (matches task-level-overrides.spec.ts:1155's precedent).
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Planning' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('selecting a lane promotes the backlog item to the board', async () => {
    const { browser, page } = await launchWithBacklogItem();
    try {
      await openPromotePopover(page);

      const menu = page.locator('[data-testid="promote-popover"]');
      await menu.getByRole('button', { name: 'Planning' }).click();

      await expect.poll(() => readBacklogPromoteCalls(page)).toContainEqual({
        backlogTaskIds: [PROMOTE_BACKLOG_ITEM_ID],
        targetSwimlaneId: 'lane-ppc-planning',
      });
      await expect(menu).not.toBeVisible();
      await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// RestorePopover (completed-tasks dialog row action)
// ---------------------------------------------------------------------------

const RESTORE_PROJECT_ID = 'proj-restore-popover-clip';
const RESTORE_TASK_ID = 'task-restore-popover-clip';

async function launchWithArchivedTaskForRestore(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${RESTORE_PROJECT_ID}',
        name: 'Restore Popover Clip Test',
        path: '/mock/restore-popover-clip',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-rpc-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
      });

      state.archivedTasks.push({
        id: '${RESTORE_TASK_ID}',
        title: 'Restore Popover Clip Task',
        description: 'Archived task used to reproduce the clipped Restore-to dropdown.',
        swimlane_id: laneIds['Done'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        pr_state: null,
        base_branch: 'main',
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${RESTORE_PROJECT_ID}' };
    });
  `);

  // Spy on tasks.unarchive (same pattern as archived-context-menu.spec.ts) so
  // the "selecting still works" test can assert the committed payload.
  await page.addInitScript(`
    window.__taskUnarchiveCalls = [];
    var originalUnarchive = null;
    var unarchiveCheckInterval = setInterval(function () {
      if (window.electronAPI && window.electronAPI.tasks && window.electronAPI.tasks.unarchive && !originalUnarchive) {
        originalUnarchive = window.electronAPI.tasks.unarchive;
        window.electronAPI.tasks.unarchive = async function (input) {
          window.__taskUnarchiveCalls.push({ id: input.id, targetSwimlaneId: input.targetSwimlaneId });
          return originalUnarchive(input);
        };
        clearInterval(unarchiveCheckInterval);
      }
    }, 10);
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readTaskUnarchiveCalls(page: Page): Promise<Array<{ id: string; targetSwimlaneId: string }>> {
  return page.evaluate(() => (window as unknown as {
    __taskUnarchiveCalls: Array<{ id: string; targetSwimlaneId: string }>;
  }).__taskUnarchiveCalls ?? []);
}

/** Open the Completed Tasks dialog and the row's Restore-to popover. */
async function openRestorePopover(page: Page): Promise<void> {
  const viewAllButton = page.locator('[data-testid="view-all-completed"]');
  await viewAllButton.waitFor({ state: 'visible', timeout: 10000 });
  await viewAllButton.click();

  const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const row = page.locator('[data-testid="completed-task-row"]').first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="restore-task-btn"]').click();
  await page.locator('[data-testid="restore-popover"]').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('RestorePopover (completed tasks dialog row action)', () => {
  test('portal escapes the completed-tasks dialog and its overflow-hidden row cell', async () => {
    const { browser, page } = await launchWithArchivedTaskForRestore();
    try {
      await openRestorePopover(page);

      // Portal proof against the dialog, this mount site's clipping
      // ancestor (the row's own <td> is overflow-hidden per
      // DataTable.tsx:331, since CompletedTasksDialog does not set
      // sortableEnabled - the worst-case ~40px-row clip).
      const escapedDialog = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="completed-tasks-dialog"]');
        const menuElement = document.querySelector('[data-testid="restore-popover"]');
        return !!dialog && !!menuElement && !dialog.contains(menuElement);
      });
      expect(escapedDialog).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a click on the popover header does not count as outside and does not dismiss the menu', async () => {
    const { browser, page } = await launchWithArchivedTaskForRestore();
    try {
      await openRestorePopover(page);

      const menu = page.locator('[data-testid="restore-popover"]');
      // Same discriminator as PromotePopover: a plain, non-interactive label
      // with no onClick handler.
      await menu.getByText('Restore to', { exact: true }).click();

      // Intentional fixed wait: NON-occurrence assertion, and required so
      // OverlayPopover's ~100ms exit animation can't mask a wrongly-closing
      // menu (see the PromotePopover test above for the full rationale).
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'To Do' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('selecting a lane restores the archived task to the board', async () => {
    const { browser, page } = await launchWithArchivedTaskForRestore();
    try {
      await openRestorePopover(page);

      const menu = page.locator('[data-testid="restore-popover"]');
      await menu.getByRole('button', { name: 'To Do' }).click();

      await expect.poll(() => readTaskUnarchiveCalls(page)).toContainEqual({
        id: RESTORE_TASK_ID,
        targetSwimlaneId: 'lane-rpc-to-do',
      });
      await expect(menu).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ShortcutsTab Presets menu
// ---------------------------------------------------------------------------

const SHORTCUTS_PROJECT_ID = 'proj-shortcuts-presets-clip';

async function launchInShortcutsTab(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${SHORTCUTS_PROJECT_ID}',
        name: 'Shortcuts Presets Clip Test',
        path: '/mock/shortcuts-presets-clip',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: 'lane-spc-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-'),
          position: index,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${SHORTCUTS_PROJECT_ID}' };
    });
  `);

  // Spy on boardConfig.setShortcuts so the "selecting still works" test can
  // assert the committed payload without racing the mock's getShortcuts(),
  // which always returns [] and would otherwise clobber the just-added
  // local row back to empty via ShortcutsTab's `useEffect([shortcuts])`.
  await page.addInitScript(`
    window.__setShortcutsCalls = [];
    var originalSetShortcuts = null;
    var setShortcutsCheckInterval = setInterval(function () {
      if (window.electronAPI && window.electronAPI.boardConfig && window.electronAPI.boardConfig.setShortcuts && !originalSetShortcuts) {
        originalSetShortcuts = window.electronAPI.boardConfig.setShortcuts;
        window.electronAPI.boardConfig.setShortcuts = async function (actions, target) {
          window.__setShortcutsCalls.push({ actions: actions, target: target });
          return originalSetShortcuts(actions, target);
        };
        clearInterval(setShortcutsCheckInterval);
      }
    }, 10);
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readSetShortcutsCalls(page: Page): Promise<Array<{ actions: Array<{ label: string }>; target: string }>> {
  return page.evaluate(() => (window as unknown as {
    __setShortcutsCalls: Array<{ actions: Array<{ label: string }>; target: string }>;
  }).__setShortcutsCalls ?? []);
}

/** Navigate to Settings > Shortcuts and open the Presets menu. */
async function openPresetsMenu(page: Page): Promise<void> {
  await waitForBoard(page);
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await page.locator('[data-testid="add-shortcut"]').waitFor({ state: 'visible', timeout: 3000 });

  await page.locator('[data-testid="shortcut-presets"]').click();
  await page.locator('[data-testid="shortcut-presets-menu"]').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('ShortcutsTab Presets menu', () => {
  test('portal escapes the settings panel scroller', async () => {
    const { browser, page } = await launchInShortcutsTab();
    try {
      await openPresetsMenu(page);

      // Portal proof against the settings panel, this mount site's clipping
      // ancestor (an overflow-y-auto scroller wraps the tab body -
      // settings/shared.tsx:207).
      const escapedSettingsPanel = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        const menuElement = document.querySelector('[data-testid="shortcut-presets-menu"]');
        return !!panel && !!menuElement && !panel.contains(menuElement);
      });
      expect(escapedSettingsPanel).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a click on a preset category header does not count as outside and does not dismiss the menu', async () => {
    const { browser, page } = await launchInShortcutsTab();
    try {
      await openPresetsMenu(page);

      const menu = page.locator('[data-testid="shortcut-presets-menu"]');
      // Category header ("Editors") is a plain non-interactive div with no
      // onClick - same discriminator shape as the two popovers above.
      await menu.getByText('Editors', { exact: true }).click();

      // Intentional fixed wait: NON-occurrence assertion, and required so
      // OverlayPopover's exit animation can't mask a wrongly-closing menu.
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Cursor' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('selecting a preset commits a new shortcut', async () => {
    const { browser, page } = await launchInShortcutsTab();
    try {
      await openPresetsMenu(page);

      const menu = page.locator('[data-testid="shortcut-presets-menu"]');
      await menu.getByRole('button', { name: 'Cursor' }).click();

      await expect.poll(async () => {
        const calls = await readSetShortcutsCalls(page);
        return calls.some((call) => call.target === 'team' && call.actions.some((action) => action.label === 'Cursor'));
      }).toBe(true);
      await expect(menu).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
