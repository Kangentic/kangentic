/**
 * UI tests for ActivityLog rendering of the TurnRetrying event type.
 *
 * EventType.TurnRetrying ('turn_retrying') represents a transient StopFailure
 * error (529 overloaded / server_error) that the agent is auto-retrying - the
 * false-idle-during-retry fix (see activity-engine.ts's
 * applyRetryableFailureHold) keeps the session `thinking` through the retry
 * instead of force-idling it like a terminal TurnFailed. Its renderer entry
 * in EVENT_RENDERERS is:
 *
 *   [EventType.TurnRetrying]: (common, event) =>
 *     <BadgeLine {...common} badge="Retrying" detail={event.detail} variant="warn" />
 *
 * The exhaustiveness guard (tests/unit/activity-log-renderers.test.ts) only
 * pins that this entry EXISTS; it stubs out BadgeLine entirely and never
 * renders JSX, so it cannot catch a wrong badge label, a wrong detail wire-up,
 * or a dropped `variant="warn"`. This spec seeds a real turn_retrying
 * SessionEvent into the mock eventCache and asserts the actual rendered
 * content, modeled on the sibling idle-hint-activity-log.spec.ts.
 *
 * Tier: UI (headless Chromium). The mock eventCache is pre-seeded via
 * __mockPreConfigure so no real PTY, IPC, or Electron binary is needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-turn-retrying-ui-test';
const TASK_ID = 'task-turn-retrying-ui';
const SESSION_ID = 'sess-turn-retrying-ui-01';
const SWIMLANE_ID = 'lane-planning-turn-retrying';
const RETRY_DETAIL = 'server_error';

/**
 * Build the pre-configure script that seeds a project with a running session
 * and an eventCache containing a single turn_retrying event. The Planning
 * lane has auto_spawn=true so the TerminalPanel shows the running session
 * and its Activity tab.
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Turn Retrying Activity Log Test',
        path: '/mock/turn-retrying-ui',
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
        pid: 34567,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/turn-retrying-ui',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        transient: false,
      });
      state.activityCache['${SESSION_ID}'] = 'thinking';

      // Seed the eventCache with a single turn_retrying event.
      // SessionEvent.ts is epoch milliseconds; detail carries the classified
      // error kind (see hook-manager.ts's turn_retrying classification).
      var baseTs = Date.now();
      state.eventCache['${SESSION_ID}'] = [
        { ts: baseTs, type: 'turn_retrying', detail: '${RETRY_DETAIL}' },
      ];

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 8,
        title: 'Turn Retrying Task',
        description: 'A task that emitted a turn_retrying event',
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

test.describe('ActivityLog - TurnRetrying event rendering', () => {
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
    const activityTab = page.locator('button:has-text("Activity")');
    await expect(activityTab).toBeVisible({ timeout: 10000 });
  });

  test('turn_retrying event renders a "Retrying" badge in the Activity tab', async () => {
    const activityTab = page.locator('button:has-text("Activity")');
    await activityTab.click();

    // Wait for the "Retrying" badge text to appear in the DOM.
    await expect(page.getByText('Retrying', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('turn_retrying event passes its detail text through to the Activity tab row', async () => {
    // The Activity tab should already be active from the previous test.
    await expect(
      page.getByText(RETRY_DETAIL, { exact: true }),
    ).toBeVisible({ timeout: 5000 });
  });

  test('the "Retrying" badge renders with the warn (amber) variant, not the default variant', async () => {
    // BadgeLine's warn variant applies 'bg-amber-900/30 text-amber-400'; the
    // default variant applies 'bg-surface-raised text-fg-secondary'. Asserting
    // the amber class distinguishes TurnRetrying's warn badge from a default
    // one - this is the part the exhaustiveness guard's stubbed-out BadgeLine
    // cannot see, since it never renders real JSX or class names.
    const badge = page.getByText('Retrying', { exact: true });
    await expect(badge).toHaveClass(/bg-amber-900\/30/);
    await expect(badge).toHaveClass(/text-amber-400/);
  });
});
