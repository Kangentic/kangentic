import { test, expect, type Page } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

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

/**
 * "New group" is a rare action and now sits behind the footer split button's
 * caret, so the constantly-used "Add project" stands alone in the footer.
 */
async function clickNewGroup(page: Page): Promise<void> {
  await page.getByTestId('sidebar-footer-more-button').click();
  await page.getByTestId('sidebar-new-group-button').click();
  // The popover stays mounted through its exit animation. Later assertions in
  // this file locate context menus by `.fixed.bg-surface-raised`, which the
  // closing footer menu also matches, so wait it out rather than leaving a
  // second match behind for whichever test runs next.
  await page.getByTestId('sidebar-footer-menu').waitFor({ state: 'detached', timeout: 5000 });
}

async function createGroup(page: Page, name: string): Promise<void> {
  await clickNewGroup(page);
  const input = page.locator('input[placeholder="Group name"]');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

test.describe('ProjectSidebar header count badge', () => {
  test('shows project count badge in header when projects exist', async () => {
    // The "Projects" header renders a CountBadge next to the label when projects.length > 0.
    // Scope to the header area to avoid matching group or project-row badges.
    const header = page.locator('.px-3.pt-3.pb-2.border-b').first();
    await expect(header.locator('.rounded-full').filter({ hasText: '2' })).toBeVisible();
  });
});

test.describe('Project Groups', () => {
  test('can create a project group', async () => {
    await createGroup(page, 'Work');
    await expect(page.locator('text=Work').first()).toBeVisible();
  });

  test('right-clicking the list background offers the create actions', async () => {
    // That area used to fall through to Electron's native Copy / Paste menu,
    // which offers nothing a project list can act on.
    const projectList = page.getByTestId('sidebar-project-list');
    const box = await projectList.boundingBox();
    if (!box) throw new Error('Sidebar project list has no layout');
    // Derived from the scrolling list container's OWN layout, not the
    // sidebar's total height minus a hardcoded footer offset - the footer
    // lives outside this container, so a footer height change can never move
    // this point onto the footer or a project row.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20, { button: 'right' });

    const menu = page.getByTestId('sidebar-background-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('sidebar-background-add-project')).toBeVisible();

    await menu.getByTestId('sidebar-background-new-group').click();
    const input = page.locator('input[placeholder="Group name"]');
    await expect(input).toBeVisible();
    await input.fill('FromBackgroundMenu');
    await input.press('Enter');
    await expect(page.locator('text=FromBackgroundMenu').first()).toBeVisible();
  });

  test('right-clicking a project row does not open the background menu', async () => {
    // Rows stopPropagation their own context-menu event; the list container's
    // onContextMenu handler underneath must never also fire for a row click.
    await page.locator('.truncate.font-medium:text("Alpha")').click({ button: 'right' });

    // Scoped by an item only ProjectContextMenu renders - both menus share
    // the ".fixed.bg-surface-raised" shell, so a bare selector on that class
    // would also match SidebarBackgroundMenu.
    const projectMenu = page.locator('.fixed.bg-surface-raised').filter({ hasText: 'Open in Explorer' });
    await expect(projectMenu).toBeVisible();
    await expect(page.getByTestId('sidebar-background-menu')).toHaveCount(0);
  });

  test('right-clicking a group header does not open the background menu', async () => {
    await createGroup(page, 'NoBackgroundLeak');
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });

    // Scoped by an item only GroupContextMenu renders, for the same reason as above.
    const groupMenu = page.locator('.fixed.bg-surface-raised').filter({ hasText: 'Move up' });
    await expect(groupMenu).toBeVisible();
    await expect(page.getByTestId('sidebar-background-menu')).toHaveCount(0);
  });

  test('Escape cancels group creation', async () => {
    await clickNewGroup(page);
    const input = page.locator('input[placeholder="Group name"]');
    await expect(input).toBeVisible();
    await input.press('Escape');
    await expect(input).toBeHidden();
  });

  test('choosing New group again cancels creation', async () => {
    await clickNewGroup(page);
    const input = page.locator('input[placeholder="Group name"]');
    await expect(input).toBeVisible();
    await clickNewGroup(page);
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

    // Count badge should show "2" in the group header
    await expect(groupHeader.locator('.rounded-full').filter({ hasText: '2' })).toBeVisible();

    // Click again to expand
    await groupName.click();
    await expect(sidebar.locator('.truncate.font-medium:text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('.truncate.font-medium:text("Beta")')).toBeVisible();
  });

  test('group count badge is visible when expanded', async () => {
    // GroupHeader now renders CountBadge regardless of collapsed state.
    // This test covers the expanded state (the prior test only covers collapsed).
    const sidebar = page.locator('.bg-surface-raised').first();
    await createGroup(page, 'ExpandedBadgeGroup');

    // Move both projects into the group
    await sidebar.locator('.truncate.font-medium:text("Alpha")').click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=ExpandedBadgeGroup').click();
    await sidebar.locator('.truncate.font-medium:text("Beta")').click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=ExpandedBadgeGroup').click();

    // Group is expanded by default - projects are visible
    await expect(sidebar.locator('.truncate.font-medium:text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('.truncate.font-medium:text("Beta")')).toBeVisible();

    // Badge must be visible while expanded
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await expect(groupHeader.locator('.rounded-full').filter({ hasText: '2' })).toBeVisible();
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

test.describe('Sidebar Footer Actions', () => {
  test('footer caret menu stays inside the sidebar', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    const sidebarBox = await sidebar.boundingBox();
    if (!sidebarBox) throw new Error('Sidebar has no layout');

    await page.getByTestId('sidebar-footer-more-button').click();
    const menu = page.getByTestId('sidebar-footer-menu');
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    if (!menuBox) throw new Error('Footer menu has no layout');

    // Before the fix, the default auto alignment left-aligned the menu to the
    // caret (auto left-aligns any trigger in the viewport's left half, which
    // the sidebar caret always is), so the menu hung off the sidebar's right
    // edge and floated over the board. A couple of pixels of tolerance for
    // cross-platform sub-pixel rounding (cross-platform-parity.md); not an
    // exact-equality check.
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 2);
  });

  test('clicking Add project from the footer menu closes it', async () => {
    // Neutralize the add-project flow so it toasts-and-returns instead of
    // opening or creating a project. A real project open re-renders the
    // sidebar for reasons unrelated to the fix under test, which could close
    // the menu (or not) independent of the setMenuOpen(false) call this test
    // is pinning.
    await page.evaluate(() => {
      (window as unknown as { __mockProbePathOverrides: Record<string, unknown> })
        .__mockProbePathOverrides = { exists: false };
    });

    await page.getByTestId('sidebar-footer-more-button').click();
    const menu = page.getByTestId('sidebar-footer-menu');
    await expect(menu).toBeVisible();

    await page.getByTestId('sidebar-new-project-button').click();

    // The popover stays mounted through its exit animation (see clickNewGroup above).
    await menu.waitFor({ state: 'detached', timeout: 5000 });
  });
});

test.describe('GroupContextMenu - move up/down', () => {
  test('Move down reorders the group one position later', async () => {
    // Create two groups so we can move First down
    await clickNewGroup(page);
    const input = page.locator('input[placeholder="Group name"]');
    await input.fill('First');
    await input.press('Enter');
    await expect(input).toBeHidden();

    await clickNewGroup(page);
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
    await clickNewGroup(page);
    const input = page.locator('input[placeholder="Group name"]');
    await input.fill('GroupA');
    await input.press('Enter');
    await expect(input).toBeHidden();

    await clickNewGroup(page);
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

    // Right-click the only group - Move up should be disabled
    const groupHeader = page.locator('[data-testid^="project-group-"]');
    await groupHeader.click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');

    const moveUpButton = contextMenu.locator('button:has-text("Move up")');
    await expect(moveUpButton).toBeDisabled();
  });

  test('Move down is disabled when group is last', async () => {
    await createGroup(page, 'LoneGroup');

    // Right-click the only group - Move down should be disabled
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
