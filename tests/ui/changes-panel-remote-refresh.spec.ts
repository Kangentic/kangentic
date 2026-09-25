/**
 * UI test for ChangesPanel's mount-only remote-refresh opt-in.
 *
 * Background: `fetchBranchSummary` is the cheap, local-only branch context
 * fired on mount and on every fs.watch refetch. `refreshBranchSummaryFromRemote`
 * is a SEPARATE call, fired once per panel identity (mount only), that opts
 * into the handler's throttled `refreshRemote: true` fetch so `behind` reflects
 * the real remote rather than the last time anyone fetched. The two must never
 * merge: an fs.watch-driven refetch that started passing `refreshRemote: true`
 * would turn every keystroke in the working tree into network I/O. See
 * src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx.
 *
 * This spec pins two properties, via the mock's `__mockBranchSummaryCalls` log
 * (tests/ui/mock-electron-api.js):
 *   1. Mount fires at least one `branchSummary` call with `refreshRemote: true`
 *      (proves the opt-in actually reaches the IPC call, not just exists in
 *      source).
 *   2. A burst of fs.watch (`onDiffChanged`) fires produces MORE branchSummary
 *      traffic (proves the watcher path is live, not a vacuous "nothing fired"
 *      pass) but the refreshRemote:true COUNT never grows past its mount-time
 *      value (proves the watcher path stays flagless).
 *
 * Counts are asserted as DELTAS around the fs.watch burst, not fixed absolutes,
 * because React 19 StrictMode double-invokes the mount effect in dev - the
 * ChangesPanel.tsx comment ("hmr-safe: ... accepted") already documents that a
 * remount re-running the mount-only effect is expected behavior, so a rigid
 * "exactly one true call" assertion would be pinned to an artifact of
 * StrictMode rather than the property under test.
 *
 * Tier: UI (headless Chromium). No PTY or real git needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-branch-summary-refresh-${RUN_ID}`;
const TASK_ID = `task-branch-summary-refresh-${RUN_ID}`;
const SESSION_ID = `sess-branch-summary-refresh-${RUN_ID}`;

interface MockBranchSummaryCall {
  worktreePath: string | null;
  projectPath: string | null;
  baseBranch: string | null;
  refreshRemote: boolean;
}

async function getBranchSummaryCalls(page: Page): Promise<MockBranchSummaryCall[]> {
  return page.evaluate(() => (window as unknown as { __mockBranchSummaryCalls?: MockBranchSummaryCall[] }).__mockBranchSummaryCalls ?? []);
}

/** Poll until the call log stops growing (two consecutive reads, spaced apart,
 *  agree), then return the settled length. Mirrors the "poll for scrollback
 *  length to stop growing" pattern for a call-count instead of PTY output. */
async function waitForStableBranchSummaryCallCount(page: Page): Promise<number> {
  let lastLength = -1;
  await expect
    .poll(
      async () => {
        const length = (await getBranchSummaryCalls(page)).length;
        const stable = length === lastLength && length > 0;
        lastLength = length;
        return stable;
      },
      { timeout: 5000, intervals: [150, 150, 150, 150, 150] },
    )
    .toBe(true);
  return lastLength;
}

async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockGitDiff = { files: [] };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Branch Summary Refresh Test ${RUN_ID}',
        path: '/mock/branch-summary-refresh-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-branch-summary-refresh-' + s.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
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
        cwd: '/mock/branch-summary-refresh-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Branch Summary Refresh Task ${RUN_ID}',
        description: 'Task used for the ChangesPanel mount-only remote-refresh test',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/branch-summary-refresh-${RUN_ID}',
        branch_name: 'feature/branch-summary-refresh',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Changes panel: mount-only remote-refresh opt-in', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('fires refreshRemote only at mount, never on an fs.watch refetch', async () => {
    const card = page
      .locator(`[data-swimlane-name="Code Review"]`)
      .locator(`text=Branch Summary Refresh Task ${RUN_ID}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.locator('[data-testid="changes-file-tree"]').waitFor({ state: 'visible', timeout: 8000 });

    // Mount settles: both the flagless fetchBranchSummary and the
    // refreshRemote:true refreshBranchSummaryFromRemote have fired (possibly
    // twice each under StrictMode's dev double-invoke).
    const mountCallCount = await waitForStableBranchSummaryCallCount(page);
    const callsAtMount = await getBranchSummaryCalls(page);
    expect(callsAtMount.length).toBe(mountCallCount);

    const trueCountAtMount = callsAtMount.filter((call) => call.refreshRemote).length;
    // Property 1: the opt-in genuinely reaches the IPC call at mount.
    expect(trueCountAtMount).toBeGreaterThanOrEqual(1);
    // A flagless call fired too - the two paths are separate calls, not one
    // call that merged the flag in.
    expect(callsAtMount.length).toBeGreaterThan(trueCountAtMount);

    // Fire a burst of fs.watch triggers (mirrors a rapid multi-file write).
    await page.evaluate(() => {
      const fire = (window as unknown as { __mockFireDiffChanged?: () => void }).__mockFireDiffChanged;
      fire?.();
      fire?.();
      fire?.();
    });

    // Property 2 (anti-vacuity half): the watcher path is actually live - more
    // branchSummary traffic follows the burst.
    await expect
      .poll(async () => (await getBranchSummaryCalls(page)).length, { timeout: 5000 })
      .toBeGreaterThan(mountCallCount);

    // Property 2 (the property under test): none of that new traffic carried
    // refreshRemote:true. A watcher-driven refetch must stay flagless.
    const callsAfterWatch = await getBranchSummaryCalls(page);
    const trueCountAfterWatch = callsAfterWatch.filter((call) => call.refreshRemote).length;
    expect(trueCountAfterWatch).toBe(trueCountAtMount);

    // Close panel + dialog so state does not leak to other tests.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
