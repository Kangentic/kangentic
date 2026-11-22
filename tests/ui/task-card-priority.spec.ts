/**
 * UI tests for priority and labels on the task card (#1053, #1143, #1146).
 *
 * Intent: a task's priority is the bare level meter in the card's title row,
 * after #N and before the browser globe (#1146, #1160), centered on the row,
 * so a card with no labels spends no row
 * on it. The label row holds labels only. The bottom entry of the scale (index
 * 0, "None" by default) draws nothing, so a board where nobody sets priority
 * looks as it did. The rule above a footer closes the label row: a card under an
 * agent trail with no labels has none, a labelled one keeps it. The Task tab's
 * Priority and Labels settings hide each on cards, one without the other.
 * Hovering a card's title shows the whole title.
 *
 * Only a browser proves these: the order inside the title row, a computed
 * border, a rendered line height, a tooltip, and what a live update of the board
 * or config store repaints.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-card-priority';
const LABELLED_TASK_ID = 'task-priority-labelled';
const NONE_TASK_ID = 'task-priority-none';
const TRAIL_TASK_ID = 'task-priority-trail';
const TRAIL_SESSION_ID = 'session-priority-trail';
const LABELLED_TRAIL_TASK_ID = 'task-labelled-trail';
const LABELLED_TRAIL_SESSION_ID = 'session-labelled-trail';
const DONE_TASK_ID = 'task-priority-done';
const LABELLED_TITLE = 'Show failing checks on the card so a reviewer sees them before opening the pull request';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.config.showTaskNumbers = true;
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Card Priority Test', path: '/mock/card-priority-test',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-priority-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    function task(fields) {
      return Object.assign({
        description: '', agent: null, session_id: null, worktree_path: null, branch_name: null,
        pr_number: null, pr_url: null, base_branch: null, archived_at: null, labels: [], priority: 0,
        created_at: timestamp, updated_at: timestamp,
      }, fields);
    }
    function runningSession(sessionId, taskId, pid) {
      state.sessions.push({
        id: sessionId, taskId: taskId, projectId: '${PROJECT_ID}', pid: pid,
        status: 'running', shell: 'bash', cwd: '/mock/card-priority-test', startedAt: timestamp,
        exitCode: null, resuming: false, agentSessionId: 'agent-' + sessionId,
      });
      state.activityCache[sessionId] = 'thinking';
      state.messageTrailCache[sessionId] = [{ uuid: 't-' + sessionId, ts: 1, text: 'The tap works.' }];
    }
    state.tasks.push(task({
      id: '${LABELLED_TASK_ID}', display_id: 1048, title: '${LABELLED_TITLE}',
      swimlane_id: laneIds['To Do'], position: 0, priority: 3, labels: ['ui', 'git'],
    }));
    state.tasks.push(task({
      id: '${NONE_TASK_ID}', display_id: 1050, title: 'Rename the base picker local',
      swimlane_id: laneIds['To Do'], position: 1, priority: 0, labels: ['refactor'],
    }));
    // Running, with an agent trail and a priority but no labels: nothing sits
    // between the trail and the footer, so the footer draws no rule.
    runningSession('${TRAIL_SESSION_ID}', '${TRAIL_TASK_ID}', 9001);
    state.tasks.push(task({
      id: '${TRAIL_TASK_ID}', display_id: 1040, title: 'Install channels', agent: 'claude',
      session_id: '${TRAIL_SESSION_ID}', swimlane_id: laneIds['Executing'], position: 0, priority: 2,
    }));
    // Running, with an agent trail and a label: the label row closes with a rule.
    runningSession('${LABELLED_TRAIL_SESSION_ID}', '${LABELLED_TRAIL_TASK_ID}', 9002);
    state.tasks.push(task({
      id: '${LABELLED_TRAIL_TASK_ID}', display_id: 1041, title: 'Retry a timed-out check', agent: 'claude',
      session_id: '${LABELLED_TRAIL_SESSION_ID}', swimlane_id: laneIds['Executing'], position: 1, labels: ['ci'],
    }));
    state.archivedTasks.push(task({
      id: '${DONE_TASK_ID}', display_id: 1035, title: 'Base a task on a tag',
      swimlane_id: laneIds['Done'], position: 0, priority: 4, labels: ['git'], archived_at: timestamp,
    }));
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function openBoard(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const launched = await chromium.launch({ headless: true });
  const context = await launched.newContext({ viewport: { width: 1920, height: 1080 } });
  const opened = await context.newPage();
  await opened.addInitScript({ path: MOCK_SCRIPT });
  await opened.addInitScript(preConfig);
  await gotoVite(opened, VITE_URL);
  await opened.waitForSelector('text=Kangentic', { timeout: 15000 });
  await opened.locator(`[data-task-id="${LABELLED_TASK_ID}"]`).waitFor({ state: 'visible', timeout: 15000 });
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

const card = (target: Page, taskId: string) => target.locator(`[data-task-id="${taskId}"]`);

/** Mark which tasks have a running Browser pane, the session-store fact the card's globe reads. */
async function setBrowserGuestTasks(target: Page, entries: Array<[string, number]>): Promise<void> {
  await target.evaluate((guestEntries) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { setState: (partial: Record<string, unknown>) => void } };
    }).__zustandStores;
    stores.session.setState({ browserGuestTasks: new Map(guestEntries) });
  }, entries);
}

