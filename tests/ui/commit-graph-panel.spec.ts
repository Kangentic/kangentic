/**
 * UI tests for the Task Detail Changes panel's commit-history browser.
 *
 * The commit graph is the top region of a vertical split: a pinned
 * "Uncommitted changes" row (`data-testid="commit-history-uncommitted"`,
 * selected by default) above the commit list (SVG DAG + one row per commit,
 * `data-testid="commit-graph-row"`), always visible once Changes is opened
 * (via the `changes-toggle` pill) - there is no separate Files | Graph toggle.
 * Selecting a commit row scopes the detail pane below (file tree + diff) to
 * that commit's diff and shows a `commit-detail-header` with a back button
 * (`commit-detail-back`) that returns to Uncommitted. The commit graph is
 * seeded through the mock via window.__mockCommitGraph.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
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

const PROJECT_ID = 'proj-commit-graph';
const TASK_ID = 'task-commit-graph';
const SESSION_ID = 'sess-commit-graph';

// Three-commit linear fixture; the tip carries the HEAD badge, the root the base badge.
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    window.__mockCommitGraph = {
      commits: [
        { hash: 'commit-aaa', shortHash: 'aaaaaaa', parents: ['commit-bbb'], authorName: 'Ada', authorTimestamp: ts, subject: 'third commit' },
        { hash: 'commit-bbb', shortHash: 'bbbbbbb', parents: ['commit-ccc'], authorName: 'Ada', authorTimestamp: ts, subject: 'second commit' },
        { hash: 'commit-ccc', shortHash: 'ccccccc', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'first commit' },
      ],
      tipHash: 'commit-aaa',
      baseHash: 'commit-ccc',
      mergeBaseHash: 'commit-ccc',
      currentBranch: 'feature/commit-graph',
      truncated: false,
    };

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Commit Graph Test',
      path: '/mock/commit-graph-test',
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

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/commit-graph-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Commit Graph Task',
      description: 'Task used for commit-graph pane test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/commit-graph',
      branch_name: 'feature/commit-graph',
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
  await browser?.close();
});

/** Open the task dialog and the Changes panel (assumed closed on entry). The
 *  commit-history browser renders immediately - there is no separate toggle. */
