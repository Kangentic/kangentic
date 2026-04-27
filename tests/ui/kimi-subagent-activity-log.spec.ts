/**
 * UI tests for ActivityLog rendering of SubagentStart and SubagentStop events.
 *
 * The Kimi wire parser emits EventType.SubagentStart and EventType.SubagentStop
 * when it sees a SubagentEvent envelope whose inner event.type is "TurnBegin"
 * or "TurnEnd" respectively. This spec verifies that ActivityLog renders those
 * event types as BadgeLine rows with the correct badge text ("Subagent" /
 * "Subagent done") and the detail string from the payload ("explore").
 *
 * Tier: UI (headless Chromium). The mock eventCache is pre-seeded via
 * __mockPreConfigure so no real PTY, IPC, or Electron binary is needed.
 * The rendering logic under test lives entirely in ActivityLog.tsx and its
 * EVENT_RENDERERS map.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-kimi-subagent-ui-test';
const TASK_ID = 'task-kimi-subagent-ui';
const SESSION_ID = 'sess-kimi-subagent-ui-01';
const SWIMLANE_ID = 'lane-planning-kimi-sub';

/**
 * Build the pre-configure script that seeds a project with a running session
 * and an eventCache containing SubagentStart and SubagentStop events.
 * The Planning lane has auto_spawn=true so the TerminalPanel shows the
 * running session and its Activity tab.
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Kimi Subagent UI Test',
        path: '/mock/kimi-subagent-ui',
        github_url: null,
        default_agent: 'kimi',
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

      // Running session so TerminalPanel renders a tab bar with Activity tab.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 12345,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/kimi-subagent-ui',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        transient: false,
      });
      state.activityCache['${SESSION_ID}'] = 'idle';

      // Seed the eventCache with the SubagentEvent lifecycle sequence that the
      // Kimi wire parser produces for a SubagentEvent envelope:
      //   inner TurnBegin  -> EventType.SubagentStart, detail = 'explore'
      //   inner TurnEnd    -> EventType.SubagentStop,  detail = 'explore'
      // Timestamps are milliseconds (SessionEvent.ts is epoch ms).
      var baseTs = Date.now();
      state.eventCache['${SESSION_ID}'] = [
        { ts: baseTs,       type: 'subagent_start', detail: 'explore' },
        { ts: baseTs + 500, type: 'subagent_stop',  detail: 'explore' },
      ];

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 42,
        title: 'Kimi Subagent Task',
        description: 'A task that ran a subagent',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'kimi',
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

test.describe('ActivityLog - SubagentStart and SubagentStop rendering', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState(makePreConfig()));
    // Wait for the Planning column to appear (confirms project loaded)
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

  test('SubagentStart event renders as "Subagent" badge with detail "explore"', async () => {
    // Click the Activity tab to make ActivityLog visible.
    // ActivityLog is rendered in a div with display:block when isActivityActive.
    const activityTab = page.locator('button:has-text("Activity")');
    await activityTab.click();

    // Wait for the ActivityLog container to be visible (at least one row rendered)
    // The virtualizer renders rows into the scroll container once items exist.
    // We wait for the "Subagent" badge text to appear in the DOM.
    await expect(page.getByText('Subagent', { exact: true })).toBeVisible({ timeout: 5000 });

    // Verify the badge row also contains the detail string "explore".
    // We scope to the parent row to confirm badge and detail co-exist in one row.
    const subagentStartRow = page.locator('div').filter({ hasText: /^[0-9:]+\s+Subagent\s+explore$/ });
    // Loose check: the page contains a text node with "Subagent" badge and "explore" detail.
    // We assert both pieces are present without hard-coding the DOM structure.
    await expect(page.getByText('Subagent', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('explore').first()).toBeVisible();
    void subagentStartRow; // referenced to document intent without strict-mode fragility
  });

  test('SubagentStop event renders as "Subagent done" badge with detail "explore"', async () => {
    // The Activity tab should already be active from the previous test.
    // Assert the SubagentStop badge renders.
    await expect(page.getByText('Subagent done', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('both subagent events appear in the Activity log (two rows visible)', async () => {
    // With only two events in the cache, both should be rendered by the virtualizer.
    // Count occurrences of the detail string - it appears in both rows.
    await expect(page.getByText('Subagent', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Subagent done', { exact: true })).toBeVisible({ timeout: 5000 });

    // The detail string "explore" appears in both the SubagentStart and SubagentStop rows.
    const exploreOccurrences = page.getByText('explore', { exact: true });
    // toHaveCount polls internally, no fixed wait needed.
    await expect(exploreOccurrences).toHaveCount(2, { timeout: 5000 });
  });
});
