/**
 * UI tests for ActivityLog rendering of the IdleHint event type.
 *
 * EventType.IdleHint ('idle_hint') represents a "Claude is waiting for your
 * input" notification that has been pre-classified at the source. Its renderer
 * entry in EVENT_RENDERERS is:
 *
 *   [EventType.IdleHint]: (common, event) =>
 *     <BadgeLine {...common} badge="Waiting for input" detail={event.detail} />
 *
 * This spec seeds an idle_hint SessionEvent into the mock eventCache and asserts
 * that the Activity tab renders:
 *   1. A "Waiting for input" badge visible in the DOM.
 *   2. The detail text ("Claude is waiting for your input") visible alongside it.
 *
 * Tier: UI (headless Chromium). The mock eventCache is pre-seeded via
 * __mockPreConfigure so no real PTY, IPC, or Electron binary is needed.
 * Rendering logic under test lives entirely in ActivityLog.tsx and its
 * EVENT_RENDERERS map.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-idle-hint-ui-test';
const TASK_ID = 'task-idle-hint-ui';
const SESSION_ID = 'sess-idle-hint-ui-01';
const SWIMLANE_ID = 'lane-planning-idle-hint';
const IDLE_HINT_DETAIL = 'Claude is waiting for your input';

/**
 * Build the pre-configure script that seeds a project with a running session
 * and an eventCache containing a single idle_hint event. The Planning lane has
 * auto_spawn=true so the TerminalPanel shows the running session and its
 * Activity tab.
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Idle Hint Activity Log Test',
        path: '/mock/idle-hint-ui',
        github_url: null,
        default_agent: 'claude',
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var id = template.name === 'Planning' ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: template.name,
          role: template.role,
          color: template.color,
          icon: template.icon,
          is_archived: template.is_archived,
          is_ghost: template.is_ghost,
          permission_mode: template.permission_mode ?? null,
          auto_spawn: template.auto_spawn ?? false,
          auto_command: template.auto_command ?? null,
          plan_exit_target_id: template.plan_exit_target_id ?? null,
          agent_override: template.agent_override ?? null,
          handoff_context: template.handoff_context ?? false,
          position: index,
          created_at: ts,
        });
      });

      // Running session so TerminalPanel renders a tab bar with the Activity tab.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 23456,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/idle-hint-ui',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        transient: false,
      });
      state.activityCache['${SESSION_ID}'] = 'idle';

      // Seed the eventCache with a single idle_hint event.
      // SessionEvent.ts is epoch milliseconds; detail carries the notification text.
      var baseTs = Date.now();
      state.eventCache['${SESSION_ID}'] = [
        { ts: baseTs, type: 'idle_hint', detail: '${IDLE_HINT_DETAIL}' },
      ];

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 7,
        title: 'Idle Hint Task',
        description: 'A task that emitted an idle_hint event',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

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

test.describe('ActivityLog - IdleHint event rendering', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState(makePreConfig()));
    // Wait for the Planning column to appear (confirms project loaded and board rendered)
    await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('Activity tab button is visible when a running session exists', async () => {
    // TerminalPanel renders the Activity tab button only when activeSessions.length >= 1.
    // The pre-configured running session should trigger this.
    const activityTab = page.locator('button:has-text("Activity")');
    await expect(activityTab).toBeVisible({ timeout: 10000 });
  });

  test('idle_hint event renders a "Waiting for input" badge in the Activity tab', async () => {
    // Click the Activity tab to make ActivityLog visible.
    const activityTab = page.locator('button:has-text("Activity")');
    await activityTab.click();

    // Wait for the "Waiting for input" badge text to appear in the DOM.
    // The virtualizer renders the row once the session's eventCache is loaded
    // by the session-store and passed down to ActivityLog.
    await expect(page.getByText('Waiting for input', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('idle_hint event passes its detail text through to the Activity tab row', async () => {
    // The Activity tab should already be active from the previous test.
    // Assert the detail string from the seeded event is also visible in the DOM.
    await expect(
      page.getByText(IDLE_HINT_DETAIL, { exact: true }),
    ).toBeVisible({ timeout: 5000 });
  });

  test('both the badge and the detail appear in the same row', async () => {
    // Confirm the badge and detail co-exist: the Activity log must show both
    // "Waiting for input" and the detail text from the single seeded event.
    await expect(page.getByText('Waiting for input', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(IDLE_HINT_DETAIL, { exact: true })).toBeVisible({ timeout: 5000 });

    // With exactly one idle_hint event seeded, each piece of text should
    // appear exactly once in the rendered log.
    await expect(page.getByText('Waiting for input', { exact: true })).toHaveCount(1, { timeout: 5000 });
    await expect(page.getByText(IDLE_HINT_DETAIL, { exact: true })).toHaveCount(1, { timeout: 5000 });
  });
});