/**
 * Whether the board card's footer draws its rule, read off its computed border
 * WIDTH: Tailwind's preflight gives every element `border-style: solid` at 0px,
 * so the style alone reads solid with no rule drawn. Scoped to the column,
 * because the bottom panel's session for the same task carries the task id too.
 */
async function footerRule(target: Page, taskId: string): Promise<'rule' | 'none'> {
  const footer = target
    .locator(`[data-swimlane-name] [data-task-id="${taskId}"]`)
    .locator('[data-testid="usage-bar"], [data-testid="status-bar"]')
    .first();
  await expect(footer).toBeVisible();
  const width = await footer.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth));
  return width > 0 ? 'rule' : 'none';
}

test.describe('Task card priority and labels', () => {
  // One boot for the read-only checks. The one write (an agent's priority
  // update) runs last, and the switch cases boot their own page below.
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await openBoard());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('the meter sits in the title row, after #N, named for its level', async () => {
    const mark = card(page, LABELLED_TASK_ID).locator('[data-card-title-row] > [data-testid="priority-pill"]');
    await expect(mark).toHaveAccessibleName('Priority: High');
    await expect(mark).toHaveAttribute('data-variant', 'inline');
    // High is the third of four levels above None: three filled bars of four.
    await expect(mark.locator('[data-testid="priority-meter"] > span')).toHaveCount(4);
    await expect(mark.locator('[data-testid="priority-meter"] [data-filled]')).toHaveCount(3);
    // The meter follows the ticket number directly.
    await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="task-card-display-id"] + [data-testid="priority-pill"]')).toHaveCount(1);
  });

  test('a running Browser pane puts the globe last, after the meter', async () => {
    await setBrowserGuestTasks(page, [[LABELLED_TASK_ID, 1]]);
    const row = card(page, LABELLED_TASK_ID).locator('[data-card-title-row]');
    await expect(row.locator('[data-testid="task-card-display-id"] + [data-testid="priority-pill"] + [data-testid="task-card-browser-alive"]')).toHaveCount(1);
    await setBrowserGuestTasks(page, []);
    await expect(row.locator('[data-testid="task-card-browser-alive"]')).toHaveCount(0);
  });

  test('the label row holds labels only', async () => {
    const pills = card(page, LABELLED_TASK_ID).locator('[data-testid="task-pills"]');
    await expect(pills.locator('> *')).toHaveText(['ui', 'git']);
    await expect(pills.locator('[data-testid="priority-pill"]')).toHaveCount(0);
  });

  test('the meter is bare and adds no height to the title row', async () => {
    const mark = card(page, LABELLED_TASK_ID).locator('[data-testid="priority-pill"]');
    const look = await mark.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderTopWidth, width: element.getBoundingClientRect().width };
    });
    expect(look.background).toBe('rgba(0, 0, 0, 0)');
    expect(look.border).toBe('0px');
    // The 18px meter with no padding of its own; the title row's gap spaces it.
    expect(look.width).toBeGreaterThan(17);
    expect(look.width).toBeLessThan(19);
    const withMeter = await card(page, LABELLED_TASK_ID).locator('[data-card-title-row]').boundingBox();
    const withoutMeter = await card(page, NONE_TASK_ID).locator('[data-card-title-row]').boundingBox();
    expect(Math.abs((withMeter?.height ?? 0) - (withoutMeter?.height ?? 0))).toBeLessThanOrEqual(0.5);
    // Equal 10px bars, centered on the row (#1160): the rising meter's lit
    // bars sat low beside #N and the globe.
    const meterBox = await mark.locator('[data-testid="priority-meter"]').boundingBox();
    expect(Math.abs((meterBox?.height ?? 0) - 10)).toBeLessThanOrEqual(0.5);
    const meterCenter = (meterBox?.y ?? 0) + (meterBox?.height ?? 0) / 2;
    const rowCenter = (withMeter?.y ?? 0) + (withMeter?.height ?? 0) / 2;
    expect(Math.abs(meterCenter - rowCenter)).toBeLessThanOrEqual(1);
  });

  test('the bottom entry of the scale draws no meter', async () => {
    const noneCard = card(page, NONE_TASK_ID);
    await expect(noneCard.locator('[data-testid="task-pills"]')).toHaveText('refactor');
    await expect(noneCard.locator('[data-testid="priority-pill"]')).toHaveCount(0);
  });

  test('under an agent trail, the footer rule closes a label row and nothing else', async () => {
    // The trails must be showing, or a rule is there for another reason.
    await expect(card(page, TRAIL_TASK_ID).locator('[data-testid="task-card-trail"]')).toBeVisible();
    await expect(card(page, LABELLED_TRAIL_TASK_ID).locator('[data-testid="task-card-trail"]')).toBeVisible();
    // Priority only: the meter is in the title row, so no row stands under the trail.
    await expect(card(page, TRAIL_TASK_ID).locator('[data-card-title-row] > [data-testid="priority-pill"]')).toHaveAccessibleName('Priority: Medium');
    await expect(card(page, TRAIL_TASK_ID).locator('[data-testid="task-pills"]')).toHaveCount(0);
    await expect.poll(() => footerRule(page, TRAIL_TASK_ID)).toBe('none');
    await expect.poll(() => footerRule(page, LABELLED_TRAIL_TASK_ID)).toBe('rule');
  });

  test('hovering the title shows the whole title', async () => {
    const title = card(page, LABELLED_TASK_ID).locator('[data-testid="task-card-title"]');
    // The title is cut short on the card, so the tip is the only place it reads whole.
    expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await title.hover();
    // A tip that repeats its trigger's text is not exposed as a description, so
    // it is read off the tooltip itself.
    const tip = page.locator('[data-tooltip]');
    await expect(tip).toHaveText(LABELLED_TITLE);
    await page.mouse.move(2, 2);
    await expect(tip).toHaveCount(0);
  });

  test('the bare mark shows its level in the hover tip', async () => {
    const mark = card(page, LABELLED_TASK_ID).locator('[data-testid="priority-pill"]');
    await mark.hover();
    const tip = page.locator('[data-tooltip]');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('role', 'tooltip');
    await expect(tip).toHaveText('High');
    // Park the pointer on empty page space so the tip does not leak into later tests.
    await page.mouse.move(2, 2);
    await expect(tip).toHaveCount(0);
  });

  test('the Done list row shows the meter in its title line', async () => {
    const row = card(page, DONE_TASK_ID);
    await expect(row.locator('[data-testid="compact-title"] ~ [data-testid="priority-pill"]')).toHaveAccessibleName('Priority: Urgent');
    await expect(row.locator('[data-testid="task-card-display-id"] + [data-testid="priority-pill"]')).toHaveCount(1);
    await expect(row.locator('[data-testid="task-pills"] [data-testid="priority-pill"]')).toHaveCount(0);
  });

  test('the task detail header carries no priority badge', async () => {
    await card(page, TRAIL_TASK_ID).click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[data-testid="task-display-id"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="priority-pill"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('an agent update to priority repaints the card without a reload', async () => {
    await page.evaluate(async ({ taskId, projectId }) => {
      await window.electronAPI.tasks.update({ id: taskId, priority: 4 });
      const fire = (window as unknown as { __mockFireTaskUpdatedByAgent?: (id: string, title: string, project: string) => void }).__mockFireTaskUpdatedByAgent;
      fire?.(taskId, 'Rename the base picker local', projectId);
    }, { taskId: NONE_TASK_ID, projectId: PROJECT_ID });
    await expect(card(page, NONE_TASK_ID).locator('[data-card-title-row] > [data-testid="priority-pill"]')).toHaveAccessibleName('Priority: Urgent');
  });
});

test('the Priority and Labels settings hide each on cards independently', async () => {
  test.setTimeout(60_000);
  const { browser, page } = await openBoard();
  try {
    await test.step('Priority off: no meter on a board or Done card, labels stay', async () => {
      await setConfig(page, { showTaskPriority: false });
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="priority-pill"]')).toHaveCount(0);
      await expect(card(page, DONE_TASK_ID).locator('[data-testid="priority-pill"]')).toHaveCount(0);
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="task-pills"] > *')).toHaveText(['ui', 'git']);
      await setConfig(page, { showTaskPriority: true });
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="priority-pill"]')).toHaveCount(1);
    });

    await test.step('Labels off: no label row, the meter stays, and the trail card loses its rule', async () => {
      await setConfig(page, { showTaskLabels: false });
      await expect(card(page, LABELLED_TASK_ID).locator('[data-testid="task-pills"]')).toHaveCount(0);
      await expect(card(page, LABELLED_TASK_ID).locator('[data-card-title-row] > [data-testid="priority-pill"]')).toHaveCount(1);
      await expect.poll(() => footerRule(page, LABELLED_TRAIL_TASK_ID)).toBe('none');
    });
  } finally {
    await browser.close();
  }
});
