/**
 * A start that never reached an agent says so on its card, in a warning tone in
 * place of "Paused", with the reason in the hover tip. A plain pause reads as a
 * choice, so three tasks that never ran looked like tasks with no terminal.
 *
 * UI-tier: what only a browser proves is the visible footer and its tip. Where the
 * reason comes from is pinned in `session-queue-folder-recheck.test.ts` and
 * `session-idle-timeout.test.ts`.
 *
 * Red-green: drop the `startBlockedReason` pass in `PendingFooter` and every
 * reason reads "Paused".
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-start-blocked';

const ROWS = [
  { taskId: 'task-worktree', status: 'suspended', reason: 'worktree-missing', exitCode: null },
  { taskId: 'task-folder', status: 'suspended', reason: 'folder-missing', exitCode: null },
  { taskId: 'task-never', status: 'suspended', reason: 'never-started', exitCode: null },
  { taskId: 'task-spawn', status: 'exited', reason: 'spawn-failed', exitCode: -1 },
  { taskId: 'task-paused', status: 'suspended', reason: undefined, exitCode: null },
];

const preConfig = (cardDensity: string) => `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    Object.assign(state.config, { cardDensity: '${cardDensity}' });
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Start Blocked', path: '/mock/start-blocked', github_url: null,
      default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var planningId = null;
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var laneId = 'lane-sb-' + index;
      if (swimlane.name === 'Planning') planningId = laneId;
      state.swimlanes.push(Object.assign({}, swimlane, { id: laneId, position: index, created_at: timestamp }));
    });
    ${JSON.stringify(ROWS)}.forEach(function (row, index) {
      state.tasks.push({
        id: row.taskId, display_id: 1000 + index, title: 'Card ' + row.taskId, description: 'A task', swimlane_id: planningId,
        position: index, agent: 'claude', session_id: null, worktree_path: null, branch_name: null, pr_number: null,
        pr_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0, attachment_count: 0, archived_at: null,
        created_at: timestamp, updated_at: timestamp,
      });
      state.sessions.push({
        id: 'session-' + row.taskId, taskId: row.taskId, projectId: '${PROJECT_ID}', pid: null, status: row.status, shell: 'bash',
        cwd: '/mock/start-blocked', startedAt: timestamp, exitCode: row.exitCode, resuming: false, agentSessionId: null,
        startBlockedReason: row.reason,
      });
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launch(cardDensity = 'default'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(cardDensity));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

function footerOf(page: Page, taskId: string) {
  return page.locator(`[data-task-id="${taskId}"]`).locator('[data-testid="status-bar"]');
}

test.describe('A start that never reached an agent', () => {
  test('says so in place of Paused, with the reason in its tip', async () => {
    const { browser, page } = await launch();
    try {
      for (const [taskId, label, tip] of [
        ['task-worktree', 'Worktree missing', 'Its worktree folder is gone. Resume makes it again from the branch.'],
        ['task-folder', 'Folder missing', 'The folder this agent starts in is gone.'],
        ['task-never', 'Didn\'t start', 'The agent never reported that it started.'],
        ['task-spawn', 'Didn\'t start', 'The terminal could not start. Its window shows why.'],
      ]) {
        const footer = footerOf(page, taskId);
        await expect(footer).toHaveText(label);
        await footer.getByText(label).hover();
        await expect(page.getByRole('tooltip')).toHaveText(tip);
        await page.mouse.move(0, 0);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
      }
    } finally {
      await browser.close();
    }
  });

  test('a plain pause still reads Paused, in the quiet tone', async () => {
    const { browser, page } = await launch();
    try {
      const paused = footerOf(page, 'task-paused');
      await expect(paused).toHaveText('Paused');
      await expect(paused.locator('span.text-fg-faint')).toHaveCount(1);
      await expect(footerOf(page, 'task-never').locator('span.text-warning')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a compact card, which has no footer, says it under the title', async () => {
    const { browser, page } = await launch('compact');
    try {
      await expect(page.locator('[data-task-id="task-worktree"]').getByTestId('task-card-start-blocked-line')).toHaveText('Worktree missing');
      await expect(page.locator('[data-task-id="task-paused"]').getByTestId('task-card-start-blocked-line')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
