/**
 * UI test for ChangesPanel's fetchFiles in-flight/pending-rerun guard.
 *
 * Background: a rapid string of fs.watch fires (e.g. an agent writing many
 * files in a burst) would otherwise queue multiple concurrent `diffFiles` IPC
 * calls whose responses can resolve out of order. `fetchFiles` guards against
 * this: while a call is in flight, a new trigger just marks a pending
 * re-fetch and returns; once the in-flight call resolves, the pending
 * re-fetch runs exactly once, through `fetchFilesRef` so it picks up the
 * LATEST scope/selection rather than the params captured when it was queued.
 * See src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx.
 *
 * `fetchUncommittedCount` also calls `diffFiles` (a separate, unguarded call
 * fired whenever scope isn't 'working' or a commit is selected), so a scope
 * switch legitimately adds its OWN diffFiles traffic alongside fetchFiles's.
 * That call never includes a `commitOid` key, while fetchFiles always does
 * (even when its value is undefined) - the mock's `hasCommitOidKey` flag
 * (tests/ui/mock-electron-api.js) lets this spec isolate fetchFiles's own
 * call sequence from that unrelated, expected traffic.
 *
 * This spec locks two properties, using only fetchFiles-origin calls
 * (`hasCommitOidKey === true`):
 *   1. Coalescing - two `onDiffChanged` triggers that land while a diffFiles
 *      call is in flight produce zero extra calls (not one call per trigger).
 *   2. Latest params - when scope changes while the initial call is still in
 *      flight, the queued rerun fires with the NEW scope, not the one
 *      captured when fetchFiles was first invoked; the panel settles on the
 *      new scope's files.
 *
 * Tier: UI (headless Chromium). window.__mockGitDiffFilesDeferred holds each
 * diffFiles call open until its resolver is invoked, and
 * window.__mockGitDiffFilesCalls records every call's params - both test
 * hooks added to tests/ui/mock-electron-api.js for this spec. No PTY or real
 * git needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-fetch-guard-${RUN_ID}`;
const TASK_ID = `task-fetch-guard-${RUN_ID}`;
const SESSION_ID = `sess-fetch-guard-${RUN_ID}`;

// Distinct fixtures per scope so the test can tell, from the rendered file
// tree, which scope's result actually won the race.
const WORKING_FIXTURE = {
  files: [
    { path: 'src/working-only.ts', status: 'M', insertions: 1, deletions: 0, original: 'a', modified: 'b', language: 'typescript' },
  ],
};
const STAGED_FIXTURE = {
  files: [
    { path: 'src/staged-only.ts', status: 'M', insertions: 2, deletions: 0, original: 'c', modified: 'd', language: 'typescript' },
    { path: 'src/staged-second.ts', status: 'A', insertions: 3, deletions: 0, original: '', modified: 'e', language: 'typescript' },
  ],
};

interface MockDiffFilesCall {
  scope: string;
  commitOid: string | null;
  hasCommitOidKey: boolean;
}

async function getAllCalls(page: Page): Promise<MockDiffFilesCall[]> {
  return page.evaluate(() => (window as unknown as { __mockGitDiffFilesCalls?: MockDiffFilesCall[] }).__mockGitDiffFilesCalls ?? []);
}

/** Only the calls that came from fetchFiles's own guarded call site (see
 *  file header: fetchUncommittedCount never sends a `commitOid` key). */
async function getFetchFilesCalls(page: Page): Promise<MockDiffFilesCall[]> {
  return (await getAllCalls(page)).filter((call) => call.hasCommitOidKey);
}

/** Resolve the Nth (0-indexed, across ALL diffFiles calls - fetchFiles and
 *  fetchUncommittedCount share the same resolver queue in call order). */
async function resolveDiffFilesCall(page: Page, index: number): Promise<void> {
  await page.evaluate((callIndex) => {
    const resolvers = (window as unknown as { __mockGitDiffFilesResolvers?: Array<() => void> }).__mockGitDiffFilesResolvers ?? [];
    const resolve = resolvers[callIndex];
    if (!resolve) throw new Error(`No diffFiles resolver queued at index ${callIndex}`);
    resolve();
  }, index);
}

/**
 * Launch a headless page with a project, an Executing lane, a task with a
 * suspended session (so the dialog opens in view mode and the suspended body
 * branch renders Changes without a live TerminalTab / PTY), and the
 * working/staged diff fixtures seeded. Mirrors
 * tests/ui/changes-panel-diff-disposal.spec.ts's launch helper.
 */
