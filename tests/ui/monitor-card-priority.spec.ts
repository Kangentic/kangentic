/**
 * UI tests for priority on the Agent Monitor card (#1053).
 *
 * Intent: a monitor card draws the same pill row as the board card, priority
 * first and then labels. A card whose only pill is its priority, under an agent
 * message trail, keeps the rule above its footer, as a labelled card does. A row
 * with no priority (0, or a row built before the field existed) draws no
 * priority pill.
 *
 * Without it a user loses the priority of every task in the monitor, or sees a
 * priority-only card with its footer jammed against the agent's output with no
 * rule between them.
 *
 * Only a browser proves the footer half: the rule is a computed border style on
 * a rendered element, which a unit test over the view model cannot see.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-monitor-priority';
const PRIORITY_SESSION_ID = 'sess-priority-only';
const LABEL_SESSION_ID = 'sess-label-only';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Monitor Priority', path: '/mock/monitor-priority',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      state.swimlanes.push({
        id: 'lane-monitor-priority-' + index, name: lane.name, role: lane.role, color: lane.color,
        icon: lane.icon, is_archived: lane.is_archived, permission_strategy: lane.permission_strategy || null,
        auto_spawn: lane.auto_spawn || false, position: index, created_at: timestamp,
      });
    });
    [
      { id: '${PRIORITY_SESSION_ID}', taskId: 'task-priority-only', pid: 5301 },
      { id: '${LABEL_SESSION_ID}', taskId: 'task-label-only', pid: 5302 },
    ].forEach(function (seed) {
      state.sessions.push({
        id: seed.id, taskId: seed.taskId, projectId: '${PROJECT_ID}', pid: seed.pid, status: 'running',
        shell: 'bash', cwd: '/mock/monitor-priority', startedAt: timestamp, exitCode: null,
      });
      state.activityCache[seed.id] = 'thinking';
    });
    // The agent trail on the priority-only row, so the footer rule is asked for
    // by the priority and not by the absence of a trail.
    state.messageTrailCache['${PRIORITY_SESSION_ID}'] = [{ uuid: 'm1', ts: 1, text: 'The tap works.' }];
    return { currentProjectId: '${PROJECT_ID}' };
  });

  // The second row omits priority entirely, as a row built before the field did.
  window.__mockMonitorRows = [
    {
      sessionId: '${PRIORITY_SESSION_ID}', projectId: '${PROJECT_ID}', projectName: 'Monitor Priority',
      taskId: 'task-priority-only', taskTitle: 'Install channels', outputPeek: [], displayId: 1040,
      columnName: 'Executing', commandTerminalBranch: null, priority: 3, labels: [],
      prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Opus 5', effort: 'medium', permissionMode: 'auto',
      startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
      status: 'running', activity: 'thinking', activityReason: null,
      lastEvent: null, contextPercent: 20, isolated: false, isCommandTerminal: false,
    },
    {
      sessionId: '${LABEL_SESSION_ID}', projectId: '${PROJECT_ID}', projectName: 'Monitor Priority',
      taskId: 'task-label-only', taskTitle: 'Rename the base picker local', outputPeek: [], displayId: 1050,
      columnName: 'Executing', commandTerminalBranch: null, labels: ['bug'],
      prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Sonnet 5', effort: 'medium', permissionMode: 'auto',
      startedAt: '2026-01-01T00:01:00.000Z', exitedAt: null,
      status: 'running', activity: 'thinking', activityReason: null,
      lastEvent: null, contextPercent: 10, isolated: false, isCommandTerminal: false,
    },
  ];
`;

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
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-testid="agent-monitor-button"]').click();
  await page.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Monitor card priority pill', () => {
  test('a priority-only card under an agent trail shows the pill and keeps the footer rule', async () => {
    const card = page.locator(`[data-testid="monitor-card"][data-session-id="${PRIORITY_SESSION_ID}"]`);
    // The trail must be showing, or the rule is there for the old reason and
    // this passes without the fix.
    await expect(card.locator('[data-testid="monitor-card-trail"]')).toBeVisible();
    const pill = card.locator('[data-testid="priority-pill"]');
    await expect(pill).toHaveText('High');
    await expect(pill.locator('svg.lucide-flag')).toHaveCount(1);
    const footer = card.locator('[data-testid="monitor-card-usage"]');
    await expect(footer).toBeVisible();
    await expect.poll(() => footer.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('solid');
  });

  test('a row with no priority draws no priority pill and keeps its label', async () => {
    const card = page.locator(`[data-testid="monitor-card"][data-session-id="${LABEL_SESSION_ID}"]`);
    await expect(card.getByText('bug', { exact: true })).toBeVisible();
    await expect(card.locator('[data-testid="priority-pill"]')).toHaveCount(0);
  });
});