async function openDialogWithChangesPanel(taskLocatorText: string, swimlaneName: string): Promise<Page> {
  const card = page.locator(`[data-swimlane-name="${swimlaneName}"]`).locator(`text=${taskLocatorText}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="changes-toggle"]').click();
  await page.locator('[data-testid="commit-graph-panel"]').waitFor({ state: 'visible', timeout: 10000 });
  return dialog;
}

/** Close the Changes panel and the dialog, leaving the selection on
 *  "Uncommitted changes" so the next test's dialog reopen starts from the
 *  same known state (persisted per-task in the session store's
 *  changesOpenTasks / changesSelectedCommit). */
async function closeChangesPanelAndDialog(dialog: Locator): Promise<void> {
  const uncommittedRow = page.locator('[data-testid="commit-history-uncommitted"]');
  if (await uncommittedRow.isVisible() && (await uncommittedRow.getAttribute('aria-pressed')) !== 'true') {
    await uncommittedRow.click();
  }
  await page.locator('[data-testid="changes-toggle"]').click();
  await page.keyboard.press('Control+Shift+W');
  await expect(dialog).not.toBeVisible({ timeout: 8000 });
}

test.describe('Task Detail Changes panel - commit-history browser', () => {
  test('shows the graph immediately with Uncommitted selected by default, selecting a commit shows its detail, and Uncommitted returns to the working diff', async () => {
    const dialog = await openDialogWithChangesPanel('Commit Graph Task', 'Code Review');

    // The graph renders immediately - no toggle click needed.
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(3, { timeout: 10000 });

    // Uncommitted changes is the default selection; the scope selector is
    // visible (Uncommitted's detail exposes working/staged/branch).
    const uncommittedRow = page.locator('[data-testid="commit-history-uncommitted"]');
    await expect(uncommittedRow).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="commit-detail-header"]')).not.toBeVisible();

    // The tip commit is marked HEAD; the branch base is labelled with the base branch.
    const tipCommitRow = page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'third commit' });
    await expect(tipCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'HEAD' })).toBeVisible();
    const baseCommitRow = page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'first commit' });
    await expect(baseCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'main' })).toBeVisible();

    // Select a commit: the detail pane shows the commit-detail header instead
    // of the scope selector, and the row is marked selected.
    await tipCommitRow.click();
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-detail-header"]')).toContainText('aaaaaaa');
    await expect(page.locator('[data-testid="changes-scope-select"]')).not.toBeVisible();
    await expect(tipCommitRow).toHaveAttribute('aria-pressed', 'true');
    await expect(uncommittedRow).toHaveAttribute('aria-pressed', 'false');

    // The back button returns to Uncommitted.
    await page.locator('[data-testid="commit-detail-back"]').click();
    await expect(page.locator('[data-testid="commit-detail-header"]')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible();
    await expect(uncommittedRow).toHaveAttribute('aria-pressed', 'true');

    await closeChangesPanelAndDialog(dialog);
  });

  test('shows "No git history available." then "No commits on this branch yet." for the two empty-graph fixtures, with Uncommitted still selectable', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [],
        tipHash: null,
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: null,
        truncated: false,
      };
    });

    const dialog = await openDialogWithChangesPanel('Commit Graph Task', 'Code Review');
    await expect(page.getByText('No git history available.')).toBeVisible({ timeout: 10000 });
    // The Uncommitted row still renders above the empty state.
    await expect(page.locator('[data-testid="commit-history-uncommitted"]')).toBeVisible();

    // Re-seed a fixture with a tip/branch but zero commits, then fire the
    // diff-changed push (CommitGraphPanel refetches without unmounting).
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [],
        tipHash: 'abc',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/x',
        truncated: false,
      };
      (window as unknown as { __mockFireDiffChanged?: () => void }).__mockFireDiffChanged?.();
    });
    await expect(page.getByText('No commits on this branch yet.')).toBeVisible({ timeout: 10000 });
    // The other empty-state copy (both tipHash and currentBranch null) must
    // not also be showing.
    await expect(page.getByText('No git history available.')).not.toBeVisible();

    await closeChangesPanelAndDialog(dialog);
  });

  test('shows the truncated footer from the seeded result', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [
          { hash: 'c1', shortHash: 'c1', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'only commit' },
        ],
        tipHash: 'c1',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/commit-graph',
        truncated: true,
      };
    });

    const dialog = await openDialogWithChangesPanel('Commit Graph Task', 'Code Review');
    await expect(page.getByText(/Showing latest \d+ commits/)).toBeVisible({ timeout: 10000 });

    await closeChangesPanelAndDialog(dialog);
  });

  test('live-refreshes the commit rows via the diff-changed watcher while browsing a commit', async () => {
    await page.evaluate(() => {
      const ts = new Date().toISOString();
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [
          { hash: 'live-1', shortHash: 'live1', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'before refresh' },
        ],
        tipHash: 'live-1',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/commit-graph',
        truncated: false,
      };
    });

    const dialog = await openDialogWithChangesPanel('Commit Graph Task', 'Code Review');
    await expect(page.getByText('before refresh')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(1);

    // Select the commit, then update the fixture and fire the diff-changed
    // push - the same signal a real fs.watch-driven GIT_DIFF_CHANGED event
    // delivers (see preload.ts's onDiffChanged / GIT_DIFF_CHANGED, and the
    // main-process push in git-diff.ts). The graph list updates in place
    // without kicking the selection back to Uncommitted.
    await page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'before refresh' }).click();
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => {
      const ts = new Date().toISOString();
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [
          { hash: 'live-2', shortHash: 'live2', parents: ['live-1'], authorName: 'Ada', authorTimestamp: ts, subject: 'after refresh' },
          { hash: 'live-1', shortHash: 'live1', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'before refresh' },
        ],
        tipHash: 'live-2',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/commit-graph',
        truncated: false,
      };
      (window as unknown as { __mockFireDiffChanged?: () => void }).__mockFireDiffChanged?.();
    });

    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(2, { timeout: 10000 });
    await expect(page.getByText('after refresh')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible();
    // The selection survives the refresh (commit-detail stays open).
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible();

    await closeChangesPanelAndDialog(dialog);
  });
});

// ─── Commit graph PR-head ref badge ─────────────────────────────────────────

const PR_BADGE_PROJECT_ID = 'proj-commit-graph-pr-badge';
const PR_BADGE_TASK_ID = 'task-commit-graph-pr-badge';
const PR_BADGE_SESSION_ID = 'sess-commit-graph-pr-badge';
const PR_HEAD_HASH = 'commit-pr-head';

const prBadgePreConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    window.__mockCommitGraph = {
      commits: [
        { hash: '${PR_HEAD_HASH}', shortHash: 'prhead1', parents: ['commit-pr-base'], authorName: 'Ada', authorTimestamp: ts, subject: 'PR head commit' },
        { hash: 'commit-pr-base', shortHash: 'prbase1', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'PR base commit' },
      ],
      tipHash: '${PR_HEAD_HASH}',
      baseHash: 'commit-pr-base',
      mergeBaseHash: 'commit-pr-base',
      currentBranch: 'feature/pr-badge',
      truncated: false,
    };

    state.projects.push({
      id: '${PR_BADGE_PROJECT_ID}',
      name: 'PR Badge Graph Test',
      path: '/mock/pr-badge-graph-test',
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

    state.sessions.push({
      id: '${PR_BADGE_SESSION_ID}',
      taskId: '${PR_BADGE_TASK_ID}',
      projectId: '${PR_BADGE_PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-badge-graph-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${PR_BADGE_TASK_ID}',
      title: 'PR Badge Graph Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${PR_BADGE_SESSION_ID}',
      worktree_path: '/mock/worktrees/pr-badge-graph',
      branch_name: 'feature/pr-badge',
      pr_number: 42,
      pr_url: 'https://github.com/example/example/pull/42',
      head_sha: '${PR_HEAD_HASH}',
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PR_BADGE_PROJECT_ID}' };
  });
`;

test.describe('Commit graph PR-head ref badge', () => {
  let prBadgeBrowser: Browser;
  let prBadgePage: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(prBadgePreConfig);
    prBadgeBrowser = result.browser;
    prBadgePage = result.page;
    await prBadgePage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await prBadgeBrowser?.close();
  });

  test("renders a PR badge on the commit matching the task's head_sha", async () => {
    const card = prBadgePage
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Badge Graph Task')
      .first();
    await card.click();
    const dialog = prBadgePage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await prBadgePage.locator('[data-testid="changes-toggle"]').click();
    await prBadgePage.locator('[data-testid="commit-graph-svg"]').waitFor({ state: 'visible', timeout: 10000 });

    const headCommitRow = prBadgePage.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'PR head commit' });
    await expect(headCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'PR #42' })).toBeVisible();

    // The base commit row must NOT carry the PR badge.
    const baseCommitRow = prBadgePage.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'PR base commit' });
    await expect(baseCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'PR #42' })).toHaveCount(0);

    await prBadgePage.locator('[data-testid="changes-toggle"]').click();
    await prBadgePage.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
