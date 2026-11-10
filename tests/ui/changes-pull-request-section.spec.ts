/**
 * UI tests for a task's PR in the Changes panel (#1032, #1060): the Pull
 * request section above History, Send to agent, and the Changes button's count.
 *
 * What only a browser proves here: the section's presence rules against real
 * task rows, that the count on the Changes button is the count in the section
 * header, that the section opens itself while there is something to fix
 * without touching the choice remembered across tasks, the header's two states,
 * the row, open and Send wiring through the bridge with the interaction-time
 * projectId, and the toast rule (a send to a running agent shows none, a held
 * one does).
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
    'task-reset': {
      checksPageUrl: 'https://github.com/o/r/pull/43/checks',
      checks: [${check('10', 'Lint', 'passed')}, ${check('11', 'Unit Test', 'failed')}],
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
    task('task-reset', 'Reset PR Task', 6, { pr_number: 43, pr_url: 'https://github.com/o/r/pull/43', pr_state: 'open', pr_merge_readiness: 'failing' });
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

/** The choice remembered for every task, written through the store as the toggle writes it. */
const setRememberedOpen = (open: boolean) => page.evaluate((value) => (window as unknown as {
  __zustandStores: { config: { getState: () => { updateConfig: (partial: { changesChecksOpen: boolean }) => Promise<void> } } };
}).__zustandStores.config.getState().updateConfig({ changesChecksOpen: value }), open);
const readRememberedOpen = () => page.evaluate(() => window.electronAPI.config.get().then((config) => config.changesChecksOpen));

/** Record every URL the app asks the OS to open, from an empty list. */
async function recordOpenedUrls(): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const target = window as unknown as { __openedUrls: string[]; electronAPI: { shell: { openExternal: (url: string) => Promise<void> } } };
    target.__openedUrls = [];
    target.electronAPI.shell.openExternal = async (url: string) => { target.__openedUrls.push(url); };
  });
  return () => page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls);
}

