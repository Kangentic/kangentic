/**
 * UI tests for the global `diffViewMode` config preference.
 *
 * Intent: `diffViewMode` is a single global config key (default `'split'`).
 * Two entry points read and write it:
 *   1. The in-diff toggle buttons (`data-testid="diff-view-split"` /
 *      `data-testid="diff-view-inline"`) inside DiffViewer.
 *   2. The "Diff View" select in the Layout settings tab.
 *
 * Both read from `useConfigStore(state => state.config.diffViewMode)` and write
 * via `updateConfig({ diffViewMode: ... })`. The mock's `config.set(partial)`
 * does a deep-merge, so `config.get()` after a write reflects the update.
 *
 * Tests:
 *   1. In-diff toggle persists across panel reopen (the "stick" behavior).
 *      - Default is split (split button has `bg-surface-raised`).
 *      - Click inline: assert inline becomes active, config reflects the write.
 *      - Close the Changes panel, reopen it: inline is still active (read path).
 *
 *   2. Layout settings tab reflects and drives the same global value.
 *      - After test 1 left the preference as `inline`, open Settings > Layout.
 *      - Assert the "Diff View" select shows `inline`.
 *      - Change it back to `split` via selectOption; assert config reflects the write.
 *
 * Setup mirrors task-detail-changes-diffviewer-toolbar.spec.ts: seeds a project
 * + running session + task in "Code Review", sets `window.__mockGitDiff` so
 * ChangesPanel auto-selects a file and DiffViewer mounts. Unique IDs avoid
 * collision with the toolbar spec.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-diffviewmode-pref';
const TASK_ID = 'task-diffviewmode-pref';
const SESSION_ID = 'sess-diffviewmode-pref';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'DiffViewMode Preference Test',
      path: '/mock/diffviewmode-pref-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-dvm-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/diffviewmode-pref-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'DiffViewMode Preference Task',
      description: 'Task used to test the global diffViewMode preference',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diffviewmode-pref',
      branch_name: 'feature/diffviewmode-pref',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  // Clear the git diff mock so it does not bleed into other specs.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
  await browser?.close();
});

/**
 * Open the task-detail dialog for the seeded task and click the Changes pill.
 * Waits for the DiffViewer toolbar toggle buttons to be visible, confirming
 * that ChangesPanel has auto-selected the file and DiffViewer is mounted.
 */
async function openChangesPanel(): Promise<void> {
  // Seed git.diffFiles for this invocation. The mock hook is cleared after
  // each panel open in the cleanup steps below, so we re-seed here.
  await page.evaluate(() => {
    (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
      files: [
        {
          path: 'src/renderer/components/Foo.tsx',
          status: 'M',
          insertions: 3,
          deletions: 1,
          binary: false,
          original: 'const x = 1;\n',
          modified: 'const x = 2;\n',
          language: 'typescript',
        },
      ],
    };
  });

  const card = page
    .locator('[data-swimlane-name="Code Review"]')
    .locator('text=DiffViewMode Preference Task')
    .first();
  await card.click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const changesPill = page.locator('[data-testid="changes-toggle"]');
  await expect(changesPill).toBeVisible();
  await changesPill.click();

  // Wait for both toggle buttons: they render synchronously before Monaco
  // initializes, so their presence confirms DiffViewer is mounted.
  await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible();
}

/**
 * Close the Changes panel and then the task-detail dialog, returning the app
 * to the board view so the next test can start from a clean known state.
 */
async function closeDialogAndPanel(): Promise<void> {
  // Close Changes panel via the pill toggle.
  const changesPill = page.locator('[data-testid="changes-toggle"]');
  if (await changesPill.isVisible().catch(() => false)) {
    await changesPill.click();
  }

  // Close task-detail dialog. The dialog may contain an xterm panel, so use
  // document.dispatchEvent to bypass xterm's Escape capture (anti-pattern 10).
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'hidden', timeout: 3000 });

  // Clear the git diff mock so it does not leak between tests.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
}

