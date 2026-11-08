/**
 * UI test for the Changes panel's base-branch divergence label (folded in
 * from #345).
 *
 * The Uncommitted detail's branch header shows a small label next to the
 * branch name: "off <base>" when the task's base branch matches the project
 * default (config.git.defaultBaseBranch, 'main' in the mock config), or
 * "based on <base>" when the task was cut from a custom base branch. The
 * label only renders in the Uncommitted detail (never in commit-detail).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-base-label';
const DEFAULT_BASE_TASK_ID = 'task-base-label-default';
const CUSTOM_BASE_TASK_ID = 'task-base-label-custom';
const DEFAULT_BASE_SESSION_ID = 'sess-base-label-default';
const CUSTOM_BASE_SESSION_ID = 'sess-base-label-custom';
const TAG_BASE_TASK_ID = 'task-base-label-tag';
const TAG_BASE_SESSION_ID = 'sess-base-label-tag';

const HEX_TAG_NAME = '202401011200ab';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/index.ts', status: 'M', insertions: 1, deletions: 1, original: 'old', modified: 'new', language: 'typescript' },
    ],
    totalInsertions: 1,
    totalDeletions: 1,
  };

  // BranchHeader (and therefore the base-label chip it renders) only shows
  // once it has a branch or last commit to display.
  window.__mockBranchSummary = {
    currentBranch: 'feature/base-label',
    ahead: 0,
    behind: 0,
    lastCommit: { hash: 'abc1234', subject: 'seed commit', timestamp: new Date().toISOString() },
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Base Label Test',
      path: '/mock/base-label-test',
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
      id: '${DEFAULT_BASE_SESSION_ID}',
      taskId: '${DEFAULT_BASE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/base-label-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${DEFAULT_BASE_TASK_ID}',
      title: 'Default Base Task',
      description: 'Cut from the project default base branch',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${DEFAULT_BASE_SESSION_ID}',
      worktree_path: '/mock/worktrees/base-label-default',
      branch_name: 'feature/base-label-default',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${CUSTOM_BASE_SESSION_ID}',
      taskId: '${CUSTOM_BASE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/base-label-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${CUSTOM_BASE_TASK_ID}',
      title: 'Custom Base Task',
      description: 'Cut from a custom (non-default) base branch',
      swimlane_id: laneIds['Code Review'],
      position: 1,
      agent: 'claude',
      session_id: '${CUSTOM_BASE_SESSION_ID}',
      worktree_path: '/mock/worktrees/base-label-custom',
      branch_name: 'feature/base-label-custom',
      pr_number: null,
      pr_url: null,
      base_branch: 'release/2.0',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A task cut from a tag: main's git:resolveRef answer is seeded.
    window.__mockGitRefs = { 'v2.4.0': { kind: 'tag', sha: 'b'.repeat(40) } };
    state.sessions.push({
      id: '${TAG_BASE_SESSION_ID}',
      taskId: '${TAG_BASE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/base-label-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TAG_BASE_TASK_ID}',
      title: 'Tag Base Task',
      description: 'Cut from a release tag',
      swimlane_id: laneIds['Code Review'],
      position: 2,
      agent: 'claude',
      session_id: '${TAG_BASE_SESSION_ID}',
      worktree_path: '/mock/worktrees/base-label-tag',
      branch_name: 'feature/base-label-tag',
      pr_number: null,
      pr_url: null,
      base_branch: 'v2.4.0',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A tag whose name is 14 hex characters: only a commit base is shortened.
    window.__mockGitRefs['${HEX_TAG_NAME}'] = { kind: 'tag', sha: 'c'.repeat(40) };
    state.sessions.push({
      id: 'sess-base-label-hex-tag',
      taskId: 'task-base-label-hex-tag',
      projectId: '${PROJECT_ID}',
      pid: 9996,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/base-label-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: 'task-base-label-hex-tag',
      title: 'Hex Tag Base Task',
      description: 'Cut from a date-stamped tag',
      swimlane_id: laneIds['Code Review'],
      position: 3,
      agent: 'claude',
      session_id: 'sess-base-label-hex-tag',
      worktree_path: '/mock/worktrees/base-label-hex-tag',
      branch_name: 'feature/base-label-hex-tag',
      pr_number: null,
      pr_url: null,
      base_branch: '${HEX_TAG_NAME}',
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

test.describe('Changes panel: base-branch divergence label', () => {
  test('shows the bare branch name for a task cut from the project default base branch, with the full sentence on hover', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Default Base Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const badge = page.locator('[data-testid="changes-base-label"]');
    await expect(badge).toBeVisible({ timeout: 8000 });
    // The visible pill is just the branch name - no "off"/"based on" verb.
    await expect(badge).toHaveText('main');
    await expect(badge).toHaveAccessibleDescription('Based on main, the project default');
    // Default base uses the subdued tone, matching the graph's own base-ref badge.
    await expect(badge).toHaveClass(/border-edge-subtle/);
    await expect(badge).not.toHaveClass(/border-accent/);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('shows the bare branch name for a task cut from a custom base branch, with the full sentence on hover', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Custom Base Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const badge = page.locator('[data-testid="changes-base-label"]');
    await expect(badge).toBeVisible({ timeout: 8000 });
    await expect(badge).toHaveText('release/2.0');
    await expect(badge).toHaveAccessibleDescription('Based on release/2.0, not the project default');
    // Custom base uses the accent tone - the more surprising case, meant to draw the eye.
    await expect(badge).toHaveClass(/border-accent/);
    await expect(badge).not.toHaveClass(/border-edge-subtle/);
    // A branch base draws no kind icon.
    await expect(badge).toHaveAttribute('data-base-kind', 'branch');
    await expect(badge.locator('svg')).toHaveCount(0);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('marks a base that is a tag with the tag icon', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Tag Base Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const badge = page.locator('[data-testid="changes-base-label"]');
    await expect(badge).toHaveText('v2.4.0');
    await expect(badge).toHaveAttribute('data-base-kind', 'tag');
    await expect(badge.locator('svg')).toHaveCount(1);
    await expect(badge).toHaveAccessibleDescription('Based on v2.4.0, not the project default');

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('shows a tag named with 14 hex characters whole, not cut to a short SHA', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Hex Tag Base Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    const badge = page.locator('[data-testid="changes-base-label"]');
    await expect(badge).toHaveAttribute('data-base-kind', 'tag');
    await expect(badge).toHaveText(HEX_TAG_NAME);

    // The passive readers never ask main to fetch a tag.
    const fetchingCalls = await page.evaluate(
      () => (window as unknown as { __mockGitResolveRefCalls?: Array<{ fetchTag: boolean }> }).__mockGitResolveRefCalls?.filter((call) => call.fetchTag) ?? [],
    );
    expect(fetchingCalls).toEqual([]);

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
