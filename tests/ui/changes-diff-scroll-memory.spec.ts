/**
 * UI tests for the Changes view diff scroll memory.
 *
 * Verifies that opening a file for the first time reveals its first change
 * centered (so a change deep in the file is scrolled into view and the top of
 * the file is virtualized away), and that switching away and back restores the
 * previous scroll position instead of re-revealing the first change.
 *
 * Monaco virtualizes lines: only visible lines exist as `.view-line` DOM nodes,
 * so DOM presence of a token is a proxy for "scrolled to that region". The diff
 * is computed client-side from the mock's original/modified strings, so no real
 * git is involved; the fixture is seeded via window.__mockGitDiff.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-diff-scroll';
const TASK_ID = 'task-diff-scroll';
const SESSION_ID = 'sess-diff-scroll';

const TOP_TOKEN = 'TOP_OF_FILE_TOKEN_AAA';
const MID_TOKEN = 'MID_CHANGE_TOKEN_ZZZ';
const TOTAL_LINES = 200;
const CHANGE_LINE = 100;

// Build a long file whose only change sits deep in the middle (line 100), with a
// recognizable token on line 1 so we can tell whether the viewport is at the top.
function buildFixtureScript(): string {
  return `
    (function () {
      var lines = [];
      for (var i = 1; i <= ${TOTAL_LINES}; i++) {
        if (i === 1) { lines.push('// ${TOP_TOKEN} line ' + i); }
        else if (i === ${CHANGE_LINE}) { lines.push('const filler = ' + i + ';'); }
        else { lines.push('// filler line ' + i); }
      }
      var original = lines.join('\\n');
      var modifiedLines = lines.slice();
      modifiedLines[${CHANGE_LINE} - 1] = 'const value = "${MID_TOKEN}";';
      var modified = modifiedLines.join('\\n');
      window.__mockGitDiff = {
        files: [
          { path: 'alpha.ts', status: 'M', insertions: 1, deletions: 1, original: original, modified: modified, language: 'typescript' },
          { path: 'beta.ts', status: 'M', insertions: 1, deletions: 0, original: 'const a = 1;', modified: 'const a = 1;\\nconst b = 2;', language: 'typescript' },
        ],
      };
    })();
  `;
}

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Diff Scroll Test',
      path: '/mock/diff-scroll-test',
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
      cwd: '/mock/diff-scroll-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Diff Scroll Task',
      description: 'Task used for diff scroll memory test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diff-scroll',
      branch_name: 'feature/diff-scroll',
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
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(buildFixtureScript());

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes view: diff scroll memory', () => {
  test('first open reveals the first change centered; revisit restores scroll', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Diff Scroll Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Open the Changes panel; alpha.ts is auto-selected (first file).
    await page.locator('[data-testid="changes-toggle"]').click();
    // 10s, matching every other visibility wait in this test (below) and the
    // sibling commit-detail-selection.spec.ts: under CI worker contention the
    // panel mount + Monaco diff-editor construction can take longer than a
    // tight 5s budget (observed flake: failed at 6.5s, passed at 10.7s on
    // retry), so a fixed 5000ms here was simply tighter than everywhere else
    // that waits on the same locator.
    await page.locator('[data-testid="diff-editor-area"]').waitFor({ state: 'visible', timeout: 10000 });
    // Wait for Monaco to render diff content (rendered line nodes exist).
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });

    const midLine = page.locator('.view-line', { hasText: MID_TOKEN });
    const topLine = page.locator('.view-line', { hasText: TOP_TOKEN });

    // First visit: the change deep in the file is revealed (centered), so its
    // line is rendered and the virtualized top of the file is not.
    await expect(midLine).toBeVisible({ timeout: 10000 });
    await expect(topLine).toHaveCount(0);

    // Scroll to the top of the file so the saved position differs from the
    // first-change reveal. Focus the modified editor by clicking the revealed
    // change line, then jump to the top with Ctrl+Home (deterministic, unlike
    // wheel delta math which depends on the editor's height).
    await midLine.click();
    await page.keyboard.press('Control+Home');
    // TOP_TOKEN renders in both diff panes once at the top, so match the first.
    await expect(topLine.first()).toBeVisible({ timeout: 10000 });

    // Switch to beta.ts, then back to alpha.ts.
    await page.locator('button', { hasText: 'beta.ts' }).click();
    await expect(page.locator('.view-line', { hasText: 'const b = 2;' })).toBeVisible({ timeout: 10000 });

    await page.locator('button', { hasText: 'alpha.ts' }).click();

    // Revisit restores the saved top position: the top token is visible again
    // and the first-change line is NOT re-revealed.
    await expect(topLine.first()).toBeVisible({ timeout: 10000 });
    await expect(midLine).toHaveCount(0);

    // Use Control+Shift+W (capture-phase) rather than Escape: Monaco captured
    // focus via the click+Ctrl+Home sequence, so the bubble-phase Escape listener
    // on the task-detail window can be intercepted by Monaco on CI Linux.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
