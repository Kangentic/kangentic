/**
 * Regression spec: opening the detail of an ALREADY-RUNNING agent must not flash
 * "Starting agent...".
 *
 * Bug: `TerminalTab` seeds `terminalReady` from the store (firstOutput/usage), which
 * is correct - but its init-effect CLEANUP then reset `terminalReady` to false
 * unconditionally. React StrictMode mounts, unmounts and remounts every component, so
 * that cleanup ran on every open in dev: the terminal rendered ready, the cleanup
 * cleared the flag, one render showed the overlay, and the lifting effect restored it.
 * The user saw "Starting agent..." flash on a task whose agent had been working for
 * minutes.
 *
 * Traced live before fixing (console): `ready true` -> `CLEANUP resetting
 * terminalReady=false` -> `ready false` -> `ready true`. The DOM-only instruments
 * could not see the correct first commit because it never painted.
 *
 * Fix: reset only when the store has no output for this session - the same predicate
 * the state is seeded from - so a remount of a session that has already produced
 * output keeps its ready state.
 *
 * Why the UI tier: this only reproduces under React StrictMode, which the real app
 * enables in `index.tsx`. These tests load that app, so they exercise the same
 * mount/unmount/remount cycle the user hits.
 *
 * Non-vacuous by construction: the second test asserts the overlay DOES still appear
 * for a session with no output yet, so the first cannot pass merely because the
 * overlay stopped existing.
 *
 * How to verify RED / GREEN: in `TerminalTab.tsx`, change the cleanup's guard back to
 * an unconditional `setTerminalReady(false)`. Test 1 goes red; test 2 stays green.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const RUN_ID = Math.random().toString(36).slice(2, 8);

function preConfig(suffix: string): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: 'proj-overlay-${suffix}',
        name: 'Launch Overlay ${suffix}',
        path: '/mock/launch-overlay-${suffix}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-lo-${suffix}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: ts,
        }));
      });

      state.sessions.push({
        id: 'sess-overlay-${suffix}',
        taskId: 'task-overlay-${suffix}',
        projectId: 'proj-overlay-${suffix}',
        pid: 6100,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/launch-overlay-${suffix}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.tasks.push({
        id: 'task-overlay-${suffix}',
        display_id: 1,
        title: 'Overlay Task ${suffix}',
        description: '',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: 'sess-overlay-${suffix}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.activityCache['sess-overlay-${suffix}'] = 'thinking';

      return { currentProjectId: 'proj-overlay-${suffix}' };
    });
  `;
}

async function launch(suffix: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(suffix));
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** Record every launch-overlay INSERTION from now on. A poll cannot prove absence:
 *  the flash was ~15ms and would fall between samples. */
async function recordOverlayInsertions(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __overlayInserts: number }).__overlayInserts = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const hit = node.matches('[data-testid="launch-overlay"]')
            || !!node.querySelector('[data-testid="launch-overlay"]');
          if (hit) (window as unknown as { __overlayInserts: number }).__overlayInserts += 1;
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
  });
}

const overlayInsertions = (page: Page) =>
  page.evaluate(() => (window as unknown as { __overlayInserts?: number }).__overlayInserts ?? 0);

test('opening a detail whose agent has already produced output shows no launch overlay', async () => {
  const suffix = `ready-${RUN_ID}`;
  const { browser, page } = await launch(suffix);
  try {
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });

    // The agent has already produced output, which is what makes the overlay wrong.
    await page.evaluate((sessionId) => {
      (window as unknown as { __mockFireFirstOutput?: (id: string) => void })
        .__mockFireFirstOutput?.(sessionId);
    }, `sess-overlay-${suffix}`);
    await expect.poll(() => page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session: { getState: () => { sessionFirstOutput: Record<string, boolean> } } };
      }).__zustandStores;
      return !!stores?.session.getState().sessionFirstOutput[sessionId];
    }, `sess-overlay-${suffix}`), { timeout: 10000 }).toBe(true);

    await recordOverlayInsertions(page);
    await page.locator(`[data-task-id="task-overlay-${suffix}"]`).click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="terminal-tab-container"]').first()
      .waitFor({ state: 'visible', timeout: 10000 });
    // Let the StrictMode remount and every settle effect run.
    await page.waitForTimeout(1200);

    expect(await overlayInsertions(page)).toBe(0);
  } finally {
    await browser.close();
  }
});

test('a session that has produced nothing yet still gets its launch overlay', async () => {
  // The guard against the fix above degenerating into "never show the overlay".
  const suffix = `cold-${RUN_ID}`;
  const { browser, page } = await launch(suffix);
  try {
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });

    await recordOverlayInsertions(page);
    await page.locator(`[data-task-id="task-overlay-${suffix}"]`).click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="launch-overlay"]').first()
      .waitFor({ state: 'visible', timeout: 10000 });

    expect(await overlayInsertions(page)).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
