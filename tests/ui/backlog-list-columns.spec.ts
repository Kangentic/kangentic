/**
 * The backlog table's columns (task #1137): the Priority meter fits its column whatever the
 * scale's names, None draws an empty meter, each row's more-actions button opens the row's menu
 * in the board's order without selecting the row, the Updated column sorts newest first, and at
 * the 900x600 floor beside a 400px sidebar Title keeps its width while the table scrolls sideways.
 *
 * Layout is read in the page through getBoundingClientRect and compared relative to other
 * elements, with a pixel of slack, per cross-platform-parity.md. One boot, one step per check.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const PROJECT_ID = 'list-columns-proj';

const NEWEST_TITLE = 'Edited two hours ago';

function seedScript(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var hoursAgo = function (hours) { return new Date(Date.now() - hours * 3600000).toISOString(); };
      state.config.sidebar = { width: 400 };
      state.config.sidebarVisible = true;
      state.config.backlog = Object.assign({}, state.config.backlog, {
        priorities: [
          { label: 'None', color: '#6b7280' },
          { label: 'Low', color: '#3b82f6' },
          { label: 'Medium', color: '#eab308' },
          { label: 'High', color: '#f97316' },
          { label: 'Urgent', color: '#ef4444' },
          { label: 'Waiting on vendor response', color: '#14b8a6' },
        ],
      });
      state.projects.push({ id: '${PROJECT_ID}', name: 'list-columns', path: '/mock/list-columns', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: hoursAgo(0), created_at: hoursAgo(0) });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'list-lane-' + index, position: index, created_at: hoursAgo(0) }));
      });
      var rows = [
        { title: 'Filed in spring, untouched', priority: 2, created: 4000, updated: 4000 },
        // Created most recently and never edited: newest by Created, but not by Updated, so the
        // Updated column's order differs from what a sort on created_at would give.
        { title: 'Waiting on a vendor', priority: 5, created: 100, updated: 100 },
        { title: '${NEWEST_TITLE}', priority: 0, created: 2000, updated: 2 },
      ];
      rows.forEach(function (row, index) {
        state.backlogTasks.push({ id: 'list-item-' + index, title: row.title, description: 'A description long enough to fill the title column on a narrow window.', priority: row.priority, labels: [], position: index, assignee: null, due_date: null, item_type: null, external_id: null, external_source: null, external_url: null, sync_status: null, external_metadata: null, attachment_count: 0, created_at: hoursAgo(row.created), updated_at: hoursAgo(row.updated) });
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 760 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript());
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="backlog-task-row"]').first().waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

/** Every priority pill's right edge, and the Title column's left edge. */
async function readPriorityFit(target: Page): Promise<{ pillRights: number[]; titleLeft: number }> {
  return target.evaluate(() => {
    const titleHeader = document.querySelector('th[data-column-key="title"]');
    const pills = Array.from(document.querySelectorAll('[data-testid="backlog-task-row"] [data-testid="priority-pill"]'));
    return {
      pillRights: pills.map((pill) => pill.getBoundingClientRect().right),
      titleLeft: titleHeader ? titleHeader.getBoundingClientRect().left : 0,
    };
  });
}

