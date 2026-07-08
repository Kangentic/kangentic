/**
 * UI test for the Changes panel's commit-detail selection (PR 5).
 *
 * Selecting a commit row in the history browser scopes the detail pane (file
 * tree + diff) to that commit's diff, seeded via window.__mockGitDiffByCommit
 * (checked by the mock before window.__mockGitDiffByScope - see
 * resolveGitDiffFixture in mock-electron-api.js). The scope selector and
 * branch header disappear in commit-detail (FileTreePanel's own guards drop
 * them when `scope`/`branchSummary` are undefined); a commit-detail-header
 * with a back button (commit-detail-back) replaces them, and returns to
 * Uncommitted (the branch-wide working diff, from window.__mockGitDiff).
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

const PROJECT_ID = 'proj-commit-detail';
const TASK_ID = 'task-commit-detail';
const SESSION_ID = 'sess-commit-detail';

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/working.ts', status: 'M', insertions: 1, deletions: 1, original: 'old working', modified: 'new working', language: 'typescript' },
    ],
    totalInsertions: 1,
    totalDeletions: 1,
  };

  window.__mockGitDiffByCommit = {
    'commit-aaa': {
      files: [
        { path: 'src/committed.ts', status: 'M', insertions: 3, deletions: 1, original: 'old committed', modified: 'new committed', language: 'typescript' },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
    },
  };

  window.__mockCommitGraph = {
    commits: [
      { hash: 'commit-aaa', shortHash: 'aaaaaaa', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'fix parser' },
    ],
    tipHash: 'commit-aaa',
    baseHash: 'commit-aaa',
    mergeBaseHash: 'commit-aaa',
    currentBranch: 'feature/commit-detail',
    truncated: false,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Commit Detail Test',
      path: '/mock/commit-detail-test',
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
      cwd: '/mock/commit-detail-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Commit Detail Task',
      description: 'Task used for commit-detail selection test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/commit-detail',
      branch_name: 'feature/commit-detail',
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

test.describe('Changes panel: commit-detail selection', () => {
  test('selecting a commit scopes the detail pane to its diff; Uncommitted returns to the working diff', async () => {
    const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Detail Task').first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    // Uncommitted is selected by default: the working diff's file shows, the
    // scope selector is present.
    await expect(fileTree.locator('text=working.ts')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible();

    // Select the commit row: the detail pane swaps to that commit's file list.
    await page.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'fix parser' }).click();
    await expect(fileTree.locator('text=committed.ts')).toBeVisible({ timeout: 10000 });
    await expect(fileTree.locator('text=working.ts')).not.toBeVisible();
    await expect(page.locator('[data-testid="changes-scope-select"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="commit-detail-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="commit-detail-header"]')).toContainText('+3/-1');

    // Selecting the file shows its commit-scoped diff content.
    await fileTree.locator('text=committed.ts').click();
    await expect(page.locator('[data-testid="diff-editor-area"]')).toBeVisible();

    // Back returns to Uncommitted: the working file reappears, the scope
    // selector returns, the commit header disappears.
    await page.locator('[data-testid="commit-detail-back"]').click();
    await expect(fileTree.locator('text=working.ts')).toBeVisible({ timeout: 10000 });
    await expect(fileTree.locator('text=committed.ts')).not.toBeVisible();
    await expect(page.locator('[data-testid="changes-scope-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="commit-detail-header"]')).not.toBeVisible();

    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});

// ─── Commit-detail header restore fallback ──────────────────────────────────
//
// A `changesSelectedCommit` restored from a task's persisted `detail_view_state`
// (dialog opened fresh, no click this session) has no `selectedCommitMeta` -
// that is local component state, seeded only by clicking a commit row. The
// header must fall back to showing just the short hash until the user clicks.

const RESTORE_PROJECT_ID = 'proj-commit-detail-restore';
const RESTORE_TASK_ID = 'task-commit-detail-restore';
const RESTORE_SESSION_ID = 'sess-commit-detail-restore';
const RESTORE_COMMIT_OID = 'abcdef1234567890';

const restorePreConfig = `
  window.__mockCommitGraph = {
    commits: [
      { hash: '${RESTORE_COMMIT_OID}', shortHash: 'abcdef1', parents: [], authorName: 'Restore Author', authorTimestamp: new Date().toISOString(), subject: 'restored subject line' },
    ],
    tipHash: '${RESTORE_COMMIT_OID}',
    baseHash: '${RESTORE_COMMIT_OID}',
    mergeBaseHash: '${RESTORE_COMMIT_OID}',
    currentBranch: 'feature/commit-detail-restore',
    truncated: false,
  };

  window.__mockGitDiffByCommit = {
    '${RESTORE_COMMIT_OID}': {
      files: [
        { path: 'src/restored.ts', status: 'M', insertions: 1, deletions: 1, original: 'old restored', modified: 'new restored', language: 'typescript' },
      ],
      totalInsertions: 1,
      totalDeletions: 1,
    },
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${RESTORE_PROJECT_ID}',
      name: 'Commit Detail Restore Test',
      path: '/mock/commit-detail-restore-test',
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
      id: '${RESTORE_SESSION_ID}',
      taskId: '${RESTORE_TASK_ID}',
      projectId: '${RESTORE_PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/commit-detail-restore-test',
      startedAt: ts,
      exitCode: null,
    });

    // The task's detail_view_state already carries a selected commit - the
    // "restored, no click this session" scenario - so no interaction is needed
    // to reproduce the hole; the header must render on first open.
    state.tasks.push({
      id: '${RESTORE_TASK_ID}',
      title: 'Commit Detail Restore Task',
      description: 'Task used for the commit-detail header restore-fallback test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${RESTORE_SESSION_ID}',
      worktree_path: '/mock/worktrees/commit-detail-restore',
      branch_name: 'feature/commit-detail-restore',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
      detail_view_state: JSON.stringify({ changesSelectedCommit: '${RESTORE_COMMIT_OID}' }),
    });

    return { currentProjectId: '${RESTORE_PROJECT_ID}' };
  });
`;

test.describe('Changes panel: commit-detail header restore fallback', () => {
  let restoreBrowser: Browser;
  let restorePage: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(restorePreConfig);
    restoreBrowser = result.browser;
    restorePage = result.page;
    await restorePage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await restoreBrowser?.close();
  });

  test('a commit selection restored from detail_view_state shows only the short hash until the row is clicked', async () => {
    const card = restorePage.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Detail Restore Task').first();
    await card.click();

    const dialog = restorePage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    await restorePage.locator('[data-testid="changes-toggle"]').click();
    await restorePage.locator('[data-testid="commit-graph-panel"]').waitFor({ state: 'visible', timeout: 10000 });

    const header = restorePage.locator('[data-testid="commit-detail-header"]');
    await expect(header).toBeVisible({ timeout: 10000 });
    // Short hash (first 7 chars of the restored OID) always renders.
    await expect(header).toContainText('abcdef1');
    // No selectedCommitMeta this session (never clicked) - the subject/author
    // line must be absent. Structural assertion (span count) rather than a
    // literal-text check: the header always renders exactly 2 <span>s (the
    // short hash + the insertions/deletions badge) when commitHeaderMeta is
    // null; the subject <span> and the author-line <span> render only when it
    // is populated, bringing the count to 4 - this holds regardless of what
    // text a regression happens to synthesize.
    await expect(header.locator('span')).toHaveCount(2, { timeout: 5000 });
    await expect(header).not.toContainText('restored subject line');
    await expect(header).not.toContainText('Restore Author');

    await restorePage.locator('[data-testid="changes-toggle"]').click();
    await restorePage.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});

// ─── File-content cache key isolation across commit selection ──────────────
//
// The file-content cache key is `commit:<oid>:<path>` for a commit selection
// and `scope:<scope>:<path>` for Uncommitted, so the SAME path never serves a
// stale cache entry across a scope-vs-commit switch.
//
// A naive 2-step repro (click a file under Uncommitted, switch to a commit
// reusing that path) does NOT reliably distinguish the fixed cache key from
// the reverted one: the stale-while-revalidate design always kicks off a
// CORRECTLY-parameterized background refetch regardless of the cache key, and
// on that first transition the stale-served value always matches what's
// already on screen (cache and screen were written together moments before),
// so both the fixed and the reverted key converge to the same content before
// the mock's near-instant Promise resolution gives a poll any chance to
// observe a difference (verified empirically: the naive repro stayed green
// under the reverted key). The genuinely wrong, non-matching stale value only
// appears once TWO files interleave: after visiting file A under a commit,
// switching to a DIFFERENT file B, then returning to Uncommitted (auto-
// restoring B, not A), file A's cache entry is left behind holding the
// commit's content while the screen has moved on. Re-selecting A at that
// point is the reproduction - under the reverted key ('scope:path', no
// commit awareness) A's stale entry is the commit's content; under the fixed
// key ('scope:scope:path' for an Uncommitted-context fetch, distinct from any
// 'commit:oid:path' entry) A's entry was never touched by the commit
// detour, so it already holds the correct Uncommitted content.
//
// To assert the exact synchronous stale-serve value deterministically (not
// racing the mock's instant self-correction), the corrective background
// fetch is gated via window.__mockGitFileContentDeferred (mirrors the
// established __mockTaskDeleteDeferred pattern) so the wrong-vs-right stale
// value is frozen and inspectable before being released.

const CACHE_PROJECT_ID = 'proj-commit-detail-cache';
const CACHE_TASK_ID = 'task-commit-detail-cache';
const CACHE_SESSION_ID = 'sess-commit-detail-cache';
const CACHE_COMMIT_OID = 'cache-test-commit';
const PATH_A = 'src/alpha.ts';
const PATH_B = 'src/beta.ts';
const UNCOMMITTED_A = 'export const marker = "ALPHA_UNCOMMITTED_MARKER";';
const COMMITTED_A = 'export const marker = "ALPHA_COMMITTED_MARKER";';
const UNCOMMITTED_B = 'export const marker = "BETA_UNCOMMITTED_MARKER";';
const COMMITTED_B = 'export const marker = "BETA_COMMITTED_MARKER";';

const cachePreConfig = `
  window.__mockGitDiff = {
    files: [
      { path: '${PATH_A}', status: 'M', insertions: 1, deletions: 1, original: 'old alpha', modified: '${UNCOMMITTED_A}', language: 'typescript' },
      { path: '${PATH_B}', status: 'M', insertions: 1, deletions: 1, original: 'old beta', modified: '${UNCOMMITTED_B}', language: 'typescript' },
    ],
    totalInsertions: 2,
    totalDeletions: 2,
  };

  window.__mockGitDiffByCommit = {
    '${CACHE_COMMIT_OID}': {
      files: [
        { path: '${PATH_A}', status: 'M', insertions: 2, deletions: 2, original: 'old alpha committed', modified: '${COMMITTED_A}', language: 'typescript' },
        { path: '${PATH_B}', status: 'M', insertions: 2, deletions: 2, original: 'old beta committed', modified: '${COMMITTED_B}', language: 'typescript' },
      ],
      totalInsertions: 4,
      totalDeletions: 4,
    },
  };

  window.__mockCommitGraph = {
    commits: [
      { hash: '${CACHE_COMMIT_OID}', shortHash: 'cachetes', parents: [], authorName: 'Ada', authorTimestamp: new Date().toISOString(), subject: 'cache isolation commit' },
    ],
    tipHash: '${CACHE_COMMIT_OID}',
    baseHash: '${CACHE_COMMIT_OID}',
    mergeBaseHash: '${CACHE_COMMIT_OID}',
    currentBranch: 'feature/commit-detail-cache',
    truncated: false,
  };

  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${CACHE_PROJECT_ID}',
      name: 'Commit Detail Cache Test',
      path: '/mock/commit-detail-cache-test',
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
      id: '${CACHE_SESSION_ID}',
      taskId: '${CACHE_TASK_ID}',
      projectId: '${CACHE_PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/commit-detail-cache-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${CACHE_TASK_ID}',
      title: 'Commit Detail Cache Task',
      description: 'Task used for the file-content cache-key isolation test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${CACHE_SESSION_ID}',
      worktree_path: '/mock/worktrees/commit-detail-cache',
      branch_name: 'feature/commit-detail-cache',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${CACHE_PROJECT_ID}' };
  });
`;

/** Read the live Monaco modified-editor content, the same real editor the diff
 *  pane renders (window.__monaco is exposed dev-only for test automation; see
 *  changes-panel-collapse-unchanged.spec.ts for the established pattern). */
