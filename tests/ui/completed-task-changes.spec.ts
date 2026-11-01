/**
 * UI tests for a completed task's Changes tab and the parts of its view that
 * read what the task changed from git (`git:taskChanges`).
 *
 * The tab is the live task's Changes panel over the task's commits, never a
 * working tree: at rest it lists the files of the task's whole change (a range
 * when its commits landed as one run), a History row narrows it to one commit,
 * and nothing in it watches, blames or asks the checkout for a branch summary.
 * With no single range the commits are listed on their own, and a file opens in
 * the newest commit that touched it. The Summary's commit and file rows open the
 * tab, the header strip takes the range's totals, and a task with nothing to
 * show says why in one line.
 *
 * Seeds: `window.__mockTaskChanges[taskId]` is the resolver's answer,
 * `__mockGitDiffByRange['<base>..<head>']` the range's file contents, and
 * `__mockGitDiffByCommit[oid]` one commit's files.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-completed-changes';
const TASK_ID = 'task-completed-changes';
const PROJECT_PATH = '/mock/completed-changes';

const RANGE_BASE = '47df392aa1b2c3d4e5f60718293a4b5c6d7e8f90';
const NEWEST = 'f4657fdaa1b2c3d4e5f60718293a4b5c6d7e8f90';
const MIDDLE = '4f6fb55aa1b2c3d4e5f60718293a4b5c6d7e8f90';
const OLDEST = '0c1d2e3aa1b2c3d4e5f60718293a4b5c6d7e8f90';

interface SeedCommit { hash: string; subject: string }

function graphCommit(commit: SeedCommit, parent: string) {
  return {
    hash: commit.hash,
    shortHash: commit.hash.slice(0, 7),
    parents: [parent],
    authorName: 'Ada',
    authorTimestamp: '2026-10-13T05:00:00.000Z',
    subject: commit.subject,
    webUrl: `https://github.com/example/example/commit/${commit.hash}`,
  };
}

const COMMITS: SeedCommit[] = [
  { hash: NEWEST, subject: 'docs: describe the range read' },
  { hash: MIDDLE, subject: 'feat: read a completed task from git' },
  { hash: OLDEST, subject: 'test: pin the resolver' },
];

/** The range answer: three commits that landed as one run. */
function landedChanges() {
  return {
    range: { base: RANGE_BASE, head: NEWEST },
    commits: [graphCommit(COMMITS[0], MIDDLE), graphCommit(COMMITS[1], OLDEST), graphCommit(COMMITS[2], RANGE_BASE)],
    truncated: false,
    files: [
      { path: 'src/main/git/task-changes.ts', status: 'A', insertions: 410, deletions: 0 },
      { path: 'src/renderer/changes/ChangesPanel.tsx', status: 'M', insertions: 120, deletions: 80 },
      { path: 'docs/architecture.md', status: 'M', insertions: 36, deletions: 24 },
    ],
    totals: { insertions: 566, deletions: 104, filesChanged: 3 },
    emptyReason: null,
    branchName: null,
    baseBranch: 'main',
    projectPath: PROJECT_PATH,
    webProviderName: 'GitHub',
  };
}

/** No single range: two commits with a commit of another task between them. */
function unionChanges() {
  return {
    range: null,
    commits: [graphCommit(COMMITS[0], MIDDLE), graphCommit(COMMITS[2], RANGE_BASE)],
    truncated: false,
    files: [
      { path: 'docs/architecture.md', status: 'M', insertions: 30, deletions: 2, newestCommitSha: NEWEST },
      { path: 'tests/unit/task-changes.test.ts', status: 'A', insertions: 12, deletions: 0, newestCommitSha: OLDEST },
    ],
    totals: null,
    emptyReason: null,
    branchName: null,
    baseBranch: 'main',
    projectPath: PROJECT_PATH,
    webProviderName: null,
  };
}

