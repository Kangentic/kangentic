/**
 * UI tests for the CollapsedRail component.
 *
 * The rail is only visible when the sidebar is collapsed. We collapse it by
 * clicking the "Hide sidebar" toggle button inside the full ProjectSidebar,
 * which triggers `useSidebarResize.toggle()` and sets `open = false`. This is
 * more reliable than pre-configuring `sidebarVisible: false` because the hook's
 * `useState` is frozen at mount time (it only reads config once).
 *
 * Performance: four shared Chromium launches, one per distinct preConfigScript
 * variant. Within each describe block, page.goto() in beforeEach resets the
 * in-memory mock state so tests are fully isolated. Compared to the original
 * per-test chromium.launch() pattern (11 launches for 11 tests), this reduces
 * launches from 11 to 4. The four describe blocks each own their browser+page
 * and share no mutable state between them, so parallel mode is safe and
 * overlaps the 4 launches on CI's 4-worker UI runner.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Each describe owns its own browser+page with no shared mutable state between
// describes, so CI's 4-worker pool can run all four groups concurrently.
test.describe.configure({ mode: 'parallel' });
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'rail-proj-a';
const PROJECT_B_ID = 'rail-proj-b';
const SESSION_A_ID = 'rail-sess-a';

/**
 * Collapse the sidebar so the CollapsedRail becomes active.
 * Called in beforeEach after each page.goto() so every test starts with the
 * rail visible regardless of which test ran before.
 */
async function collapseSidebar(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('button[title^="Hide sidebar"]').click();
  await page.locator('[data-testid="sidebar-expand-button"]').waitFor({ state: 'attached', timeout: 5000 });
}

/**
 * Pre-configure two projects with distinct first letters.
 * Project A is active with swimlanes set up.
 */
function twoDistinctProjectsScript(options?: {
  withSessionA?: boolean;
  sessionAActivity?: 'idle' | 'thinking';
}): string {
  const withSession = options?.withSessionA ?? false;
  const activity = options?.sessionAActivity ?? 'idle';
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Alpha',
        path: '/mock/alpha',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Beta',
        path: '/mock/beta',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 1,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'rail-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      ${withSession ? `
      state.sessions.push({
        id: '${SESSION_A_ID}',
        taskId: 'rail-task-a',
        projectId: '${PROJECT_A_ID}',
        pid: 1001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/alpha',
        startedAt: ts,
        exitCode: null,
        transient: false,
      });
      state.activityCache['${SESSION_A_ID}'] = '${activity}';
      ` : ''}

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

/**
 * Two projects whose names start with the same letter ("Alpha", "Aleph").
 */
function twoCollidingProjectsScript(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Alpha',
        path: '/mock/alpha',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Aleph',
        path: '/mock/aleph',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 1,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'rail-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

/**
 * Reset the page and collapse the sidebar. Each beforeEach calls this so every
 * test starts from a known state regardless of mutations from the prior test.
 */
async function resetAndCollapse(page: Page): Promise<void> {
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await collapseSidebar(page);
}

// ─── Group 1: two distinct projects, no sessions ──────────────────────────
//
// Covers: avatar labels, active-project highlight, project switching, no-
// session baseline, expand button, new-project button. All 7 tests share one
// Chromium launch because they use the same preConfigScript.

test.describe('CollapsedRail - distinct projects (no sessions)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(twoDistinctProjectsScript());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetAndCollapse(page);
  });

  test('single first letter when names have distinct initials', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton).toHaveText('A');
    await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).toHaveText('B');
  });

  test('active project button has bg-accent/20 class, inactive does not', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton).toHaveClass(/bg-accent\/20/);
    await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).not.toHaveClass(/bg-accent\/20/);
  });

  test('clicking an inactive rail cell opens that project', async () => {
    const betaButton = page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`);
    await betaButton.waitFor({ state: 'attached', timeout: 5000 });

    await betaButton.click();

    // The mock's currentProjectId updates when openProject is called.
    // Poll via getCurrent() to verify the switch happened.
    await expect.poll(async () => {
      return page.evaluate(async () => {
        const project = await window.electronAPI.projects.getCurrent();
        return project?.id ?? null;
      });
    }, { timeout: 5000 }).toBe('rail-proj-b');
  });

  test('baseline: no sessions, no activity icon', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton.locator('svg.text-amber-400')).toHaveCount(0);
    await expect(alphaButton.locator('svg.text-green-400')).toHaveCount(0);
  });

  test('expand button re-opens the full sidebar', async () => {
    const expandButton = page.locator('[data-testid="sidebar-expand-button"]');
    await expandButton.waitFor({ state: 'attached', timeout: 5000 });

    await expandButton.click();

    // toggle() calls config.set({ sidebarVisible: true }) - confirm via the mock
    await expect.poll(async () => {
      return page.evaluate(async () => {
        const cfg = await window.electronAPI.config.getGlobal();
        return (cfg as { sidebarVisible: boolean }).sidebarVisible;
      });
    }, { timeout: 5000 }).toBe(true);
  });

  test('new project button calls dialog.selectFolder', async () => {
    // Patch selectFolder after page load to track calls
    await page.evaluate(() => {
      (window as { __selectFolderCallCount: number }).__selectFolderCallCount = 0;
      window.electronAPI.dialog.selectFolder = async function () {
        (window as { __selectFolderCallCount: number }).__selectFolderCallCount++;
        // Return null to cancel (no project opened)
        return null as unknown as string;
      };
    });

    const newProjectButton = page.locator('[data-testid="rail-new-project-button"]');
    await newProjectButton.waitFor({ state: 'attached', timeout: 5000 });
    await newProjectButton.click();

    await expect.poll(async () => {
      return page.evaluate(() => (window as { __selectFolderCallCount: number }).__selectFolderCallCount);
    }, { timeout: 3000 }).toBe(1);
  });
});

