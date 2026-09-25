/**
 * UI coverage for the renderer-side feature-usage telemetry call sites.
 *
 * Seven renderer call sites report feature adoption over IPC via
 * window.electronAPI.analytics.trackFeatureUsed(<feature>):
 *   - SettingsPanel.tsx fires 'settings' on mount.
 *   - useSearchPalette.ts's open() fires 'quick_find'.
 *   - usage-dashboard-store.ts's open() fires 'usage_dashboard'.
 *   - monitor-store.ts's open() fires 'agent_monitor'.
 *   - active-view-slice.ts's setActiveView('backlog') fires 'backlog'.
 *   - ChangesPanel.tsx fires 'changes_panel' in a mount effect (every host:
 *     task detail, the standalone dialog, the Command Terminal, the pop-out).
 *   - useConversationWindowBridge.ts fires 'conversation_viewer' whenever
 *     conversationSessionId is set (search-palette hit, session-summary
 *     button, or the task-detail header pill / kebab item).
 *
 * The headless mock (mock-electron-api.js) records every call into
 * window.__mockTrackFeatureUsedCalls, but nothing read it back: a typo'd
 * feature string at any call site ships silently, since main-process
 * validation just drops an unrecognized name (isKnownAnalyticsFeature in
 * src/main/analytics/usage.ts) rather than throwing. Each test below opens
 * the surface through its real user-facing trigger and asserts the exact
 * literal was recorded.
 *
 * Each test launches its own browser/project (no cross-test state), so the
 * file opts into parallel mode like search-palette.spec.ts and
 * usage-dashboard.spec.ts. The Changes panel and conversation viewer tests
 * need seeded task/session state the shared `createProject` helper cannot
 * produce, so they use the same `__mockPreConfigure` launch pattern as
 * task-detail-changes-panel.spec.ts and conversation-pill-disabled-state.spec.ts.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** Read the mock's feature-usage call log (empty array if nothing fired yet). */
async function getTrackedFeatures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const mockWindow = window as unknown as { __mockTrackFeatureUsedCalls?: string[] };
    return mockWindow.__mockTrackFeatureUsedCalls ?? [];
  });
}

