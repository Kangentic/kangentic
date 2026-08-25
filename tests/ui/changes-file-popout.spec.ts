/**
 * UI tests for the per-file diff pop-out affordance ('changes-file' PopOutKind).
 *
 * Double-clicking a file row in the Changes file tree (and the context menu's
 * "Open in new window" item) opens that ONE file's diff in its own OS window.
 * The pop-out window itself never opens in this tier - assertions ride the
 * mock's popOut call log (window.__mockPopOut.getCalls()): the right kind and
 * params (taskId / projectId / filePath / scope / commitOid), single-click
 * staying selection-only, the cap-refusal toast, and the command-terminal
 * embed (no task identity) not offering the affordance at all.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-file-popout';
const TASK_ID = 'task-file-popout';
const SESSION_ID = 'sess-file-popout';
const COMMIT_OID = 'c0ffee0000000000000000000000000000000001';

interface PopOutCall {
  type: string;
  kind: string;
  params: {
    taskId?: string;
    projectId?: string;
    filePath?: string;
    scope?: string | null;
    commitOid?: string | null;
    projectPath?: string;
    worktreePath?: string;
    baseBranch?: string;
    status?: string;
    oldPath?: string;
    binary?: boolean;
    taskDisplayId?: number;
    taskTitle?: string;
  };
}

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'docs/database.md', status: 'M', insertions: 3, deletions: 1, original: 'old doc', modified: 'new doc', language: 'markdown' },
      { path: 'src/index.ts', status: 'M', insertions: 4, deletions: 2, original: 'old', modified: 'new', language: 'typescript' },
    ],
    totalInsertions: 7,
    totalDeletions: 3,
  };

  window.__mockGitDiffByCommit = {
    '${COMMIT_OID}': {
      files: [
        { path: 'docs/commit-file.md', status: 'M', insertions: 2, deletions: 2, original: 'was', modified: 'is', language: 'markdown' },
      ],
    },
  };

  window.__mockCommitGraph = {
    commits: [
      { hash: '${COMMIT_OID}', shortHash: 'c0ffee0', parents: [], authorName: 'Dev', authorTimestamp: '2026-01-01T00:00:00.000Z', subject: 'feat: commit-scoped fixture' },
    ],
    tipHash: '${COMMIT_OID}',
    baseHash: null,
    mergeBaseHash: null,
    currentBranch: 'feature/file-popout',
    truncated: false,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'File Popout Test',
      path: '/mock/file-popout-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-fp-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
      cwd: '/mock/file-popout-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 77,
      title: 'File Popout Task',
      description: 'Task used for the per-file diff pop-out tests',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/file-popout',
      branch_name: 'feature/file-popout',
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

async function getPopOutCalls(): Promise<PopOutCall[]> {
  return page.evaluate(() => {
    const mockPopOut = (window as unknown as { __mockPopOut: { getCalls: () => PopOutCall[] } }).__mockPopOut;
    return mockPopOut.getCalls();
  }) as Promise<PopOutCall[]>;
}

async function resetPopOutMock(): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockPopOut: { reset: () => void } }).__mockPopOut.reset();
  });
}

/** Open the task detail and its Changes panel, tolerant of a prior test (or a
 *  retry) having left either open already. */
