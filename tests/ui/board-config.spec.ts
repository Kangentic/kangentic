import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

test.describe('Ghost Columns', () => {
  test('ghost column renders with dimmed style and tooltip', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'ghost-test');
    await waitForBoard(page);

    // Add a ghost column to the mock swimlanes after project setup, then reload board
    await page.evaluate(() => {
      const api = (window as any).electronAPI;
      const stores = (window as any).__zustandStores;
      // Use the swimlanes.create mock to add a ghost lane
      api.swimlanes.create({
        name: 'Deprecated Review',
        color: '#888888',
        is_ghost: true,
        auto_spawn: false,
      }).then(() => {
        stores.board.getState().loadBoard();
      });
    });

    const ghostColumn = page.locator('[data-swimlane-name="Deprecated Review"]');
    await expect(ghostColumn).toBeVisible();

    // Verify dimmed styling (opacity-50 class)
    await expect(ghostColumn).toHaveClass(/opacity-50/);

    // Verify dashed border
    await expect(ghostColumn).toHaveClass(/border-dashed/);

    // Verify tooltip
    await expect(ghostColumn).toHaveAccessibleDescription('Removed from team config. Move tasks to continue.');

    // "Add task" button should not exist inside ghost column
    const addButton = ghostColumn.locator('text=Add task');
    await expect(addButton).toHaveCount(0);

    // "Removed from team config" text should be present
    const removedText = ghostColumn.locator('text=Removed from team config');
    await expect(removedText).toBeVisible();

    await browser.close();
  });
});

test.describe('Config Warning Banner', () => {
  test('warning banner shows and can be dismissed', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'warning-test');
    await waitForBoard(page);

    // Inject config warnings into the board store
    await page.evaluate(() => {
      const stores = (window as any).__zustandStores;
      if (stores?.board) {
        stores.board.getState().setConfigWarnings([
          'kangentic.json has a syntax error. Board loaded from local database.',
        ]);
      }
    });

    // Banner should appear with the warning text
    const banner = page.locator('text=kangentic.json has a syntax error');
    await expect(banner).toBeVisible();

    // Click dismiss button
    const dismissButton = page.locator('button[aria-label="Dismiss warning"]');
    await dismissButton.click();

    // Banner should be gone
    await expect(banner).not.toBeVisible();

    await browser.close();
  });

  // Trimmed (test-suite audit): "shows the stored open-time warnings when a
  // project becomes current" is the first half of board-config-save-refusals.spec.ts
  // 'switching projects clears the outgoing banner', which seeds the stored
  // warning, opens a project and waits for the banner.
});
