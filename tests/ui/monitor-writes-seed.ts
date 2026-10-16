/**
 * Shared seed and page helpers for the Agent Monitor write specs
 * (monitor-writes-reach-board.spec.ts and monitor-confirm-and-detail-writes.spec.ts).
 *
 * This is a plain module, not a spec: importing a spec file would register its
 * tests a second time in the importer. Every helper here is stateless, and each
 * spec launches its own browser per test, so nothing leaks between tests.
 *
 * The seed builds one project (the OPEN one) and a second project the board is not
 * open on, the default board's lanes, and a task per entry. A task with `session`
 * also gets a running session and a monitor row; a task with `otherProject` is
 * tagged so the open board never lists it. The mock holds ONE task list, so the
 * other project's task lives beside the open project's, tagged.
 */
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

export const PROJECT_ID = 'proj-monitor-writes';
export const PROJECT_NAME = 'Monitor Writes Test';
export const OTHER_PROJECT_ID = 'proj-monitor-writes-other';
export const OTHER_PROJECT_NAME = 'Monitor Writes Other';

export interface TaskSeed {
  id: string;
  displayId: number;
  title: string;
  /** Swimlane name from the mock's default board. */
  lane: string;
  worktree?: boolean;
  /** A running session, so the monitor-hosted detail shows the task's live view. */
  session?: boolean;
  /** The task belongs to the second project, which the board is NOT open on. */
  otherProject?: boolean;
}

export interface Seed {
  tasks: TaskSeed[];
  skipDeleteConfirm?: boolean;
}

export function sessionIdOf(taskId: string): string {
  return `session-${taskId}`;
}

export function seedScript(seed: Seed): string {
  const rows = seed.tasks.map((task) => ({
    sessionId: sessionIdOf(task.id),
    projectId: task.otherProject ? OTHER_PROJECT_ID : PROJECT_ID,
    projectName: task.otherProject ? OTHER_PROJECT_NAME : PROJECT_NAME,
    taskId: task.id, taskTitle: task.title, outputPeek: [], displayId: task.displayId,
    columnName: task.lane, commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
    agentName: 'claude', modelDisplayName: 'Opus 5', effort: 'medium', permissionMode: 'auto',
    startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
    status: 'running', activity: 'thinking', activityReason: null,
    lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false,
  }));
  return `
    window.__mockMonitorRows = ${JSON.stringify(rows)};
    window.__mockPreConfigure(function (state) {
      var seed = ${JSON.stringify(seed)};
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: '${PROJECT_NAME}', path: '/mock/monitor-writes',
        github_url: null, default_agent: 'claude', group_id: null, position: 0,
        last_opened: timestamp, created_at: timestamp,
      });
      state.projects.push({
        id: '${OTHER_PROJECT_ID}', name: '${OTHER_PROJECT_NAME}', path: '/mock/monitor-writes-other',
        github_url: null, default_agent: 'claude', group_id: null, position: 1,
        last_opened: timestamp, created_at: timestamp,
      });
      if (seed.skipDeleteConfirm) state.config.skipDeleteConfirm = true;

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-mw-' + index;
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
      });

      var positions = {};
      seed.tasks.forEach(function (entry, index) {
        var sessionId = entry.session ? 'session-' + entry.id : null;
        positions[entry.lane] = (positions[entry.lane] || 0);
        state.tasks.push({
          id: entry.id, display_id: entry.displayId, title: entry.title, description: '',
          // A task of the other project is tagged, so the open board never lists it.
          projectId: entry.otherProject ? '${OTHER_PROJECT_ID}' : undefined,
          swimlane_id: laneIds[entry.lane], position: positions[entry.lane],
          agent: entry.session ? 'claude' : null, session_id: sessionId,
          worktree_path: entry.worktree ? '/mock/monitor-writes/.kangentic/worktrees/' + entry.id : null,
          branch_name: entry.worktree ? 'feature/' + entry.id : null,
          pr_number: null, pr_url: null, pr_state: null,
          base_branch: entry.worktree ? 'main' : null,
          use_worktree: entry.worktree ? 1 : 0,
          labels: [], priority: 0, attachment_count: 0, archived_at: null,
          automations_disabled: false, workflow_id: null, workflow_project_id: null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          canvas_x: null, canvas_y: null, created_at: timestamp, updated_at: timestamp,
        });
        positions[entry.lane] += 1;
        if (entry.session) {
          state.sessions.push({
            id: sessionId, taskId: entry.id, projectId: entry.otherProject ? '${OTHER_PROJECT_ID}' : '${PROJECT_ID}',
            pid: 9000 + index, status: 'running', shell: 'bash', cwd: '/mock/monitor-writes',
            startedAt: timestamp, exitCode: null, resuming: false, agentSessionId: 'agent-' + entry.id,
          });
          state.activityCache[sessionId] = 'thinking';
        }
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

export async function launch(seed: Seed): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(seedScript(seed));
    await gotoVite(page, VITE_URL);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export const byTestId = (page: Page, testId: string): Locator => page.locator(`[data-testid="${testId}"]`);
export const boardCard = (page: Page, taskId: string): Locator => page.locator(`[data-board-lanes] [data-task-id="${taskId}"]`);
export const cardInLane = (page: Page, lane: string, taskId: string): Locator =>
  page.locator(`[data-swimlane-name="${lane}"] [data-task-id="${taskId}"]`);

export async function openMonitor(page: Page): Promise<void> {
  await byTestId(page, 'agent-monitor-button').click();
  await byTestId(page, 'monitor-page').waitFor({ state: 'visible', timeout: 10000 });
  await byTestId(page, 'monitor-grid').waitFor({ state: 'visible', timeout: 10000 });
}

export async function closeMonitor(page: Page): Promise<void> {
  await byTestId(page, 'monitor-close').click();
  await byTestId(page, 'monitor-page').waitFor({ state: 'hidden', timeout: 10000 });
}

/**
 * Right-click a monitor row; the menu mounts once the row's task bundle resolves.
 * Scoped to the monitor page: a running session also puts its id on the bottom
 * panel's tab and pane, so a bare `[data-session-id]` is ambiguous for those rows.
 */
export async function openRowMenu(page: Page, taskId: string): Promise<Locator> {
  await byTestId(page, 'monitor-page').locator(`[data-session-id="${sessionIdOf(taskId)}"]`).click({ button: 'right' });
  const menu = byTestId(page, 'monitor-row-menu');
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  return menu;
}

/** How many times the mock's `tasks.delete` ran for a task. */
export async function deleteCallCount(page: Page, taskId: string): Promise<number> {
  return page.evaluate((id) => {
    const counts = (window as unknown as { __mockTaskDeleteCallCount?: Record<string, number> }).__mockTaskDeleteCallCount;
    return counts?.[id] ?? 0;
  }, taskId);
}

/** Titles in the open project's backlog, read from the mock. */
export async function backlogTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { backlog: { list: () => Promise<Array<{ title: string }>> } } }).electronAPI;
    return (await api.backlog.list()).map((item) => item.title);
  });
}

/** The project ids `tasks.move` was stamped with, in order. */
export async function moveProjectIds(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => (window as unknown as { __mockMoveProjectIds?: Array<string | null> }).__mockMoveProjectIds ?? []);
}

/** Every `backlog.demote` the mock received, in order, with the project id it was stamped for. */
export async function demoteCalls(page: Page): Promise<Array<{ taskId: string; projectId: string | null }>> {
  return page.evaluate(() => (window as unknown as {
    __mockDemoteCalls?: Array<{ taskId: string; projectId: string | null }>;
  }).__mockDemoteCalls ?? []);
}
