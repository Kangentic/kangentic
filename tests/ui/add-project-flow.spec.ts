import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, waitForBoard, createProject, dismissOnboardingChecklist } from './helpers';

/**
 * Coverage for useAddProject's branches (src/renderer/hooks/useAddProject.ts): the
 * folder-pick -> probePath -> ensureGit -> openProjectByPath pipeline shared by the welcome
 * screen's "Open a project" button and the sidebar's "+" button.
 *
 * Each test launches its own page (launchPage) so the probePath/ensureGit test hooks
 * (window.__mockProbePathOverrides, window.__mockEnsureGitResult, window.__mockFolderPath)
 * never leak across tests (mirrors onboarding-welcome-screen.spec.ts's launchWithOverrides).
 */
test.describe.configure({ mode: 'parallel' });

test.describe('Add project flow', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('reopens the existing project instead of creating a new one when probePath reports it already registered', async () => {
    ({ browser, page } = await launchPage());
    await createProject(page, 'add-project-existing-a');
    const firstProjectIdOrNull = await page.evaluate(async () => {
      const current = await window.electronAPI.projects.getCurrent();
      return current?.id ?? null;
    });
    expect(firstProjectIdOrNull).not.toBeNull();
    const firstProjectId = firstProjectIdOrNull as string;

    // A second project, so "no new project created" is checking a real count rather than
    // 0 -> 1 either way.
    await createProject(page, 'add-project-existing-b');
    const countBeforeReopen = (await page.evaluate(() => window.electronAPI.projects.list())).length;
    expect(countBeforeReopen).toBe(2);

    // The path picked this time need not match the first project's stored path exactly (a
    // symlink, a re-canonicalized path) - probePath is the one source of truth for "this is
    // already a registered project".
    await page.evaluate((existingId: string) => {
      (window as unknown as { __mockProbePathOverrides: Record<string, unknown> }).__mockProbePathOverrides = {
        alreadyRegisteredProjectId: existingId,
      };
      (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/add-project-existing-a-reselected';
    }, firstProjectId);

    await page.locator('[data-testid="sidebar-new-project-button"]').click();

    await expect.poll(async () => {
      const current = await page.evaluate(() => window.electronAPI.projects.getCurrent());
      return current?.id ?? null;
    }, { timeout: 5000 }).toBe(firstProjectId);

    const countAfterReopen = (await page.evaluate(() => window.electronAPI.projects.list())).length;
    expect(countAfterReopen).toBe(2);
  });

  test('shows an error toast and creates nothing when the folder cannot be opened', async () => {
    ({ browser, page } = await launchPage());
    await expect(page.locator('[data-testid="welcome-open-project"]')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __mockProbePathOverrides: Record<string, unknown> }).__mockProbePathOverrides = {
        exists: false,
      };
      (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/add-project-moved-away';
    });

    await page.locator('[data-testid="welcome-open-project"]').click();

    const errorToast = page.locator('[data-testid="toast"]')
      .filter({ hasText: 'That folder could not be opened. It may have been moved or renamed.' });
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toHaveClass(/border-red-500/);

    const projectCount = (await page.evaluate(() => window.electronAPI.projects.list())).length;
    expect(projectCount).toBe(0);
    await expect(page.locator('[data-testid="welcome-open-project"]')).toBeVisible();
  });

  test('opens the project anyway and shows a warning toast when git setup fails', async () => {
    ({ browser, page } = await launchPage());

    await page.evaluate(() => {
      (window as unknown as { __mockEnsureGitResult: Record<string, unknown> }).__mockEnsureGitResult = {
        ok: false,
        created: false,
        error: 'git not found',
      };
      (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/add-project-git-fail';
    });

    await page.locator('[data-testid="welcome-open-project"]').click();
    // Failing to set up git must never block the open - the board must still load.
    await waitForBoard(page);

    const warningToast = page.locator('[data-testid="toast"]').filter({
      hasText: 'Could not set up git here. Tasks will share one working tree, and Kangentic cannot keep its own files out of your commits.',
    });
    await expect(warningToast).toBeVisible({ timeout: 5000 });
    await expect(warningToast).toHaveClass(/border-yellow-500/);

    const projectCount = (await page.evaluate(() => window.electronAPI.projects.list())).length;
    expect(projectCount).toBe(1);

    await dismissOnboardingChecklist(page);
  });

  test('opens the project and shows an info toast when a git repo is freshly created', async () => {
    ({ browser, page } = await launchPage());

    await page.evaluate(() => {
      (window as unknown as { __mockEnsureGitResult: Record<string, unknown> }).__mockEnsureGitResult = {
        ok: true,
        created: true,
        error: null,
      };
      (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/add-project-git-created';
    });

    await page.locator('[data-testid="welcome-open-project"]').click();
    await waitForBoard(page);

    const infoToast = page.locator('[data-testid="toast"]').filter({
      hasText: 'Started a git repo in this folder. Make a first commit to give each task its own worktree; until then they share this one.',
    });
    await expect(infoToast).toBeVisible({ timeout: 5000 });
    await expect(infoToast).toHaveClass(/border-accent/);

    await dismissOnboardingChecklist(page);
  });

  test("names the new project from probePath's suggestedName, not the folder's own basename", async () => {
    ({ browser, page } = await launchPage());

    await page.evaluate(() => {
      (window as unknown as { __mockProbePathOverrides: Record<string, unknown> }).__mockProbePathOverrides = {
        suggestedName: 'Custom Name',
      };
      (window as unknown as { __mockFolderPath: string }).__mockFolderPath = '/mock/projects/add-project-suggested-name';
    });

    await page.locator('[data-testid="welcome-open-project"]').click();
    await waitForBoard(page);

    const current = await page.evaluate(() => window.electronAPI.projects.getCurrent());
    expect(current?.name).toBe('Custom Name');
    await expect(page.locator('[role="button"]').filter({ hasText: 'Custom Name' })).toBeVisible();
    await expect(page.locator('[role="button"]').filter({ hasText: 'add-project-suggested-name' })).toHaveCount(0);

    await dismissOnboardingChecklist(page);
  });
});
