/**
 * Restoring a task from Done shows the restore in progress, on BOTH surfaces.
 *
 * The restore keeps the outgoing session's suspended record and its id while
 * main recreates the worktree and boots the CLI, which is several seconds. Two
 * separate defects lived in that window, and fixing the first exposed the
 * second:
 *
 *   1. `getTaskProgress` discarded the spawn label whenever a session existed,
 *      so the card read "Paused" and the detail offered a manual "Resume
 *      session" button while the engine was already restoring.
 *   2. Once the label won, `displayKind` became 'preparing' - but the detail's
 *      active-terminal branch only excluded 'queued' and 'suspended', so it
 *      matched on the STALE session id and painted the dead session's terminal
 *      (the echoed `--resume` command over a bare shell prompt). Visually that
 *      reads as a broken agent, which is worse than the button it replaced.
 *
 * Both surfaces are asserted together because they are driven by one predicate
 * and disagreeing about it is the whole bug class.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-restore-progress';
const TASK_ID = 'task-restore-progress';
const TASK_TITLE = 'Restore Progress Probe';
const SESSION_ID = 'session-restore-progress';
const SPAWN_LABEL = 'Creating worktree...';

interface StoreWindow {
  __zustandStores: {
    session: {
      getState: () => {
        setDetailTaskId: (id: string) => void;
        spawnProgress: Record<string, string>;
      };
      setState: (partial: { spawnProgress: Record<string, string> }) => void;
    };
    window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } };
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Restore Progress Test',
        path: '/mock/restore-progress-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'),
          position: i,
          created_at: ts,
        }));
      });
      // Mid-restore: already unarchived into an auto-spawn column, but the
      // outgoing session record and its id are still on the row because the new
      // one has not spawned yet.
      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Restored from Done, worktree being recreated.',
        swimlane_id: 'lane-executing',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: 'feature/restore-progress',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'suspended',
        shell: 'pwsh',
        cwd: '/mock/restore-progress-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        agentSessionId: 'agent-restore-progress',
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** The push main sends while it recreates the worktree. */
async function emitSpawnProgress(page: Page): Promise<void> {
  await page.evaluate(({ taskId, label }) => {
    const store = (window as unknown as StoreWindow).__zustandStores.session;
    store.setState({ spawnProgress: { ...store.getState().spawnProgress, [taskId]: label } });
  }, { taskId: TASK_ID, label: SPAWN_LABEL });
}

test.describe('Restore from Done reports progress on both surfaces', () => {
  test('the card shows the spawn label instead of Paused', async () => {
    const { browser, page } = await launch();
    try {
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);
      await expect(card).toBeVisible({ timeout: 10000 });

      // Precondition: with no label in flight, the suspended record reads Paused.
      await expect(card).toContainText('Paused');

      await emitSpawnProgress(page);

      await expect(card).toContainText(SPAWN_LABEL, { timeout: 5000 });
      await expect(card).not.toContainText('Paused');
    } finally {
      await browser.close();
    }
  });

  test('the detail shows the launch overlay, not the dead terminal and not a Resume button', async () => {
    const { browser, page } = await launch();
    try {
      await page.evaluate((taskId) => {
        (window as unknown as StoreWindow).__zustandStores.session.getState().setDetailTaskId(taskId);
      }, TASK_ID);

      let windowId: string | null = null;
      await expect.poll(async () => {
        windowId = await page.evaluate((anchorId) => {
          const windows = (window as unknown as StoreWindow).__zustandStores.window.getState().windows;
          return Object.values(windows).find((candidate) => candidate.anchor === anchorId)?.id ?? null;
        }, TASK_ID);
        return windowId;
      }, { timeout: 5000 }).not.toBeNull();

      const frame = page.locator(`[data-testid="window-frame-${windowId}"]`);
      await frame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

      // Before the label: the suspended record earns the Resume prompt.
      await expect(frame.locator('button:has-text("Resume session")')).toBeVisible();

      await emitSpawnProgress(page);

      // The restore is now advertised as in flight...
      await expect(frame).toContainText(SPAWN_LABEL, { timeout: 5000 });
      // ...with no manual button competing with it...
      await expect(frame.locator('button:has-text("Resume session")')).toHaveCount(0);
      // ...and crucially NOT the outgoing session's terminal, which is what the
      // branch-order regression painted once 'preparing' started winning.
      await expect(frame.locator('.xterm')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
