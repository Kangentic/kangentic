/**
 * UI tests for the one-step project Move flow (Project Settings > General).
 *
 * Covers the confirmation dialog (active-session list, computed destination),
 * the cross-volume progress card, and the success / error / warning toasts.
 * The folder picker returns the destination PARENT; the hook computes
 * `<parent>/<current folder name>` and calls relocate with `{ mode: 'move' }`.
 *
 * One shared page is launched for the whole file (the mock seeds a project with
 * a running session) to keep browser churn low; each test opens the Move dialog,
 * asserts, then closes it. Per-test relocate overrides never mutate the real
 * project path, so the shared state stays stable across tests.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-move-a';
const SESSION_ID = 'sess-move-a';
const TASK_ID = 'task-move-a';

/** One project with a single running agent session bound to a titled task. */
const MOVE_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Mover', path: '/mock/projects/Mover',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'lane-move-' + i, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 2001,
      status: 'running', shell: 'bash', cwd: '/mock/projects/Mover', startedAt: ts, exitCode: null,
    });
    state.activityCache['${SESSION_ID}'] = 'idle';
    state.tasks.push({
      id: '${TASK_ID}', title: 'Refactor the parser', description: '', swimlane_id: 'lane-move-1',
      position: 0, agent: null, session_id: '${SESSION_ID}', worktree_path: null, branch_name: null,
      pr_number: null, pr_url: null, base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(90_000); // cold Vite compile on the first navigation of the run
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(MOVE_PRECONFIG);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 30_000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 30_000 });

  // Open Project Settings > General once; tests reuse the open panel.
  await page.locator('.truncate.font-medium:text("Mover")').first().click({ button: 'right' });
  await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByTestId('project-location-move').waitFor({ state: 'visible', timeout: 5000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  // Default relocate stub: captures args, returns the project unchanged (no
  // real path mutation, so the shared page's state is stable across tests).
  await page.evaluate(() => {
    const api = window.electronAPI.projects as unknown as {
      relocate: (id: string, newPath: string, options?: { mode?: string }) => Promise<unknown>;
    };
    (window as Record<string, unknown>).__lastRelocate = null;
    (window as Record<string, number>).__relocateCalls = 0;
    api.relocate = async function (id: string, newPath: string, options?: { mode?: string }) {
      (window as Record<string, number>).__relocateCalls += 1;
      (window as Record<string, unknown>).__lastRelocate = { id, newPath, mode: options?.mode };
      return { project: { id, name: 'Mover', path: '/mock/projects/Mover' }, warnings: [] };
    };
  });
});

test.afterEach(async () => {
  // Close the dialog or progress card if a test left one open.
  const heading = page.getByRole('heading', { name: 'Move Project Folder' });
  if (await heading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(heading).toBeHidden();
  }
});

/** Set the folder-picker result (destination parent) and open the Move dialog. */
async function openMoveDialog(parentPath: string): Promise<void> {
  await page.evaluate((parent) => {
    (window as Record<string, unknown>).__mockFolderPath = parent;
  }, parentPath);
  await page.getByTestId('project-location-move').click();
  await expect(page.getByRole('heading', { name: 'Move Project Folder' })).toBeVisible();
}

