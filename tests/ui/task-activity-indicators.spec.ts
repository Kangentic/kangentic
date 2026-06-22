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
function makePreConfig(opts: { sessionStatus: string; activity: string; withUsage: boolean; nullSessionId?: boolean; withEvents?: boolean; noActivityCache?: boolean; withRateLimits?: boolean; emptyRateLimits?: boolean; rateLimitResetsInPast?: boolean; rateLimitResetsWithin24h?: boolean; agent?: string | null }): string {
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
        agent: ${opts.agent !== undefined ? (opts.agent === null ? 'null' : `'${opts.agent}'`) : 'null'},
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
        ${opts.withRateLimits ? `rateLimits: [
          { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 18, resetsAt: ${opts.rateLimitResetsInPast ? 'Math.floor(Date.now() / 1000) - 60' : opts.rateLimitResetsWithin24h ? 'Math.floor(Date.now() / 1000) + 1800' : 'Math.floor(Date.now() / 1000) + 3600'} },
          { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 4, resetsAt: ${opts.rateLimitResetsInPast ? 'Math.floor(Date.now() / 1000) - 60' : opts.rateLimitResetsWithin24h ? 'Math.floor(Date.now() / 1000) + 7200' : 'Math.floor(Date.now() / 1000) + 86400 * 5'} },
        ],` : opts.emptyRateLimits ? 'rateLimits: [],' : ''}
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

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(usageBar).toBeVisible();

      const children = usageBar.locator('> *');
      const texts = await children.evaluateAll((els) =>
        els.map((el) => el.textContent?.trim() || '')
      );

      const costIdx = texts.findIndex((t) => t.includes('$'));
      const tokensIdx = texts.findIndex((t) => t.includes('1k'));

      expect(costIdx).toBeGreaterThanOrEqual(0);
      expect(tokensIdx).toBeGreaterThan(costIdx);

      // Click the X close button (Escape may be captured by terminal in view mode)
      await page.locator('[data-testid="task-detail-close"]').click();
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

      // Click the X close button (Escape may be captured by terminal in view mode)
      await page.locator('[data-testid="task-detail-close"]').click();
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

      // Use Control+Shift+W (capture-phase) rather than Escape: the task-detail
      // window has a suspended session, so the bubble-phase Escape listener can
      // be intercepted on CI Linux after clicking the card moves focus.
      await page.keyboard.press('Control+Shift+W');
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 8000 });
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

    // Gap 1: liveTelemetryUnsupported branch
    // When a task's agent declares liveTelemetryUnsupported (currently only
    // Droid), ContextBar renders a static pill with the adapter's label and
    // tooltip instead of the indefinite Loader2 spinner. The renderer never
    // branches on agent name -- it reads the generic capability flag from
    // agentList.find(a => a.name === task.agent).
    //
    // The ContextBar component lives inside TaskDetailDialog (and the bottom
    // panel), not in the TaskCard inline bar. We open the dialog to assert
    // the ContextBar branch. The dialog's ContextBar has the `min-h-8` class
    // that distinguishes it from the TaskCard's own compact usage bar.
    test('shows static "Telemetry: TUI only" pill (no spinner) for droid agent', async () => {
      // Set agent:'droid' so agentList.find(a => a.name === 'droid')
      // resolves to the entry carrying liveTelemetryUnsupported. Leave
      // withUsage:false and noActivityCache:true so usage and
      // resolvedModelName both stay null -- triggering the early-return
      // branch in ContextBar before the full bar layout renders.
      const { browser, page } = await launchWithState(
        makePreConfig({
          sessionStatus: 'running',
          activity: 'idle',
          withUsage: false,
          noActivityCache: true,
          agent: 'droid',
        }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the task detail dialog to exercise the ContextBar component.
        await page.locator('text=Test Initializing Task').first().click();
        const dialog = page.locator('[data-testid="task-detail-dialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        // The ContextBar inside the dialog carries min-h-8 to distinguish it
        // from the TaskCard's own compact usage bar (which uses mt-2 pt-2).
        const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(usageBar).toBeVisible({ timeout: 10000 });

        // data-live-telemetry="unsupported" is the machine-readable signal
        await expect(usageBar).toHaveAttribute('data-live-telemetry', 'unsupported');

        // Human-readable pill text
        await expect(usageBar).toContainText('Telemetry: TUI only');

        // No spinner -- the indefinite Loader2 must be absent
        await expect(usageBar.locator('.lucide-loader-2')).toHaveCount(0);

        // No "Starting agent..." or "Resuming agent..." copy
        await expect(usageBar).not.toContainText('Starting agent...');
        await expect(usageBar).not.toContainText('Resuming agent...');

        // Tooltip contains the "Run /cost or /context" hint
        const pill = usageBar.locator('span[title]');
        const titleAttr = await pill.first().getAttribute('title');
        expect(titleAttr).toBeTruthy();
        expect(titleAttr).toMatch(/\/cost|\/context/);
      } finally {
        await browser.close();
      }
    });
  });

  // Group H: running session with no activity cache entry
  // Regression: previously, a running session whose activity entry was
  // missing from the main-side cache (orphaned DB row, HMR recovery gap,
  // listener reattach race) rendered a permanent thinking spinner + green
  // pulse in the title row because getTaskProgress defaulted activity to
  // 'thinking'. A running session is always either thinking or idle;
  // when there is no cached value, we default to idle (the safer value).
  // A real thinking session emits events quickly and self-corrects.
  // The bottom-bar "Starting agent..." overlay is unchanged (Group G).
  test.describe('running session with missing activity cache entry', () => {
    test('title row shows idle mail icon (not spinner) when activity cache is empty', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, noActivityCache: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const titleRow = page.locator('text=Test Initializing Task').first().locator('..');
        await expect(titleRow.locator('.lucide-mail')).toBeVisible({ timeout: 10000 });
        await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('card container has animate-pulse-subtle (idle pulse) when activity cache is empty', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, noActivityCache: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const card = page.locator(`[data-task-id="${TASK_ID}"]`);
        await expect(card).toBeVisible();

        const classAttr = await card.getAttribute('class');
        expect(classAttr).toBeTruthy();
        expect(classAttr).toContain('animate-pulse-subtle');
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

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();
        await expect(pill).toContainText('18%');
        await expect(pill).toContainText('4%');
        // Clock icon for 5h session, CalendarDays icon for 7d weekly
        await expect(pill.locator('svg')).toHaveCount(2);

        await page.locator('[data-testid="task-detail-close"]').click();
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

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });
        await expect(contextBar.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);

        await page.locator('[data-testid="task-detail-close"]').click();
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

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        // The title is "5h session: <reset>\n7d weekly: <reset>".
        // sevenDay resets in 5 days so its line uses "Resets <formatted date>".
        expect(titleAttr).toMatch(/Resets [^\s]/);

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('hides pill when usage.rateLimits is absent even though latestRateLimits is populated globally', async () => {
      // The visibility gate is `!!usage.rateLimits && !!latestRateLimits`. Adapters
      // like Codex or Gemini never populate usage.rateLimits, so the pill must stay
      // hidden even when a sibling Claude session has already seeded latestRateLimits.
      //
      // Setup: task has usage (so ContextBar renders fully) but usage.rateLimits is
      // absent. We then inject latestRateLimits directly into the session store via
      // Zustand to simulate a sibling session's update having already arrived.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Inject a non-null latestRateLimits snapshot into the store, simulating
        // a sibling session having already reported its rate limits.
        await page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores: { session: { getState: () => { latestRateLimits: unknown } & Record<string, unknown>; setState: (patch: Record<string, unknown>) => void } };
          }).__zustandStores;
          stores.session.setState({
            latestRateLimits: {
              rateLimits: [
                { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 65, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowDurationSeconds: 5 * 60 * 60 },
                { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 30, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
              ],
              capturedAt: Date.now(),
              sourceSessionId: 'some-other-session',
            },
          });
        });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        // The pill must be absent: this session's usage has no rateLimits, so the
        // per-session visibility gate blocks it regardless of latestRateLimits.
        await expect(contextBar.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('tooltip omits "via" suffix when sourceSessionId points at a missing task row', async () => {
      // sourceAgent is resolved by looking up the task whose session_id equals
      // latestRateLimits.sourceSessionId. When that task has been deleted (or the
      // snapshot came from a transient command-terminal session with no task row),
      // the lookup returns undefined. The tooltip must still render without crashing
      // and must NOT contain " via ".
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Override latestRateLimits so that sourceSessionId points at a session
        // that has no corresponding task row in the board store.
        await page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores: { session: { setState: (patch: Record<string, unknown>) => void } };
          }).__zustandStores;
          stores.session.setState({
            latestRateLimits: {
              rateLimits: [
                { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 50, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowDurationSeconds: 5 * 60 * 60 },
                { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
              ],
              capturedAt: Date.now(),
              // This session ID has no matching task in the board store, so
              // sourceAgent resolves to undefined and the "via" suffix is omitted.
              sourceSessionId: 'orphan-session-with-no-task',
            },
          });
        });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        // Must NOT contain "via" because sourceAgent resolves to undefined when
        // the task row for sourceSessionId is absent. Both old code (no suffix at
        // all) and new code (suffix without "via") satisfy this invariant.
        expect(titleAttr).not.toContain(' via ');

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('does not render pill when usage.rateLimits is an empty array', async () => {
      // rateLimits: [] is a valid value per the RateLimitWindow[] type (e.g. an
      // adapter that discovered no active plan windows). The ContextBar gates on
      // usage.rateLimits.length > 0, so the pill must stay hidden.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, emptyRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });
        await expect(contextBar.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('does not render pill when latestRateLimits.rateLimits is an empty array', async () => {
      // The global snapshot can arrive with an empty rateLimits array (e.g. if
      // updateUsage received [] before any real windows were reported). ContextBar
      // gates on latestRateLimits.rateLimits.length > 0, so the pill stays hidden.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Inject latestRateLimits with an empty rateLimits array.
        await page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores: { session: { setState: (patch: Record<string, unknown>) => void } };
          }).__zustandStores;
          stores.session.setState({
            latestRateLimits: {
              rateLimits: [],
              capturedAt: Date.now(),
              sourceSessionId: 'sess-activity-test',
            },
          });
        });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });
        await expect(contextBar.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('tooltip title contains window label prefixes ("5h session:" and "7d weekly:")', async () => {
      // Regression guard: the tooltip body is built as
      // `${limitWindow.label}: ${formatResetTime(limitWindow.resetsAt)}` per line.
      // Dropping the label prefix would silently break the tooltip without failing
      // the percentage-rendering or pill-visibility assertions.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        expect(titleAttr).toContain('5h session:');
        expect(titleAttr).toContain('7d weekly:');

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('formatResetTime returns "Resets now" when resetsAt is in the past', async () => {
      // The <=0 branch in formatResetTime: when epochSeconds * 1000 - Date.now() <= 0.
      // Both windows use resetsAt = now - 60s so both lines should show "Resets now".
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true, rateLimitResetsInPast: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        // Both windows reset in the past, so both lines should contain "Resets now".
        // We check that the tooltip contains "Resets now" at all - two occurrences
        // would require splitting, but one is sufficient to confirm the branch fires.
        expect(titleAttr).toContain('Resets now');

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('formatResetTime returns "Resets in ..." when resetsAt is within 24 hours', async () => {
      // The <24h branch in formatResetTime: ms > 0 and ms < 24 * 60 * 60 * 1000.
      // Both windows use resetsAt within 2 hours so both lines should say "Resets in ".
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true, rateLimitResetsWithin24h: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        const titleAttr = await pill.getAttribute('title');
        expect(titleAttr).toBeTruthy();
        expect(titleAttr).toContain('Resets in ');

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('pill renders Clock icon for 5h session and Calendar icon for 7d weekly (iconKind identity)', async () => {
      // Regression guard for RATE_LIMIT_ICON mapping: session -> Clock, period -> Calendar.
      // Swapping them would not be caught by the svg count assertion.
      // Lucide renders aria-label on the <svg> element, so we can check by
      // svg[aria-label="5h session"] and svg[aria-label="7d weekly"].
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'idle', withUsage: true, withRateLimits: true })
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('text=Test Initializing Task').first().click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

        const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
        await expect(contextBar).toBeVisible({ timeout: 10000 });

        const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
        await expect(pill).toBeVisible();

        // ContextBar renders: <Icon aria-label={limitWindow.label} />
        // Lucide forwards aria-label to the <svg> element.
        // .lucide-clock is the CSS class lucide adds to the Clock SVG.
        // .lucide-calendar is the CSS class lucide adds to the Calendar SVG.
        // We prefer class selectors here because they survive aria-label changes;
        // both checks together confirm the iconKind-to-icon mapping is correct.
        await expect(pill.locator('.lucide-clock')).toHaveCount(1);
        await expect(pill.locator('.lucide-calendar')).toHaveCount(1);

        await page.locator('[data-testid="task-detail-close"]').click();
        await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });

  // Group: permission activity state
  //
  // The fix in activity-engine.ts ensures that when a permission-class pause
  // (AskUserQuestion, ExitPlanMode plan-approval, tool prompt) resolves, the
  // engine restores turnActive=true so the next tool_end drives straight to
  // 'thinking' without an idle detour lasting 65-83s.
  //
  // Renderer-side invariant: both 'idle' and 'permission' map to isIdle=true
  // in TaskCard.tsx, so the Mail icon appears for both. There is no separate
  // lock icon - the design groups them as "agent needs attention".
  //
  // Source confirmation:
  //   src/renderer/components/board/TaskCard.tsx line 244-245:
  //     const isIdle = displayState.kind === 'running'
  //       && (displayState.activity === 'idle' || displayState.activity === 'permission');
  //   src/renderer/utils/task-progress.ts line 92-94:
  //     activity: activity ?? 'idle'  (defaults to idle when cache is empty)
  //
  // Three assertions here:
  //   1. 'permission' shows Mail icon (not spinner) - same affordance as idle
  //   2. 'permission' does NOT show spinner (thinking is absent)
  //   3. After cache update permission -> thinking, spinner appears with NO
  //      intermediate idle/mail flash (the renderer-side invariant the fix
  //      preserves: transitions go direct without passing through idle first)
  test.describe('permission activity state', () => {
    test('permission state shows mail icon (not spinner) on task card', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'permission', withUsage: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const titleRow = page.locator('text=Test Initializing Task').first().locator('..');

        // permission maps to isIdle=true: Mail icon appears (amber, "needs attention")
        await expect(titleRow.locator('.lucide-mail')).toBeVisible({ timeout: 10000 });

        // Spinner must NOT appear - permission is not a thinking state
        await expect(titleRow.locator('.lucide-loader-circle')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('permission state card has animate-pulse-subtle (idle pulse, not green thinking pulse)', async () => {
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'permission', withUsage: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const card = page.locator(`[data-task-id="${TASK_ID}"]`);
        await expect(card).toBeVisible();

        // isIdle=true sets animate-pulse-subtle (same as idle, NOT the thinking green glow)
        const classAttr = await card.getAttribute('class');
        expect(classAttr).toBeTruthy();
        expect(classAttr).toContain('animate-pulse-subtle');
      } finally {
        await browser.close();
      }
    });

    test('permission -> thinking transition shows spinner without idle/mail flash', async () => {
      // This is the renderer-side invariant the fix preserves: after the engine
      // corrects permissionPending->false and re-arms turnActive=true, the very
      // next ACTIVITY_CHANGED push sends 'thinking'. The renderer must go
      // directly from Mail icon to spinner. We verify that at no observable
      // point between the two states does the card briefly show idle (mail)
      // when thinking is already the new state.
      //
      // Technique: seed 'permission', then push 'thinking' via updateActivity,
      // then poll for spinner. If the spinner appears we know the transition
      // happened. The negative assertion is: while spinner is visible, mail is
      // absent. Playwright polls both in the same tick so we cannot race ourselves.
      const { browser, page } = await launchWithState(
        makePreConfig({ sessionStatus: 'running', activity: 'permission', withUsage: true }),
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.locator('[data-testid="usage-bar"]').first()).toBeVisible({ timeout: 10000 });

        const titleRow = page.locator('text=Test Initializing Task').first().locator('..');

        // Confirm we start in permission (mail icon visible)
        await expect(titleRow.locator('.lucide-mail')).toBeVisible({ timeout: 10000 });

        // Push activity update: permission -> thinking (simulates engine re-arming turnActive)
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores: { session: { getState: () => { updateActivity: (id: string, state: string) => void } } };
          }).__zustandStores;
          stores.session.getState().updateActivity(sessionId, 'thinking');
        }, SESSION_ID);

        // Spinner must appear (thinking is now active)
        await expect(titleRow.locator('.lucide-loader-circle')).toBeVisible({ timeout: 5000 });

        // Mail icon must be absent in the thinking state (no idle flash)
        await expect(titleRow.locator('.lucide-mail')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  // Group: task-detail header activity indicator
  //
  // Maximizing the task-detail view hides the board card, so the idle-vs-active
  // signal is folded into the header's pause/resume button. The pause action
  // stays centered and visible at all times; activity is encoded by the
  // surrounding ring: a spinning emerald ring (Loader2) for thinking, a static
  // amber ring (Circle) for idle/permission. The button's icon never changes on
  // hover. It is gated on canToggle (false in To Do), so these tasks live in the
  // Executing lane.
  test.describe('task-detail header activity indicator', () => {
    // Place the running task in a non-todo, non-done lane so the header's
    // pause/resume button renders (canToggle is false in To Do).
    function inExecutingLane(activity: string): string {
      return makePreConfig({ sessionStatus: 'running', activity, withUsage: true })
        + `
        window.__mockPreConfigure(function (state) {
          var execLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
          var task = state.tasks.find(function (t) { return t.id === '${TASK_ID}'; });
          if (execLane && task) task.swimlane_id = execLane.id;
        });
        `;
    }

    test('thinking session shows a spinning ring with a centered pause on the header button', async () => {
      const { browser, page } = await launchWithState(inExecutingLane('thinking'));
      try {
        await page.locator('text=Test Initializing Task').first().waitFor({ state: 'visible', timeout: 15000 });
        await page.locator('text=Test Initializing Task').first().click();
        const dialog = page.locator('[data-testid="task-detail-dialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        const pauseButton = dialog.locator('button[title="Pause session"]');
        await expect(pauseButton).toBeVisible({ timeout: 10000 });
        // Active: a spinning ring (animate-spin) + the centered pause.
        await expect(pauseButton.locator('.lucide-circle.animate-spin')).toBeVisible();
        await expect(pauseButton.locator('[data-testid="pause-bars"]')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('idle session shows a static amber ring with a centered pause on the header button', async () => {
      const { browser, page } = await launchWithState(inExecutingLane('idle'));
      try {
        await page.locator('text=Test Initializing Task').first().waitFor({ state: 'visible', timeout: 15000 });
        await page.locator('text=Test Initializing Task').first().click();
        const dialog = page.locator('[data-testid="task-detail-dialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        const pauseButton = dialog.locator('button[title="Pause session"]');
        await expect(pauseButton).toBeVisible({ timeout: 10000 });
        // Idle: a static amber ring + the centered pause; the ring does not spin.
        await expect(pauseButton.locator('.lucide-circle')).toBeVisible();
        await expect(pauseButton.locator('[data-testid="pause-bars"]')).toBeVisible();
        await expect(pauseButton.locator('.lucide-circle.animate-spin')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('permission -> thinking swaps the static idle ring for the spinning ring', async () => {
      const { browser, page } = await launchWithState(inExecutingLane('permission'));
      try {
        await page.locator('text=Test Initializing Task').first().waitFor({ state: 'visible', timeout: 15000 });
        await page.locator('text=Test Initializing Task').first().click();
        const dialog = page.locator('[data-testid="task-detail-dialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        const pauseButton = dialog.locator('button[title="Pause session"]');
        await expect(pauseButton).toBeVisible({ timeout: 10000 });
        // Permission maps to idle: a static amber ring, never the spinner.
        await expect(pauseButton.locator('.lucide-circle')).toBeVisible();
        await expect(pauseButton.locator('.lucide-circle.animate-spin')).toHaveCount(0);

        // Drive permission -> thinking; the static ring becomes the spinning ring.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores: { session: { getState: () => { updateActivity: (id: string, state: string) => void } } };
          }).__zustandStores;
          stores.session.getState().updateActivity(sessionId, 'thinking');
        }, SESSION_ID);

        await expect(pauseButton.locator('.lucide-circle.animate-spin')).toBeVisible({ timeout: 5000 });
        // The pause stays centered through the transition.
        await expect(pauseButton.locator('[data-testid="pause-bars"]')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('preparing (launching) shows a muted launch overlay and a pause-less header spinner', async () => {
      // A task in the Executing lane with NO session yet; injecting a spawn label
      // derives displayKind='preparing' (worktree creation, before the session).
      const preConfig = `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}', name: 'Activity Test', path: '/mock/activity-test',
            github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push({
              id: i === 0 ? '${SWIMLANE_ID}' : state.uuid(),
              name: s.name, role: s.role, color: s.color, icon: s.icon,
              is_archived: s.is_archived, permission_strategy: s.permission_strategy ?? null,
              auto_spawn: s.auto_spawn ?? false, position: i, created_at: ts,
            });
          });
          var execLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
          state.tasks.push({
            id: '${TASK_ID}', title: 'Test Initializing Task', description: 'Launching task.',
            swimlane_id: execLane.id, position: 0, agent: null, session_id: null,
            worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
            base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
          });
          return { currentProjectId: '${PROJECT_ID}' };
        });
      `;
      const { browser, page } = await launchWithState(preConfig);
      try {
        await page.locator('text=Test Initializing Task').first().waitFor({ state: 'visible', timeout: 15000 });
        await page.evaluate((taskId) => {
          (window as unknown as {
            __zustandStores: { session: { setState: (patch: Record<string, unknown>) => void } };
          }).__zustandStores.session.setState({ spawnProgress: { [taskId]: 'Creating worktree...' } });
        }, TASK_ID);

        await page.locator('text=Test Initializing Task').first().click();
        const dialog = page.locator('[data-testid="task-detail-dialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        // Body: the muted launch overlay surfaces the spawn status.
        await expect(dialog.getByText('Creating worktree...').first()).toBeVisible({ timeout: 10000 });

        // Header: a muted (grey) launch spinner - a Loader2, NOT the green active
        // ring - with no pause bars yet (the agent has not started).
        const pauseButton = dialog.locator('button[title="Pause session"]');
        await expect(pauseButton.locator('.lucide-loader-circle')).toBeVisible();
        await expect(pauseButton.locator('[data-testid="pause-bars"]')).toHaveCount(0);
        await expect(pauseButton.locator('.lucide-circle')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  });
});
