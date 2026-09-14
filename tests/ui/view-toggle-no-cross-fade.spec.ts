import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Page } from '@playwright/test';

// Each test launches and tears down its own page (see launchPage below), so the
// file's tests fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

/**
 * Stamp the element currently at `testId` with a marker attribute React does
 * not manage. If the view swap reconciles the SAME DOM node into the other
 * view's button (the bug this spec guards against), the stamp survives onto
 * the node now rendered under the OTHER testid. If the swap unmounts the old
 * node and mounts a fresh one (the fix), the stamp is gone.
 *
 * This is deliberately not a `getAnimations()` / transition-timing check:
 * a transition that has already finished also reports no running
 * animations, so a timing-based assertion has a vacuous-pass mode that node
 * identity does not.
 */
async function stamp(page: Page, testId: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).evaluate((element) => {
    (element as HTMLElement).dataset.identityProbe = '1';
  });
}

async function expectFreshNode(page: Page, testId: string): Promise<void> {
  const probe = await page
    .locator(`[data-testid="${testId}"]`)
    .getAttribute('data-identity-probe');
  expect(probe).toBeNull();
}

test.describe('View toggle: no cross-fade across Board/Backlog switch', () => {
  test('actions slot: switching Board -> Backlog mounts a fresh New Task button', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, `view-toggle-actions-b2k-${Date.now()}`);

    await stamp(page, 'add-column-button');
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').waitFor({ state: 'visible' });

    await expectFreshNode(page, 'new-backlog-task-btn');
    await browser.close();
  });

  test('actions slot: switching Backlog -> Board mounts a fresh Add column button', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, `view-toggle-actions-k2b-${Date.now()}`);

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').waitFor({ state: 'visible' });

    await stamp(page, 'new-backlog-task-btn');
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('[data-testid="add-column-button"]').waitFor({ state: 'visible' });

    await expectFreshNode(page, 'add-column-button');
    await browser.close();
  });

  test('filter slot: switching Board -> Backlog mounts a fresh Filter button', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, `view-toggle-filter-b2k-${Date.now()}`);

    await stamp(page, 'board-filter-btn');
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="backlog-filter-btn"]').waitFor({ state: 'visible' });

    await expectFreshNode(page, 'backlog-filter-btn');
    await browser.close();
  });
});
