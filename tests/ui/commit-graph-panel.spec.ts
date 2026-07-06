/**
 * UI tests for the Task Detail commit-graph pane.
 *
 * Opens a dialog on a task with an active session (so TaskDetailBody renders,
 * not the edit form) and exercises the Graph header pill: it toggles the pane,
 * renders the SVG DAG + one row per commit, is mutually exclusive with the
 * Changes pane, and shows the empty / truncated states. The commit graph is
 * seeded through the mock via window.__mockCommitGraph.
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

test.describe('Task Detail commit-graph pane', () => {
  test('toggles the pane, renders the DAG, and is mutually exclusive with Changes', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Commit Graph Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Graph pill is available (task has a worktree). Pane is closed initially.
    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await expect(graphPill).toBeVisible();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible();

    // Open the pane: the SVG plus one row per fixture commit render. React
    // re-render after the pill click can be slow on CI Linux, so give a budget.
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(3, { timeout: 10000 });
    // The tip commit is marked HEAD; the branch base is labelled with the base branch.
    await expect(page.getByText('HEAD', { exact: true })).toBeVisible();
    await expect(page.getByText('third commit')).toBeVisible();

    // Mutual exclusivity: opening Changes closes the Graph pane.
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });

    // Re-opening Graph closes Changes again (only one right panel at a time).
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-expand"]')).not.toBeVisible();
  });

  test('shows the empty state and the truncated footer from the seeded result', async () => {
    const graphPill = page.locator('[data-testid="graph-toggle"]');

    // Empty result -> empty-state message. Re-seed then remount the pane (close +
    // reopen) so the fresh fetch reads the new fixture.
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
    await graphPill.click(); // close
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });
    await graphPill.click(); // reopen -> refetch empty
    await expect(page.getByText('No git history available.')).toBeVisible({ timeout: 10000 });

    // Truncated result -> footer note.
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
    await graphPill.click(); // close
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });
    await graphPill.click(); // reopen -> refetch truncated
    await expect(page.getByText(/Showing latest \d+ commits/)).toBeVisible({ timeout: 10000 });

    // Close the pane and dialog so state does not leak to other tests.
    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
  });

  test('Graph and Browser panes are mutually exclusive', async () => {
    // Re-seed the original 3-commit fixture; a prior test in this file may
    // have left a different (empty/truncated) fixture behind.
    await page.evaluate((taskId) => {
      const ts = new Date().toISOString();
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
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
      (window as unknown as { __mockBrowser?: { seedTaskUrl: (id: string, url: string) => void } }).__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:5173');
    }, TASK_ID);

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Commit Graph Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    const browserPill = page.locator('[data-testid="browser-toggle"]');
    await expect(browserPill).toBeVisible();

    // Open Browser first.
    await browserPill.click();
    await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible({ timeout: 10000 });

    // Opening Graph closes Browser.
    await graphPill.click();
    await expect(page.locator('[data-testid="browser-pane"]')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });

    // Reverse: opening Browser again closes Graph.
    await browserPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible({ timeout: 10000 });

    // Close the pane and dialog so state does not leak to other tests.
    await browserPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('renders the base-branch ref badge on the resolved base commit', async () => {
    await page.evaluate(() => {
      const ts = new Date().toISOString();
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
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
    });

    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Graph Task').first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });

    // The fixture's baseHash points at the root commit; the task's
    // base_branch is 'main', so the root row carries a "main" ref badge.
    const baseCommitRow = page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'first commit' });
    await expect(baseCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'main' })).toBeVisible();

    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('shows "No commits on this branch yet." when tipHash is set but commits is empty', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockCommitGraph?: unknown }).__mockCommitGraph = {
        commits: [],
        tipHash: 'abc',
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: 'feature/x',
        truncated: false,
      };
    });

    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Graph Task').first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await graphPill.click();
    await expect(page.getByText('No commits on this branch yet.')).toBeVisible({ timeout: 10000 });
    // The other empty-state copy (both tipHash and currentBranch null) must
    // not also be showing.
    await expect(page.getByText('No git history available.')).not.toBeVisible();

    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('live-refreshes the commit list via the diff-changed watcher without closing the pane', async () => {
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

    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Graph Task').first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await graphPill.click();
    await expect(page.getByText('before refresh')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(1);

    // Update the fixture WITHOUT closing the pane, then fire the diff-changed
    // push - the same signal a real fs.watch-driven GIT_DIFF_CHANGED event
    // delivers (see preload.ts's onDiffChanged / GIT_DIFF_CHANGED, and the
    // main-process push in git-diff.ts).
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

    // The pane never closed - the row list updates in place.
    await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(2, { timeout: 10000 });
    await expect(page.getByText('after refresh')).toBeVisible();
    await expect(dialog).toBeVisible();

    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});

// ─── Commit graph availability without an active session ───────────────────
//
// Pins the M4 fix: `canShowGraph` in TaskDetailWindow.tsx now reads
// `sessionState.canShowChanges && !!(task.worktree_path || projectPath)`
// instead of the old ungated `!!(task.worktree_path || projectPath)`. Both
// fixture tasks below carry `session_id: null` (matching "no active session")
// but keep a SUSPENDED session row for their taskId, so a plain card click
// opens the view header instead of the edit form - TaskCard.tsx only forces
// edit mode when `displayState.kind === 'none'` (a session-less task), which
// a suspended session avoids. This is the only way to reach the header pill
// row through a real click for a task with no running PTY.

const NO_ACTIVE_SESSION_PROJECT_ID = 'proj-commit-graph-no-active-session';
const CODE_REVIEW_TASK_ID = 'task-commit-graph-no-active-session';
const TODO_LANE_TASK_ID = 'task-commit-graph-todo-lane';

const noActiveSessionPreConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    window.__mockCommitGraph = {
      commits: [
        { hash: 'commit-y', shortHash: 'commity', parents: [], authorName: 'Ada', authorTimestamp: ts, subject: 'no-active-session commit' },
      ],
      tipHash: 'commit-y',
      baseHash: null,
      mergeBaseHash: null,
      currentBranch: 'feature/no-active-session',
      truncated: false,
    };

    state.projects.push({
      id: '${NO_ACTIVE_SESSION_PROJECT_ID}',
      name: 'No Active Session Graph Test',
      path: '/mock/no-active-session-graph-test',
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

    // (a) Non-terminal lane (Code Review), worktree set, session_id null but a
    // SUSPENDED session row exists for the task - Graph must still be
    // available (the pane reads git directly and needs no live PTY).
    state.sessions.push({
      id: 'sess-no-active-session',
      taskId: '${CODE_REVIEW_TASK_ID}',
      projectId: '${NO_ACTIVE_SESSION_PROJECT_ID}',
      pid: 9999,
      status: 'suspended',
      shell: 'bash',
      cwd: '/mock/worktrees/no-active-session-graph',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${CODE_REVIEW_TASK_ID}',
      title: 'No Active Session Graph Task',
      description: '',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: null,
      worktree_path: '/mock/worktrees/no-active-session-graph',
      branch_name: 'feature/no-active-session',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // (b) To Do lane: the lifecycle gate hides Graph even though this task
    // ALSO carries a worktree_path (proving the gate, not a missing worktree,
    // is what hides the pill).
    state.sessions.push({
      id: 'sess-todo-lane-graph',
      taskId: '${TODO_LANE_TASK_ID}',
      projectId: '${NO_ACTIVE_SESSION_PROJECT_ID}',
      pid: 9998,
      status: 'suspended',
      shell: 'bash',
      cwd: '/mock/worktrees/todo-lane-graph',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TODO_LANE_TASK_ID}',
      title: 'Todo Lane Graph Task',
      description: '',
      swimlane_id: laneIds['To Do'],
      position: 1,
      agent: 'claude',
      session_id: null,
      worktree_path: '/mock/worktrees/todo-lane-graph',
      branch_name: 'feature/todo-lane-graph',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${NO_ACTIVE_SESSION_PROJECT_ID}' };
  });
`;

test.describe('Commit graph availability without an active session', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(noActiveSessionPreConfig);
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('Graph pill is available with no active session and renders the pane in the no-session layout', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=No Active Session Graph Task')
      .first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    // The pill's mere visibility already proves the dialog opened in the view
    // header (the edit-mode title bar renders no quick-access pills at all).
    await expect(graphPill).toBeVisible();

    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('no-active-session commit')).toBeVisible();
    // No running PTY: TaskDetailBody's suspended-session branch shows the
    // resume control alongside the graph pane, not a live terminal.
    await expect(page.getByText('Resume session')).toBeVisible();

    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('Graph pill is hidden for a task in the To Do lane even though it has a worktree', async () => {
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Todo Lane Graph Task')
      .first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The folder pill (also gated on worktree_path) proves the task DOES
    // carry a worktree, so an absent Graph pill below is the lifecycle gate,
    // not a missing worktree_path.
    await expect(page.locator('[data-testid="branch-pill"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-toggle"]')).not.toBeVisible();

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
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
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(prBadgePreConfig);
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test("renders a PR badge on the commit matching the task's head_sha", async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Badge Graph Task')
      .first();
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const graphPill = page.locator('[data-testid="graph-toggle"]');
    await graphPill.click();
    await expect(page.locator('[data-testid="commit-graph-svg"]')).toBeVisible({ timeout: 10000 });

    const headCommitRow = page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'PR head commit' });
    await expect(headCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'PR #42' })).toBeVisible();

    // The base commit row must NOT carry the PR badge.
    const baseCommitRow = page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'PR base commit' });
    await expect(baseCommitRow.locator('[data-testid="commit-ref-badge"]').filter({ hasText: 'PR #42' })).toHaveCount(0);

    await graphPill.click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
