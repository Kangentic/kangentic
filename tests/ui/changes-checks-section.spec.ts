/**
 * UI tests for a task's PR in the Changes panel (#1032): the compact PR pill in
 * the panel header, the Checks section above History, Send to agent, and the
 * Changes button's count.
 *
 * What only a browser proves here: the section's presence rules against real
 * task rows, its fold remembered across tasks, the badge's three states, the
 * row and Send wiring through the bridge with the interaction-time projectId,
 * and the toast rule (a send to a running agent shows none, a held one does).
 * The check normalization and the message are unit-tested
 * (tests/unit/pr-failed-checks.test.ts).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pr-checks';

const check = (id: string, name: string, status: string, group: string | null = 'CI') =>
  `{ id: '${id}', name: '${name}', group: ${group ? `'${group}'` : 'null'}, url: 'https://ci.example/${id}', status: '${status}', hasLog: true }`;

const preConfig = `
  window.__mockGitDiff = {
    files: [{ path: 'src/app.ts', status: 'M', insertions: 2, deletions: 1, original: 'a', modified: 'b', language: 'typescript' }],
    totalInsertions: 2,
    totalDeletions: 1,
  };
  window.__mockPrChecks = {
    'task-failing': {
      checksPageUrl: 'https://github.com/o/r/pull/38/checks',
      checks: [
        ${check('1', 'Lint', 'passed')},
        ${check('2', 'UI Test (10/11)', 'failed')},
        ${check('3', 'codecov/patch', 'failed', null)},
        ${check('4', 'Docs', 'skipped')},
      ],
    },
    'task-running': {
      checksPageUrl: 'https://github.com/o/r/pull/39/checks',
      checks: [${check('5', 'Lint', 'passed')}, ${check('6', 'E2E Test (3/5)', 'pending')}],
    },
    'task-swap': {
      checksPageUrl: 'https://github.com/o/r/pull/42/checks',
      checks: [${check('8', 'Lint', 'passed')}, ${check('9', 'Unit Test', 'failed')}],
    },
    'task-conflict': {
      checksPageUrl: 'https://github.com/o/r/pull/40/checks',
      checks: [${check('7', 'Lint', 'passed')}],
    },
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({ id: '${PROJECT_ID}', name: 'PR Checks Test', path: '/mock/pr-checks', github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-prc-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    function task(id, title, position, pr) {
      // A running session, so the task window opens on its header (with the
      // Changes button), not the edit form.
      state.sessions.push({
        id: 'sess-' + id, taskId: id, projectId: '${PROJECT_ID}', pid: 9000 + position,
        status: 'running', shell: 'bash', cwd: '/mock/pr-checks', startedAt: ts, exitCode: null,
      });
      state.tasks.push(Object.assign({
        id: id, title: title, description: '', swimlane_id: laneIds['Code Review'], position: position, agent: 'claude',
        session_id: 'sess-' + id, worktree_path: '/mock/worktrees/' + id, branch_name: 'feature/' + id, base_branch: 'main',
        pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null,
        archived_at: null, created_at: ts, updated_at: ts,
      }, pr));
    }
    task('task-failing', 'Failing PR Task', 0, { pr_number: 38, pr_url: 'https://github.com/o/r/pull/38', pr_state: 'open', pr_merge_readiness: 'failing' });
    task('task-running', 'Running PR Task', 1, { pr_number: 39, pr_url: 'https://github.com/o/r/pull/39', pr_state: 'open', pr_merge_readiness: 'running' });
    task('task-conflict', 'Conflict PR Task', 2, { pr_number: 40, pr_url: 'https://github.com/o/r/pull/40', pr_state: 'open', pr_merge_readiness: 'conflicting' });
    task('task-no-checks', 'No Checks PR Task', 3, { pr_number: 41, pr_url: 'https://github.com/o/r/pull/41', pr_state: 'open', pr_merge_readiness: 'ready' });
    task('task-no-pr', 'No PR Task', 4, {});
    task('task-swap', 'Swap PR Task', 5, { pr_number: 42, pr_url: 'https://github.com/o/r/pull/42', pr_state: 'open', pr_merge_readiness: 'failing' });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

const dialog = () => page.locator('[data-testid="task-detail-dialog"]');

async function openTask(title: string, openChanges = true): Promise<void> {
  if (await dialog().isVisible()) {
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog()).not.toBeVisible({ timeout: 8000 });
  }
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
  await dialog().waitFor({ state: 'visible', timeout: 8000 });
  if (openChanges) {
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.locator('[data-testid="changes-file-tree"]').first().waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function closeTask(): Promise<void> {
  if (await page.locator('[data-testid="changes-file-tree"]').first().isVisible()) {
    await page.locator('[data-testid="changes-toggle"]').click();
  }
  await page.keyboard.press('Control+Shift+W');
  await expect(dialog()).not.toBeVisible({ timeout: 8000 });
}

test.describe('Changes panel: the PR and its checks', () => {
  test('the Changes button counts what to fix while the panel is closed', async () => {
    await openTask('Failing PR Task', false);
    // Two failed checks; the skipped one counts for nothing.
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveText('2', { timeout: 10000 });
    await closeTask();
    await openTask('Conflict PR Task', false);
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveText('1', { timeout: 10000 });
    await closeTask();
    await openTask('Running PR Task', false);
    await expect(page.locator('[data-testid="changes-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveCount(0);
    await closeTask();
  });

  test('the panel header shows the PR pill, and Checks starts folded with the check progress', async () => {
    await openTask('Failing PR Task');
    const pill = page.locator('[data-testid="changes-pr-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('data-pr-readiness', 'failing');
    await expect(pill).toContainText('PR #38');

    const toggle = page.locator('[data-testid="changes-checks-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const progress = toggle.locator('[data-testid="changes-checks-progress"]');
    // Passed of total, the skipped check counted in neither.
    await expect(progress).toHaveText('1/3');
    await expect(progress).toHaveAttribute('data-progress-state', 'failed');
    // The body stays mounted, clipped to height 0, so visibility checks (which
    // ignore an ancestor's clip) cannot tell; the collapsed body is aria-hidden.
    await expect(page.locator('[data-testid="changes-checks-body"]').locator('..')).toHaveAttribute('aria-hidden', 'true');
    await closeTask();
  });

  test('opened: failed rows open their check, Send goes to the bridge with the project, and a sent message shows no toast', async () => {
    await openTask('Failing PR Task');
    const toggle = page.locator('[data-testid="changes-checks-toggle"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = page.locator('[data-testid="changes-checks-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('CI / UI Test (10/11)');
    await expect(page.locator('[data-testid="changes-checks-passed"]')).toContainText('1 passed');

    await page.evaluate(() => { (window as unknown as { __openedUrls: string[] }).__openedUrls = []; });
    await page.evaluate(() => {
      const target = window as unknown as { __openedUrls: string[]; electronAPI: { shell: { openExternal: (url: string) => Promise<void> } } };
      target.electronAPI.shell.openExternal = async (url: string) => { target.__openedUrls.push(url); };
    });
    await rows.first().click();
    await page.locator('[data-testid="changes-checks-passed"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls))
      .toEqual(['https://ci.example/2', 'https://github.com/o/r/pull/38/checks']);

    const toastsBefore = await page.evaluate(() => (window as unknown as {
      __zustandStores: { toast: { getState: () => { toasts: unknown[] } } };
    }).__zustandStores.toast.getState().toasts.length);
    await page.locator('[data-testid="changes-checks-send"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockSendPrChecksCalls?: unknown[] }).__mockSendPrChecksCalls ?? []))
      .toEqual([{ taskId: 'task-failing', projectId: 'proj-pr-checks' }]);
    await expect(page.locator('[data-testid="changes-checks-send"]')).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as {
      __zustandStores: { toast: { getState: () => { toasts: unknown[] } } };
    }).__zustandStores.toast.getState().toasts.length)).toBe(toastsBefore);
    await closeTask();
  });

  test('a message held for the next agent says so in a toast', async () => {
    await page.evaluate(() => { (window as unknown as { __mockSendPrChecksResult: unknown }).__mockSendPrChecksResult = { outcome: 'held', count: 1 }; });
    await openTask('Conflict PR Task');
    // The fold is remembered from the previous test: Checks opens open here.
    await expect(page.locator('[data-testid="changes-checks-toggle"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid="changes-checks-conflict"]')).toContainText('Conflicts with main');
    // A conflict is the pill's job: the badge counts checks only, and they passed.
    await expect(page.locator('[data-testid="changes-checks-progress"]')).toHaveAttribute('data-progress-state', 'passed');
    await page.locator('[data-testid="changes-checks-send"]').click();
    await expect(page.getByText('Held for the next agent')).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => { delete (window as unknown as { __mockSendPrChecksResult?: unknown }).__mockSendPrChecksResult; });
    await closeTask();
  });

  test('a running check shows progress and no Send; a PR with no checks shows the pill only; no PR shows neither', async () => {
    await openTask('Running PR Task');
    await expect(page.locator('[data-testid="changes-checks-progress"]')).toHaveAttribute('data-progress-state', 'pending');
    await expect(page.locator('[data-testid="changes-checks-progress"]')).toHaveText('1/2');
    await expect(page.locator('[data-testid="changes-checks-send"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="changes-pr-pill-pulse"]')).toHaveCount(1);
    await closeTask();

    await openTask('No Checks PR Task');
    await expect(page.locator('[data-testid="changes-pr-pill"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-checks-section"]')).toHaveCount(0);
    await closeTask();

    await openTask('No PR Task');
    await expect(page.locator('[data-testid="changes-pr-pill"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="changes-checks-section"]')).toHaveCount(0);
    await closeTask();
  });

  test('toggling Checks writes the remembered choice to config, both directions', async () => {
    const setChecksOpen = (open: boolean) => page.evaluate((value) => (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: { changesChecksOpen: boolean }) => Promise<void> } } };
    }).__zustandStores.config.getState().updateConfig({ changesChecksOpen: value }), open);
    const readChecksOpen = () => page.evaluate(() => window.electronAPI.config.get().then((config) => config.changesChecksOpen));

    await setChecksOpen(false);
    await openTask('Failing PR Task');
    const toggle = page.locator('[data-testid="changes-checks-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(readChecksOpen).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(readChecksOpen).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(readChecksOpen).toBe(false);
    await closeTask();
  });

  test('a failed Send shows the reason without Electron\'s remote-method prefix', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockSendPrChecksResult: () => never }).__mockSendPrChecksResult = () => {
        throw new Error("Error invoking remote method 'task:prSendChecks': Error: Nothing on this pull request needs fixing");
      };
    });
    try {
      await page.evaluate(() => (window as unknown as {
        __zustandStores: { config: { getState: () => { updateConfig: (partial: { changesChecksOpen: boolean }) => Promise<void> } } };
      }).__zustandStores.config.getState().updateConfig({ changesChecksOpen: true }));
      await openTask('Failing PR Task');
      await page.locator('[data-testid="changes-checks-send"]').click();
      const errorToastBodies = () => page.evaluate(() => (window as unknown as {
        __zustandStores: { toast: { getState: () => { toasts: { variant: string; message?: string }[] } } };
      }).__zustandStores.toast.getState().toasts.filter((toast) => toast.variant === 'error').map((toast) => toast.message));
      await expect.poll(errorToastBodies).toContain('Nothing on this pull request needs fixing.');
      expect((await errorToastBodies()).join('\n')).not.toContain('Error invoking remote method');
      await expect(page.getByText('Error invoking remote method')).toHaveCount(0);
    } finally {
      await page.evaluate(() => { delete (window as unknown as { __mockSendPrChecksResult?: unknown }).__mockSendPrChecksResult; });
    }
    await closeTask();
  });

  test('a changed merge readiness re-reads the checks at once, inside the 10 s shared read window', async () => {
    // A task no earlier test read, so its first read is this one's and the
    // shared cache entry is at most a few seconds old when readiness changes.
    await openTask('Swap PR Task', false);
    const toggle = page.locator('[data-testid="changes-checks-toggle"]');
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(toggle.locator('[data-testid="changes-checks-progress"]')).toHaveText('1/2', { timeout: 10000 });
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveText('1');
    const callsFor = () => page.evaluate(() => ((window as unknown as { __mockListPrChecksCalls?: { taskId: string }[] }).__mockListPrChecksCalls ?? [])
      .filter((call) => call.taskId === 'task-swap').length);
    const callsBefore = await callsFor();
    expect(callsBefore).toBeGreaterThan(0);

    // The PR refresh finds the failure fixed: the host's answer and the row's verdict change together.
    await page.evaluate(() => {
      const target = window as unknown as {
        __mockPrChecks: Record<string, { checks: { status: string }[] }>;
        __zustandStores: { board: { getState: () => { tasks: { id: string }[] }; setState: (partial: { tasks: unknown[] }) => void } };
      };
      target.__mockPrChecks['task-swap'].checks.forEach((entry) => { entry.status = 'passed'; });
      const board = target.__zustandStores.board;
      board.setState({
        tasks: board.getState().tasks.map((task) => (task.id === 'task-swap' ? { ...task, pr_merge_readiness: 'ready' } : task)),
      });
    });

    await expect.poll(callsFor).toBeGreaterThan(callsBefore);
    await expect(toggle.locator('[data-testid="changes-checks-progress"]')).toHaveText('2/2');
    await expect(toggle.locator('[data-testid="changes-checks-progress"]')).toHaveAttribute('data-progress-state', 'passed');
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveCount(0);
    await closeTask();
  });
});