test('backlog table columns', async () => {
  await test.step('every priority meter stays inside its column, a long level name included', async () => {
    const { pillRights, titleLeft } = await readPriorityFit(page);
    expect(pillRights).toHaveLength(3);
    for (const right of pillRights) expect(right).toBeLessThanOrEqual(titleLeft + 1);
  });

  await test.step('None draws an empty meter, named for the level', async () => {
    const noneRow = page.locator('[data-testid="backlog-task-row"]', { hasText: NEWEST_TITLE });
    const pill = noneRow.locator('[data-testid="priority-pill"]');
    await expect(pill).toHaveAccessibleName('Priority: None');
    await expect(pill.locator('[data-testid="priority-meter"] [data-filled]')).toHaveCount(0);
  });

  await test.step('the row menu button opens Edit, Move to, Delete under itself and leaves the row unselected', async () => {
    const firstRow = page.locator('[data-testid="backlog-task-row"]').first();
    const button = firstRow.locator('[data-testid="backlog-row-menu-btn"]');
    await button.click();
    const menu = page.locator('[data-testid="backlog-row-menu"]');
    await expect(menu).toBeVisible();
    const order = await menu.evaluate((element) => Array.from(element.querySelectorAll('[role="menuitem"]')).map((item) => item.getAttribute('data-testid')));
    expect(order[0]).toBe('context-edit-item');
    expect(order[order.length - 1]).toBe('context-delete-item');
    expect(order.slice(1, -1).every((testId) => testId === 'context-move-to-board')).toBe(true);
    const buttonBox = await button.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(buttonBox && menuBox).toBeTruthy();
    if (buttonBox && menuBox) {
      expect(Math.abs((menuBox.x + menuBox.width) - (buttonBox.x + buttonBox.width))).toBeLessThanOrEqual(1);
      expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 1);
    }
    await expect(firstRow.locator('[data-testid="backlog-task-checkbox"]')).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  await test.step('a second click on the same button closes its menu', async () => {
    const button = page.locator('[data-testid="backlog-task-row"]').first().locator('[data-testid="backlog-row-menu-btn"]');
    await button.click();
    await expect(page.locator('[data-testid="backlog-row-menu"]')).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await button.click();
    await expect(page.locator('[data-testid="backlog-row-menu"]')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  await test.step('the menu works from the keyboard: Enter focuses Edit, arrows move, Escape returns to the button', async () => {
    const button = page.locator('[data-testid="backlog-task-row"]').first().locator('[data-testid="backlog-row-menu-btn"]');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="context-edit-item"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="context-move-to-board"]').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('[data-testid="context-delete-item"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="backlog-row-menu"]')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  await test.step('Updated replaces Created, and its first click puts the newest change on top', async () => {
    const header = page.locator('th[data-column-key="updated"]');
    await expect(header).toHaveText(/updated/i);
    await expect(page.locator('th[data-column-key="created"]')).toHaveCount(0);
    // Updated order is [edited 2h ago, never edited (created 100h ago), untouched since filing];
    // a sort on created_at would put the never-edited row first.
    const rows = page.locator('[data-testid="backlog-task-row"]');
    await header.click();
    await expect(rows).toContainText([NEWEST_TITLE, 'Waiting on a vendor', 'Filed in spring']);
    await header.click();
    await expect(rows).toContainText(['Filed in spring', 'Waiting on a vendor', NEWEST_TITLE]);
    await header.click();
  });

  await test.step('dragging a row to a new place bumps that row\'s Updated time and no other', async () => {
    const rowFor = (title: string) => page.locator('[data-testid="backlog-task-row"]', { hasText: title });
    const updatedOf = (title: string) => rowFor(title).locator('[data-testid="backlog-updated"]');
    // The sort above ended unsorted, which is what enables row dragging.
    const handle = rowFor('Filed in spring').locator('[data-testid="row-drag-handle"]');
    await expect(handle).toBeVisible();
    const untouchedBefore = await updatedOf('Waiting on a vendor').innerText();
    const draggedBefore = await updatedOf('Filed in spring').innerText();

    // Read live geometry right before the gesture, and drop on the last row so the order changes.
    const handleBox = await handle.boundingBox();
    const targetBox = await rowFor(NEWEST_TITLE).boundingBox();
    expect(handleBox && targetBox).toBeTruthy();
    if (!handleBox || !targetBox) return;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 10, { steps: 3 });
    await page.mouse.move(startX, targetBox.y + targetBox.height * 0.75, { steps: 15 });
    await page.mouse.up();

    const rows = page.locator('[data-testid="backlog-task-row"]');
    await expect(rows).toContainText(['Waiting on a vendor', NEWEST_TITLE, 'Filed in spring']);
    // Four thousand hours ago becomes "just now", in whatever words the locale uses.
    await expect(updatedOf('Filed in spring')).not.toHaveText(draggedBefore);
    await expect(updatedOf('Filed in spring')).toHaveText(/now|second/i);
    await expect(updatedOf('Waiting on a vendor')).toHaveText(untouchedBefore);
  });

  await test.step('the Updated cell tip shows when the item was created', async () => {
    const cell = page.locator('[data-testid="backlog-task-row"]', { hasText: 'Waiting on a vendor' }).locator('[data-testid="backlog-updated"]');
    await cell.hover();
    await expect(page.locator('[data-tooltip]')).toHaveText(/^Created /);
    await expect(cell).toHaveAccessibleDescription(/^Created /);
    await page.mouse.move(0, 0);
  });

  await test.step('the Priorities popover draws a meter in every entry pill, rename mode included', async () => {
    await page.locator('[data-testid="manage-priorities-btn"]').click();
    const colorButtons = page.getByRole('button', { name: 'Change color' });
    await expect(colorButtons).toHaveCount(6);
    for (let index = 0; index < 6; index++) {
      await expect(colorButtons.nth(index).locator('[data-testid="priority-meter"]')).toHaveCount(1);
    }
    await page.getByRole('button', { name: 'Rename' }).first().click();
    const editInput = page.locator('input[type="text"]:focus');
    await expect(editInput).toBeVisible();
    await expect(colorButtons.first().locator('[data-testid="priority-meter"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // The first Escape ends the rename; a second closes the popover if the first did not.
    await page.keyboard.press('Escape');
    await expect(colorButtons).toHaveCount(0);
  });

  await test.step('the open row menu is portaled out of the backlog view and wraps on the arrow keys', async () => {
    const button = page.locator('[data-testid="backlog-task-row"]').first().locator('[data-testid="backlog-row-menu-btn"]');
    await button.click();
    const menu = page.locator('[data-testid="backlog-row-menu"]');
    await expect(menu).toBeVisible();
    const placement = await menu.evaluate((element) => ({
      insideView: !!document.querySelector('[data-testid="backlog-view"]')?.contains(element),
      parentIsBody: element.parentElement === document.body,
    }));
    expect(placement).toEqual({ insideView: false, parentIsBody: true });

    await expect(page.locator('[data-testid="context-edit-item"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-testid="context-delete-item"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="context-edit-item"]')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('[data-testid="context-delete-item"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('[data-testid="context-edit-item"]')).toBeFocused();

    // Tab closes the menu and hands the key's own move on from the row's button.
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const focusInsideMenu = await page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'));
    expect(focusInsideMenu).toBe(false);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  await test.step('a row menu button acts on its row alone, even inside a multi-selection', async () => {
    const rowFor = (title: string) => page.locator('[data-testid="backlog-task-row"]', { hasText: title });
    await rowFor('Filed in spring').locator('[data-testid="backlog-task-checkbox"]').click();
    await rowFor(NEWEST_TITLE).locator('[data-testid="backlog-task-checkbox"]').click();
    await expect(rowFor('Filed in spring').locator('[data-testid="backlog-task-checkbox"]')).toBeChecked();
    await expect(rowFor(NEWEST_TITLE).locator('[data-testid="backlog-task-checkbox"]')).toBeChecked();

    await rowFor(NEWEST_TITLE).locator('[data-testid="backlog-row-menu-btn"]').click();
    const menu = page.locator('[data-testid="backlog-row-menu"]');
    await expect(menu).toBeVisible();
    await expect(page.locator('[data-testid="context-delete-item"]')).toHaveText('Delete');
    await expect(menu).not.toContainText(/\d+ items?/);
    await page.locator('[data-testid="context-delete-item"]').click();

    await expect(page.getByText('This will permanently delete the backlog task.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(rowFor(NEWEST_TITLE)).toHaveCount(0);
    await expect(rowFor('Filed in spring')).toHaveCount(1);
  });

  await test.step('picking a Move to column from the row menu moves that row and closes the menu', async () => {
    const targetRow = page.locator('[data-testid="backlog-task-row"]', { hasText: 'Waiting on a vendor' });
    await targetRow.locator('[data-testid="backlog-row-menu-btn"]').click();
    const menu = page.locator('[data-testid="backlog-row-menu"]');
    await expect(menu).toBeVisible();
    await page.locator('[data-testid="context-move-to-board"]').first().click();
    // closeToTrigger hands focus back to the button, but the promoted row leaves the list, so
    // the button goes with it: what holds is that the menu is gone and only this row moved.
    await expect(menu).toHaveCount(0);
    await expect(targetRow).toHaveCount(0);
    await expect(page.locator('[data-testid="backlog-task-row"]', { hasText: 'Filed in spring' })).toHaveCount(1);
  });

  await test.step('at 900x600 beside a 400px sidebar, Title keeps its width and the table scrolls sideways', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await expect.poll(() => page.locator('th[data-column-key="title"]').evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThanOrEqual(200);
    const scrolls = await page.locator('[data-testid="backlog-view"] .overflow-auto').first()
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(scrolls).toBe(true);
  });

  await test.step('in a window too short for the menu below the last row, it opens above and stays inside', async () => {
    // More rows than the short window shows, so the last one sits at the bottom edge once the
    // list is scrolled to its end.
    await page.evaluate(async () => {
      const bridge = window as unknown as {
        electronAPI: { backlog: { create: (input: { title: string }) => Promise<unknown> } };
        __zustandStores: { backlog: { getState: () => { loadBacklog: () => Promise<void> } } };
      };
      for (let index = 1; index <= 8; index++) {
        await bridge.electronAPI.backlog.create({ title: `Filler row ${index}` });
      }
      const stores = bridge.__zustandStores;
      await stores.backlog.getState().loadBacklog();
    });
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.locator('[data-testid="backlog-view"] .overflow-auto').first()
      .evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastRow = page.locator('[data-testid="backlog-task-row"]', { hasText: 'Filler row 8' });
    await expect(lastRow).toBeVisible();
    const button = lastRow.locator('[data-testid="backlog-row-menu-btn"]');
    await button.click();
    const menu = page.locator('[data-testid="backlog-row-menu"]');
    await expect(menu).toBeVisible();
    const geometry = await page.evaluate(() => {
      const menuRect = document.querySelector('[data-testid="backlog-row-menu"]')!.getBoundingClientRect();
      const buttonRect = document.querySelectorAll('[data-testid="backlog-row-menu-btn"][aria-expanded="true"]')[0].getBoundingClientRect();
      return { menuTop: menuRect.top, menuBottom: menuRect.bottom, menuHeight: menuRect.height, buttonTop: buttonRect.top, buttonBottom: buttonRect.bottom, innerHeight: window.innerHeight };
    });
    // Precondition: the menu does not fit below the button, so only a flip keeps it clear of it.
    expect(geometry.innerHeight - geometry.buttonBottom).toBeLessThan(geometry.menuHeight);
    expect(geometry.menuTop).toBeGreaterThanOrEqual(0);
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.buttonTop + 1);
    await page.keyboard.press('Escape');
  });
});