test.describe('Feature usage telemetry', () => {
  test('opening Settings records the settings feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Settings ${Date.now()}`);

      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('settings');
    } finally {
      await browser.close();
    }
  });

  test('opening Quick Find records the quick_find feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Quick Find ${Date.now()}`);

      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette').waitFor({ state: 'visible', timeout: 3000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('quick_find');
    } finally {
      await browser.close();
    }
  });

  test('opening the usage dashboard records the usage_dashboard feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Usage Dashboard ${Date.now()}`);

      await page.locator('[data-testid="usage-stats-button"]').click();
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 5000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('usage_dashboard');
    } finally {
      await browser.close();
    }
  });

  test('opening the Agent Monitor records the agent_monitor feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Agent Monitor ${Date.now()}`);

      await page.locator('[data-testid="agent-monitor-button"]').click();
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'visible', timeout: 10000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('agent_monitor');
    } finally {
      await browser.close();
    }
  });

  test('switching to the Backlog view records the backlog feature usage', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Telemetry Backlog ${Date.now()}`);

      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await page.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('backlog');
    } finally {
      await browser.close();
    }
  });

  test('opening the Changes panel records the changes_panel feature usage', async () => {
    const CHANGES_PROJECT_ID = 'proj-telemetry-changes';
    const CHANGES_TASK_ID = 'task-telemetry-changes';
    const CHANGES_SESSION_ID = 'sess-telemetry-changes';

    // Running session, so displayState.kind === 'running' -> the dialog opens
    // in non-editing mode and TaskDetailHeader (with the Changes pill) renders,
    // mirroring task-detail-changes-panel.spec.ts's preConfig shape.
    const preConfigScript = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${CHANGES_PROJECT_ID}',
          name: 'Telemetry Changes Panel',
          path: '/mock/telemetry-changes-panel',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var laneIds = {};
        state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
          var id = 'lane-telemetry-changes-' + index;
          laneIds[swimlane.name] = id;
          state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
        });

        state.sessions.push({
          id: '${CHANGES_SESSION_ID}',
          taskId: '${CHANGES_TASK_ID}',
          projectId: '${CHANGES_PROJECT_ID}',
          pid: 9999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/telemetry-changes-panel',
          startedAt: ts,
          exitCode: null,
        });

        state.tasks.push({
          id: '${CHANGES_TASK_ID}',
          title: 'Telemetry Changes Task',
          description: '',
          swimlane_id: laneIds['Code Review'],
          position: 0,
          agent: 'claude',
          session_id: '${CHANGES_SESSION_ID}',
          worktree_path: '/mock/worktrees/telemetry-changes',
          branch_name: 'feature/telemetry-changes',
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });

        return { currentProjectId: '${CHANGES_PROJECT_ID}' };
      });
    `;

    await waitForViteReady(VITE_URL);
    const browser: Browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.addInitScript({ path: MOCK_SCRIPT });
      await page.addInitScript(preConfigScript);
      await page.goto(VITE_URL);
      await page.waitForLoadState('load');
      await page.waitForSelector('text=Kangentic', { timeout: 15000 });
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

      const card = page
        .locator('[data-swimlane-name="Code Review"]')
        .locator('text=Telemetry Changes Task')
        .first();
      await card.click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Panel starts closed; the pill opens it (matches
      // task-detail-changes-panel.spec.ts's "controls toggle" test). CI Linux
      // can take >5s for the re-render, so give the expand control 10s.
      await page.locator('[data-testid="changes-toggle"]').click();
      await page.locator('[data-testid="changes-expand"]').waitFor({ state: 'visible', timeout: 10000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('changes_panel');
    } finally {
      await browser.close();
    }
  });

  test('opening the conversation viewer records the conversation_viewer feature usage', async () => {
    const CONVERSATION_PROJECT_ID = 'proj-telemetry-conversation';
    const CONVERSATION_TASK_ID = 'task-telemetry-conversation';
    const CONVERSATION_HISTORICAL_SESSION_ID = 'sess-telemetry-conversation-historical';

    // No live session: the task-detail header's conversation pill resolves
    // through transcripts.listSessions instead, exercising the historical-
    // session path the same way conversation-pill-disabled-state.spec.ts does.
    const preConfigScript = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${CONVERSATION_PROJECT_ID}',
          name: 'Telemetry Conversation Viewer',
          path: '/mock/telemetry-conversation-viewer',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var laneIds = {};
        state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
          var id = 'lane-telemetry-conversation-' + index;
          laneIds[swimlane.name] = id;
          state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
        });

        state.tasks.push({
          id: '${CONVERSATION_TASK_ID}',
          title: 'Telemetry Conversation Task',
          description: '',
          swimlane_id: laneIds['Code Review'],
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

        var transcriptSessionsByTask = {};
        transcriptSessionsByTask['${CONVERSATION_TASK_ID}'] = [
          {
            sessionId: '${CONVERSATION_HISTORICAL_SESSION_ID}',
            agentName: 'Claude Code',
            startedAt: ts,
            exitedAt: ts,
            isolatedSwimlaneId: null,
            status: 'exited',
          },
        ];

        return {
          currentProjectId: '${CONVERSATION_PROJECT_ID}',
          transcriptSessionsByTask: transcriptSessionsByTask,
        };
      });
    `;

    await waitForViteReady(VITE_URL);
    const browser: Browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.addInitScript({ path: MOCK_SCRIPT });
      await page.addInitScript(preConfigScript);
      await page.goto(VITE_URL);
      await page.waitForLoadState('load');
      await page.waitForSelector('text=Kangentic', { timeout: 15000 });
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

      // Open the task-detail window directly via the store, bypassing the
      // card-click edit-mode heuristic for a task with no live session
      // (mirrors conversation-pill-disabled-state.spec.ts's openTaskDetail).
      await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
        }).__zustandStores;
        stores?.session.getState().setDetailTaskId(taskId);
      }, CONVERSATION_TASK_ID);
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

      const conversationPill = page.getByTestId('conversation-pill');
      await expect(conversationPill).toBeEnabled({ timeout: 5000 });
      await conversationPill.click();

      await page.getByTestId('conversation-window').waitFor({ state: 'visible', timeout: 5000 });

      await expect
        .poll(async () => getTrackedFeatures(page), { timeout: 5000 })
        .toContain('conversation_viewer');
    } finally {
      await browser.close();
    }
  });
});