test.describe('diffViewMode: in-diff toggle persists across panel reopen', () => {
  test('default is split; switching to inline persists after panel reopen', async () => {
    await openChangesPanel();

    // Confirm the default: split button is active (has bg-surface-raised),
    // inline button is inactive.
    await expect(page.locator('[data-testid="diff-view-split"]')).toHaveClass(/bg-surface-raised/, { timeout: 3000 });
    await expect(page.locator('[data-testid="diff-view-inline"]')).not.toHaveClass(/bg-surface-raised/);

    // Click the inline toggle.
    await page.locator('[data-testid="diff-view-inline"]').click();

    // Assert inline becomes active and split becomes inactive.
    await expect(page.locator('[data-testid="diff-view-inline"]')).toHaveClass(/bg-surface-raised/, { timeout: 3000 });
    await expect(page.locator('[data-testid="diff-view-split"]')).not.toHaveClass(/bg-surface-raised/);

    // Assert the write path: config.get() must reflect the change.
    await expect
      .poll(
        async () => {
          const cfg = await page.evaluate(() =>
            (window as unknown as { electronAPI: { config: { get: () => Promise<Record<string, unknown>> } } })
              .electronAPI.config.get(),
          );
          return cfg['diffViewMode'];
        },
        { timeout: 3000 },
      )
      .toBe('inline');

    // Close the Changes panel by clicking the pill again.
    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await changesPill.click();
    // DiffViewer unmounts when the panel closes.
    await expect(page.locator('[data-testid="diff-view-split"]')).not.toBeVisible({ timeout: 3000 });

    // Re-seed the git diff mock and reopen the panel. DiffViewer must mount
    // with the persisted inline preference (the read path).
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = {
        files: [
          {
            path: 'src/renderer/components/Foo.tsx',
            status: 'M',
            insertions: 3,
            deletions: 1,
            binary: false,
            original: 'const x = 1;\n',
            modified: 'const x = 2;\n',
            language: 'typescript',
          },
        ],
      };
    });
    await changesPill.click();
    await expect(page.locator('[data-testid="diff-view-inline"]')).toBeVisible({ timeout: 8000 });

    // Inline must still be active after reopen (the "stick" behavior).
    await expect(page.locator('[data-testid="diff-view-inline"]')).toHaveClass(/bg-surface-raised/, { timeout: 3000 });
    await expect(page.locator('[data-testid="diff-view-split"]')).not.toHaveClass(/bg-surface-raised/);

    await closeDialogAndPanel();
  });
});

test.describe('diffViewMode: Layout settings tab reflects and drives the same value', () => {
  test('Layout tab Diff View select shows current value and can update config', async () => {
    // This test relies on the previous test leaving diffViewMode as 'inline'
    // in the mock config. We verify the select reflects that, then change it
    // back to 'split' so later tests (and the toolbar spec) start from the default.

    // Open Settings panel.
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    // Navigate to the Layout tab.
    await page.getByRole('button', { name: 'Layout' }).click();

    // The "Diff View" row must be visible.
    await expect(page.getByText('Diff View')).toBeVisible({ timeout: 3000 });

    // Find the select for the "Diff View" setting row. SettingRow renders:
    //   div.space-y-1.5 (wrapper)
    //     div (label block)
    //       div.text-sm (label text)
    //       div.flex (description row)
    //         div.text-xs (description text)  <-- we match this
    //     div.relative (Select wrapper)
    //       select                             <-- we want this
    //
    // Walk up 3 levels from the description div to reach wrapper, then
    // find the select anywhere inside the wrapper.
    const diffViewDescription = page.getByText('Default layout for viewing file diffs');
    const diffViewRow = diffViewDescription.locator('..').locator('..').locator('..');
    const diffViewSelect = diffViewRow.locator('select');

    // Assert the select reflects the 'inline' value set by the previous test.
    await expect(diffViewSelect).toHaveValue('inline', { timeout: 3000 });

    // Change the select back to 'split'.
    await diffViewSelect.selectOption('split');

    // Assert the write path: config.get() must reflect 'split'.
    await expect
      .poll(
        async () => {
          const cfg = await page.evaluate(() =>
            (window as unknown as { electronAPI: { config: { get: () => Promise<Record<string, unknown>> } } })
              .electronAPI.config.get(),
          );
          return cfg['diffViewMode'];
        },
        { timeout: 3000 },
      )
      .toBe('split');

    // Close the settings panel via Escape.
    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
  });
});
