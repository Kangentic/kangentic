/**
 * UI tests for a History row's hash link-out (CommitGraphPanel's CommitHash).
 *
 * Main stamps `webUrl` on a commit the repository's web host has, and names
 * the host in `webProviderName`, through the PR connector that claims the
 * primary remote. A row whose commit has one renders its hash as its own
 * button that opens the commit there; the rest of the row still selects. A
 * commit the remote does not have (pushed nowhere yet) keeps a plain hash.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-hash-link';
const TASK_ID = 'task-hash-link';
const SESSION_ID = 'sess-hash-link';
const PUSHED_COMMIT = 'c0ffee00112233445566778899aabbccddeeff00';
const LOCAL_COMMIT = 'deadc0de112233445566778899aabbccddeeff00';
const PUSHED_URL = `https://github.com/example/example/commit/${PUSHED_COMMIT}`;

const preConfig = `
  window.__mockGitDiff = {
    files: [{ path: 'src/working.ts', status: 'M', insertions: 1, deletions: 1, original: 'a', modified: 'b', language: 'typescript' }],
    totalInsertions: 1,
    totalDeletions: 1,
  };
  window.__mockCommitGraph = {
    commits: [
      { hash: '${LOCAL_COMMIT}', shortHash: 'deadc0d', parents: ['${PUSHED_COMMIT}'], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'not pushed yet', webUrl: null },
      { hash: '${PUSHED_COMMIT}', shortHash: 'c0ffee0', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'already on the remote', webUrl: '${PUSHED_URL}' },
    ],
    tipHash: '${LOCAL_COMMIT}',
    baseHash: '${PUSHED_COMMIT}',
    mergeBaseHash: '${PUSHED_COMMIT}',
    currentBranch: 'feature/hash-link',
    truncated: false,
    webProviderName: 'GitHub',
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Hash Link Test', path: '/mock/hash-link-test', github_url: null,
      default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-hl-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9981, status: 'running',
      shell: 'bash', cwd: '/mock/hash-link-test', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Hash Link Task', description: '', swimlane_id: laneIds['Code Review'],
      position: 0, agent: 'claude', session_id: '${SESSION_ID}', worktree_path: '/mock/worktrees/hash-link',
      branch_name: 'feature/hash-link', pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithHistory(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Hash Link Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="changes-toggle"]').click();
  await page.locator('[data-testid="commit-graph-row"]').first().waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

function historyRow(page: Page, subject: string): Locator {
  return page.locator('[data-testid="commit-graph-row"]').filter({ hasText: subject });
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []);
}

test.describe('History row hash link-out', () => {
  test('a pushed commit\'s hash opens it on the host, and does not select the row', async () => {
    const { browser, page } = await launchWithHistory();
    try {
      const row = historyRow(page, 'already on the remote');
      const link = row.locator('[data-testid="commit-hash-link"]');
      await expect(link).toHaveText('c0ffee0');
      await expect(link).toHaveAccessibleName('Open c0ffee0 on GitHub');
      await expect(link).toHaveAccessibleDescription('Open on GitHub');

      await link.click();
      await expect.poll(() => openedUrls(page)).toEqual([PUSHED_URL]);
      // The hash is its own control: the row stays unselected, no bar appears.
      await expect(row.locator('[data-testid="commit-graph-row-select"]')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-testid="commit-selection-bar"]')).toHaveCount(0);

      // The rest of the row still selects it.
      await row.locator('[data-testid="commit-graph-row-select"]').click();
      await expect(page.locator('[data-testid="commit-selection-hash"]')).toHaveText('c0ffee0', { timeout: 10000 });
      expect(await openedUrls(page)).toEqual([PUSHED_URL]);
    } finally {
      await browser.close();
    }
  });

  test('a commit the remote does not have keeps a plain hash with no link', async () => {
    const { browser, page } = await launchWithHistory();
    try {
      const row = historyRow(page, 'not pushed yet');
      await expect(row).toContainText('deadc0d');
      await expect(row.locator('[data-testid="commit-hash-link"]')).toHaveCount(0);
      // The control: the pushed row in the same list does carry its link.
      await expect(historyRow(page, 'already on the remote').locator('[data-testid="commit-hash-link"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });
});
