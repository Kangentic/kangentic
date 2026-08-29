/**
 * UI tests for: closing the `changes` pop-out leaves the inline Changes panel CLOSED.
 *
 * Detaching only suppresses the inline render (`showChanges` masks on
 * changesPopOut.isOpen), so the open flag used to survive and the panel reclaimed
 * the split the moment the window closed. By then the user has already reviewed
 * the files in the bigger window, so that reclaim is an extra step to undo.
 *
 * Pop-out windows are real OS windows and never open in this tier, so both the
 * detach and the close are driven through window.__mockFirePopOutChanged, which
 * fires the real popOut:changed push into App.tsx's subscription (not just the
 * pop-out store) so the renderer's own side effects run.
 *
 * Per-test browser rather than a shared page: the pop-out store is global, and
 * .claude/rules/cross-platform-parity.md bans cross-test state leakage.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-changes-popout';
const TASK_ID = 'task-changes-popout';
const SESSION_ID = 'sess-changes-popout';
const TASK_TITLE = 'Changes Popout Task';

/** popOutInstanceKey('changes', ...) is kind:projectId:taskId - project FIRST. */
const CHANGES_POPOUT_KEY = `changes:${PROJECT_ID}:${TASK_ID}`;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Changes Popout Test',
      path: '/mock/changes-popout-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> the dialog opens in
    // non-editing mode and TaskDetailHeader (with the Changes pill) renders.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/changes-popout-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: '${TASK_TITLE}',
      description: 'Task used for the Changes pop-out close test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/changes-popout',
      branch_name: 'feature/changes-popout',
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

async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Open the task detail from its board card and wait for the window. */
async function openTaskDetail(page: Page) {
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

/** Fire main's popOut:changed push with the given open-key set. */
async function firePopOutChanged(page: Page, keys: string[]): Promise<void> {
  await page.evaluate((openKeys) => {
    (window as unknown as { __mockFirePopOutChanged: (k: string[]) => void }).__mockFirePopOutChanged(openKeys);
  }, keys);
}

/**
 * The entity ids the session store currently marks as having an open Changes
 * panel. This is what separates a real clear from a second render mask: the
 * panel is suppressed either way while the window is detached.
 */
async function changesOpenEntityIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { changesOpenTasks: Set<string> } } };
    }).__zustandStores;
    return Array.from(stores?.session?.getState().changesOpenTasks ?? new Set<string>());
  });
}

test.describe('Changes pop-out close does not reclaim the inline panel', () => {
  test('closing the pop-out leaves the panel closed and the pill inactive', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskDetail(page);

      const changesPill = page.locator('[data-testid="changes-toggle"]');
      const changesPanel = page.locator('[data-testid="changes-expand"]');

      // Open Changes inline. On CI Linux the re-render after the pill click can
      // take several seconds, so give the state update a full budget.
      await changesPill.click();
      await expect(changesPanel).toBeVisible({ timeout: 10000 });
      expect(await changesOpenEntityIds(page)).toContain(TASK_ID);

      // Detach. The panel is suppressed, but the pill must keep reading active:
      // the pill is the only control that can close it, and a pill reading
      // "Show changes" over a detached window would be a lie.
      await firePopOutChanged(page, [CHANGES_POPOUT_KEY]);
      await expect(changesPanel).not.toBeVisible({ timeout: 10000 });
      await expect(changesPill).toHaveAttribute('title', /^Hide changes/);
      expect(await changesOpenEntityIds(page)).toContain(TASK_ID);

      // Close the pop-out: the panel must NOT come back.
      await firePopOutChanged(page, []);
      await expect(changesPill).toHaveAttribute('title', /^Show changes/, { timeout: 10000 });
      await expect(changesPanel).not.toBeVisible();
      expect(await changesOpenEntityIds(page)).not.toContain(TASK_ID);

      // The pill still works: one click re-opens the panel.
      await changesPill.click();
      await expect(changesPanel).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  /**
   * Nothing closes a task's pop-outs when its task-detail window closes, so a
   * changes pop-out outlives the window that spawned it. The clear has to happen
   * anyway, or reopening the task shows the panel again.
   */
  test('a pop-out that outlives its task-detail window still clears the flag', async () => {
    const { browser, page } = await launchWithState();
    try {
      const dialog = await openTaskDetail(page);
      const changesPill = page.locator('[data-testid="changes-toggle"]');
      const changesPanel = page.locator('[data-testid="changes-expand"]');

      await changesPill.click();
      await expect(changesPanel).toBeVisible({ timeout: 10000 });

      await firePopOutChanged(page, [CHANGES_POPOUT_KEY]);
      await expect(changesPanel).not.toBeVisible({ timeout: 10000 });

      // Close the task-detail window with the pop-out still open. Control+Shift+W
      // (capture phase) rather than Escape: the window has a running session, so
      // the bubble-phase Escape can be intercepted on CI Linux.
      await page.keyboard.press('Control+Shift+W');
      await expect(dialog).not.toBeVisible({ timeout: 8000 });

      // The pop-out closes with no task-detail window mounted to observe it.
      await firePopOutChanged(page, []);
      await expect.poll(() => changesOpenEntityIds(page), { timeout: 10000 }).not.toContain(TASK_ID);

      // Reopening the task shows the panel closed.
      await openTaskDetail(page);
      await expect(changesPill).toHaveAttribute('title', /^Show changes/, { timeout: 10000 });
      await expect(changesPanel).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  /**
   * A per-file diff window is ADDITIVE: it is opened FROM the inline panel, which
   * stays mounted behind it. Closing one must leave that panel exactly as it was.
   */
  test('closing a per-file "changes-file" pop-out leaves the inline panel open', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskDetail(page);
      const changesPill = page.locator('[data-testid="changes-toggle"]');
      const changesPanel = page.locator('[data-testid="changes-expand"]');

      await changesPill.click();
      await expect(changesPanel).toBeVisible({ timeout: 10000 });

      const fileKey = `changes-file:${PROJECT_ID}:${TASK_ID}:src/a b/c.ts`;
      await firePopOutChanged(page, [fileKey]);
      await firePopOutChanged(page, []);

      await expect(changesPanel).toBeVisible();
      await expect(changesPill).toHaveAttribute('title', /^Hide changes/);
      expect(await changesOpenEntityIds(page)).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });
});
