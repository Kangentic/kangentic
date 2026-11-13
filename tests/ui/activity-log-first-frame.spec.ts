/**
 * UI coverage for ActivityLog's first frame after its tab turns active.
 *
 * The Activity tab stays mounted while hidden (display: none). Its virtualizer is handed the
 * scroll element only while `active`, and the scroll-to-end runs in a layout effect that runs
 * again when the rows first exist. A tab with more events than fit therefore paints at its LAST
 * event on the first frame after activation. Before the fix the first frame showed the oldest
 * rows, then jumped to the end on the next frame (312px in the web demo's poster gate).
 *
 * A later poll passes both before and after the fix, so the read happens inside one
 * page.evaluate: click the tab, wait for exactly one animation frame, read. requestAnimationFrame
 * callbacks run before that frame is painted, so this is what the first painted frame shows.
 *
 * Red checks: making getScrollElement unconditional, or turning the scroll-to-end layout effect
 * back into useEffect, leaves the first frame at scrollTop 0 and this test fails.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-activity-first-frame';
const TASK_ID = 'task-activity-first-frame';
const SESSION_ID = 'sess-activity-first-frame';
const SWIMLANE_ID = 'lane-planning-activity-first-frame';
const EVENT_COUNT = 300;
const LAST_DETAIL = `evt-${EVENT_COUNT - 1}`;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Activity First Frame Test', path: '/mock/activity-first-frame',
      github_url: null, default_agent: 'claude', position: 0, last_opened: timestamp, created_at: timestamp,
    });
    state.DEFAULT_SWIMLANES.forEach(function (template, index) {
      var id = template.name === 'Planning' ? '${SWIMLANE_ID}' : state.uuid();
      state.swimlanes.push({
        id: id, name: template.name, role: template.role, color: template.color, icon: template.icon,
        is_archived: template.is_archived, is_ghost: template.is_ghost,
        permission_mode: template.permission_mode ?? null, auto_spawn: template.auto_spawn ?? false,
        auto_command: template.auto_command ?? null, plan_exit_target_id: template.plan_exit_target_id ?? null,
        agent_override: template.agent_override ?? null, handoff_context: template.handoff_context ?? false,
        position: index, created_at: timestamp,
      });
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 34568,
      status: 'running', shell: 'bash', cwd: '/mock/activity-first-frame', startedAt: timestamp,
      exitCode: null, resuming: false, transient: false,
    });
    state.activityCache['${SESSION_ID}'] = 'thinking';
    var baseTimestamp = Date.now() - ${EVENT_COUNT} * 1000;
    var events = [];
    for (var index = 0; index < ${EVENT_COUNT}; index++) {
      events.push({ ts: baseTimestamp + index * 1000, type: 'turn_retrying', detail: 'evt-' + index });
    }
    state.eventCache['${SESSION_ID}'] = events;
    state.tasks.push({
      id: '${TASK_ID}', display_id: 9, title: 'Activity First Frame Task',
      description: 'A task with many activity events', swimlane_id: '${SWIMLANE_ID}', position: 0,
      agent: 'claude', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null,
      pr_number: null, pr_url: null, base_branch: null, use_worktree: null, labels: [], priority: 0,
      attachment_count: 0, archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

interface FirstFrameReading {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  lastRowRendered: boolean;
  lastRowInView: boolean;
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test('an Activity tab activated after being hidden paints at its last event on the first frame', async () => {
  const activityTab = page.locator('[data-testid="terminal-activity-tab"]');
  await expect(activityTab).toBeVisible({ timeout: 10000 });

  // The tab is mounted but hidden: its list has not been shown yet, so it is not the active tab.
  const hiddenWrapperCount = await page.evaluate(() => {
    const list = document.querySelector('div.overflow-y-auto.leading-5');
    return list !== null && list.parentElement !== null && getComputedStyle(list.closest('[style*="display"]') as Element).display === 'none' ? 1 : 0;
  });
  expect(hiddenWrapperCount, 'the Activity list must be mounted and hidden before activation').toBe(1);

  const reading = await page.evaluate(async (): Promise<FirstFrameReading> => {
    const button = document.querySelector('[data-testid="terminal-activity-tab"]') as HTMLButtonElement | null;
    if (!button) throw new Error('no Activity tab button');
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const list = document.querySelector('div.overflow-y-auto.leading-5') as HTMLElement;
    const listRect = list.getBoundingClientRect();
    const lastRow = Array.from(list.querySelectorAll('[data-index]')).find((row) => row.textContent?.includes('evt-299'));
    const lastRowRect = lastRow ? lastRow.getBoundingClientRect() : null;
    return {
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      scrollTop: list.scrollTop,
      lastRowRendered: lastRow !== undefined,
      lastRowInView: lastRowRect !== null && lastRowRect.top >= listRect.top - 1 && lastRowRect.bottom <= listRect.bottom + 1,
    };
  });

  expect(reading.lastRowRendered, `row ${LAST_DETAIL} must be rendered on the first frame`).toBe(true);
  expect(reading.lastRowInView, `row ${LAST_DETAIL} must be in view on the first frame`).toBe(true);
  expect(reading.scrollTop, 'first frame must already be at the end').toBeGreaterThanOrEqual(reading.scrollHeight - reading.clientHeight - 2);
  // The fixture must actually need scrolling, or the assertions above prove nothing.
  expect(reading.scrollHeight).toBeGreaterThan(reading.clientHeight + 500);
});
