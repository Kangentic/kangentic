import { test, expect, type Page } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

let page: Page;

test.beforeEach(async () => {
  const launched = await launchPage();
  page = launched.page;
  await createProject(page, 'Alpha');
  await createProject(page, 'Beta');
});

test.afterEach(async () => {
  await page.context().browser()?.close();
});

async function createGroup(page: Page, name: string): Promise<void> {
  await page.locator('button[title="New group"]').click();
  const input = page.locator('input[placeholder="Group name"]');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

test.describe('Project Groups', () => {
  test('can create a project group', async () => {
    await createGroup(page, 'Work');
    await expect(page.locator('text=Work').first()).toBeVisible();
  });

  test('Escape cancels group creation', async () => {
    await page.locator('button[title="New group"]').click();
    const input = page.locator('input[placeholder="Group name"]');
    await expect(input).toBeVisible();
    await input.press('Escape');
    await expect(input).toBeHidden();
  });

  test('clicking Group button again cancels creation', async () => {
    const groupButton = page.locator('button[title="New group"]');
    await groupButton.click();
    const input = page.locator('input[placeholder="Group name"]');
    await expect(input).toBeVisible();
    await groupButton.click();
    await expect(input).toBeHidden();
  });

  test('collapse hides projects and shows count', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    await createGroup(page, 'MyGroup');

    // Move Alpha to MyGroup via context menu
    await sidebar.locator('.truncate.font-medium:text("Alpha")').click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=MyGroup').click();

    // Move Beta to MyGroup via context menu
    await sidebar.locator('.truncate.font-medium:text("Beta")').click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=MyGroup').click();

    // Both projects should be visible under the group
    await expect(sidebar.locator('.truncate.font-medium:text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('.truncate.font-medium:text("Beta")')).toBeVisible();

    // Click the group header's text area to collapse (avoid action buttons)
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    const groupName = groupHeader.locator('text=MyGroup');
    await groupName.click();

    // Projects should be hidden in sidebar
    await expect(sidebar.locator('.truncate.font-medium:text("Alpha")')).toBeHidden();
    await expect(sidebar.locator('.truncate.font-medium:text("Beta")')).toBeHidden();

    // Count pill should show "2 projects" in the group header
    await expect(groupHeader.locator('text=2 projects')).toBeVisible();

    // Click again to expand
    await groupName.click();
    await expect(sidebar.locator('.truncate.font-medium:text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('.truncate.font-medium:text("Beta")')).toBeVisible();
  });

  test('can rename a group via context menu', async () => {
    await createGroup(page, 'OldName');
    await expect(page.locator('text=OldName').first()).toBeVisible();

    // Right-click the group header to open the context menu
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Rename').click();

    // Type new name and confirm
    const renameInput = groupHeader.locator('input');
    await renameInput.fill('NewName');
    await renameInput.press('Enter');

    await expect(page.locator('text=NewName').first()).toBeVisible();
  });

  test('can rename a group via overflow button', async () => {
    await createGroup(page, 'OverflowRename');

    // Click the always-visible overflow button
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.locator('[data-testid^="group-menu-"]').click();
    await page.locator('.fixed.bg-surface-raised').locator('text=Rename').click();

    const renameInput = groupHeader.locator('input');
    await renameInput.fill('RenamedViaOverflow');
    await renameInput.press('Enter');

    await expect(page.locator('text=RenamedViaOverflow').first()).toBeVisible();
  });

  test('can delete a group and projects become ungrouped', async () => {
    await createGroup(page, 'Temp');

    // Move Alpha to Temp via context menu
    await page.locator('text=Alpha').first().click({ button: 'right' });
    await page.locator('text=Temp').last().click();

    // Delete the group via right-click menu
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Delete').click();

    // Confirm dialog
    await expect(page.getByRole('heading', { name: 'Delete Group' })).toBeVisible();
    await page.locator('button:has-text("Delete")').last().click();

    // Group header should be gone
    await expect(page.locator('[data-testid^="project-group-"]')).toBeHidden();

    // Alpha should still be visible (ungrouped)
    await expect(page.locator('text=Alpha').first()).toBeVisible();
  });

  test('context menu moves project to group', async () => {
    await createGroup(page, 'Dev');

    // Right-click Alpha to open context menu
    await page.locator('text=Alpha').first().click({ button: 'right' });

    // Click "Dev" in the context menu
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();
    await contextMenu.locator('text=Dev').click();

    // Alpha should now be indented (grouped)
    const alphaItem = page.locator('text=Alpha').first().locator('..');
    await expect(page.locator('text=Alpha').first()).toBeVisible();
  });

  test('context menu removes project from group', async () => {
    await createGroup(page, 'Team');

    // Move Alpha to Team
    await page.locator('text=Alpha').first().click({ button: 'right' });
    await page.locator('text=Team').last().click();

    // Right-click Alpha again to remove from group
    await page.locator('text=Alpha').first().click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();
    await contextMenu.locator('text=Remove from group').click();

    // Alpha is still visible (now ungrouped)
    await expect(page.locator('text=Alpha').first()).toBeVisible();
  });
});

test.describe('GroupContextMenu - move up/down', () => {
  test('Move down reorders the group one position later', async () => {
    // Create two groups so we can move First down
    await page.locator('button[title="New group"]').click();
    const input = page.locator('input[placeholder="Group name"]');
    await input.fill('First');
    await input.press('Enter');
    await expect(input).toBeHidden();

    await page.locator('button[title="New group"]').click();
    const input2 = page.locator('input[placeholder="Group name"]');
    await input2.fill('Second');
    await input2.press('Enter');
    await expect(input2).toBeHidden();

    // Right-click First group header and choose Move down
    const groupHeaders = page.locator('[data-testid^="project-group-"]');
    const firstHeader = groupHeaders.first();
    await firstHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await contextMenu.locator('text=Move down').click();

    // After moving down, Second should appear before First in the DOM
    const allHeaders = page.locator('[data-testid^="project-group-"]');
    await expect.poll(async () => {
      const texts = await allHeaders.allTextContents();
      const secondIndex = texts.findIndex((t) => t.includes('Second'));
      const firstIndex = texts.findIndex((t) => t.includes('First'));
      return secondIndex < firstIndex;
    }, { timeout: 5000 }).toBe(true);
  });

  test('Move up reorders the group one position earlier', async () => {
    await page.locator('button[title="New group"]').click();
    const input = page.locator('input[placeholder="Group name"]');
    await input.fill('GroupA');
    await input.press('Enter');
    await expect(input).toBeHidden();

    await page.locator('button[title="New group"]').click();
    const input2 = page.locator('input[placeholder="Group name"]');
    await input2.fill('GroupB');
    await input2.press('Enter');
    await expect(input2).toBeHidden();

    // Right-click GroupB (second/last) and choose Move up
    const groupHeaders = page.locator('[data-testid^="project-group-"]');
    const lastHeader = groupHeaders.last();
    await lastHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await contextMenu.locator('text=Move up').click();

    // After moving up, GroupB should appear before GroupA in the DOM
    const allHeaders = page.locator('[data-testid^="project-group-"]');
    await expect.poll(async () => {
      const texts = await allHeaders.allTextContents();
      const groupBIndex = texts.findIndex((t) => t.includes('GroupB'));
      const groupAIndex = texts.findIndex((t) => t.includes('GroupA'));
      return groupBIndex < groupAIndex;
    }, { timeout: 5000 }).toBe(true);
  });

  test('Move up is disabled when group is first', async () => {
    await createGroup(page, 'OnlyGroup');

    // Right-click the only group -- Move up should be disabled
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');

    const moveUpButton = contextMenu.locator('button:has-text("Move up")');
    await expect(moveUpButton).toBeDisabled();
  });

  test('Move down is disabled when group is last', async () => {
    await createGroup(page, 'LoneGroup');

    // Right-click the only group -- Move down should be disabled
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');

    const moveDownButton = contextMenu.locator('button:has-text("Move down")');
    await expect(moveDownButton).toBeDisabled();
  });

  test('clicking outside the open group context menu closes it', async () => {
    await createGroup(page, 'ClickOutside');

    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();

    // Click somewhere far from the menu (the body)
    await page.mouse.click(900, 600);

    await expect(contextMenu).toBeHidden();
  });

  test('Escape closes the open group context menu', async () => {
    await createGroup(page, 'EscapeGroup');

    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(contextMenu).toBeHidden();
  });
});
