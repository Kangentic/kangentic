/**
 * UI coverage for BrowserPane's jar-sync mount gate (BrowserPane.tsx).
 *
 * On mount, BrowserPane calls `window.electronAPI.browser.ensureJar(taskId,
 * projectId)` and holds the guest's FIRST mount behind a
 * `data-testid="browser-pane-jar-syncing"` loading state until that promise
 * settles or a 3s cap fires. `jarSynced` is committed to `true` exactly once
 * (a plain `useState`, never reset by the effect), so a live pane is never
 * re-blanked by a later render of the same component instance.
 *
 * The headless mock resolves `ensureJar` instantly by design (see its comment
 * in mock-electron-api.js: "a test can monkeypatch it to a slow promise to
 * exercise the timeout-proceed path"), so no other browser-pane spec ever
 * observes this gate. This file monkeypatches `ensureJar` via a SECOND
 * `addInitScript`, registered after the mock script so `window.electronAPI`
 * already exists when it runs. Each test launches its own browser/context
 * (mirrors browser-pane-refetch-guard.spec.ts) rather than sharing one page,
 * because the three scenarios (pending-controllable, hung-forever, resolved)
 * need different `ensureJar` bodies and Playwright has no way to swap an
 * already-registered init script between tests on a shared page.
 *
 * Revert mapping (how each test fails if the gate regresses):
 *   1. If BrowserPane stopped waiting on ensureJar (e.g. the `!jarSynced`
 *      branch were deleted or `jarSynced` were seeded `true`), the pane would
 *      mount immediately while ensureJar is still pending: the jar-syncing
 *      testid would never appear and `browser-pane` would be present at
 *      count 1 instead of 0.
 *   2. If the resolution path stopped calling `markSynced` (e.g. the
 *      `.finally()` were changed to `.then()`, silently skipping a rejection,
 *      or the call were dropped), resolving the deferred promise would never
 *      unblock the pane and the test's `waitFor('visible')` would time out.
 *   3. If the 3s cap were removed or its `setTimeout` never fired
 *      `markSynced`, a hung `ensureJar` would wedge the pane on the
 *      jar-syncing testid forever and the test's `waitFor('visible')` would
 *      time out well past the cap.
 *   4. If a future change re-derived the gate from something recomputed on
 *      every BrowserPane render (instead of the current one-shot `useState`
 *      commit), forcing a genuine BrowserPane re-render post-mount (via the
 *      same URL-refresh-token nudge kangentic_browser_open_pane sends) would
 *      flip `browser-pane-jar-syncing` back on during the sample loop; a
 *      child-only interaction (e.g. typing in the note input) would NOT
 *      re-render BrowserPane at all and would pass vacuously either way, so
 *      the refresh-token nudge is load-bearing here, not incidental.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-jar-sync';
const TASK_ID = 'task-browser-jar-sync';
const TASK_TITLE = 'Jar Sync Gate Task';
const SESSION_ID = 'sess-browser-jar-sync';
const PROJECT_PATH = '/mock/browser-jar-sync-test';
const TASK_URL = 'http://localhost:5173/';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Jar Sync Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    // A project default URL means the pane resolves straight past the empty
    // state on first toggle, landing on the urlLoading -> jarSynced sequence
    // this file exercises.
    state.projectConfigs['${PROJECT_PATH}'] = {
      browser: { enabled: true, defaultUrl: '${TASK_URL}' },
    };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-jar-sync-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: '${TASK_TITLE}',
      description: 'Used to drive the BrowserPane jar-sync mount gate',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
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

type EnsureJarMode = 'deferred' | 'hangForever';

/**
 * Overrides `window.electronAPI.browser.ensureJar`, installed as a SECOND
 * addInitScript (after the mock script) so `window.electronAPI` already
 * exists when this runs. Every call is logged to `window.__jarSyncCalls`.
 *
 * - 'deferred': returns a promise that only settles when the test calls
 *   `window.__jarSyncResolve()`, so the test controls exactly when the gate
 *   should open.
 * - 'hangForever': returns a promise that never settles, so the only way the
 *   pane can proceed is BrowserPane's own 3s cap.
 */
function ensureJarOverrideScript(mode: EnsureJarMode): string {
  const body = mode === 'deferred'
    ? `
      window.electronAPI.browser.ensureJar = function (taskId, projectId) {
        window.__jarSyncCalls.push({ taskId: taskId, projectId: projectId });
        return new Promise(function (resolve) {
          window.__jarSyncResolve = resolve;
        });
      };
    `
    : `
      window.electronAPI.browser.ensureJar = function (taskId, projectId) {
        window.__jarSyncCalls.push({ taskId: taskId, projectId: projectId });
        return new Promise(function () { /* never settles */ });
      };
    `;
  return `
    window.__jarSyncCalls = [];
    window.__jarSyncResolve = null;
    ${body}
  `;
}

