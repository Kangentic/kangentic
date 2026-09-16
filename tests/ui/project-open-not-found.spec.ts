/**
 * UI tests for Sentry DESKTOP-V: clicking a sidebar project whose row main
 * can no longer resolve used to reject into an unawaited click handler (an
 * unhandled rejection) with nothing shown on screen. `openProject` now
 * never throws - it reports the failure through a toast and refetches the
 * list, so the dead row stops being clickable.
 *
 * Technique follows sidebar-command-terminals.spec.ts: monkey-patch the
 * mock's `projects.open` / `projects.list` at runtime to reproduce a
 * renderer whose list has outlived the row behind it.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';
import { PROJECT_NOT_FOUND_PREFIX } from '../../src/shared/ipc-channels';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'onf-proj-a';
const PROJECT_B_ID = 'onf-proj-b';

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/onf-project-alpha',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/onf-project-beta',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 1,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'onf-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

test.describe('clicking a stale sidebar project', () => {
  test('shows a toast, drops the row, and produces no unhandled rejection', async () => {
    const { browser, page } = await launchWithState();

    try {
      // Attached before the interaction under test, matching the doc'd
      // convention in collectPageErrors - the whole point of this test is
      // that the click used to file an unhandled rejection with nothing on
      // screen, so the error window has to cover the click itself.
      const getPageErrors = collectPageErrors(page);

      await page.evaluate(({ prefix, projectAId }) => {
        window.electronAPI.projects.__openCalls.length = 0;
        // Main can no longer resolve this row (a global-DB recovery that
        // reopened onto a different file, or a dev-only boot prune) - the
        // renderer's own list is what's stale here.
        window.electronAPI.projects.open = async function (id: string) {
          window.electronAPI.projects.__openCalls.push(id);
          throw new Error(`Error invoking remote method 'project:open': Error: ${prefix}${id}`);
        };
        // The refetch openProject triggers must reflect main's view, which
        // no longer has the row - otherwise the row would come right back.
        window.electronAPI.projects.list = async function () {
          return [{
            id: projectAId,
            name: 'Project Alpha',
            path: '/mock/onf-project-alpha',
            github_url: null,
            default_agent: 'claude',
            default_model: null,
            default_effort: null,
            group_id: null,
            position: 0,
            last_opened: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }];
        };
      }, { prefix: PROJECT_NOT_FOUND_PREFIX, projectAId: PROJECT_A_ID });

      await page.locator(`[data-testid="project-row-${PROJECT_B_ID}"]`).click();

      // Positive signal the click actually drove the broken path.
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: /no longer available|Could not open/ }))
        .toBeVisible({ timeout: 5000 });

      const openCalls = await page.evaluate(() => window.electronAPI.projects.__openCalls as string[]);
      expect(openCalls).toEqual([PROJECT_B_ID]);

      // The dead row stops being clickable: it is gone from the sidebar
      // once the store refetches.
      await expect(page.locator(`[data-testid="project-row-${PROJECT_B_ID}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="project-row-${PROJECT_A_ID}"]`)).toBeVisible();

      // The regression this test actually reports: no unhandled rejection.
      await page.waitForTimeout(300);
      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('PROJECT_LIST_CHANGED refetches the list without a click', async () => {
    const { browser, page } = await launchWithState();

    try {
      await expect(page.locator(`[data-testid="project-row-${PROJECT_B_ID}"]`)).toBeVisible();

      await page.evaluate(({ projectAId }) => {
        // Main deleted the row behind the renderer's back (the mechanism
        // this push exists for: a boot prune, or a recovered global DB
        // that reopened onto a different file).
        window.electronAPI.projects.list = async function () {
          return [{
            id: projectAId,
            name: 'Project Alpha',
            path: '/mock/onf-project-alpha',
            github_url: null,
            default_agent: 'claude',
            default_model: null,
            default_effort: null,
            group_id: null,
            position: 0,
            last_opened: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }];
        };
        (window as unknown as { __mockFireProjectListChanged: () => void }).__mockFireProjectListChanged();
      }, { projectAId: PROJECT_A_ID });

      await expect(page.locator(`[data-testid="project-row-${PROJECT_B_ID}"]`)).toHaveCount(0, { timeout: 5000 });
      await expect(page.locator(`[data-testid="project-row-${PROJECT_A_ID}"]`)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('clicking a stale project through the COLLAPSED RAIL also produces no unhandled rejection', async () => {
    // The sidebar row (above) and the collapsed rail are two separate click
    // handlers over the same store method - `ProjectListItem` awaits/catches
    // nothing special, `CollapsedRail` fires `openProject(project.id)`
    // unawaited with no `.catch`. Before this fix, an unawaited rejection
    // from the rail would have surfaced exactly like the row's did. Covering
    // it here (not a new browser launch) keeps this cheap: the assertions
    // exercise the same `openProject` outcome contract already pinned in
    // `tests/unit/project-open-outcomes.test.ts`, just through the rail's DOM.
    const { browser, page } = await launchWithState();

    try {
      const getPageErrors = collectPageErrors(page);

      // Collapse the sidebar so the rail becomes the active surface. Pre-
      // configuring `sidebarVisible: false` does not work here: the sidebar's
      // open/closed `useState` is frozen at mount time, so it has to be
      // toggled live (mirrors collapsed-rail.spec.ts's collapseSidebar()).
      await page.locator('button[title^="Hide sidebar"]').click();
      await page.locator('[data-testid="sidebar-expand-button"]').waitFor({ state: 'attached', timeout: 5000 });

      await page.evaluate(({ prefix, projectAId }) => {
        window.electronAPI.projects.__openCalls.length = 0;
        window.electronAPI.projects.open = async function (id: string) {
          window.electronAPI.projects.__openCalls.push(id);
          throw new Error(`Error invoking remote method 'project:open': Error: ${prefix}${id}`);
        };
        window.electronAPI.projects.list = async function () {
          return [{
            id: projectAId,
            name: 'Project Alpha',
            path: '/mock/onf-project-alpha',
            github_url: null,
            default_agent: 'claude',
            default_model: null,
            default_effort: null,
            group_id: null,
            position: 0,
            last_opened: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }];
        };
      }, { prefix: PROJECT_NOT_FOUND_PREFIX, projectAId: PROJECT_A_ID });

      await page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`).click();

      await expect(page.locator('[data-testid="toast"]').filter({ hasText: /no longer available|Could not open/ }))
        .toBeVisible({ timeout: 5000 });

      const openCalls = await page.evaluate(() => window.electronAPI.projects.__openCalls as string[]);
      expect(openCalls).toEqual([PROJECT_B_ID]);

      // The dead rail cell drops out once the store refetches.
      await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`)).toBeVisible();

      // The regression this test actually reports: no unhandled rejection
      // from the rail's unawaited `openProject(project.id)` call.
      await page.waitForTimeout(300);
      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