// ─── Group 2: two colliding projects (same first letter) ─────────────────

test.describe('CollapsedRail - colliding project initials', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(twoCollidingProjectsScript());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetAndCollapse(page);
  });

  test('2-letter label when two projects share the same first letter', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    // Both projects start with "AL" - the collision fallback uses slice(0,2).toUpperCase()
    await expect(alphaButton).toHaveText('AL');
    await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).toHaveText('AL');
  });
});

// ─── Group 3: idle session, no activity icon ─────────────────────────────

// Activity indicators are intentionally omitted from the collapsed rail: at the
// rail's narrow column width the partial-arc Loader2 glyph reads as a broken
// icon overflowing the project initial. The expanded sidebar still surfaces
// thinking/idle counts via SidebarActivityCounts; the rail just shows initials.

test.describe('CollapsedRail - idle session, no activity icon', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(twoDistinctProjectsScript({ withSessionA: true, sessionAActivity: 'idle' }));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetAndCollapse(page);
  });

  test('idle session does not render an activity icon on the rail', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton.locator('svg.text-amber-400')).toHaveCount(0);
    await expect(alphaButton.locator('svg.text-green-400')).toHaveCount(0);
  });
});

// ─── Group 4: thinking session, no icon and plain title ─────────────────

test.describe('CollapsedRail - thinking session, no icon and plain title', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(twoDistinctProjectsScript({ withSessionA: true, sessionAActivity: 'thinking' }));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetAndCollapse(page);
  });

  test('thinking session does not render an activity icon on the rail', async () => {
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton.locator('svg.text-amber-400')).toHaveCount(0);
    await expect(alphaButton.locator('svg.text-green-400')).toHaveCount(0);
  });

  test('title is plain project name even when a thinking session is active', async () => {
    // Guards against regression where compound tooltip e.g. "Alpha - 1 thinking, 0 idle"
    // is re-introduced alongside a badge. The title must stay plain project.name only.
    const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
    await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

    await expect(alphaButton).toHaveAttribute('title', 'Alpha');
  });
});