interface JarSyncTestWindow {
  __jarSyncCalls?: Array<{ taskId: string; projectId: string | null }>;
  __jarSyncResolve?: () => void;
}

async function launch(mode: EnsureJarMode): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(ensureJarOverrideScript(mode));

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Open the task-detail dialog and click the browser toggle. Does not wait
 *  for the pane itself, since several tests need to observe the gated state
 *  in between. */
async function openTaskDetailAndToggleBrowser(page: Page): Promise<void> {
  const card = page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-toggle"]').click();
}

async function resolveJarSync(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as unknown as JarSyncTestWindow;
    if (!testWindow.__jarSyncResolve) {
      throw new Error('ensureJar was never invoked - __jarSyncResolve is unset');
    }
    testWindow.__jarSyncResolve();
  });
}

test.describe('BrowserPane jar-sync mount gate', () => {
  test('while ensureJar is pending, the pane shows the jar-syncing gate and withholds the pane mount', async () => {
    const { browser, page } = await launch('deferred');
    try {
      await openTaskDetailAndToggleBrowser(page);

      const jarSyncing = page.locator('[data-testid="browser-pane-jar-syncing"]');
      await jarSyncing.waitFor({ state: 'visible', timeout: 5000 });

      // The active pane's content must not exist in the DOM at all while the
      // sync gate is held open - a reverted gate would mount `browser-pane`
      // immediately instead.
      await expect(page.locator('[data-testid="browser-pane"]')).toHaveCount(0);

      // ensureJar was invoked with this task's identity. Dev-mode React
      // StrictMode double-invokes mount effects (documented in
      // browser-pane-request-bridge.spec.ts's registration test), so this
      // may be called once or twice - assert on identity, not call count.
      const calls = await page.evaluate(() => (window as unknown as JarSyncTestWindow).__jarSyncCalls ?? []);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call).toEqual({ taskId: TASK_ID, projectId: PROJECT_ID });
      }
    } finally {
      await browser.close();
    }
  });

  test('resolving ensureJar mounts the pane and clears the jar-syncing gate', async () => {
    const { browser, page } = await launch('deferred');
    try {
      await openTaskDetailAndToggleBrowser(page);

      const jarSyncing = page.locator('[data-testid="browser-pane-jar-syncing"]');
      await jarSyncing.waitFor({ state: 'visible', timeout: 5000 });

      await resolveJarSync(page);

      await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(jarSyncing).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a hung ensureJar still mounts the pane once the 3s cap fires', async () => {
    // The cap itself is 3s; give the assertion comfortable headroom above
    // that without depending on a bare waitForTimeout - this is a polling
    // waitFor, so a faster resolution would not slow the test down, and the
    // per-test default (15s on the ui project) already covers this budget,
    // but be explicit since this is the one test in the file expected to
    // actually spend several real seconds waiting.
    test.setTimeout(20_000);

    const { browser, page } = await launch('hangForever');
    try {
      await openTaskDetailAndToggleBrowser(page);

      await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 8000 });
      await expect(page.locator('[data-testid="browser-pane-jar-syncing"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('once mounted, the pane is never re-blanked by a BrowserPane re-render', async () => {
    const { browser, page } = await launch('deferred');
    try {
      await openTaskDetailAndToggleBrowser(page);

      await page.locator('[data-testid="browser-pane-jar-syncing"]').waitFor({ state: 'visible', timeout: 5000 });
      await resolveJarSync(page);

      const pane = page.locator('[data-testid="browser-pane"]');
      await pane.waitFor({ state: 'visible', timeout: 5000 });

      // `jarSynced` lives in BrowserPane itself, not in the BrowserPaneActive
      // child - so an interaction confined to the child (typing in the note
      // input, toggling draw mode) never re-renders BrowserPane and could
      // never catch a regression here. The one in-app trigger that
      // re-renders a LIVE BrowserPane without remounting it is a bump of
      // this task's URL refresh token, which is exactly what
      // kangentic_browser_open_pane sends on a re-open of an already-active
      // pane (see browser-pane-request-bridge.spec.ts). Firing it here
      // forces BrowserPane to re-render and re-evaluate the `!jarSynced`
      // branch on a real re-render, not merely hold state it never re-reads.
      await page.evaluate(
        ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
        [PROJECT_ID, TASK_ID] as const,
      );

      // The refetch this triggers resolves quickly against the mock, but the
      // pane must never show the jar-syncing gate at any point across the
      // re-render/refetch cycle, not just at the start or end - so sample
      // across a short window instead of checking once. This is a
      // non-occurrence assertion (see the anti-flake catalogue): there is no
      // positive condition to poll for, so a bounded, documented sample loop
      // is the correct shape.
      const jarSyncing = page.locator('[data-testid="browser-pane-jar-syncing"]');
      for (let sample = 0; sample < 5; sample++) {
        expect(await jarSyncing.count()).toBe(0);
        await page.waitForTimeout(100);
      }
      await expect(pane).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