/** A report whose knowledge links the three commits, so the Summary lists them. */
function report() {
  const summary = {
    sessionId: 'sess-completed-changes', totalCostUsd: 3.2, totalInputTokens: 1_200_000, totalOutputTokens: 40_000,
    modelDisplayName: 'Opus 5.5', durationMs: 1_800_000, toolCallCount: 120, compactionCount: 0,
    // The figure stored while the run worked: the strip shows git's when a range resolves.
    linesAdded: 469, linesRemoved: 181, filesChanged: 18,
    taskCreatedAt: '2026-10-13T03:00:00.000Z', startedAt: '2026-10-13T03:04:00.000Z', exitedAt: '2026-10-13T05:03:00.000Z',
    exitCode: 0, toolBreakdown: [],
  };
  return {
    summary,
    startedAt: '2026-10-13T03:04:00.000Z',
    endedAt: '2026-10-13T05:03:00.000Z',
    route: [],
    conversations: [],
    models: [],
    modelFallback: [],
    backgroundCalls: [],
    totals: {
      runs: { runCount: 0, runtimeMs: null, costUsd: null, toolCallCount: 0, compactionCount: 0 },
      models: { turns: 0, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      backgroundCalls: { durationMs: null, costUsd: null, tokens: null },
    },
    knowledge: {
      commits: COMMITS.map((commit) => ({ ...commit, sha: commit.hash, committedAt: '2026-10-13T05:00:00.000Z' })),
      commitCount: COMMITS.length,
      changedFiles: ['src/main/git/task-changes.ts'],
      changedFileCount: 1,
    },
    summaryState: { kind: 'written', text: 'Read a completed task from git.' },
  };
}

function preConfig(changes: object | null): string {
  const rangeContents = {
    [`${RANGE_BASE}..${NEWEST}`]: {
      files: [
        { path: 'src/main/git/task-changes.ts', status: 'A', original: '', modified: 'export const RANGE_CONTENT_MARKER = 1;', language: 'typescript' },
        { path: 'src/renderer/changes/ChangesPanel.tsx', status: 'M', original: 'old', modified: 'new', language: 'typescript' },
        { path: 'docs/architecture.md', status: 'M', original: 'old', modified: 'new', language: 'markdown' },
      ],
    },
  };
  const commitContents = {
    [MIDDLE]: {
      files: [{ path: 'src/renderer/changes/ChangesPanel.tsx', status: 'M', insertions: 120, deletions: 80, original: 'old', modified: 'new', language: 'typescript' }],
    },
    [NEWEST]: {
      files: [{ path: 'docs/architecture.md', status: 'M', insertions: 30, deletions: 2, original: 'old', modified: 'new', language: 'markdown' }],
    },
    [OLDEST]: {
      files: [{ path: 'tests/unit/task-changes.test.ts', status: 'A', insertions: 12, deletions: 0, original: '', modified: 'test', language: 'typescript' }],
    },
  };
  return `
    window.__mockTaskChanges = ${changes ? JSON.stringify({ [TASK_ID]: changes }) : '{}'};
    window.__mockGitDiffByRange = ${JSON.stringify(rangeContents)};
    window.__mockGitDiffByCommit = ${JSON.stringify(commitContents)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Completed Changes', path: '${PROJECT_PATH}', github_url: null,
        default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push(Object.assign({}, template, { id: 'lane-cc-' + index, position: index, created_at: ts }));
      });
      var doneLane = state.swimlanes.find(function (lane) { return lane.role === 'done'; });
      state.archivedTasks.push({
        id: '${TASK_ID}', title: 'Completed Changes Task', description: 'Read from git', swimlane_id: doneLane.id,
        position: 0, agent: null, session_id: null, worktree_path: null, branch_name: null, pr_number: null,
        pr_url: null, pr_state: null, base_branch: 'main', use_worktree: null, attachment_count: 0,
        archived_at: ts, created_at: ts, updated_at: ts,
      });
      state.taskReportCache['${TASK_ID}'] = ${JSON.stringify(report())};
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(changes: object | null): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(changes));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Count calls to git bridge methods while the original still runs. The
 * renderer reads `window.electronAPI.git.<method>` at call time, so a wrap
 * installed after load is seen.
 */
async function recordGitCalls(page: Page, methods: string[]): Promise<void> {
  await page.evaluate((names) => {
    const scope = window as unknown as {
      electronAPI: { git: Record<string, (...args: unknown[]) => unknown> };
      __gitCalls: Record<string, unknown[][]>;
    };
    scope.__gitCalls = {};
    for (const name of names) {
      const original = scope.electronAPI.git[name];
      scope.electronAPI.git[name] = (...args: unknown[]) => {
        (scope.__gitCalls[name] ??= []).push(args);
        return original.apply(scope.electronAPI.git, args);
      };
    }
  }, methods);
}

async function gitCalls(page: Page, method: string): Promise<unknown[][]> {
  return page.evaluate((name) => (window as unknown as { __gitCalls: Record<string, unknown[][]> }).__gitCalls[name] ?? [], method);
}

/**
 * Hold every `git.diffFiles` call that carries a `commitOid` (a History
 * commit's file list) until the test releases it, then deliver the real reply.
 * The renderer reads `window.electronAPI.git.diffFiles` at call time, so a wrap
 * installed after load is seen. Calls without a `commitOid` pass straight
 * through.
 */
async function holdCommitReplies(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface HeldReply { commitOid: string; delivered: boolean; release: () => void }
    const scope = window as unknown as {
      electronAPI: { git: { diffFiles: (request: { commitOid?: string }) => Promise<unknown> } };
      __heldCommitReplies: HeldReply[];
    };
    scope.__heldCommitReplies = [];
    const original = scope.electronAPI.git.diffFiles;
    scope.electronAPI.git.diffFiles = async (request) => {
      if (!request?.commitOid) return original.call(scope.electronAPI.git, request);
      const held: HeldReply = { commitOid: request.commitOid, delivered: false, release: () => {} };
      const gate = new Promise<void>((resolve) => { held.release = resolve; });
      scope.__heldCommitReplies.push(held);
      const reply = await original.call(scope.electronAPI.git, request);
      await gate;
      held.delivered = true;
      return reply;
    };
  });
}

async function heldCommitReplies(page: Page): Promise<Array<{ commitOid: string; delivered: boolean }>> {
  return page.evaluate(() => {
    const scope = window as unknown as { __heldCommitReplies: Array<{ commitOid: string; delivered: boolean }> };
    return scope.__heldCommitReplies.map((held) => ({ commitOid: held.commitOid, delivered: held.delivered }));
  });
}

/**
 * Deliver every held reply, wait until the renderer's await has been handed it,
 * then let React paint two frames so a state write the reply makes has landed
 * before the caller asserts that nothing changed.
 */
async function releaseHeldCommitReplies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __heldCommitReplies: Array<{ release: () => void }> };
    for (const held of scope.__heldCommitReplies) held.release();
  });
  await expect.poll(async () => (await heldCommitReplies(page)).every((held) => held.delivered)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * A pop-out window's page, booted the way the window engine boots one: the
 * descriptor names the surface and its params before the renderer mounts. The
 * git recorder is installed before boot too, since a pop-out root subscribes
 * on its first effect.
 */
async function launchPopOut(changes: object, descriptor: { kind: string; params: Record<string, unknown> }): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(changes));
  await page.addInitScript(`
    window.electronAPI.popOut.descriptor = ${JSON.stringify(descriptor)};
    window.__gitCalls = {};
    ['subscribeDiff', 'diffFiles', 'fileContent', 'branchSummary'].forEach(function (name) {
      var original = window.electronAPI.git[name];
      window.electronAPI.git[name] = function () {
        (window.__gitCalls[name] = window.__gitCalls[name] || []).push(Array.prototype.slice.call(arguments));
        return original.apply(window.electronAPI.git, arguments);
      };
    });
  `);
  await gotoVite(page, VITE_URL);
  return { browser, page };
}

async function openCompletedTask(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('text=Completed Changes Task').click();
  await expect(page.locator('[data-testid="completed-task-view"]')).toBeVisible({ timeout: 5000 });
}

async function openChangesTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.locator('[data-testid="completed-panel-changes"]')).toBeVisible();
}

function fileRow(page: Page, filePath: string) {
  return page.locator(`[data-testid="completed-panel-changes"] [data-testid="changes-file-row"][data-path="${filePath}"]`);
}

test.describe('Completed task: Changes tab over a landed range', () => {
  test('at rest it lists the range\'s files and reads none of the checkout', async () => {
    const { browser, page } = await launch(landedChanges());
    try {
      await recordGitCalls(page, ['subscribeDiff', 'branchSummary', 'blame', 'fileHistory', 'commitGraph', 'diffFiles', 'fileContent']);
      await openCompletedTask(page);
      await openChangesTab(page);

      const panel = page.locator('[data-testid="completed-panel-changes"]');
      for (const filePath of ['src/main/git/task-changes.ts', 'src/renderer/changes/ChangesPanel.tsx', 'docs/architecture.md']) {
        await expect(fileRow(page, filePath)).toBeVisible({ timeout: 10000 });
      }
      // No working tree, so no Working / Staged / Branch.
      await expect(panel.locator('[data-testid="changes-scope-select"]')).toHaveCount(0);

      // History arrives open with the task's commits, counted for the task.
      const historyToggle = panel.locator('[data-testid="changes-history-toggle"]');
      await expect(historyToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(panel.locator('[data-testid="commit-graph-row"]')).toHaveCount(3);
      await expect(historyToggle.locator('[data-testid="changes-history-count"]')).toHaveText('3');
      await expect(historyToggle.locator('[data-testid="changes-history-count"]').locator('..')).toHaveAccessibleDescription('3 commits for this task');
      // Each hash links out, the panel's History stamped from the result.
      await expect(panel.locator('[data-testid="commit-hash-link"]')).toHaveCount(3);

      // A file's diff reads the range, both sides from commits.
      await fileRow(page, 'src/main/git/task-changes.ts').getByRole('button').first().click();
      await expect(page.locator('[data-testid="diff-editor-area"]')).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => (await gitCalls(page, 'fileContent')).length).toBeGreaterThan(0);
      for (const [request] of await gitCalls(page, 'fileContent')) {
        expect(request).toMatchObject({ range: { base: RANGE_BASE, head: NEWEST }, projectPath: PROJECT_PATH });
        expect((request as { worktreePath?: string }).worktreePath).toBeUndefined();
      }

      // Nothing asked the checkout: no watch, no branch summary, no blame, no
      // per-file history, no live graph, and the files came with the result.
      for (const method of ['subscribeDiff', 'branchSummary', 'blame', 'fileHistory', 'commitGraph', 'diffFiles']) {
        expect(await gitCalls(page, method), method).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  });

  test('a History row narrows the list to its commit; the x and Escape go back to all changes', async () => {
    // A cold app launch, then five waits of 8 to 10 s each, inside the UI
    // project's 15 s budget. It failed on CI at exactly 15 s as a shard's first
    // test and passed on its retry, which --fail-on-flaky-tests counts as a
    // failure. test.slow() triples the enclosing budget; each wait still waits
    // on real DOM state, never a fixed sleep.
    test.slow();
    const { browser, page } = await launch(landedChanges());
    try {
      await openCompletedTask(page);
      await openChangesTab(page);
      const panel = page.locator('[data-testid="completed-panel-changes"]');
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });

      await panel.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'feat: read a completed task from git' })
        .locator('[data-testid="commit-graph-row-select"]').click();
      const bar = panel.locator('[data-testid="commit-selection-bar"]');
      await expect(bar.locator('[data-testid="commit-selection-hash"]')).toHaveText('4f6fb55', { timeout: 10000 });
      await expect(panel.locator('[data-testid="commit-selection-close"]')).toHaveAccessibleDescription('Back to all changes');
      await expect(fileRow(page, 'src/renderer/changes/ChangesPanel.tsx')).toBeVisible({ timeout: 10000 });
      await expect(fileRow(page, 'docs/architecture.md')).toHaveCount(0);

      await panel.locator('[data-testid="commit-selection-close"]').click();
      await expect(bar).toHaveCount(0);
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible();

      // Escape lets go of a selected commit and keeps the window; the next one closes it.
      await panel.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'test: pin the resolver' })
        .locator('[data-testid="commit-graph-row-select"]').click();
      await expect(bar).toBeVisible({ timeout: 10000 });
      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(page.locator('[data-testid="completed-task-view"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="completed-task-view"]')).toHaveCount(0, { timeout: 8000 });
    } finally {
      await browser.close();
    }
  });

  test('the strip shows the range\'s totals, not the figure stored while the run worked', async () => {
    const { browser, page } = await launch(landedChanges());
    try {
      await openCompletedTask(page);
      const changesMetric = page.locator('[data-testid="completed-metric-changes"]');
      await expect(changesMetric).toContainText('+566', { timeout: 10000 });
      await expect(changesMetric).toContainText('-104');
      await expect(changesMetric).toContainText('3 files');
      await expect(changesMetric).not.toContainText('+469');
    } finally {
      await browser.close();
    }
  });

  test('the Summary lists git\'s files with status and lines, and its rows open the Changes tab', async () => {
    const { browser, page } = await launch(landedChanges());
    try {
      await openCompletedTask(page);
      const filesCard = page.locator('[data-testid="completed-files-changed"]');
      const files = filesCard.locator('[data-testid="completed-changed-file"]');
      await expect(files).toHaveCount(3, { timeout: 10000 });
      // Git's files, biggest change first as the resolver sorted them, not the
      // index's one name.
      await expect(files.nth(0)).toContainText('src/main/git/task-changes.ts');
      await expect(files.nth(0)).toContainText('+410');
      await expect(files.nth(1)).toContainText('+120');
      await expect(files.nth(1)).toContainText('-80');
      // The row cuts its path short, so its tip is the whole path, with no
      // instruction: a click on a file row opening it needs no words.
      await expect(files.nth(0)).toHaveAccessibleDescription('src/main/git/task-changes.ts');

      // A file row opens the tab on that file, in the whole change.
      await files.nth(1).click();
      await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
      await expect(fileRow(page, 'src/renderer/changes/ChangesPanel.tsx')).toHaveAttribute('data-selected', 'true', { timeout: 10000 });
      await expect(page.locator('[data-testid="commit-selection-bar"]')).toHaveCount(0);

      // A commit row opens the tab on that commit.
      await page.getByRole('tab', { name: 'Summary' }).click();
      const commitRow = page.locator('[data-testid="completed-commits"] [data-testid="completed-commit-row"]').filter({ hasText: 'feat: read a completed task from git' });
      // Its tip is the subject and the exact time, as on a row that cannot open.
      await expect(commitRow).toHaveAccessibleDescription(/^feat: read a completed task from git\b/);
      await expect(commitRow).not.toHaveAccessibleDescription(/in Changes/);
      await commitRow.click();
      await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-testid="commit-selection-hash"]')).toHaveText('4f6fb55', { timeout: 10000 });
    } finally {
      await browser.close();
    }
  });
});

test.describe('Completed task: a selected History commit inside a landed range', () => {
  const letGoOfTheCommit = [
    ['the selection bar close button', async (page: Page) => { await page.locator('[data-testid="commit-selection-close"]').click(); }],
    ['Escape', async (page: Page) => { await page.keyboard.press('Escape'); }],
  ] as const;

  for (const [way, letGo] of letGoOfTheCommit) {
    test(`a commit's file list that lands after ${way} lets go of it is dropped`, async () => {
      const { browser, page } = await launch(landedChanges());
      try {
        await openCompletedTask(page);
        await openChangesTab(page);
        const panel = page.locator('[data-testid="completed-panel-changes"]');
        const rows = panel.locator('[data-testid="changes-file-row"]');
        await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });
        await expect(rows).toHaveCount(3);

        await holdCommitReplies(page);
        await panel.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'feat: read a completed task from git' })
          .locator('[data-testid="commit-graph-row-select"]').click();
        const bar = panel.locator('[data-testid="commit-selection-bar"]');
        await expect(bar).toBeVisible({ timeout: 10000 });
        // The commit's file list was asked for and is still on its way.
        await expect.poll(() => heldCommitReplies(page)).toEqual([{ commitOid: MIDDLE, delivered: false }]);

        // Let go of the commit before the reply lands: the panel shows the
        // task's whole change again, straight from the result.
        await letGo(page);
        await expect(bar).toHaveCount(0);
        await expect(rows).toHaveCount(3);
        await expect(fileRow(page, 'docs/architecture.md')).toBeVisible();

        // The late reply carries the commit's one file. It must not replace the
        // whole change's three, and the held call proves it was really late.
        await releaseHeldCommitReplies(page);
        await expect(rows).toHaveCount(3);
        await expect(fileRow(page, 'docs/architecture.md')).toBeVisible();
        await expect(fileRow(page, 'src/main/git/task-changes.ts')).toBeVisible();
        await expect(bar).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  }

  test('a selected commit\'s file content request drops the range, and at rest it carries it', async () => {
    const { browser, page } = await launch(landedChanges());
    try {
      await recordGitCalls(page, ['fileContent']);
      await openCompletedTask(page);
      await openChangesTab(page);
      const panel = page.locator('[data-testid="completed-panel-changes"]');
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });

      // At rest the panel opens its first file and reads it against the task's range.
      await expect.poll(async () => (await gitCalls(page, 'fileContent')).length, { timeout: 10000 }).toBeGreaterThan(0);
      const restRequests = await gitCalls(page, 'fileContent');
      for (const [request] of restRequests) {
        expect(request).toMatchObject({ range: { base: RANGE_BASE, head: NEWEST }, projectPath: PROJECT_PATH });
        expect((request as { commitOid?: string }).commitOid).toBeUndefined();
      }

      // Select a History commit and open its file: the request names the
      // commit alone, since a range would read the whole change instead.
      await panel.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'feat: read a completed task from git' })
        .locator('[data-testid="commit-graph-row-select"]').click();
      await expect(panel.locator('[data-testid="commit-selection-hash"]')).toHaveText('4f6fb55', { timeout: 10000 });
      await expect(fileRow(page, 'src/renderer/changes/ChangesPanel.tsx')).toBeVisible({ timeout: 10000 });
      await fileRow(page, 'src/renderer/changes/ChangesPanel.tsx').getByRole('button').first().click();
      await expect.poll(async () => (await gitCalls(page, 'fileContent')).length - restRequests.length, { timeout: 10000 }).toBeGreaterThan(0);

      const commitRequests = (await gitCalls(page, 'fileContent')).slice(restRequests.length);
      for (const [request] of commitRequests) {
        expect(request).toMatchObject({ commitOid: MIDDLE, projectPath: PROJECT_PATH });
        expect((request as { range?: unknown }).range).toBeUndefined();
      }
    } finally {
      await browser.close();
    }
  });
});

