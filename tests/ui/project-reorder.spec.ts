import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Project Reorder', () => {
  test('new project appears at top of sidebar (position 0)', async () => {
    await createProject(page, 'Alpha');
    await createProject(page, 'Beta');
    await createProject(page, 'Gamma');

    // Gamma was created last, should be at the top (position 0)
    const projectButtons = page.locator('[role="button"]:has(.truncate.font-medium)');
    const names = await projectButtons.locator('.truncate.font-medium').allTextContents();

    expect(names[0]).toBe('Gamma');
    expect(names[1]).toBe('Beta');
    expect(names[2]).toBe('Alpha');
  });

  test('order persists after re-fetch via loadProjects', async () => {
    // Force a fresh load from the mock backend
    await page.evaluate(async () => {
      const store = (window as any).__zustandStores?.project;
      if (store) {
        await store.getState().loadProjects();
      } else {
        // Fallback: call the API directly and check order
        const projects = await window.electronAPI.projects.list();
        // Verify they come back sorted by position
        for (let i = 1; i < projects.length; i++) {
          if (projects[i].position < projects[i - 1].position) {
            throw new Error('Projects not sorted by position');
          }
        }
      }
    });

    // Verify sidebar order is still correct
    const projectButtons = page.locator('[role="button"]:has(.truncate.font-medium)');
    const names = await projectButtons.locator('.truncate.font-medium').allTextContents();

    expect(names[0]).toBe('Gamma');
    expect(names[1]).toBe('Beta');
    expect(names[2]).toBe('Alpha');
  });

  test('reorder API updates position values', async () => {
    // Call reorder directly to reverse the order: Alpha, Beta, Gamma
    const positions = await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      const reversed = [...projects].reverse();
      await window.electronAPI.projects.reorder(reversed.map((p: any) => p.id));
      const updated = await window.electronAPI.projects.list();
      return updated.map((p: any) => ({ name: p.name, position: p.position }));
    });

    expect(positions[0].name).toBe('Alpha');
    expect(positions[0].position).toBe(0);
    expect(positions[1].name).toBe('Beta');
    expect(positions[1].position).toBe(1);
    expect(positions[2].name).toBe('Gamma');
    expect(positions[2].position).toBe(2);
  });

  test('drag project down reorders sidebar', async () => {
    // Current order after previous test: Alpha, Beta, Gamma
    // Drag Alpha (top) down past Beta to get: Beta, Alpha, Gamma
    const projectItems = page.locator('[role="button"]:has(.truncate.font-medium)');
    const firstItem = projectItems.nth(0);
    const secondItem = projectItems.nth(1);

    const firstBox = await firstItem.boundingBox();
    const secondBox = await secondItem.boundingBox();
    if (!firstBox || !secondBox) throw new Error('Could not get bounding boxes');

    const startX = firstBox.x + firstBox.width / 2;
    const startY = firstBox.y + firstBox.height / 2;
    // Drop at the bottom edge of the second item -- just enough to swap
    // positions 0 and 1 without overshooting into position 2
    const endX = secondBox.x + secondBox.width / 2;
    const endY = secondBox.y + secondBox.height * 0.75;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // Move enough to activate PointerSensor (distance >= 5)
    await page.mouse.move(startX, startY + 10, { steps: 3 });
    await page.waitForTimeout(100);

    // Move to target position in small steps
    await page.mouse.move(endX, endY, { steps: 15 });
    await page.waitForTimeout(300);

    await page.mouse.up();
    await page.waitForTimeout(500);

    // After drag, verify order changed -- Alpha should no longer be first
    const names = await projectItems.locator('.truncate.font-medium').allTextContents();
    expect(names[0]).not.toBe('Alpha');
    // Alpha should have moved down at least one position
    const alphaIndex = names.indexOf('Alpha');
    expect(alphaIndex).toBeGreaterThan(0);
  });

  test('drag reorder persists to backend', async () => {
    // Verify the backend positions match the current sidebar order
    const sidebar = page.locator('.bg-surface-raised').first();
    const sidebarNames = await sidebar
      .locator('[role="button"] .truncate.font-medium')
      .allTextContents();

    const backendNames = await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      return projects.map((p: any) => p.name);
    });

    // Backend order should match sidebar order
    expect(backendNames).toEqual(sidebarNames);
  });
});