test.describe('Project Move', () => {
  test('lists the active session by task title and computes the destination', async () => {
    await openMoveDialog('/mock/new-home');
    await expect(page.locator('p', { hasText: 'To:' })).toContainText('/mock/new-home/Mover');
    await expect(page.getByTestId('project-move-active-sessions')).toContainText('Refactor the parser');
  });

  test('cancel aborts without calling relocate', async () => {
    await openMoveDialog('/mock/new-home');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Move Project Folder' })).toBeHidden();
    const calls = await page.evaluate(() => (window as Record<string, number>).__relocateCalls);
    expect(calls).toBe(0);
  });

  test('confirm calls relocate with move mode and the computed path', async () => {
    await openMoveDialog('/mock/new-home');
    await page.getByRole('button', { name: 'Move Folder', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Move Project Folder' })).toBeHidden();
    const captured = await page.evaluate(() => (window as Record<string, { newPath: string; mode: string }>).__lastRelocate);
    expect(captured.newPath).toBe('/mock/new-home/Mover');
    expect(captured.mode).toBe('move');
  });

  test('shows the progress card during a move then hides it', async () => {
    await page.evaluate(() => {
      const api = window.electronAPI.projects as unknown as {
        relocate: (id: string, newPath: string) => Promise<unknown>;
      };
      api.relocate = function (id: string) {
        return new Promise((resolve) => {
          (window as Record<string, unknown>).__finishMove = () =>
            resolve({ project: { id, name: 'Mover', path: '/mock/projects/Mover' }, warnings: [] });
        });
      };
    });
    await openMoveDialog('/mock/new-home');
    await page.getByRole('button', { name: 'Move Folder', exact: true }).click();

    await expect(page.getByTestId('project-move-progress')).toBeVisible();
    await page.evaluate((projectId) => {
      (window as Record<string, (p: unknown) => void>).__mockFireProjectMoveProgress({
        projectId, phase: 'copying', copiedEntries: 3, totalEntries: 10,
      });
    }, PROJECT_ID);
    await expect(page.getByTestId('project-move-progress')).toContainText('Copying');
    await expect(page.getByTestId('project-move-progress')).toContainText('10');

    await page.evaluate(() => (window as Record<string, () => void>).__finishMove());
    await expect(page.getByTestId('project-move-progress')).toBeHidden();
  });

  test('a move failure surfaces an error toast and hides the progress card', async () => {
    // The finally block in useProjectRelocation must unsubscribe from progress
    // and set isMoving=false even on error, so the progress card never lingers.
    await page.evaluate(() => {
      const api = window.electronAPI.projects as unknown as {
        relocate: (id: string, newPath: string) => Promise<unknown>;
      };
      api.relocate = async function () {
        throw new Error('Destination already exists: /mock/new-home/Mover');
      };
    });
    await openMoveDialog('/mock/new-home');
    await page.getByRole('button', { name: 'Move Folder', exact: true }).click();
    await expect(page.getByText('Destination already exists: /mock/new-home/Mover')).toBeVisible();
    // Progress card must be hidden because isMoving reverts to false in finally.
    await expect(page.getByTestId('project-move-progress')).toBeHidden();
  });

  test('a source-delete-failed warning surfaces a warning toast', async () => {
    await page.evaluate(() => {
      const api = window.electronAPI.projects as unknown as {
        relocate: (id: string, newPath: string) => Promise<unknown>;
      };
      api.relocate = async function (id: string) {
        return { project: { id, name: 'Mover', path: '/mock/projects/Mover' }, warnings: ['source-delete-failed'] };
      };
    });
    await openMoveDialog('/mock/new-home');
    await page.getByRole('button', { name: 'Move Folder', exact: true }).click();
    await expect(page.getByText('the original copy remains at /mock/projects/Mover')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Second describe: project with NO running/queued sessions.
// This requires a separate page with different seed data, so it gets its own
// browser context and beforeAll/afterAll rather than sharing the first page.
// ---------------------------------------------------------------------------

const NO_SESSION_PROJECT_ID = 'proj-move-b';

/** One project with no sessions at all. */
const NO_SESSION_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${NO_SESSION_PROJECT_ID}', name: 'Quiet', path: '/mock/projects/Quiet',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'lane-quiet-' + i, position: i, created_at: ts }));
    });
    return { currentProjectId: '${NO_SESSION_PROJECT_ID}' };
  });
`;

let noSessionBrowser: import('@playwright/test').Browser;
let noSessionPage: import('@playwright/test').Page;

test.describe('Project Move - no active sessions', () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    await waitForViteReady(VITE_URL);
    noSessionBrowser = await chromium.launch({ headless: true });
    const noSessionContext = await noSessionBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    noSessionPage = await noSessionContext.newPage();
    await noSessionPage.addInitScript({ path: MOCK_SCRIPT });
    await noSessionPage.addInitScript(NO_SESSION_PRECONFIG);
    await noSessionPage.goto(VITE_URL);
    await noSessionPage.waitForLoadState('load');
    await noSessionPage.waitForSelector('text=Kangentic', { timeout: 30_000 });
    await noSessionPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Open Project Settings > General.
    await noSessionPage.locator('.truncate.font-medium:text("Quiet")').first().click({ button: 'right' });
    await noSessionPage.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
    await noSessionPage.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
    await noSessionPage.getByRole('button', { name: 'General', exact: true }).click();
    await noSessionPage.getByTestId('project-location-move').waitFor({ state: 'visible', timeout: 5000 });
  });

  test.afterAll(async () => {
    await noSessionBrowser?.close();
  });

  test('dialog shows "No active agent sessions." and omits the active-sessions list', async () => {
    await noSessionPage.evaluate((parent) => {
      (window as Record<string, unknown>).__mockFolderPath = parent;
    }, '/mock/new-home');
    await noSessionPage.getByTestId('project-location-move').click();
    await expect(noSessionPage.getByRole('heading', { name: 'Move Project Folder' })).toBeVisible();

    // The "No active agent sessions." paragraph must be present.
    await expect(noSessionPage.locator('p.text-xs.text-fg-muted', { hasText: 'No active agent sessions.' })).toBeVisible();
    // The active-sessions list must NOT be rendered.
    await expect(noSessionPage.getByTestId('project-move-active-sessions')).toBeHidden();

    // Cleanup: close the dialog.
    await noSessionPage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(noSessionPage.getByRole('heading', { name: 'Move Project Folder' })).toBeHidden();
  });
});