async function ensureChangesPanelOpen(): Promise<void> {
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  if (!(await dialog.isVisible())) {
    await page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=File Popout Task')
      .first()
      .click();
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
  }
  const fileTree = page.locator('[data-testid="changes-file-tree"]');
  if (!(await fileTree.isVisible())) {
    await page.locator('[data-testid="changes-toggle"]').click();
  }
  await fileTree.waitFor({ state: 'visible', timeout: 8000 });
  // Re-establish the working (Uncommitted) scope: a failed or retried earlier
  // test can leave the file list pinned to the fixture commit, and every test
  // here that needs the working rows would then fail for that unrelated reason.
  const workingRow = page.locator('[data-testid="changes-file-row"][data-path="docs/database.md"]');
  if (!(await workingRow.isVisible())) {
    await page.locator('[data-testid="commit-history-uncommitted"]').click();
    await workingRow.waitFor({ state: 'visible', timeout: 8000 });
  }
}

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes panel: per-file diff pop-out', () => {
  test('double-click opens a changes-file pop-out with scope params; single-click only selects', async () => {
    await ensureChangesPanelOpen();
    await resetPopOutMock();

    const row = page.locator('[data-testid="changes-file-row"][data-path="docs/database.md"]');
    const rowButton = row.getByRole('button', { name: /database\.md/ });
    await rowButton.waitFor({ state: 'visible', timeout: 8000 });

    // Single click selects the row into the inline pane - and nothing else.
    await rowButton.click();
    await expect(row).toHaveAttribute('data-selected', 'true', { timeout: 5000 });

    await rowButton.dblclick();

    await expect
      .poll(async () => (await getPopOutCalls()).filter((call) => call.type === 'open').length, { timeout: 5000 })
      .toBe(1);
    const calls = await getPopOutCalls();
    const openCall = calls.find((call) => call.type === 'open');
    expect(openCall?.kind).toBe('changes-file');
    expect(openCall?.params.taskId).toBe(TASK_ID);
    expect(openCall?.params.projectId).toBe(PROJECT_ID);
    expect(openCall?.params.filePath).toBe('docs/database.md');
    expect(openCall?.params.scope).toBe('working');
    expect(openCall?.params.commitOid ?? null).toBeNull();
    // The boot seed: paths, the file's list-entry fields, and the task label,
    // so the window fetches and titles itself without store hydration.
    expect(openCall?.params.projectPath).toBe('/mock/file-popout-test');
    expect(openCall?.params.worktreePath).toBe('/mock/worktrees/file-popout');
    expect(openCall?.params.baseBranch).toBe('main');
    expect(openCall?.params.status).toBe('M');
    expect(openCall?.params.binary).toBe(false);
    expect(openCall?.params.taskDisplayId).toBe(77);
    expect(openCall?.params.taskTitle).toBe('File Popout Task');
  });

  test('double-click in a commit-scoped file list carries the commitOid instead of a scope', async () => {
    await ensureChangesPanelOpen();
    await resetPopOutMock();

    // Select the fixture commit in the history region; the file list swaps to
    // the commit's diff.
    await page.locator('[data-testid="commit-graph-row"]', { hasText: 'commit-scoped fixture' }).click();
    const commitRow = page.locator('[data-testid="changes-file-row"][data-path="docs/commit-file.md"]');
    const commitRowButton = commitRow.getByRole('button', { name: /commit-file\.md/ });
    await commitRowButton.waitFor({ state: 'visible', timeout: 8000 });

    await commitRowButton.dblclick();

    await expect
      .poll(async () => (await getPopOutCalls()).filter((call) => call.type === 'open').length, { timeout: 5000 })
      .toBe(1);
    const openCall = (await getPopOutCalls()).find((call) => call.type === 'open');
    expect(openCall?.kind).toBe('changes-file');
    expect(openCall?.params.filePath).toBe('docs/commit-file.md');
    expect(openCall?.params.commitOid).toBe(COMMIT_OID);
    expect(openCall?.params.scope ?? null).toBeNull();

    // Restore the working diff for the tests that follow.
    await page.locator('[data-testid="commit-history-uncommitted"]').click();
    await page
      .locator('[data-testid="changes-file-row"][data-path="docs/database.md"]')
      .waitFor({ state: 'visible', timeout: 8000 });
  });

  test('the context menu offers "Open in new window" and it opens the pop-out', async () => {
    await ensureChangesPanelOpen();
    await resetPopOutMock();

    const rowButton = page
      .locator('[data-testid="changes-file-row"][data-path="src/index.ts"]')
      .getByRole('button', { name: /index\.ts/ });
    await rowButton.waitFor({ state: 'visible', timeout: 8000 });
    await rowButton.click({ button: 'right' });

    const menu = page.locator('[data-testid="changes-file-context-menu"]');
    await expect(menu).toBeVisible({ timeout: 8000 });
    const item = menu.locator('[data-testid="context-open-new-window"]');
    await expect(item).toBeVisible({ timeout: 3000 });
    await item.click();
    await expect(menu).toBeHidden({ timeout: 5000 });

    await expect
      .poll(async () => (await getPopOutCalls()).filter((call) => call.type === 'open').length, { timeout: 5000 })
      .toBe(1);
    const openCall = (await getPopOutCalls()).find((call) => call.type === 'open');
    expect(openCall?.kind).toBe('changes-file');
    expect(openCall?.params.filePath).toBe('src/index.ts');
  });

  test('a cap-refused open (popOut.open resolves false) surfaces the limit toast', async () => {
    await ensureChangesPanelOpen();
    await resetPopOutMock();
    await page.evaluate(() => {
      (window as unknown as { __mockPopOut: { setOpenResult: (value: boolean) => void } }).__mockPopOut.setOpenResult(false);
    });

    const rowButton = page
      .locator('[data-testid="changes-file-row"][data-path="docs/database.md"]')
      .getByRole('button', { name: /database\.md/ });
    await rowButton.dblclick();

    await expect(
      page.locator('[data-testid="toast"]', { hasText: 'File diff window limit reached' }),
    ).toBeVisible({ timeout: 8000 });

    await page.evaluate(() => {
      (window as unknown as { __mockPopOut: { setOpenResult: (value: boolean) => void } }).__mockPopOut.setOpenResult(true);
    });
  });

  test('the command-terminal Changes embed (no task identity) offers no per-file pop-out', async () => {
    // Close the task detail so the command terminal's file tree is the only one.
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    if (await dialog.isVisible()) {
      await page.keyboard.press('Control+Shift+W');
      await expect(dialog).not.toBeVisible({ timeout: 8000 });
    }
    await resetPopOutMock();

    await page.keyboard.press('Control+Shift+P');
    const changesToggle = page.locator('[data-testid="command-bar-changes-toggle"]');
    await changesToggle.waitFor({ state: 'visible', timeout: 8000 });
    await changesToggle.click();

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    await fileTree.waitFor({ state: 'visible', timeout: 8000 });
    const rowButton = fileTree
      .locator('[data-testid="changes-file-row"][data-path="docs/database.md"]')
      .getByRole('button', { name: /database\.md/ });
    await rowButton.waitFor({ state: 'visible', timeout: 8000 });

    // The double-click must be a no-op here. The context-menu open that follows
    // doubles as the settle point proving the dblclick was processed.
    await rowButton.dblclick();
    await rowButton.click({ button: 'right' });
    const menu = page.locator('[data-testid="changes-file-context-menu"]');
    await expect(menu).toBeVisible({ timeout: 8000 });
    await expect(menu.locator('[data-testid="context-copy-path"]')).toBeVisible({ timeout: 3000 });
    await expect(menu.locator('[data-testid="context-open-new-window"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden({ timeout: 5000 });

    const calls = await getPopOutCalls();
    expect(calls.filter((call) => call.type === 'open' && call.kind === 'changes-file')).toEqual([]);
  });
});