test.describe('Changes panel: the pull request section', () => {
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

  test('something to fix opens the section itself, its header repeats the button\'s count, and the remembered choice is never written', async () => {
    await setRememberedOpen(false);
    await openTask('Failing PR Task');
    // No PR pill in the panel header: the section is where the PR lives. Any PR
    // control stamps data-pr-state, whatever its test id.
    const surfaceHeader = page.locator('[data-testid="surface-header-changes"]');
    await expect(surfaceHeader).toBeVisible();
    await expect(surfaceHeader.locator('[data-pr-state]')).toHaveCount(0);

    const toggle = page.locator('[data-testid="changes-pr-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // One count in the header, and it is the Changes button's: two failed
    // checks, the skipped one counted for nothing. No check progress beside it.
    await expect(toggle.locator('[data-testid="changes-pr-fix-count"]')).toHaveText('2');
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveText('2');
    // The visible badge is aria-hidden, so the toggle's own text carries the count.
    await expect(toggle).toContainText('2 things on the PR to fix');
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveCount(0);
    expect(await readRememberedOpen()).toBe(false);

    // Collapsing it here is not the remembered choice either. The body stays
    // mounted, clipped to height 0, so visibility checks (which ignore an
    // ancestor's clip) cannot tell; the collapsed body is aria-hidden.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-testid="changes-pr-body"]').locator('..')).toHaveAttribute('aria-hidden', 'true');
    expect(await readRememberedOpen()).toBe(false);
    await closeTask();

    // The collapse lasted only for that open of the panel.
    await openTask('Failing PR Task');
    await expect(page.locator('[data-testid="changes-pr-toggle"]')).toHaveAttribute('aria-expanded', 'true');
    await closeTask();
  });

  test('failed rows open their check, the header opens the PR, Send goes to the bridge with the project, and a sent message shows no toast', async () => {
    await openTask('Failing PR Task');
    const rows = page.locator('[data-testid="changes-pr-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('CI / UI Test (10/11)');
    await expect(page.locator('[data-testid="changes-pr-passed"]')).toContainText('1 passed');

    const openedUrls = await recordOpenedUrls();
    await rows.first().click();
    await page.locator('[data-testid="changes-pr-passed"]').click();
    await page.locator('[data-testid="changes-pr-open"]').click();
    await expect.poll(openedUrls)
      .toEqual(['https://ci.example/2', 'https://github.com/o/r/pull/38/checks', 'https://github.com/o/r/pull/38']);

    const toastsBefore = await page.evaluate(() => (window as unknown as {
      __zustandStores: { toast: { getState: () => { toasts: unknown[] } } };
    }).__zustandStores.toast.getState().toasts.length);
    await page.evaluate(() => { (window as unknown as { __mockSendPrChecksCalls: unknown[] }).__mockSendPrChecksCalls = []; });
    await page.locator('[data-testid="changes-pr-send"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockSendPrChecksCalls?: unknown[] }).__mockSendPrChecksCalls ?? []))
      .toEqual([{ taskId: 'task-failing', projectId: 'proj-pr-checks' }]);
    await expect(page.locator('[data-testid="changes-pr-send"]')).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as {
      __zustandStores: { toast: { getState: () => { toasts: unknown[] } } };
    }).__zustandStores.toast.getState().toasts.length)).toBe(toastsBefore);
    await closeTask();
  });

  test('a message held for the next agent says so in a toast', async () => {
    await page.evaluate(() => { (window as unknown as { __mockSendPrChecksResult: unknown }).__mockSendPrChecksResult = { outcome: 'held', count: 1 }; });
    await openTask('Conflict PR Task');
    // A conflict is something to fix, so the section is open and counts it,
    // though every check passed.
    await expect(page.locator('[data-testid="changes-pr-toggle"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid="changes-pr-conflict"]')).toContainText('Conflicts with main');
    await expect(page.locator('[data-testid="changes-pr-fix-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="changes-pr-toggle"]')).toContainText('1 thing on the PR to fix');
    await page.locator('[data-testid="changes-pr-send"]').click();
    await expect(page.getByText('Held for the next agent')).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => { delete (window as unknown as { __mockSendPrChecksResult?: unknown }).__mockSendPrChecksResult; });
    await closeTask();
  });

  test('a running check shows progress and no Send; a PR with no checks shows the header alone, which opens it; no PR shows no section', async () => {
    await openTask('Running PR Task');
    // Nothing to fix: the header's one count is the check progress.
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveAttribute('data-progress-state', 'pending');
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveText('1/2');
    await expect(page.locator('[data-testid="changes-pr-fix-count"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="changes-pr-send"]')).toHaveCount(0);
    await closeTask();

    await openTask('No Checks PR Task');
    // Nothing to open, so no toggle and no body, but the PR is still one click away.
    await expect(page.locator('[data-testid="changes-pr-header"]')).toContainText('Pull request');
    await expect(page.locator('[data-testid="changes-pr-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="changes-pr-body"]')).toHaveCount(0);
    const openedUrls = await recordOpenedUrls();
    await page.locator('[data-testid="changes-pr-open"]').click();
    await expect.poll(openedUrls).toEqual(['https://github.com/o/r/pull/41']);
    await closeTask();

    await openTask('No PR Task');
    await expect(page.locator('[data-testid="changes-pr-section"]')).toHaveCount(0);
    await closeTask();
  });

  test('with nothing to fix, toggling the section writes the remembered choice to config, both directions', async () => {
    await setRememberedOpen(false);
    await openTask('Running PR Task');
    const toggle = page.locator('[data-testid="changes-pr-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(readRememberedOpen).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(readRememberedOpen).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(readRememberedOpen).toBe(false);
    await closeTask();
  });

  test('a failed Send shows the reason without Electron\'s remote-method prefix', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockSendPrChecksResult: () => never }).__mockSendPrChecksResult = () => {
        throw new Error("Error invoking remote method 'task:prSendChecks': Error: Nothing on this pull request needs fixing");
      };
    });
    try {
      await openTask('Failing PR Task');
      await page.locator('[data-testid="changes-pr-send"]').click();
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
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(page.locator('[data-testid="changes-pr-fix-count"]')).toHaveText('1', { timeout: 10000 });
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
    // Nothing left to fix: both red counts go, and the header falls back to the check progress.
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveText('2/2');
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveAttribute('data-progress-state', 'passed');
    await expect(page.locator('[data-testid="changes-pr-fix-count"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="changes-toggle-fix-count"]')).toHaveCount(0);
    await closeTask();
  });

  test('a collapse made while there is something to fix is forgotten once the fixes clear in place, and fixes returning open the section again', async () => {
    await setRememberedOpen(false);
    await openTask('Reset PR Task');
    const toggle = page.locator('[data-testid="changes-pr-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Both the checks and the row's verdict change in place, as a PR refresh does.
    const setPrState = (checkStatus: string, readiness: string) => page.evaluate(({ checkStatus: status, readiness: verdict }) => {
      const target = window as unknown as {
        __mockPrChecks: Record<string, { checks: { name: string; status: string }[] }>;
        __zustandStores: { board: { getState: () => { tasks: { id: string }[] }; setState: (partial: { tasks: unknown[] }) => void } };
      };
      target.__mockPrChecks['task-reset'].checks.forEach((entry) => { if (entry.name === 'Unit Test') entry.status = status; });
      const board = target.__zustandStores.board;
      board.setState({
        tasks: board.getState().tasks.map((task) => (task.id === 'task-reset' ? { ...task, pr_merge_readiness: verdict } : task)),
      });
    }, { checkStatus, readiness });

    await setPrState('passed', 'ready');
    // Nothing to fix: the header is back on the progress, and the section follows the remembered choice (closed).
    await expect(page.locator('[data-testid="changes-pr-progress"]')).toHaveText('2/2');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await setPrState('failed', 'failing');
    await expect(page.locator('[data-testid="changes-pr-fix-count"]')).toHaveText('1');
    // The earlier collapse did not outlive the fixes, so the section opens again.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // None of this was the remembered choice.
    expect(await readRememberedOpen()).toBe(false);
    await closeTask();
  });

  test('both fix badges draw the danger fill, not the accent fill, and the open button does not toggle the section and says which PR it opens', async () => {
    await setRememberedOpen(false);
    await openTask('Failing PR Task');
    const toggle = page.locator('[data-testid="changes-pr-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Computed colors compared with each other, never with a literal: the
    // accent probe uses a class the app's own CSS already generates.
    const fills = await page.evaluate(() => {
      const fillOf = (element: Element) => getComputedStyle(element).backgroundColor;
      const probe = document.createElement('div');
      probe.className = 'bg-accent-emphasis';
      document.body.appendChild(probe);
      const accent = fillOf(probe);
      probe.remove();
      const sectionBadge = document.querySelector('[data-testid="changes-pr-fix-count"]');
      const buttonBadge = document.querySelector('[data-testid="changes-toggle-fix-count"]');
      return {
        accent,
        section: sectionBadge ? fillOf(sectionBadge) : null,
        button: buttonBadge ? fillOf(buttonBadge) : null,
      };
    });
    expect(fills.section).not.toBeNull();
    expect(fills.section).toBe(fills.button);
    expect(fills.section).not.toBe(fills.accent);
    expect(fills.section).not.toBe('rgba(0, 0, 0, 0)');

    // Clicking the open button opens the PR and leaves the section as it was.
    const openedUrls = await recordOpenedUrls();
    const openButton = page.locator('[data-testid="changes-pr-open"]');
    await openButton.click();
    await expect.poll(openedUrls).toEqual(['https://github.com/o/r/pull/38']);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(openButton.locator('xpath=ancestor::*[@data-testid="changes-pr-toggle"]')).toHaveCount(0);

    // The hover text names the PR and carries its state.
    await openButton.hover();
    await expect(openButton).toHaveAccessibleDescription(/Open PR #38 in default browser/);
    await expect(openButton).toHaveAccessibleDescription(/A check or build failed/);
    await closeTask();
  });
});
