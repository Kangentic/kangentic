/**
 * UI tests for task card activity indicators during initialization.
 *
 * When a task first spawns a session, the backend defaults activity to 'idle'
 * before any hooks fire. During this initializing phase (no usage data yet),
 * the card should show only the "Starting agent..." bottom bar -- no title icon.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with pre-configured mock state.
 * The preConfigScript string is evaluated via addInitScript after the mock
 * is injected but before React mounts, so stores load the pre-set data.
 */
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

/** Shared IDs used across pre-configure scripts */
const PROJECT_ID = 'proj-activity-test';
const TASK_ID = 'task-activity-test';
const SESSION_ID = 'sess-activity-test';
const SWIMLANE_ID = 'lane-backlog';

/** Base pre-configure that creates a project with a task linked to a running session */
function makePreConfig(opts: { sessionStatus: string; activity: string; withUsage: boolean; nullSessionId?: boolean; withEvents?: boolean; noActivityCache?: boolean; withRateLimits?: boolean }): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Activity Test',
        path: '/mock/activity-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: s.name,
          role: s.role,
          color: s.color,
          icon: s.icon,
          is_archived: s.is_archived,
          permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false,
          position: i,
          created_at: ts,
        });
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: '${opts.sessionStatus}',
        shell: 'bash',
        cwd: '/mock/activity-test',
        startedAt: ts,
        exitCode: null,
      });

      ${opts.noActivityCache ? '' : `state.activityCache['${SESSION_ID}'] = '${opts.activity}';`}
      ${opts.withEvents ? `
      state.eventCache['${SESSION_ID}'] = [
        { ts: Date.now(), type: 'tool_start', tool: 'Read', detail: '/mock/file.ts' },
      ];
      ` : ''}

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Test Initializing Task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: null,
        session_id: ${opts.sessionStatus === 'suspended' || opts.nullSessionId ? 'null' : `'${SESSION_ID}'`},
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
    ${opts.withUsage ? `
    // Override getUsage to return mock usage data for this session
    var origGetUsage = window.electronAPI.sessions.getUsage;
    window.electronAPI.sessions.getUsage = async function () {
      var result = {};
      result['${SESSION_ID}'] = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.01, totalDurationMs: 5000 },
        ${opts.withRateLimits ? `rateLimits: {
          fiveHour: { usedPercentage: 18, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          sevenDay: { usedPercentage: 4, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5 },
        },` : ''}
      };
      return result;
    };
    ` : ''}
  `;
}

test.describe('Task Activity Indicators', () => {
  // Group A: running/idle/noUsage (3 tests share one browser)
  test.describe('running idle without usage', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false })
      ));
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('running idle without usage shows mail icon and usage bar', async () => {
      // Wait for the usage-bar to appear (confirms running state loaded)
      await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

      // After activity sync, idle activity shows mail icon (no spinner)
      const title = page.locator('text=Test Initializing Task').first();
      const titleRow = title.locator('..');
      await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible({ timeout: 10000 });
      await expect(titleRow.locator('.lucide-mail')).toBeVisible({ timeout: 10000 });
    });

    test('running idle with events but no usage shows mail icon and usage bar', async () => {
      const { browser: eventBrowser, page: eventPage } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false, withEvents: true })
      );

      try {
        await eventPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(eventPage.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const title = eventPage.locator('text=Test Initializing Task').first();
        const titleRow = title.locator('..');
        await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible({ timeout: 10000 });
        await expect(titleRow.locator('.lucide-mail')).toBeVisible({ timeout: 10000 });
      } finally {
        await eventBrowser.close();
      }
    });

    test('running thinking without usage shows spinner icon and usage bar', async () => {
      const { browser: thinkBrowser, page: thinkPage } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'thinking', withUsage: false, withEvents: true })
      );

      try {
        await thinkPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(thinkPage.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        // Thinking activity: spinner icon in title row
        const title = thinkPage.locator('text=Test Initializing Task').first();
        const titleRow = title.locator('..');
        await expect(titleRow.locator('.lucide-loader-circle')).toBeVisible();
        await expect(titleRow.locator('.lucide-mail')).not.toBeVisible();
      } finally {
        await thinkBrowser.close();
      }
    });
  });

  // Group B: running/idle/withUsage (5 tests share one browser)
  test.describe('running idle with usage', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true })
      ));
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('task with usage data and idle activity shows mail icon', async () => {
      const card = page.locator('text=Test Initializing Task').first();
      await expect(card).toBeVisible();

      const titleRow = card.locator('..');
      await expect(titleRow.locator('.lucide-mail')).toBeVisible();
      await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();

      const cardEl = page.locator(`[data-task-id="${TASK_ID}"]`);
      await expect(cardEl.locator('[data-testid="usage-bar"]')).toBeVisible();
      await expect(cardEl.locator('[data-testid="status-bar"]')).not.toBeVisible();
    });

    test('context bar renders cost before token counts', async () => {
      await page.locator('text=Test Initializing Task').first().click();
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

      const usageBar = page.locator('[data-testid="usage-bar"].h-8');
      await expect(usageBar).toBeVisible();

      const children = usageBar.locator('> *');
      const texts = await children.evaluateAll((els) =>
        els.map((el) => el.textContent?.trim() || '')
      );

      const costIdx = texts.findIndex((t) => t.includes('$'));
      const tokensIdx = texts.findIndex((t) => t.includes('1k'));

      expect(costIdx).toBeGreaterThanOrEqual(0);
      expect(tokensIdx).toBeGreaterThan(costIdx);

      // Click the backdrop overlay to close (Escape may be captured by terminal in view mode)
      await page.locator('.fixed.inset-0').first().click({ position: { x: 5, y: 5 } });
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    });

    test('status bar shows separate token and cost spans when usage exists', async () => {
      const tokens = page.locator('[data-testid="aggregate-tokens"]');
      const cost = page.locator('[data-testid="aggregate-cost"]');
      await expect(tokens).toBeVisible();
      await expect(cost).toBeVisible();

      await expect(tokens).toContainText('1k');
      await expect(cost).toContainText('$');
    });

    test('task with session opens detail dialog in view mode (not edit mode)', async () => {
      const card = page.locator('text=Test Initializing Task').first();
      await card.click();
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

      const heading = page.locator('.fixed h2:has-text("Test Initializing Task")');
      await expect(heading).toBeVisible();
      const titleInput = page.locator('.fixed input[placeholder="Task title"]');
      await expect(titleInput).not.toBeVisible();

      // Click the backdrop overlay to close (Escape may be captured by terminal in view mode)
      await page.locator('.fixed.inset-0').first().click({ position: { x: 5, y: 5 } });
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    });

    test('Edit button in kebab menu is enabled while agent is thinking', async () => {
      // This test needs thinking activity, launch separately
      const { browser: thinkBrowser, page: thinkPage } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'thinking', withUsage: true })
      );

      try {
        await thinkPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await thinkPage.locator('text=Test Initializing Task').first().click();
        await thinkPage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        await thinkPage.locator('[title="Actions"]').click();

        const editButton = thinkPage.locator('button:has-text("Edit")').filter({ has: thinkPage.locator('.lucide-pencil') });
        await expect(editButton).toBeVisible();
        await expect(editButton).toBeEnabled();

        await editButton.click();
        const titleInput = thinkPage.locator('.fixed input[placeholder="Task title"]');
        await expect(titleInput).toBeVisible();
      } finally {
        await thinkBrowser.close();
      }
    });
  });

  // Group C: exited/idle/noUsage (2 tests share one browser)
  test.describe('exited idle without usage', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'exited', activity: 'idle', withUsage: false })
      ));
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('exited session does not show initializing bar', async () => {
      const card = page.locator('text=Test Initializing Task').first();
      await expect(card).toBeVisible();

      const titleRow = card.locator('..');
      await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();
      await expect(page.locator('[data-testid="status-bar"]')).not.toBeVisible();
    });

    test('stale exited session with null session_id does not show initializing bar', async () => {
      // This needs nullSessionId: true, launch separately
      const { browser: staleBrowser, page: stalePage } = await launchWithState(
        makePreConfig({ sessionStatus: 'exited', activity: 'idle', withUsage: false, nullSessionId: true })
      );

      try {
        await stalePage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const card = stalePage.locator('text=Test Initializing Task').first();
        await expect(card).toBeVisible();

        const titleRow = card.locator('..');
        await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();
        await expect(titleRow.locator('.lucide-mail')).not.toBeVisible();
        await expect(stalePage.locator('[data-testid="status-bar"]')).not.toBeVisible();
      } finally {
        await staleBrowser.close();
      }
    });
  });

  // Group D: suspended/idle/noUsage (3 tests share one browser)
  test.describe('suspended idle without usage', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'suspended', activity: 'idle', withUsage: false })
      ));
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('suspended task during initialization shows neither activity icon', async () => {
      const card = page.locator('text=Test Initializing Task').first();
      await expect(card).toBeVisible();

      const titleRow = card.locator('..');
      await expect(titleRow.locator('.lucide-mail')).not.toBeVisible();
      await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();
    });

    test('suspended task shows "Paused" bottom bar with pause icon', async () => {
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);
      await expect(card).toBeVisible();

      const bottomBar = card.locator('[data-testid="status-bar"]');
      await expect(bottomBar).toBeVisible();
      await expect(bottomBar).toContainText('Paused');
      await expect(bottomBar.locator('.lucide-circle-pause')).toBeVisible();

      await expect(bottomBar.locator('.lucide-loader-circle')).not.toBeVisible();
    });

    test('suspended task in backlog dialog hides Resume button', async () => {
      await page.locator('text=Test Initializing Task').first().click();

      const dialogPanel = page.locator('[data-testid="task-detail-dialog"]');
      await expect(dialogPanel).toBeVisible({ timeout: 5000 });

      // To Do tasks should not show a resume button
      const resumeBtn = page.locator('text=Resume session');
      await expect(resumeBtn).not.toBeVisible();

      await page.keyboard.press('Escape');
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 2000 });
    });
  });

  // Group E: queued/idle/noUsage (1 test)
  test.describe('queued idle without usage', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'queued', activity: 'idle', withUsage: false })
      ));
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('queued task shows "Queued..." bottom bar with spinner', async () => {
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);
      await expect(card).toBeVisible();

      const bottomBar = card.locator('[data-testid="status-bar"]');
      await expect(bottomBar).toBeVisible();
      await expect(bottomBar).toContainText('Queued...');
      await expect(bottomBar.locator('.lucide-loader-circle')).toBeVisible();

      const titleRow = card.locator('text=Test Initializing Task').first().locator('..');
      await expect(titleRow.locator('.lucide-mail')).not.toBeVisible();
    });
  });

  // Group F: custom (no session) - auto-save test
  test.describe('auto-save on session appear', () => {
    test('auto-saves and exits edit mode when session appears', async () => {
      const preConfig = `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();

          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Activity Test',
            path: '/mock/activity-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });

          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
            state.swimlanes.push({
              id: id,
              name: s.name,
              role: s.role,
              color: s.color,
              icon: s.icon,
              is_terminal: s.is_terminal,
              permission_strategy: s.permission_strategy ?? null,
              auto_spawn: s.auto_spawn ?? false,
              position: i,
              created_at: ts,
            });
          });

          // No session pushed -- task starts with no session context
          state.tasks.push({
            id: '${TASK_ID}',
            title: 'Test Initializing Task',
            description: '',
            swimlane_id: '${SWIMLANE_ID}',
            position: 0,
            agent: null,
            session_id: null,
            worktree_path: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            base_branch: null,
            archived_at: null,
            created_at: ts,
            updated_at: ts,
          });

          return { currentProjectId: '${PROJECT_ID}' };
        });
      `;

      const { browser, page } = await launchWithState(preConfig);

      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

        const titleInput = page.locator('.fixed input[placeholder="Task title"]');
        await expect(titleInput).toBeVisible();

        await titleInput.fill('Updated Title');

        await page.evaluate(
          `window.__zustandStores.session.getState().resumeSession('${TASK_ID}')`,
        );

        const heading = page.locator('.fixed h2:has-text("Updated Title")');
        await expect(heading).toBeVisible({ timeout: 3000 });
        await expect(titleInput).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  // Group G: ContextBar spinner pill
  // Verifies the bottom-bar agent label shows a single "Starting agent..."
  // (or "Resuming agent...") spinner pill until the CLI reports a real model
  // displayName, instead of flashing "Agent" -> "Claude" -> "Opus 4.6 (1M Context)".
  test.describe('ContextBar spinner pill', () => {
    test('shows "Starting agent..." spinner pill when CLI has reported no signal yet', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false, noActivityCache: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const usageBar = page.locator('[data-testid="usage-bar"]').first();
        await expect(usageBar).toBeVisible({ timeout: 10000 });
        await expect(usageBar).toContainText('Starting agent...');
        await expect(usageBar.locator('.lucide-loader-circle')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('shows resolved model name once usage.model.displayName arrives', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
        await expect(usageBar).toBeVisible({ timeout: 10000 });
        await expect(usageBar).toContainText('Claude Sonnet');
        await expect(usageBar).not.toContainText('Starting agent...');
        await expect(usageBar).not.toContainText('Resuming agent...');
      } finally {
        await browser.close();
      }
    });

    test('shows "Loading agent..." spinner with 0% bar when CLI has reported but usage is still null', async () => {
      // hasActivityEntry (eventCache) flips cliHasReported true while usage is
      // still null -- the running branch should render the full bar layout
      // with a spinner + "Loading agent..." label and 0%, never an empty slot.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false, withEvents: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
        await expect(usageBar).toBeVisible({ timeout: 10000 });
        await expect(usageBar).toContainText('Loading agent...');
        await expect(usageBar).toContainText('0%');
        await expect(usageBar.locator('.lucide-loader-circle')).toBeVisible();
        await expect(usageBar).not.toContainText('Starting agent...');
        // Inner progress bar element exists at zero width
        // Inner progress bar element exists at zero width (not "visible" since 0px wide)
        await expect(usageBar.locator('div.h-full.rounded-full')).toHaveCount(1);
        await expect(usageBar.locator('div.h-full.rounded-full')).toHaveAttribute('style', /width:\s*0%/);
      } finally {
        await browser.close();
      }
    });

    test('shows model name with 0% bar when usage exists but no tokens streamed yet', async () => {
      // Usage object is present with a model displayName but totalInputTokens
      // is 0 -- the bar should render the model name on the left and 0% on
      // the right with a zero-width inner bar (no missing progress row).
      const preConfig = makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false })
        + `
        window.electronAPI.sessions.getUsage = async function () {
          var result = {};
          result['${SESSION_ID}'] = {
            model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
            contextWindow: { usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, contextWindowSize: 200000 },
            cost: { totalCostUsd: 0, totalDurationMs: 0 },
          };
          return result;
        };
        `;
      const { browser, page } = await launchWithState(preConfig);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
        await expect(usageBar).toBeVisible({ timeout: 10000 });
        await expect(usageBar).toContainText('Claude Sonnet');
        await expect(usageBar).toContainText('0%');
        await expect(usageBar).not.toContainText('Loading agent...');
        // Inner progress bar element exists at zero width (not "visible" since 0px wide)
        await expect(usageBar.locator('div.h-full.rounded-full')).toHaveCount(1);
        await expect(usageBar.locator('div.h-full.rounded-full')).toHaveAttribute('style', /width:\s*0%/);
      } finally {
        await browser.close();
      }
    });

    test('shows "Resuming agent..." when session.resuming is true', async () => {
      const preConfig = makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: false, noActivityCache: true })
        + `
        window.__mockPreConfigure(function (state) {
          var session = state.sessions.find(function (s) { return s.id === '${SESSION_ID}'; });
          if (session) session.resuming = true;
        });
        `;
      const { browser, page } = await launchWithState(preConfig);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const usageBar = page.locator('[data-testid="usage-bar"]').first();
        await expect(usageBar).toBeVisible({ timeout: 10000 });
        await expect(usageBar).toContainText('Resuming agent...');
        await expect(usageBar.locator('.lucide-loader-circle')).toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  // Group: rate-limits pill (Claude-only field, ContextBar component)
  test.describe('rate limits pill', () => {
    test('renders 5h and 7d bars in task detail ContextBar when usage.rateLimits is present', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the task detail dialog -- ContextBar is the .h-8 usage-bar inside it
        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();
        await expect(pill).toContainText('18%');
        await expect(pill).toContainText('4%');
        // Clock icon for 5h session, CalendarDays icon for 7d weekly
        await expect(pill.locator('svg')).toHaveCount(2);

        await page.locator('.fixed.inset-0').first().click({ position: { x: 5, y: 5 } });
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('does not render pill when usage.rateLimits is absent', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });
        await expect(contextBar.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);

        await page.locator('.fixed.inset-0').first().click({ position: { x: 5, y: 5 } });
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('pill tooltip title contains "Resets " text for a reset time more than 24 h in the future', async () => {
      // sevenDay.resetsAt is set to Date.now()/1000 + 5 days in makePreConfig withRateLimits:true.
      // formatResetTime returns `Resets ${formatDateTime(...)}` when ms > 24 h.
      // We assert the pill title contains "Resets " (from the sevenDay line) followed by
      // non-empty text -- we deliberately do NOT assert exact locale output since that
      // is covered by the unit tier datetime.test.ts tests.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        // The title is "5h session: <reset>\n7d weekly: <reset>".
        // sevenDay resets in 5 days so its line uses "Resets <formatted date>".
        expect(titleAttr).toMatch(/Resets [^\s]/);

        await page.locator('.fixed.inset-0').first().click({ position: { x: 5, y: 5 } });
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });
});