function getModifiedEditorValue(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const monaco = (window as unknown as {
      __monaco?: { editor: { getDiffEditors: () => Array<{ getModifiedEditor?: () => { getValue?: () => string } }> } };
    }).__monaco;
    if (!monaco) return null;
    const diffEditors = monaco.editor.getDiffEditors();
    if (!diffEditors.length) return null;
    const modifiedEditor = diffEditors[0].getModifiedEditor ? diffEditors[0].getModifiedEditor() : null;
    return modifiedEditor && modifiedEditor.getValue ? modifiedEditor.getValue() : null;
  });
}

function fileRowButton(page: Page, filePath: string) {
  return page.locator(`[data-testid="changes-file-row"][data-path="${filePath}"]`).getByRole('button').first();
}

test.describe('Changes panel: file-content cache key isolation across commit selection', () => {
  let cacheBrowser: Browser;
  let cachePage: Page;

  test.beforeAll(async () => {
    const result = await launchWithState(cachePreConfig);
    cacheBrowser = result.browser;
    cachePage = result.page;
    await cachePage.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await cacheBrowser?.close();
  });

  test('re-selecting a file left behind by a commit detour shows its Uncommitted content, not the stale commit content', async () => {
    const card = cachePage.locator('[data-swimlane-name="Code Review"]').locator('text=Commit Detail Cache Task').first();
    await card.click();

    const dialog = cachePage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    await cachePage.locator('[data-testid="changes-toggle"]').click();
    await cachePage.locator('[data-testid="commit-graph-panel"]').waitFor({ state: 'visible', timeout: 10000 });

    // 1. Select file A under Uncommitted: populates its Uncommitted-scoped
    // cache entry.
    await fileRowButton(cachePage, PATH_A).click();
    await expect(cachePage.locator('[data-testid="diff-editor-area"]')).toBeVisible({ timeout: 8000 });
    await expect.poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 }).toContain('ALPHA_UNCOMMITTED_MARKER');

    // 2. Select the commit. A stays selected (auto-restore) and converges to
    // the commit's content for A.
    await cachePage.locator('[data-testid="commit-graph-row"]').filter({ hasText: 'cache isolation commit' }).click();
    await expect(cachePage.locator('[data-testid="commit-detail-header"]')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 }).toContain('ALPHA_COMMITTED_MARKER');

    // 3. Detour to file B under the same commit (its own cache entry).
    await fileRowButton(cachePage, PATH_B).click();
    await expect.poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 }).toContain('BETA_COMMITTED_MARKER');

    // 4. Back to Uncommitted. B stays selected (auto-restore) and converges to
    // its Uncommitted content. File A's entry is left behind, still holding
    // the commit's content from step 2.
    await cachePage.locator('[data-testid="commit-detail-back"]').click();
    await expect.poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 }).toContain('BETA_UNCOMMITTED_MARKER');

    // 5. Arm the gate, then explicitly re-select A. The synchronous
    // stale-cache-serve fires before any corrective fetch can run (the gate
    // blocks it), so this is the exact value the cache key produces - no
    // race with the self-correction.
    await cachePage.evaluate(() => {
      (window as unknown as { __mockGitFileContentDeferred?: boolean }).__mockGitFileContentDeferred = true;
    });
    await fileRowButton(cachePage, PATH_A).click();

    await expect
      .poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 })
      .toContain('ALPHA_UNCOMMITTED_MARKER');
    const gatedValue = await getModifiedEditorValue(cachePage);
    expect(gatedValue).not.toContain('ALPHA_COMMITTED_MARKER');

    // Release the gate (harmless no-op if already consumed) and let the
    // corrective fetch settle so the dialog can close cleanly.
    await cachePage.evaluate(() => {
      const resolve = (window as unknown as { __mockGitFileContentResolve?: () => void }).__mockGitFileContentResolve;
      resolve?.();
    });
    await expect.poll(() => getModifiedEditorValue(cachePage), { timeout: 8000 }).toContain('ALPHA_UNCOMMITTED_MARKER');

    // Already back on Uncommitted (step 4) - no commit-detail-back needed here.
    await cachePage.locator('[data-testid="changes-toggle"]').click();
    await cachePage.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
