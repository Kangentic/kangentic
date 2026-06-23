/**
 * UI tests for the bottom terminal panel NOT flashing expanded-then-collapsed on a project
 * switch (see src/renderer/utils/terminal-force-collapse.ts and the arm/clear in
 * useProjectSwitchEffect.ts).
 *
 * Root cause being guarded: on a switch the panel's `forceCollapsed` is driven by
 * `dialogSessionIds` (sessions owned by open detail windows), which is cleared synchronously and
 * only repopulated asynchronously once the destination's persisted windows restore. During that
 * (cold-path: ~hundreds of ms) gap the panel rendered expanded, then collapsed - a visible flash.
 * The fix arms a project-scoped `pendingDetailWindowsProjectId` from `config.workspaceByProject`
 * synchronously at the switch and ORs it into `forceCollapsed`, so the panel renders collapsed
 * from the first frame; it is cleared once the destination's workspace restore completes.
 *
 * Two deterministic assertions, neither dependent on sub-frame flash timing:
 *   1. Lifecycle: a real cold switch to a project whose workspace HAS detail windows arms the
 *      flag (captured by a Zustand subscription, which fires synchronously on every setState) and
 *      clears it once settled; a switch to a project with NO persisted windows never arms it.
 *   2. Consumption: AppLayout collapses the panel (data-collapsed) when the flag is armed for the
 *      project now shown, and ignores a stale arm for a different project.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-flash-a';
const PROJECT_B_ID = 'proj-flash-b';
const PROJECT_C_ID = 'proj-flash-c';
const TASK_B_ID = 'task-flash-b';

// A valid persisted workspace (schema version 1) with a single detail window for B's task, so the
// cold switch to B arms the pending-collapse flag.
const WORKSPACE_OVERRIDES = JSON.stringify({
  workspaceByProject: {
    [PROJECT_B_ID]: {
      version: 1,
      windows: [
        {
          taskId: TASK_B_ID,
          title: 'Flash B Window',
          geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
          restoreGeometry: null,
          state: 'floating',
        },
      ],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: null,
    },
  },
});

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    ['${PROJECT_A_ID}', '${PROJECT_B_ID}', '${PROJECT_C_ID}'].forEach(function (id, i) {
      state.projects.push({
        id: id,
        name: 'Flash Project ' + id,
        path: '/mock/' + id,
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
    });

    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-flash-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    return { currentProjectId: '${PROJECT_A_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Seed config.workspaceByProject BEFORE the mock module evaluates (it reads
  // window.__mockConfigOverrides when building its config object).
  await page.addInitScript(`window.__mockConfigOverrides = ${WORKSPACE_OVERRIDES};`);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-testid="terminal-panel-container"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Switch the active project by setting the project store directly (mirrors the sidebar click). */
async function switchToProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate((targetId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        project: {
          getState: () => { projects: Array<{ id: string }> };
          setState: (partial: object) => void;
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const target = stores.project.getState().projects.find((p) => p.id === targetId);
    if (!target) throw new Error('Project not found in store: ' + targetId);
    stores.project.setState({ currentProject: target });
  }, projectId);
}

/** Start recording every value `pendingDetailWindowsProjectId` takes (the subscription fires
 *  synchronously on each setState, so a transient arm-then-clear is captured deterministically). */
async function startPendingLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => { pendingDetailWindowsProjectId: string | null };
          subscribe: (listener: () => void) => () => void;
        };
      };
      __pendingLog?: Array<string | null>;
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const log: Array<string | null> = [];
    (window as unknown as { __pendingLog: Array<string | null> }).__pendingLog = log;
    log.push(stores.session.getState().pendingDetailWindowsProjectId);
    stores.session.subscribe(() => {
      log.push(stores.session.getState().pendingDetailWindowsProjectId);
    });
  });
}

async function readPendingLog(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => (window as unknown as { __pendingLog?: Array<string | null> }).__pendingLog ?? []);
}

async function setPendingProjectId(page: Page, projectId: string | null): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setPendingDetailWindowsProjectId: (id: string | null) => void } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    stores.session.getState().setPendingDetailWindowsProjectId(id);
  }, projectId);
}

test.describe('terminal panel - no flash on project switch', () => {
  test('cold switch to a project with persisted detail windows arms then clears the collapse flag', async () => {
    const { browser, page } = await launch();
    try {
      await startPendingLog(page);

      // B was never visited -> cold path. Its workspace has a detail window, so the switch must
      // arm pendingDetailWindowsProjectId = B (the panel renders collapsed from frame one), then
      // clear it to null once B's workspace restore completes.
      await switchToProject(page, PROJECT_B_ID);

      // Settle: the arm is cleared after the deferred cold restore runs.
      await expect
        .poll(async () => (await readPendingLog(page)).at(-1), { timeout: 8000, intervals: [100, 200, 300] })
        .toBe(null);

      const log = await readPendingLog(page);
      // The flag was armed for B at some point during the switch (the first-frame collapse fix)...
      expect(log).toContain(PROJECT_B_ID);
      // ...and never armed for any OTHER project.
      expect(log.filter((value) => value !== null && value !== PROJECT_B_ID)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('cold switch to a project with NO persisted windows never arms the flag', async () => {
    const { browser, page } = await launch();
    try {
      await startPendingLog(page);

      // C has no persisted workspace -> the switch must arm to null (disarm), never to C, so the
      // common case keeps the panel expanded with no new collapse-then-expand motion. Switch to C,
      // then to B (which DOES have persisted windows): B's arm appearing in the log is a
      // deterministic barrier proving C's full switch lifecycle has flushed (no bare timeout), so
      // we can then assert C never armed at any point.
      await switchToProject(page, PROJECT_C_ID);
      await switchToProject(page, PROJECT_B_ID);

      await expect
        .poll(async () => (await readPendingLog(page)).includes(PROJECT_B_ID), {
          timeout: 8000,
          intervals: [100, 200, 300],
        })
        .toBe(true);

      // Only null and B's arm may appear: the no-windows destination C must never have armed.
      const log = await readPendingLog(page);
      expect(log.filter((value) => value !== null && value !== PROJECT_B_ID)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('AppLayout collapses the panel when the flag is armed for the current project, ignores a stale arm', async () => {
    const { browser, page } = await launch();
    try {
      const container = page.locator('[data-testid="terminal-panel-container"]');

      // Project A has no detail window -> panel expanded.
      await expect(container).toHaveAttribute('data-collapsed', 'false');

      // Arm for the current project (A) -> the helper forces the panel collapsed.
      await setPendingProjectId(page, PROJECT_A_ID);
      await expect(container).toHaveAttribute('data-collapsed', 'true');

      // A stale arm for a DIFFERENT project must be ignored (project-scoped) -> panel expands.
      await setPendingProjectId(page, PROJECT_B_ID);
      await expect(container).toHaveAttribute('data-collapsed', 'false');

      // Disarm -> stays expanded.
      await setPendingProjectId(page, PROJECT_A_ID);
      await expect(container).toHaveAttribute('data-collapsed', 'true');
      await setPendingProjectId(page, null);
      await expect(container).toHaveAttribute('data-collapsed', 'false');
    } finally {
      await browser.close();
    }
  });
});
