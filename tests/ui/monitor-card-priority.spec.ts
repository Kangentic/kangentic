/**
 * UI tests for priority and labels on the Agent Monitor card (#1053, #1146).
 *
 * Intent: a monitor card draws them as the board card does. The priority meter
 * sits in the title row, after #N and before the browser globe (#1160), and the label row holds
 * labels only. The rule above the footer closes the label row, so a card under an
 * agent message trail with no labels has none and a labelled one keeps it. A row
 * with no priority (0, or a row built before the field existed) draws no meter.
 * The Task tab's Priority and Labels settings hide each here too.
 *
 * Without it a user loses the priority of every task in the monitor, sees a
 * footer jammed against a label row with no rule between them, or finds the
 * settings hide labels on the board but not in the monitor.
 *
 * Only a browser proves the footer half: the rule is a computed border on a
 * rendered element, which a unit test over the view model cannot see.
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
    state.config.showTaskNumbers = true;
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
      // A trail on both rows, so whether the footer draws its rule depends on
      // the label row alone.
      state.messageTrailCache[seed.id] = [{ uuid: 'm-' + seed.id, ts: 1, text: 'The tap works.' }];
    });
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

async function openMonitor(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const launched = await chromium.launch({ headless: true });
  const context = await launched.newContext({ viewport: { width: 1920, height: 1080 } });
  const opened = await context.newPage();
  await opened.addInitScript({ path: MOCK_SCRIPT });
  await opened.addInitScript(preConfig);
  await gotoVite(opened, VITE_URL);
  await opened.waitForSelector('text=Kangentic', { timeout: 15000 });
  await opened.locator('[data-testid="agent-monitor-button"]').click();
  await opened.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser: launched, page: opened };
}

/** Write a global config field through the real path the Task tab's switches use. */
async function setConfig(target: Page, partial: Record<string, boolean>): Promise<void> {
  await target.evaluate((value) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (partial: Record<string, boolean>) => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().updateConfig(value);
  }, partial);
}

const monitorCard = (target: Page, sessionId: string) => target.locator(`[data-testid="monitor-card"][data-session-id="${sessionId}"]`);

/**
 * Whether the card's footer draws its rule, read off its border WIDTH: Tailwind's
 * preflight gives every element `border-style: solid` at 0px.
 */
async function footerRule(target: Page, sessionId: string): Promise<'rule' | 'none'> {
  const footer = monitorCard(target, sessionId).locator('[data-testid="monitor-card-usage"]');
  await expect(footer).toBeVisible();
  const width = await footer.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth));
  return width > 0 ? 'rule' : 'none';
}

test.describe('Monitor card priority and labels', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await openMonitor());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('a priority-only card shows the meter after #N and no rule under its trail', async () => {
    const card = monitorCard(page, PRIORITY_SESSION_ID);
    // The trail must be showing, or a missing rule proves nothing.
    await expect(card.locator('[data-testid="monitor-card-trail"]')).toBeVisible();
    const mark = card.locator('[data-testid="priority-pill"]');
    await expect(mark).toHaveAccessibleName('Priority: High');
    await expect(mark).toHaveAttribute('data-variant', 'inline');
    await expect(mark.locator('[data-testid="priority-meter"] [data-filled]')).toHaveCount(3);
    await expect(card.locator('[data-testid="monitor-card-display-id"] + [data-testid="priority-pill"]')).toHaveCount(1);
    await expect(card.locator('[data-testid="monitor-card-display-id"]')).toHaveText('#1040');
    await expect(card.locator('[data-testid="task-pills"]')).toHaveCount(0);
    await expect.poll(() => footerRule(page, PRIORITY_SESSION_ID)).toBe('none');
  });

  test('a labelled card keeps its label row and the rule under it, and draws no meter without a priority', async () => {
    const card = monitorCard(page, LABEL_SESSION_ID);
    await expect(card.locator('[data-testid="task-pills"]')).toHaveText('bug');
    await expect(card.locator('[data-testid="priority-pill"]')).toHaveCount(0);
    await expect.poll(() => footerRule(page, LABEL_SESSION_ID)).toBe('rule');
  });
});

test('the Priority and Labels settings hide each on monitor cards', async () => {
  test.setTimeout(60_000);
  const { browser, page } = await openMonitor();
  try {
    await test.step('Priority off removes the meter', async () => {
      await setConfig(page, { showTaskPriority: false });
      await expect(monitorCard(page, PRIORITY_SESSION_ID).locator('[data-testid="priority-pill"]')).toHaveCount(0);
      await expect(monitorCard(page, LABEL_SESSION_ID).locator('[data-testid="task-pills"]')).toHaveText('bug');
      await setConfig(page, { showTaskPriority: true });
    });

    await test.step('Labels off removes the label row and its rule', async () => {
      await setConfig(page, { showTaskLabels: false });
      await expect(monitorCard(page, LABEL_SESSION_ID).locator('[data-testid="task-pills"]')).toHaveCount(0);
      await expect(monitorCard(page, PRIORITY_SESSION_ID).locator('[data-testid="priority-pill"]')).toHaveCount(1);
      await expect.poll(() => footerRule(page, LABEL_SESSION_ID)).toBe('none');
    });
  } finally {
    await browser.close();
  }
});
