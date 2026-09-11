/**
 * UI tests for the Command Terminal's branch facts.
 *
 * Two things were measured against the wrong ref or snapshotted once:
 *
 *  1. The terminal's Changes panel passed the literal "HEAD" as its base, so
 *     the ahead/behind and the base badge resolved `origin/HEAD` (the remote's
 *     default branch) rather than the project's configured base. It now passes
 *     the effective default base branch.
 *  2. The branch pill was a spawn-time fact: reattaching to a live PTY never
 *     re-read HEAD, so a terminal reattached hundreds of times kept claiming
 *     whatever branch it first landed on. The layer now re-derives every
 *     window's branch from live HEAD (`git.worktreeHead`) on mount and on every
 *     diff-changed push, and mirrors each change to main.
 *
 * Mock harness (tests/ui/mock-electron-api.js): `window.__mockWorktreeHead`
 * drives the head read, `window.__mockSetTransientBranchCalls` records the
 * mirror, `window.__mockBranchSummaryCalls` records the panel's base, and
 * `window.__mockFireDiffChanged()` fires the watcher push.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-cmd-branch';
const PROJECT_PATH = '/mock/cmd-branch-project';

/** One project whose configured default base is `develop`, not the mock's `main`. */
function preConfig(): string {
  return `
    window.__mockGitDiff = { files: [], totalInsertions: 0, totalDeletions: 0 };
    // BranchHeader (which renders the base badge) shows once it has a branch.
    window.__mockBranchSummary = {
      currentBranch: 'feature/pill',
      ahead: 0,
      behind: 3,
      lastCommit: { hash: 'abc1234', subject: 'seed commit', timestamp: new Date().toISOString() },
    };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.config.git.defaultBaseBranch = 'develop';
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Command Terminal Branch Project',
        path: '${PROJECT_PATH}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-cmd-branch-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
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

interface BranchSummaryCall {
  baseBranch: string | null;
  projectPath: string | null;
}

async function branchSummaryCalls(page: Page): Promise<BranchSummaryCall[]> {
  return page.evaluate(() => (window as unknown as { __mockBranchSummaryCalls?: BranchSummaryCall[] }).__mockBranchSummaryCalls ?? []);
}

async function setTransientBranchCalls(page: Page): Promise<Array<{ sessionId: string; branch: string }>> {
  return page.evaluate(() => (window as unknown as { __mockSetTransientBranchCalls?: Array<{ sessionId: string; branch: string }> }).__mockSetTransientBranchCalls ?? []);
}

async function setMockWorktreeHead(page: Page, head: { branch: string | null; sha: string | null }): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockWorktreeHead?: unknown }).__mockWorktreeHead = value;
  }, head);
}

/** The project's transient entries (slot + sessionId + branch) from the live store. */
async function transientEntries(page: Page): Promise<Array<{ slot: string; sessionId: string; branch: string | null }>> {
  return page.evaluate((projectId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string; slot: string; sessionId: string; branch: string | null }> } } };
    }).__zustandStores;
    const map = stores?.session?.getState().transientSessions ?? {};
    return Object.values(map)
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => ({ slot: entry.slot, sessionId: entry.sessionId, branch: entry.branch }));
  }, PROJECT_ID);
}

async function openCommandTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toBeVisible();
  // The cold spawn has written its entry once the pill names a branch.
  await expect.poll(async () => (await transientEntries(page))[0]?.branch, { timeout: 8000 }).toBeTruthy();
}

test.describe('Command Terminal: Changes panel base', () => {
  test('measures against the effective default base branch, never "HEAD", and the badge names it', async () => {
    const { browser, page } = await launchWithState(preConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openCommandTerminal(page);

      await page.getByTestId('command-bar-changes-toggle').click();

      // The panel's mount fetch and its remote-refresh fetch both carry the base.
      await expect.poll(async () => (await branchSummaryCalls(page)).length, { timeout: 8000 }).toBeGreaterThan(0);
      const calls = await branchSummaryCalls(page);
      expect(calls.every((call) => call.baseBranch === 'develop')).toBe(true);
      expect(calls.some((call) => call.baseBranch === 'HEAD')).toBe(false);

      const badge = page.getByTestId('changes-base-label');
      await expect(badge).toHaveText('develop', { timeout: 8000 });
      // No task behind a Command Terminal, so the base is always the project default.
      await expect(badge).toHaveAttribute('title', 'Based on develop, the project default');
    } finally {
      await browser.close();
    }
  });
});

test.describe('Command Terminal: branch pill follows live HEAD', () => {
  test('reopening the layer re-derives the pill from HEAD and mirrors the change to main', async () => {
    const { browser, page } = await launchWithState(preConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openCommandTerminal(page);

      // The mock spawn stamps `main`; the checkout has since moved.
      const [entry] = await transientEntries(page);
      expect(entry.branch).toBe('main');
      await expect(page.getByTestId('branch-picker-chip')).toContainText('main');
      await setMockWorktreeHead(page, { branch: 'feature/pill', sha: 'abc1234def' });

      // Hide (every PTY stays alive) and reopen: the reattach path.
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeHidden();
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      await expect(page.getByTestId('branch-picker-chip')).toContainText('feature/pill', { timeout: 8000 });
      // Same PTY, corrected branch: a reattach re-reads, it never respawns.
      await expect.poll(async () => (await transientEntries(page))[0], { timeout: 8000 })
        .toEqual({ slot: entry.slot, sessionId: entry.sessionId, branch: 'feature/pill' });
      await expect.poll(async () => await setTransientBranchCalls(page), { timeout: 8000 })
        .toEqual([{ sessionId: entry.sessionId, branch: 'feature/pill' }]);
    } finally {
      await browser.close();
    }
  });

  test('a diff-changed push while the layer is open updates the pill without a reopen', async () => {
    const { browser, page } = await launchWithState(preConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openCommandTerminal(page);
      await expect(page.getByTestId('branch-picker-chip')).toContainText('main');

      // An agent inside the terminal ran `git checkout`; the watcher fires.
      await setMockWorktreeHead(page, { branch: 'release/2.0', sha: 'def5678abc' });
      await page.evaluate(() => (window as unknown as { __mockFireDiffChanged: () => void }).__mockFireDiffChanged());

      await expect(page.getByTestId('branch-picker-chip')).toContainText('release/2.0', { timeout: 8000 });

      // A detached HEAD reads as its short sha, never as the branch it left.
      await setMockWorktreeHead(page, { branch: null, sha: '0123456789abcdef' });
      await page.evaluate(() => (window as unknown as { __mockFireDiffChanged: () => void }).__mockFireDiffChanged());
      await expect(page.getByTestId('branch-picker-chip')).toContainText('0123456', { timeout: 8000 });

      // An unknown HEAD (git error) leaves the last reading in place.
      await setMockWorktreeHead(page, { branch: null, sha: null });
      await page.evaluate(() => (window as unknown as { __mockFireDiffChanged: () => void }).__mockFireDiffChanged());
      await expect(page.getByTestId('branch-picker-chip')).toContainText('0123456');
    } finally {
      await browser.close();
    }
  });
});