test.describe('Completed task: detached Changes windows', () => {
  test('a detached Changes window of a completed task lists the range\'s files and watches nothing', async () => {
    const { browser, page } = await launchPopOut(landedChanges(), { kind: 'changes', params: { taskId: TASK_ID, projectId: PROJECT_ID } });
    try {
      // The board holds no archived task, so the window reads the task's
      // changes from git and its row from the task's own project.
      for (const filePath of ['src/main/git/task-changes.ts', 'src/renderer/changes/ChangesPanel.tsx', 'docs/architecture.md']) {
        await expect(page.locator(`[data-testid="changes-file-row"][data-path="${filePath}"]`)).toBeVisible({ timeout: 15000 });
      }
      // The row arrived, so History shows the task's commits.
      await expect(page.locator('[data-testid="commit-graph-row"]')).toHaveCount(3, { timeout: 10000 });
      await expect(page.locator('[data-testid="changes-scope-select"]')).toHaveCount(0);
      for (const method of ['subscribeDiff', 'diffFiles', 'branchSummary']) {
        expect(await gitCalls(page, method), method).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  });

  test('a file window opened from a completed task reads the range and never subscribes to a working tree', async () => {
    const { browser, page } = await launchPopOut(landedChanges(), {
      kind: 'changes-file',
      params: {
        taskId: TASK_ID, projectId: PROJECT_ID, filePath: 'src/main/git/task-changes.ts',
        range: { base: RANGE_BASE, head: NEWEST }, projectPath: PROJECT_PATH, baseBranch: 'main',
        status: 'A', binary: false, taskDisplayId: 7, taskTitle: 'Completed Changes Task',
      },
    });
    try {
      await expect(page.locator('[data-testid="diff-editor-area"]')).toBeVisible({ timeout: 15000 });
      await expect.poll(async () => (await gitCalls(page, 'fileContent')).length).toBeGreaterThan(0);
      for (const [request] of await gitCalls(page, 'fileContent')) {
        expect(request).toMatchObject({ range: { base: RANGE_BASE, head: NEWEST }, filePath: 'src/main/git/task-changes.ts' });
      }
      for (const [request] of await gitCalls(page, 'diffFiles')) {
        expect(request).toMatchObject({ range: { base: RANGE_BASE, head: NEWEST } });
      }
      // A range is fixed commits: the window has nothing to watch.
      expect(await gitCalls(page, 'subscribeDiff')).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Completed task: Changes tab with no single range', () => {
  test('the commits are listed on their own, and a file opens in the newest commit that touched it', async () => {
    const { browser, page } = await launch(unionChanges());
    try {
      await openCompletedTask(page);
      // No range, so the strip keeps the stored figure.
      await expect(page.locator('[data-testid="completed-metric-changes"]')).toContainText('+469');
      await openChangesTab(page);
      const panel = page.locator('[data-testid="completed-panel-changes"]');
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });
      await expect(fileRow(page, 'tests/unit/task-changes.test.ts')).toBeVisible();
      // No diff of the whole change exists, so the diff area points at the commits.
      await expect(panel.locator('[data-testid="diff-select-commit"]')).toHaveText('Select a commit to see its changes');

      await fileRow(page, 'tests/unit/task-changes.test.ts').getByRole('button').first().click();
      await expect(panel.locator('[data-testid="commit-selection-hash"]')).toHaveText('0c1d2e3', { timeout: 10000 });
      await expect(page.locator('[data-testid="diff-editor-area"]')).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });
});

test.describe('Completed task: Changes tab with nothing to show', () => {
  for (const [reason, line] of [
    ['no-commits', 'No commits for this task'],
    ['indexing-off', 'Indexing is off, so no commits are linked'],
    ['not-in-clone', 'This task\'s commits are not in this clone'],
  ] as const) {
    test(`${reason} reads as one line under an icon`, async () => {
      const { browser, page } = await launch({ ...landedChanges(), range: null, commits: [], files: [], totals: null, emptyReason: reason });
      try {
        await openCompletedTask(page);
        await openChangesTab(page);
        await expect(page.locator(`[data-testid="completed-changes-empty-${reason}"]`)).toHaveText(line, { timeout: 10000 });
        await expect(page.locator('[data-testid="completed-panel-changes"] [data-testid="changes-file-tree"]')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  }

  test('a failed read says so, and Retry reads again', async () => {
    const { browser, page } = await launch({ reject: 'Error invoking remote method \'git:taskChanges\': Error: The index is restarting' });
    try {
      await openCompletedTask(page);
      await openChangesTab(page);
      const error = page.locator('[data-testid="completed-changes-error"]');
      // The bridge's prefix is stripped, as every other IPC error line is.
      await expect(error).toContainText('The index is restarting.', { timeout: 10000 });
      await expect(error).not.toContainText('remote method');

      await page.evaluate((taskId) => {
        (window as unknown as { __mockTaskChanges: Record<string, unknown> }).__mockTaskChanges[taskId] = {
          range: null, commits: [], files: [], totals: null, emptyReason: 'no-commits',
        };
      }, TASK_ID);
      await error.getByRole('button', { name: 'Retry' }).click();
      await expect(page.locator('[data-testid="completed-changes-empty-no-commits"]')).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('while its Changes window is detached the tab points there instead of showing a second copy', async () => {
    const { browser, page } = await launch(landedChanges());
    try {
      await openCompletedTask(page);
      await openChangesTab(page);
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });

      await page.evaluate(({ projectId, taskId }) => {
        (window as unknown as { __mockFirePopOutChanged: (keys: string[]) => void }).__mockFirePopOutChanged([`changes:${projectId}:${taskId}`]);
      }, { projectId: PROJECT_ID, taskId: TASK_ID });
      await expect(page.locator('[data-testid="completed-changes-popped-out"]')).toHaveText('Changes are open in their own window');
      await expect(page.locator('[data-testid="completed-panel-changes"] [data-testid="changes-file-tree"]')).toHaveCount(0);

      // The window closes, and the tab shows the panel again.
      await page.evaluate(() => {
        (window as unknown as { __mockFirePopOutChanged: (keys: string[]) => void }).__mockFirePopOutChanged([]);
      });
      await expect(fileRow(page, 'docs/architecture.md')).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });
});
