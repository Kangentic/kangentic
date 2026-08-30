/**
 * UI test for KebabMenu's capture-phase Escape guard, exercised through its
 * original, highest-traffic call site: TaskDetailHeader's "Actions" menu.
 *
 * KebabMenu.tsx intercepts Escape at the capture phase (preventDefault +
 * stopImmediatePropagation) while it is open, precisely so the host window's
 * own bubble-phase Escape-to-close listener (TaskDetailWindow.tsx) never sees
 * the keystroke - without the guard, the first Escape meant to dismiss the
 * menu would ALSO close the whole task-detail window underneath it.
 *
 * The existing coverage of this guard
 * (tests/ui/task-detail-changes-diffviewer-toolbar.spec.ts) exercises it
 * through DiffViewOptionsMenu, whose children are flat KebabMenuCheckItem /
 * KebabMenuItem rows with no keyboard handling of their own. This is NOT the
 * same propagation situation as TaskDetailHeader's "Actions" kebab: for a
 * running session it also nests a "Commands" flyout (CommandSearchList,
 * TaskDetailHeader.tsx) that installs its OWN `onKeyDown` Escape handler to
 * close just the flyout. Do not delete this test as "duplicate coverage of
 * the same shared component" - it is the only test that opens the ONE
 * KebabMenu consumer that can have a second, nested Escape handler in play
 * between the guard and the document listener it exists to beat.
 *
 * Tier: UI (headless Chromium). Pure renderer state; no PTY and no real IPC.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-kebab-escape-${RUN_ID}`;
const TASK_ID = `task-kebab-escape-${RUN_ID}`;
const SESSION_ID = `sess-kebab-escape-${RUN_ID}`;
const TASK_TITLE = `Kebab Escape Task ${RUN_ID}`;

test('Escape over the open Actions menu closes only the menu, not the task window', async () => {
  await waitForViteReady(VITE_URL);
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page: Page = await context.newPage();

  try {
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'Kebab Escape Test ${RUN_ID}',
          path: '/mock/kebab-escape-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var executingLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-ke-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
          if (template.name === 'Executing') executingLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId,
            position: index,
            created_at: ts,
          }));
        });

        state.sessions.push({
          id: '${SESSION_ID}',
          taskId: '${TASK_ID}',
          projectId: '${PROJECT_ID}',
          pid: 9999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/kebab-escape-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        });
        state.activityCache['${SESSION_ID}'] = 'idle';

        state.tasks.push({
          id: '${TASK_ID}',
          title: ${JSON.stringify(TASK_TITLE)},
          description: 'Tests the KebabMenu Escape guard on TaskDetailHeader',
          swimlane_id: executingLaneId,
          position: 0,
          agent: 'claude',
          session_id: '${SESSION_ID}',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          labels: [],
          priority: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });

        return { currentProjectId: '${PROJECT_ID}' };
      });
    `);

    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });

    // The kebab popover portals to document.body, so its items are located on
    // the page, not inside the window frame.
    await dialog.locator('button[title="Actions"]').click();
    const menuItem = page.locator('[data-testid="view-conversation-btn"]');
    await expect(menuItem).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(menuItem).not.toBeVisible({ timeout: 5000 });
    // Fixed budget, not a poll (anti-pattern 6: a negative assertion cannot be
    // polled for). A leaked Escape closes the dialog through its own ~150ms
    // CSS exit animation (--overlay-exit-duration), so checking visibility
    // immediately would pass even with the guard broken - the dialog is still
    // mid-animation and technically "visible" at that instant. Give the
    // animation a generous window to finish, then assert it is still there.
    await page.waitForTimeout(400);
    await expect(dialog).toBeVisible();

    // Cleanup via the capture-phase hotkey rather than a second Escape:
    // task-detail-maximize.spec.ts documents a CI-Linux-only focus quirk
    // where a bare Escape can land on an intermediate element and never
    // reach the window's bubble-phase listener, leaving the dialog open.
    // Control+Shift+W is capture-phase and unaffected.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  } finally {
    await browser.close();
  }
});
