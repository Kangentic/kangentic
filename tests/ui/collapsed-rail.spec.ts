/**
 * UI tests for the CollapsedRail component.
 *
 * The rail is only visible when the sidebar is collapsed. We collapse it by
 * clicking the "Hide sidebar" toggle button inside the full ProjectSidebar,
 * which triggers `useSidebarResize.toggle()` and sets `open = false`. This is
 * more reliable than pre-configuring `sidebarVisible: false` because the hook's
 * `useState` is frozen at mount time (it only reads config once).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'rail-proj-a';
const PROJECT_B_ID = 'rail-proj-b';
const SESSION_A_ID = 'rail-sess-a';

/**
 * Launch a page, pre-configure state, then collapse the sidebar by clicking
 * the "Hide sidebar" button. Returns the browser and page ready for rail tests.
 */
async function launchWithCollapsedRail(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  // Wait for the board to confirm the project has loaded
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  // Collapse the sidebar so the CollapsedRail becomes active
  await page.locator('button[title="Hide sidebar"]').click();

  // Wait for the rail expand button to confirm the rail is now interactive
  await page.locator('[data-testid="sidebar-expand-button"]').waitFor({ state: 'attached', timeout: 5000 });

  return { browser, page };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('CollapsedRail - avatar labels', () => {
  test('single first letter when names have distinct initials', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

      await expect(alphaButton).toHaveText('A');
      await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).toHaveText('B');
    } finally {
      await browser.close();
    }
  });

  test('2-letter label when two projects share the same first letter', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoCollidingProjectsScript());

    try {
      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

      // Both projects start with "AL" - the collision fallback uses slice(0,2).toUpperCase()
      await expect(alphaButton).toHaveText('AL');
      await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).toHaveText('AL');
    } finally {
      await browser.close();
    }
  });
});

test.describe('CollapsedRail - active project highlight', () => {
  test('active project button has bg-accent/20 class, inactive does not', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

      await expect(alphaButton).toHaveClass(/bg-accent\/20/);
      await expect(page.locator(`[data-testid="rail-project-${PROJECT_B_ID}"]`)).not.toHaveClass(/bg-accent\/20/);
    } finally {
      await browser.close();
    }
  });

  test('clicking an inactive rail cell opens that project', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
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
    } finally {
      await browser.close();
    }
  });
});

// Activity indicators are intentionally omitted from the collapsed rail: at the
// rail's narrow column width the partial-arc Loader2 glyph reads as a broken
// icon overflowing the project initial. The expanded sidebar still surfaces
// thinking/idle counts via SidebarActivityCounts; the rail just shows initials.
test.describe('CollapsedRail - no activity indicators in collapsed view', () => {
  for (const activity of ['idle', 'thinking'] as const) {
    test(`${activity} session does not render an activity icon on the rail`, async () => {
      const { browser, page } = await launchWithCollapsedRail(
        twoDistinctProjectsScript({ withSessionA: true, sessionAActivity: activity }),
      );

      try {
        const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
        await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

        await expect(alphaButton.locator('svg.text-amber-400')).toHaveCount(0);
        await expect(alphaButton.locator('svg.text-green-400')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  }

  test('baseline: no sessions, no activity icon', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

      await expect(alphaButton.locator('svg.text-amber-400')).toHaveCount(0);
      await expect(alphaButton.locator('svg.text-green-400')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('title is plain project name even when a thinking session is active', async () => {
    // Guards against regression where compound tooltip e.g. "Alpha - 1 thinking, 0 idle"
    // is re-introduced alongside a badge. The title must stay plain project.name only.
    const { browser, page } = await launchWithCollapsedRail(
      twoDistinctProjectsScript({ withSessionA: true, sessionAActivity: 'thinking' }),
    );

    try {
      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await alphaButton.waitFor({ state: 'attached', timeout: 5000 });

      await expect(alphaButton).toHaveAttribute('title', 'Alpha');
    } finally {
      await browser.close();
    }
  });
});

test.describe('CollapsedRail - expand and new project buttons', () => {
  test('expand button re-opens the full sidebar', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
      const expandButton = page.locator('[data-testid="sidebar-expand-button"]');
      await expandButton.waitFor({ state: 'attached', timeout: 5000 });

      await expandButton.click();

      // toggle() calls config.set({ sidebarVisible: true }) - confirm via the mock
      await expect.poll(async () => {
        return page.evaluate(async () => {
          const cfg = await window.electronAPI.config.getGlobal();
          return (cfg as any).sidebarVisible;
        });
      }, { timeout: 5000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('new project button calls dialog.selectFolder', async () => {
    const { browser, page } = await launchWithCollapsedRail(twoDistinctProjectsScript());

    try {
      // Patch selectFolder after page load to track calls
      await page.evaluate(() => {
        (window as any).__selectFolderCallCount = 0;
        window.electronAPI.dialog.selectFolder = async function () {
          (window as any).__selectFolderCallCount++;
          // Return null to cancel (no project opened)
          return null as unknown as string;
        };
      });

      const newProjectButton = page.locator('[data-testid="rail-new-project-button"]');
      await newProjectButton.waitFor({ state: 'attached', timeout: 5000 });
      await newProjectButton.click();

      await expect.poll(async () => {
        return page.evaluate(() => (window as any).__selectFolderCallCount);
      }, { timeout: 3000 }).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