async function launchWithFetchGuardTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.addInitScript(`
    window.__mockGitDiffByScope = {
      working: ${JSON.stringify(WORKING_FIXTURE)},
      staged: ${JSON.stringify(STAGED_FIXTURE)},
    };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Fetch Guard Test ${RUN_ID}',
        path: '/mock/fetch-guard-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-fetch-guard-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: null,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/fetch-guard-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Fetch Guard Task ${RUN_ID}',
        description: 'Verifies the fetchFiles overlapping-fetch guard',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
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
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  // Keep the session suspended: the dialog's reconcile-on-mount probe must not
  // heal it into a live (terminal) session, which would change the body branch.
  await page.evaluate(() => {
    window.electronAPI.sessions.reconcile = async function () {
      return null;
    };
  });

  return { browser, page };
}

test.describe('ChangesPanel - fetchFiles overlapping-fetch guard', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithFetchGuardTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('coalesces bursts of triggers in flight and reruns with the latest scope', async () => {
    // Hold every diffFiles call open until its resolver is explicitly invoked.
    await page.evaluate(() => {
      (window as unknown as { __mockGitDiffFilesDeferred: boolean }).__mockGitDiffFilesDeferred = true;
    });

    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    await card.waitFor({ state: 'visible', timeout: 8000 });
    await card.click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const changesToggle = page.locator('[data-testid="changes-toggle"]');
    await changesToggle.waitFor({ state: 'visible', timeout: 8000 });
    await changesToggle.click();

    // Opening Changes mounts ChangesPanel, whose mount effect fires the
    // initial fetchFiles() - the first diffFiles call, held open by the
    // deferred hook above. Scope defaults to 'working' with no commit
    // selected, so fetchUncommittedCount's separate call is NOT triggered
    // yet (see ChangesPanel's mount-effect guard) - only fetchFiles's own
    // call site is exercised so far.
    await expect.poll(async () => (await getFetchFilesCalls(page)).length, { timeout: 8000 }).toBe(1);
    expect((await getFetchFilesCalls(page))[0].scope).toBe('working'); // diffDefaultScope

    // Fire two rapid fs.watch triggers while that call is still in flight.
    // Both must just mark a pending re-fetch (fetchFilesRef.current() hits
    // the in-flight guard) - neither should start a second diffFiles call.
    await page.evaluate(() => {
      const fire = (window as unknown as { __mockFireDiffChanged?: () => void }).__mockFireDiffChanged;
      fire?.();
      fire?.();
    });

    // Give any (incorrect) extra call a fixed budget to appear - this is a
    // negative assertion (no additional call fires), which cannot be proven
    // by polling for absence. 500ms is ample: a real overlapping call would
    // be recorded synchronously within the same task-queue turn the trigger
    // ran in, well under this window.
    await page.waitForTimeout(500);
    expect((await getFetchFilesCalls(page)).length).toBe(1);
    // Also zero unrelated traffic at this point: scope is still 'working'
    // throughout the burst, so fetchUncommittedCount never fires either.
    expect((await getAllCalls(page)).length).toBe(1);

    // Now change scope while the ORIGINAL fetchFiles call is still in
    // flight - a third trigger of fetchFiles's call site (again just
    // coalesced into the same pending flag), plus fetchUncommittedCount's
    // own (separate, unguarded, by-design) call for the new non-working
    // scope.
    const scopeSelect = page.locator('[data-testid="changes-scope-select"]');
    await scopeSelect.waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="changes-scope-staged"]').click();
    await expect.poll(async () => (await getAllCalls(page)).length, { timeout: 8000 }).toBe(2);
    // Still exactly one fetchFiles-origin call outstanding - the scope
    // change did not spawn a second one despite being the third trigger
    // received while the first call was in flight.
    expect((await getFetchFilesCalls(page)).length).toBe(1);

    // Resolve the in-flight (first, 'working') fetchFiles call. Its `finally`
    // block sees the pending flag and fires exactly ONE rerun - through
    // fetchFilesRef, so it picks up the CURRENT (staged) scope, not the
    // 'working' scope captured when the original call was queued - despite
    // THREE triggers (two watch fires + the scope change) having landed
    // while it was in flight.
    const allCallsBeforeResolve = await getAllCalls(page);
    const originalFetchFilesIndex = allCallsBeforeResolve.findIndex((call) => call.hasCommitOidKey);
    await resolveDiffFilesCall(page, originalFetchFilesIndex);
    await expect.poll(async () => (await getFetchFilesCalls(page)).length, { timeout: 8000 }).toBe(2);
    const fetchFilesCalls = await getFetchFilesCalls(page);
    expect(fetchFilesCalls[1].scope).toBe('staged');

    // Resolve every remaining outstanding call (fetchUncommittedCount's
    // 'staged' call, and the coalesced fetchFiles rerun) so the panel
    // settles fully.
    const resolverCount = await page.evaluate(() => ((window as unknown as { __mockGitDiffFilesResolvers?: unknown[] }).__mockGitDiffFilesResolvers ?? []).length);
    for (let index = 0; index < resolverCount; index++) {
      if (index === originalFetchFilesIndex) continue; // already resolved above
      await resolveDiffFilesCall(page, index);
    }

    // Final state reflects the staged fixture (the scope actually selected),
    // not a stale working-scope result from the coalesced race. The tree
    // groups files under a shared "src/" directory node and shows each leaf
    // name once (no repeated "src/" prefix per file), so match on leaf names.
    await expect(page.locator('[data-testid="changes-file-tree"]')).toContainText('staged-only.ts', { timeout: 8000 });
    await expect(page.locator('[data-testid="changes-file-tree"]')).toContainText('staged-second.ts');
    expect(await page.locator('[data-testid="changes-file-tree"]').textContent()).not.toContain('working-only.ts');

    // Across the whole sequence (initial call + 2 watch fires + 1 scope
    // change = 4 total triggers of fetchFiles's call site), the guard
    // coalesced them into exactly 2 real diffFiles calls - never 3 or 4.
    expect((await getFetchFilesCalls(page)).length).toBe(2);
  });
});
