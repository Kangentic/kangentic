/**
 * UI tests for the per-task "Disable automations" switch (#827) and the two
 * card and menu changes that shipped with it.
 *
 * Intent:
 * - A task card's right-click menu offers "Disable automations" (or "Enable
 *   automations" once off) in the TOP group, after Edit and Show changes and
 *   before the navigation row and New workflow. A workflow task is offered no
 *   such row at all, because its workflow's Pause is what holds it.
 * - A task with its automations off wears a strip across the top of its card at
 *   every card density, and the strip explains itself in its tooltip.
 * - "Changes" is now "Show changes" and still opens the changes dialog.
 * - The rule above a card's footer closes what sits over it. The agent's message
 *   trail well closes itself with its own edge, so a card showing the trail and
 *   carrying no labels drops the rule. Labels, or a plain description (a paused
 *   card, or a running card whose agent has not spoken yet), keep it.
 * - The Agent Monitor row menu is the same menu and offers the same switch,
 *   writing to the ROW's project, not the open board's. A row of the OPEN project
 *   writes through the board store, so the card under the overlay gains its strip
 *   too. A row of a workflow task is offered no switch.
 * - The Agent Monitor marks a held task in all three of its layouts: the board's
 *   strip on the card, a slice closing the list row, and a Disabled chip in the
 *   table's Automations column. A Command Terminal has no task and carries none.
 * - A write the desktop rejects reaches the user as a toast with the plain
 *   sentence main wrote, not Electron's "Error invoking remote method" wrapper, from
 *   the card menu and from the monitor menu alike. The card is left as it was.
 * - The mock refuses the switch on a workflow task the way the desktop does, so
 *   the cases above that lean on it are not passing against a mock that allows it.
 *
 * The expected menu orders and the divider rule come from the task, not from the
 * components. Assertions read state (attributes, classes, text, DOM order), never
 * pixel geometry (.claude/rules/cross-platform-parity.md). Every test launches its
 * own browser, so there is no cross-test state.
 *
 * Not covered here: the Workflows canvas card menu (`WorkflowCardMenu`) never
 * passes `onToggleAutomations`, and nothing in this file drives that host.
 */
import { test, expect, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-automations-disabled';
const PROJECT_NAME = 'Automations Disabled Test';
const STRIP_TEST_ID = 'task-card-automations-disabled';
const STRIP_TIP = "Column automations don't run for this task. Enable them from the card's menu.";

/** A class attribute holds this token, as opposed to a longer class that starts with it. */
function classToken(token: string): RegExp {
  return new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
}
const HAS_DIVIDER = classToken('border-t');

interface TrailEntry { uuid: string; ts: number; text: string }

interface TaskSeed {
  id: string;
  displayId: number;
  title: string;
  /** Swimlane name from the mock's default board. */
  lane: string;
  description?: string;
  labels?: string[];
  worktree?: boolean;
  automationsDisabled?: boolean;
  workflowId?: string;
  /** In the Done list, not on the board. */
  archived?: boolean;
  /** The task's session, if it has one. Its id is `session-<task id>`. */
  session?: 'running' | 'suspended';
}

interface Seed {
  tasks: TaskSeed[];
  /** Message trails by TASK id, held in the mock the way main's tracker holds them past a pause. */
  trails?: Record<string, TrailEntry[]>;
  workflows?: unknown[];
}

function sessionIdOf(taskId: string): string {
  return `session-${taskId}`;
}

function seedScript(seed: Seed): string {
  return `
    window.__mockWorkflows = ${JSON.stringify(seed.workflows ?? [])};
    window.__mockWorkflowLinks = [];
    window.__mockPreConfigure(function (state) {
      var seed = ${JSON.stringify(seed)};
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: '${PROJECT_NAME}', path: '/mock/automations-disabled',
        github_url: null, default_agent: 'claude', group_id: null, position: 0,
        last_opened: timestamp, created_at: timestamp,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-ad-' + index;
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
      });

      var positions = {};
      seed.tasks.forEach(function (entry, index) {
        var sessionId = entry.session ? 'session-' + entry.id : null;
        positions[entry.lane] = (positions[entry.lane] || 0);
        var task = {
          id: entry.id, display_id: entry.displayId, title: entry.title,
          description: entry.description || '',
          swimlane_id: laneIds[entry.lane], position: positions[entry.lane],
          agent: entry.session ? 'claude' : null, session_id: sessionId,
          worktree_path: entry.worktree ? '/mock/automations-disabled/.kangentic/worktrees/' + entry.id : null,
          branch_name: entry.worktree ? 'feature/' + entry.id : null,
          pr_number: null, pr_url: null, pr_state: null,
          base_branch: entry.worktree ? 'main' : null,
          use_worktree: entry.worktree ? 1 : 0,
          labels: entry.labels || [], priority: 0, attachment_count: 0,
          archived_at: entry.archived ? timestamp : null,
          automations_disabled: !!entry.automationsDisabled,
          workflow_id: entry.workflowId || null,
          workflow_project_id: entry.workflowId ? '${PROJECT_ID}' : null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          canvas_x: null, canvas_y: null, created_at: timestamp, updated_at: timestamp,
        };
        positions[entry.lane] += 1;
        if (entry.archived) state.archivedTasks.push(task); else state.tasks.push(task);

        if (entry.session) {
          state.sessions.push({
            id: sessionId, taskId: entry.id, projectId: '${PROJECT_ID}',
            pid: entry.session === 'running' ? 9000 + index : null,
            status: entry.session, shell: 'bash', cwd: '/mock/automations-disabled',
            startedAt: timestamp, exitCode: null, resuming: false, agentSessionId: 'agent-' + entry.id,
          });
          if (entry.session === 'running') state.activityCache[sessionId] = 'thinking';
        }
      });

      Object.keys(seed.trails || {}).forEach(function (taskId) {
        state.messageTrailCache['session-' + taskId] = seed.trails[taskId];
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: Seed, extraInitScript = ''): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(seedScript(seed));
    if (extraInitScript) await page.addInitScript(extraInitScript);
    await gotoVite(page, VITE_URL);
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

const boardCard = (page: Page, taskId: string): Locator => page.locator(`[data-board-lanes] [data-task-id="${taskId}"]`);
const byTestId = (page: Page, testId: string): Locator => page.locator(`[data-testid="${testId}"]`);

async function openMenu(page: Page, taskId: string): Promise<Locator> {
  await boardCard(page, taskId).click({ button: 'right' });
  const menu = byTestId(page, 'task-context-menu');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/**
 * The menu's rows top to bottom: a row is its testid, a divider is `divider`, and
 * the Move to heading is `header:Move to`. The run of Move to rows collapses to
 * one entry, since how many lanes the board has is not the menu's order.
 */
async function menuLayout(menu: Locator): Promise<string[]> {
  const rows = await menu.evaluate((element) => Array.from(element.children).map((child) => {
    const testId = child.getAttribute('data-testid');
    if (testId) return testId;
    const text = (child.textContent ?? '').trim();
    return text === '' ? 'divider' : `header:${text}`;
  }));
  return rows.filter((row, index) => !(row === 'context-move-to' && rows[index - 1] === 'context-move-to'));
}

/** Rows every task menu opens with, and the groups it closes with, around whatever the top group adds. */
const MENU_HEAD = ['context-copy-task-id', 'divider', 'context-edit-task'];
const MENU_MOVE_TO = ['divider', 'header:Move to', 'context-move-to'];
const MENU_BOTTOM = ['divider', 'context-send-to-backlog', 'context-archive-task', 'context-delete-task'];

/** The raw payloads `tasks.update` received, which the mock logs for assertions. */
async function readUpdateCalls(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as {
    electronAPI: { tasks: { __updateCalls: Array<Record<string, unknown>> } };
  }).electronAPI.tasks.__updateCalls);
}

/**
 * The message a failed desktop `ipcRenderer.invoke` carries: Electron puts the channel and
 * the error class in front of the sentence main wrote.
 */
const DECORATED_BUSY_ERROR = "Error invoking remote method 'task:update': Error: The board is busy.";
const DECORATION_FRAGMENT = 'Error invoking remote method';

/**
 * From now on `tasks.update` logs its payload like the mock does, then rejects with this
 * message. The Error is built inside the page so `instanceof Error` holds there, which is
 * what the renderer's `describeIpcError` checks before it trusts a message.
 */
async function rejectTaskUpdates(page: Page, message: string): Promise<void> {
  await page.evaluate((rejection) => {
    const tasksApi = (window as unknown as {
      electronAPI: {
        tasks: {
          update: (input: Record<string, unknown>) => Promise<unknown>;
          __updateCalls: Array<Record<string, unknown>>;
        };
      };
    }).electronAPI.tasks;
    tasksApi.update = (input) => {
      tasksApi.__updateCalls.push({ ...input });
      return Promise.reject(new Error(rejection));
    };
  }, message);
}

const toastWith = (page: Page, text: string): Locator => page.locator('[data-testid="toast"]').filter({ hasText: text });

/** Write a global config field through the real path the Task tab's select uses. */
async function updateConfig(page: Page, partial: Record<string, string>): Promise<void> {
  await page.evaluate((value) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (partial: Record<string, string>) => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().updateConfig(value);
  }, partial);
}

test.describe('per-task automations switch: the card menu', () => {
  test('a To Do card offers Disable automations in the top group, and the switch round-trips', async () => {
    const taskId = 'task-ad-todo';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 41, title: 'Ordinary To Do task', lane: 'To Do', description: 'Nothing special.' }],
    });
    try {
      const card = boardCard(page, taskId);
      await expect(card).toBeVisible();
      await expect(card.getByTestId(STRIP_TEST_ID)).toHaveCount(0);

      let menu = await openMenu(page, taskId);
      // Edit, then the automations row, then New workflow, all above the Move to
      // heading: the switch and New workflow are in the top group.
      expect(await menuLayout(menu)).toEqual([
        ...MENU_HEAD, 'context-toggle-automations', 'context-new-workflow', ...MENU_MOVE_TO, ...MENU_BOTTOM,
      ]);
      let toggle = menu.getByTestId('context-toggle-automations');
      await expect(toggle).toHaveText('Disable automations');
      await expect(toggle).toHaveAttribute('data-automations-disabled', 'false');

      await toggle.click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);
      const strip = card.getByTestId(STRIP_TEST_ID);
      await expect(strip).toBeVisible();
      await expect(strip).toHaveText('Automations disabled');
      await expect.poll(() => readUpdateCalls(page)).toEqual([{ id: taskId, automations_disabled: true }]);

      // Off: the same row now offers the way back.
      menu = await openMenu(page, taskId);
      toggle = menu.getByTestId('context-toggle-automations');
      await expect(toggle).toHaveText('Enable automations');
      await expect(toggle).toHaveAttribute('data-automations-disabled', 'true');

      await toggle.click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);
      await expect(card.getByTestId(STRIP_TEST_ID)).toHaveCount(0);
      await expect.poll(() => readUpdateCalls(page)).toEqual([
        { id: taskId, automations_disabled: true },
        { id: taskId, automations_disabled: false },
      ]);
    } finally {
      await browser.close();
    }
  });

  test('a workflow card gets no automations row, and Open workflow sits in the top group after Show changes', async () => {
    const taskId = 'task-ad-workflow';
    const workflowId = 'wf-ad-menu';
    const { browser, page } = await launch({
      workflows: [{ workflow: { id: workflowId, title: 'Menu order', state: 'running', draft: null, color_slot: 5, source_task_id: null } }],
      tasks: [{
        id: taskId, displayId: 52, title: 'Task inside a workflow', lane: 'Executing', description: 'Planned by the workflow agent.',
        worktree: true, workflowId,
      }],
    });
    try {
      // The row reads the workflow store when the menu opens: without the summaries
      // loaded there is no Open workflow row. The strip appears once they have.
      await boardCard(page, taskId).locator('[data-testid="workflow-card-strip"]').waitFor({ state: 'visible', timeout: 10000 });

      const menu = await openMenu(page, taskId);
      // Exact, so the absent switch and New workflow are asserted by the whole list, and
      // the present Open workflow row keeps the absence from passing on an empty menu.
      expect(await menuLayout(menu)).toEqual([
        ...MENU_HEAD, 'context-show-changes', 'context-open-workflow', ...MENU_MOVE_TO, ...MENU_BOTTOM,
      ]);
      await expect(menu.getByTestId('context-open-workflow')).toBeVisible();
      await expect(menu.getByTestId('context-toggle-automations')).toHaveCount(0);
      await expect(boardCard(page, taskId).getByTestId(STRIP_TEST_ID)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a task with a worktree offers Show changes, and it opens the changes dialog', async () => {
    const taskId = 'task-ad-worktree';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 63, title: 'Task with a worktree', lane: 'To Do', description: 'Has a branch.', worktree: true }],
    });
    try {
      const menu = await openMenu(page, taskId);
      expect(await menuLayout(menu)).toEqual([
        ...MENU_HEAD, 'context-show-changes', 'context-toggle-automations', 'context-new-workflow', ...MENU_MOVE_TO, ...MENU_BOTTOM,
      ]);
      const showChanges = menu.getByTestId('context-show-changes');
      // A full-text match, so the old "Changes" label cannot satisfy it.
      await expect(showChanges).toHaveText('Show changes');

      await expect(byTestId(page, 'task-changes-dialog')).toHaveCount(0);
      await showChanges.click();
      const dialog = byTestId(page, 'task-changes-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Changes - #63 Task with a worktree');
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a card toggle the desktop rejects toasts the plain reason and leaves the card as it was', async () => {
    const taskId = 'task-ad-card-reject';
    const title = 'Held task whose write fails';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 45, title, lane: 'To Do', description: 'The write is refused.' }],
    });
    try {
      const card = boardCard(page, taskId);
      await expect(card).toBeVisible();
      await rejectTaskUpdates(page, DECORATED_BUSY_ERROR);

      const menu = await openMenu(page, taskId);
      await menu.getByTestId('context-toggle-automations').click();
      await expect(byTestId(page, 'task-context-menu')).toHaveCount(0);

      // The sentence main wrote, with the user's task named and Electron's wrapper gone.
      const toast = toastWith(page, "Couldn't turn off automations");
      await expect(toast.getByTestId('toast-title')).toHaveText("Couldn't turn off automations");
      await expect(toast.getByTestId('toast-body')).toHaveText(`"${title}": The board is busy.`);
      await expect(toast).not.toContainText(DECORATION_FRAGMENT);

      // The write was attempted, and nothing on the card moved: no strip, and the menu
      // still offers the same row.
      await expect.poll(() => readUpdateCalls(page)).toEqual([{ id: taskId, automations_disabled: true }]);
      await expect(card.getByTestId(STRIP_TEST_ID)).toHaveCount(0);
      const reopened = await openMenu(page, taskId);
      await expect(reopened.getByTestId('context-toggle-automations')).toHaveText('Disable automations');
    } finally {
      await browser.close();
    }
  });

  test('an archived card with a worktree says Show changes too', async () => {
    const taskId = 'task-ad-archived';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 74, title: 'Finished task with a worktree', lane: 'Done', archived: true, worktree: true }],
    });
    try {
      const card = page.locator(`[data-task-id="${taskId}"]`).first();
      await card.waitFor({ state: 'visible', timeout: 10000 });
      await card.click({ button: 'right' });
      await expect(byTestId(page, 'archived-context-show-changes')).toHaveText('Show changes');
    } finally {
      await browser.close();
    }
  });
});

test.describe('per-task automations switch: the card strip', () => {
  const DENSITIES = [
    // The description's clamp is what proves the density took effect on THIS card.
    // The strip bleeds through the frame's padding, which comfortable makes larger.
    { density: 'compact', clamp: classToken('truncate'), bleed: classToken('-mx-2.5') },
    { density: 'default', clamp: classToken('line-clamp-3'), bleed: classToken('-mx-2.5') },
    { density: 'comfortable', clamp: classToken('line-clamp-5'), bleed: classToken('-mx-3') },
  ] as const;

  test('the strip tops the card at compact, default and comfortable density, with its tooltip', async () => {
    const disabledId = 'task-ad-strip';
    const controlId = 'task-ad-strip-control';
    const { browser, page } = await launch({
      tasks: [
        { id: disabledId, displayId: 81, title: 'Held task', lane: 'To Do', description: 'The agent will not start from a column.', automationsDisabled: true },
        { id: controlId, displayId: 82, title: 'Ordinary task', lane: 'To Do', description: 'Automations run as usual.' },
      ],
    });
    try {
      const card = boardCard(page, disabledId);
      const control = boardCard(page, controlId);
      await expect(card).toBeVisible();

      for (const { density, clamp, bleed } of DENSITIES) {
        await updateConfig(page, { cardDensity: density });
        await expect(card.getByTestId('task-card-description')).toHaveClass(clamp);

        const strip = card.getByTestId(STRIP_TEST_ID);
        await expect(strip).toBeVisible();
        await expect(strip).toHaveText('Automations disabled');
        await expect(strip).toHaveAccessibleDescription(STRIP_TIP);
        // Across the TOP: the strip's wrapper is the card's first child, bled to its edges.
        const stripWrapper = card.locator(':scope > :first-child');
        await expect(stripWrapper.getByTestId(STRIP_TEST_ID)).toHaveCount(1);
        await expect(stripWrapper).toHaveClass(bleed);

        // The same board, same density: a card with its automations on wears none.
        await expect(control.getByTestId('task-card-description')).toHaveClass(clamp);
        await expect(control.getByTestId(STRIP_TEST_ID)).toHaveCount(0);
      }
    } finally {
      await browser.close();
    }
  });
});

test.describe('per-task automations switch: the footer divider', () => {
  const USAGE_FIXTURE = {
    model: { id: 'claude-opus-5', displayName: 'Opus 5' },
    contextWindow: {
      usedPercentage: 11, usedTokens: 113852, cacheTokens: 0,
      totalInputTokens: 111701, totalOutputTokens: 2151, contextWindowSize: 1000000,
    },
    cost: { totalCostUsd: 0.5, totalDurationMs: 18000 },
  };
  const TRAIL: TrailEntry[] = [
    { uuid: 'a1', ts: 1, text: 'Read the task and the files it touches.' },
    { uuid: 'a2', ts: 2, text: 'Writing the first failing test now.' },
  ];

  /** Push a usage tick for each running session, so its footer is the real bar with a model name. */
  async function fireUsage(page: Page, taskIds: string[]): Promise<void> {
    await page.waitForFunction(() => typeof (window as unknown as { __mockFireUsage?: unknown }).__mockFireUsage === 'function');
    await page.evaluate(({ sessionIds, usage, projectId }) => {
      const fire = (window as unknown as {
        __mockFireUsage: (sessionId: string, usage: unknown, projectId: string) => void;
      }).__mockFireUsage;
      for (const sessionId of sessionIds) fire(sessionId, usage, projectId);
    }, { sessionIds: taskIds.map(sessionIdOf), usage: USAGE_FIXTURE, projectId: PROJECT_ID });
  }

  test('a running card keeps the rule unless the agent trail is shown and there are no labels', async () => {
    const trailId = 'task-ad-div-trail';
    const labelledId = 'task-ad-div-label';
    const plainId = 'task-ad-div-plain';
    const { browser, page } = await launch({
      tasks: [
        { id: trailId, displayId: 91, title: 'Trail, no labels', lane: 'Executing', description: 'Described.', session: 'running' },
        { id: labelledId, displayId: 92, title: 'Trail and a label', lane: 'Executing', description: 'Described.', session: 'running', labels: ['bug'] },
        { id: plainId, displayId: 93, title: 'No trail yet', lane: 'Executing', description: 'Described.', session: 'running' },
      ],
      trails: { [trailId]: TRAIL, [labelledId]: TRAIL },
    });
    try {
      await fireUsage(page, [trailId, labelledId, plainId]);

      // Each card's footer is the real usage bar (model name known), not the spinner bar.
      for (const taskId of [trailId, labelledId, plainId]) {
        await expect(boardCard(page, taskId).getByTestId('usage-bar-model')).toHaveText('Opus 5');
      }

      // The trail takes the description's slot on the first two, and the third has none to show.
      await expect(boardCard(page, trailId).getByTestId('task-card-trail')).toBeVisible();
      await expect(boardCard(page, labelledId).getByTestId('task-card-trail')).toBeVisible();
      await expect(boardCard(page, plainId).getByTestId('task-card-trail')).toHaveCount(0);
      await expect(boardCard(page, plainId).getByTestId('task-card-description')).toBeVisible();

      // The well closes itself: no rule above the footer, and the footer keeps its margin.
      const trailFooter = boardCard(page, trailId).getByTestId('usage-bar');
      await expect(trailFooter).toHaveClass(classToken('mt-2'));
      await expect(trailFooter).not.toHaveClass(HAS_DIVIDER);
      await expect(trailFooter).not.toHaveClass(classToken('pt-2'));

      // A label, or a plain description, keeps the rule.
      for (const taskId of [labelledId, plainId]) {
        const footer = boardCard(page, taskId).getByTestId('usage-bar');
        await expect(footer).toHaveClass(HAS_DIVIDER);
        await expect(footer).toHaveClass(classToken('pt-2'));
      }
    } finally {
      await browser.close();
    }
  });

  test('a paused card keeps the rule, even though the store still holds the agent trail', async () => {
    const pausedId = 'task-ad-div-paused';
    const { browser, page } = await launch({
      tasks: [{ id: pausedId, displayId: 94, title: 'Paused, no labels', lane: 'Executing', description: 'Parked until later.', session: 'suspended' }],
      trails: { [pausedId]: TRAIL },
    });
    try {
      const card = boardCard(page, pausedId);
      await expect(card).toBeVisible();

      // The trail IS held, so the rule is decided by the trail being SHOWN, not held.
      const held = await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session: { getState: () => { sessionMessageTrails: Record<string, Array<{ text: string }>> } } };
        }).__zustandStores;
        return stores?.session.getState().sessionMessageTrails[sessionId]?.map((entry) => entry.text) ?? [];
      }, sessionIdOf(pausedId));
      expect(held).toEqual(TRAIL.map((entry) => entry.text));

      await expect(card.getByTestId('task-card-trail')).toHaveCount(0);
      await expect(card.getByTestId('task-card-description')).toHaveText('Parked until later.');
      const footer = card.getByTestId('status-bar');
      await expect(footer).toContainText('Paused');
      await expect(footer).toHaveClass(HAS_DIVIDER);
      await expect(footer).toHaveClass(classToken('pt-2'));
    } finally {
      await browser.close();
    }
  });
});

test.describe('per-task automations switch: the Agent Monitor row menu', () => {
  const OTHER_PROJECT_ID = 'proj-automations-monitor-other';
  const taskId = 'task-ad-monitor';

  interface MonitorRowSeed {
    sessionId: string;
    taskId: string;
    taskTitle: string;
    displayId: number;
    /** Whose board the row's task is on: the project the board is open on, or a second one it is not. */
    project: 'open' | 'other';
  }

  /**
   * The one monitor row, and for an `other` row the second project it belongs to, which the
   * board is NOT open on. An `open` row belongs to the project the board is showing.
   */
  function monitorInitScript(row: MonitorRowSeed): string {
    const projectId = row.project === 'open' ? PROJECT_ID : OTHER_PROJECT_ID;
    const projectName = row.project === 'open' ? PROJECT_NAME : 'Monitor Other';
    const monitorRow = {
      sessionId: row.sessionId, projectId, projectName,
      taskId: row.taskId, taskTitle: row.taskTitle, outputPeek: [], displayId: row.displayId,
      columnName: 'To Do', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Opus 5', effort: 'medium', permissionMode: 'auto',
      startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
      status: 'running', activity: 'thinking', activityReason: null,
      lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false,
    };
    const otherProject = row.project === 'other' ? `
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.projects.push({
          id: '${OTHER_PROJECT_ID}', name: 'Monitor Other', path: '/mock/automations-monitor-other',
          github_url: null, default_agent: 'claude', group_id: null, position: 1,
          last_opened: timestamp, created_at: timestamp,
        });
      });
    ` : '';
    return `${otherProject}
    window.__mockMonitorRows = ${JSON.stringify([monitorRow])};
  `;
  }

  async function openMonitor(page: Page): Promise<void> {
    await byTestId(page, 'agent-monitor-button').click();
    await byTestId(page, 'monitor-page').waitFor({ state: 'visible', timeout: 10000 });
    await byTestId(page, 'monitor-grid').waitFor({ state: 'visible', timeout: 10000 });
  }

  /** Right-click the monitor row; the menu mounts once the row's task bundle resolves. */
  async function openRowMenu(page: Page, sessionId: string): Promise<Locator> {
    await page.locator(`[data-session-id="${sessionId}"]`).click({ button: 'right' });
    const menu = byTestId(page, 'monitor-row-menu');
    await menu.waitFor({ state: 'visible', timeout: 10000 });
    return menu;
  }

  /** Record the project id each `tasks.update` is sent with, which the mock's own log leaves out. */
  async function recordUpdateProjectIds(page: Page): Promise<void> {
    await page.evaluate(() => {
      const handle = window as unknown as {
        __updateProjectIds?: Array<string | null>;
        electronAPI: { tasks: { update: (input: Record<string, unknown>, projectId?: string | null) => Promise<unknown> } };
      };
      const original = handle.electronAPI.tasks.update;
      handle.__updateProjectIds = [];
      handle.electronAPI.tasks.update = (input, projectId) => {
        handle.__updateProjectIds?.push(projectId ?? null);
        return original(input, projectId);
      };
    });
  }

  test('the row menu offers the switch after Edit and before Open on board, and writes to the row\'s project', async () => {
    const { browser, page } = await launch(
      { tasks: [{ id: taskId, displayId: 31, title: 'Monitored task', lane: 'To Do', description: 'Seen from the monitor.' }] },
      monitorInitScript({ sessionId: 'sess-ad-monitor', taskId, taskTitle: 'Monitored task', displayId: 31, project: 'other' }),
    );
    try {
      await openMonitor(page);
      await recordUpdateProjectIds(page);

      const row = page.locator('[data-session-id="sess-ad-monitor"]');
      const menu = await openRowMenu(page, 'sess-ad-monitor');

      expect(await menuLayout(menu)).toEqual([
        ...MENU_HEAD, 'context-toggle-automations', 'monitor-menu-open-on-board', ...MENU_MOVE_TO, ...MENU_BOTTOM,
      ]);
      const toggle = menu.getByTestId('context-toggle-automations');
      await expect(toggle).toHaveText('Disable automations');

      await toggle.click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);
      await expect.poll(() => readUpdateCalls(page)).toEqual([{ id: taskId, automations_disabled: true }]);
      // The task belongs to the project the monitor row names, not the open board's.
      expect(await page.evaluate(() => (window as unknown as { __updateProjectIds?: Array<string | null> }).__updateProjectIds))
        .toEqual([OTHER_PROJECT_ID]);

      // The row's next menu reads the task again and offers the way back.
      await row.click({ button: 'right' });
      await expect(byTestId(page, 'monitor-row-menu').getByTestId('context-toggle-automations')).toHaveText('Enable automations');
    } finally {
      await browser.close();
    }
  });

  // Both write paths: a row of another project goes straight to the IPC, a row of the open
  // project goes through the board store, and either rejection reaches the user the same way.
  for (const { project, label } of [
    { project: 'other', label: 'another project' },
    { project: 'open', label: 'the open project' },
  ] as const) {
    test(`a toggle the desktop rejects, from a row of ${label}, toasts the plain reason`, async () => {
      const failingTaskId = `task-ad-monitor-reject-${project}`;
      const title = 'Monitored task whose write fails';
      const { browser, page } = await launch(
        { tasks: [{ id: failingTaskId, displayId: 32, title, lane: 'To Do', description: 'Seen from the monitor.' }] },
        monitorInitScript({ sessionId: 'sess-ad-monitor-reject', taskId: failingTaskId, taskTitle: title, displayId: 32, project }),
      );
      try {
        await openMonitor(page);
        await rejectTaskUpdates(page, DECORATED_BUSY_ERROR);

        const menu = await openRowMenu(page, 'sess-ad-monitor-reject');
        await menu.getByTestId('context-toggle-automations').click();
        await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);

        const toast = toastWith(page, "Couldn't turn off automations");
        await expect(toast.getByTestId('toast-title')).toHaveText("Couldn't turn off automations");
        await expect(toast.getByTestId('toast-body')).toHaveText(`"${title}": The board is busy.`);
        await expect(toast).not.toContainText(DECORATION_FRAGMENT);
        await expect.poll(() => readUpdateCalls(page)).toEqual([{ id: failingTaskId, automations_disabled: true }]);

        // The task was not changed, so the row's next menu still offers the same switch.
        const reopened = await openRowMenu(page, 'sess-ad-monitor-reject');
        await expect(reopened.getByTestId('context-toggle-automations')).toHaveText('Disable automations');
      } finally {
        await browser.close();
      }
    });
  }

  test('a row of a workflow task gets no automations row, and the rest of the menu is there', async () => {
    const workflowTaskId = 'task-ad-monitor-workflow';
    const workflowId = 'wf-ad-monitor';
    const { browser, page } = await launch(
      {
        workflows: [{ workflow: { id: workflowId, title: 'Monitor menu', state: 'running', draft: null, color_slot: 5, source_task_id: null } }],
        tasks: [{
          id: workflowTaskId, displayId: 33, title: 'Monitored workflow task', lane: 'Executing',
          description: 'Planned by the workflow agent.', workflowId,
        }],
      },
      monitorInitScript({
        sessionId: 'sess-ad-monitor-workflow', taskId: workflowTaskId, taskTitle: 'Monitored workflow task', displayId: 33, project: 'open',
      }),
    );
    try {
      await openMonitor(page);
      const menu = await openRowMenu(page, 'sess-ad-monitor-workflow');

      // Exact, so the absent switch is asserted by the whole list, and the present copy-id,
      // Open on board and destructive rows keep the absence from passing on an empty menu.
      expect(await menuLayout(menu)).toEqual([
        ...MENU_HEAD, 'monitor-menu-open-on-board', ...MENU_MOVE_TO, ...MENU_BOTTOM,
      ]);
      await expect(menu.getByTestId('monitor-menu-open-on-board')).toBeVisible();
      await expect(menu.getByTestId('context-toggle-automations')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a toggle on a row of the open project reaches the board card under the overlay', async () => {
    const openTaskId = 'task-ad-monitor-open';
    const { browser, page } = await launch(
      { tasks: [{ id: openTaskId, displayId: 34, title: 'Monitored task on the open board', lane: 'To Do', description: 'Seen from both places.' }] },
      monitorInitScript({
        sessionId: 'sess-ad-monitor-open', taskId: openTaskId, taskTitle: 'Monitored task on the open board', displayId: 34, project: 'open',
      }),
    );
    try {
      const card = boardCard(page, openTaskId);
      await expect(card).toBeVisible();
      await expect(card.getByTestId(STRIP_TEST_ID)).toHaveCount(0);

      await openMonitor(page);
      await recordUpdateProjectIds(page);
      const menu = await openRowMenu(page, 'sess-ad-monitor-open');
      await menu.getByTestId('context-toggle-automations').click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);

      await expect.poll(() => readUpdateCalls(page)).toEqual([{ id: openTaskId, automations_disabled: true }]);
      // The row names the open project, and the write is stamped with it.
      expect(await page.evaluate(() => (window as unknown as { __updateProjectIds?: Array<string | null> }).__updateProjectIds))
        .toEqual([PROJECT_ID]);

      // Back on the board with nothing reloaded: the card wears its strip, and its own menu
      // offers the way back.
      await byTestId(page, 'monitor-close').click();
      await byTestId(page, 'monitor-page').waitFor({ state: 'hidden', timeout: 10000 });
      const strip = card.getByTestId(STRIP_TEST_ID);
      await expect(strip).toBeVisible();
      await expect(strip).toHaveText('Automations disabled');

      const cardMenu = await openMenu(page, openTaskId);
      const toggle = cardMenu.getByTestId('context-toggle-automations');
      await expect(toggle).toHaveText('Enable automations');
      await expect(toggle).toHaveAttribute('data-automations-disabled', 'true');
    } finally {
      await browser.close();
    }
  });
});

test.describe('per-task automations switch: the Agent Monitor marks a held task', () => {
  const HELD_SESSION = 'sess-ad-held';
  const ORDINARY_SESSION = 'sess-ad-ordinary';
  const TERMINAL_SESSION = 'sess-ad-terminal';

  /** One held task, one ordinary task, and a Command Terminal, which has no automations to hold. */
  function monitorRowsScript(): string {
    const base = {
      projectId: PROJECT_ID, projectName: PROJECT_NAME, outputPeek: [],
      columnName: 'Executing', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Opus 5', effort: 'medium', permissionMode: 'auto',
      startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
      status: 'running', activity: 'thinking', activityReason: null,
      lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false,
      workflow: null, track: null, modelReported: true, browserRunning: false,
    };
    const rows = [
      { ...base, sessionId: HELD_SESSION, taskId: 'task-ad-held', taskTitle: 'Held task', displayId: 21, automationsDisabled: true },
      { ...base, sessionId: ORDINARY_SESSION, taskId: 'task-ad-ordinary', taskTitle: 'Ordinary task', displayId: 22, automationsDisabled: false },
      {
        ...base, sessionId: TERMINAL_SESSION, taskId: 'transient-ad-1', taskTitle: 'Command Terminal 1', displayId: null,
        columnName: '', commandTerminalBranch: 'main', isCommandTerminal: true, automationsDisabled: false,
      },
    ];
    return `window.__mockMonitorRows = ${JSON.stringify(rows)};`;
  }

  async function openMonitor(page: Page): Promise<void> {
    await byTestId(page, 'agent-monitor-button').click();
    await byTestId(page, 'monitor-grid').waitFor({ state: 'visible', timeout: 10000 });
  }

  /** Main's push after a toggle: the same rows, with the held task's flag set to `held`. */
  async function pushHeld(page: Page, held: boolean): Promise<void> {
    await page.evaluate(({ sessionId, value }) => {
      const handle = window as unknown as {
        __mockMonitorRows?: Array<Record<string, unknown>>;
        __mockFireMonitorChanged?: (rows: Array<Record<string, unknown>>) => void;
      };
      handle.__mockFireMonitorChanged?.((handle.__mockMonitorRows ?? []).map((row) => (
        row.sessionId === sessionId ? { ...row, automationsDisabled: value } : row
      )));
    }, { sessionId: HELD_SESSION, value: held });
  }

  const sessionCard = (page: Page, sessionId: string): Locator => page.locator(`[data-testid="monitor-card"][data-session-id="${sessionId}"]`);

  test('the card wears the board\'s strip on its own row above the location strip, with its tip', async () => {
    const { browser, page } = await launch({ tasks: [] }, monitorRowsScript());
    try {
      await openMonitor(page);
      const held = sessionCard(page, HELD_SESSION);
      const strip = held.getByTestId('monitor-card-automations-disabled');
      await expect(strip).toHaveText('Automations disabled');
      await expect(strip).toHaveAccessibleDescription(STRIP_TIP);
      // Its own row, first, ahead of the strip every card wears.
      const order = await held.evaluate((card) => Array.from(card.querySelectorAll('[data-testid="monitor-card-automations-disabled"], [data-testid="monitor-card-strip"]'))
        .map((element) => element.getAttribute('data-testid')));
      expect(order).toEqual(['monitor-card-automations-disabled', 'monitor-card-strip']);

      await expect(sessionCard(page, ORDINARY_SESSION).getByTestId('monitor-card-automations-disabled')).toHaveCount(0);
      await expect(sessionCard(page, TERMINAL_SESSION).getByTestId('monitor-card-automations-disabled')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the list row closes with the slice, and the table names it in its Automations column', async () => {
    const { browser, page } = await launch({ tasks: [] }, monitorRowsScript());
    try {
      await openMonitor(page);

      await byTestId(page, 'monitor-layout-list').click();
      await expect(sessionCard(page, HELD_SESSION)).toHaveAttribute('data-dense', 'true');
      const slice = sessionCard(page, HELD_SESSION).getByTestId('monitor-row-automations-disabled');
      await expect(slice).toHaveText('Automations disabled');
      await expect(slice).toHaveAccessibleDescription(STRIP_TIP);
      await expect(page.getByTestId('monitor-row-automations-disabled')).toHaveCount(1);

      await byTestId(page, 'monitor-layout-table').click();
      const rowOf = (title: string): Locator => page.locator('[data-testid="monitor-table-row"]', { hasText: title });
      await expect(rowOf('Held task').getByTestId('monitor-table-automations-disabled')).toHaveText('Disabled');
      await expect(rowOf('Ordinary task')).toContainText('Enabled');
      await expect(rowOf('Ordinary task').getByTestId('monitor-table-automations-disabled')).toHaveCount(0);
      // A Command Terminal has no task, so no automations either way.
      await expect(rowOf('Command Terminal 1')).not.toContainText('Enabled');
      await expect(rowOf('Command Terminal 1').getByTestId('monitor-table-automations-disabled')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a pushed toggle takes the mark off and puts it back in every layout', async () => {
    const { browser, page } = await launch({ tasks: [] }, monitorRowsScript());
    try {
      await openMonitor(page);
      const held = sessionCard(page, HELD_SESSION);
      await expect(held.getByTestId('monitor-card-automations-disabled')).toBeVisible();

      await pushHeld(page, false);
      await expect(held.getByTestId('monitor-card-automations-disabled')).toHaveCount(0);
      await byTestId(page, 'monitor-layout-list').click();
      await expect(page.getByTestId('monitor-row-automations-disabled')).toHaveCount(0);
      await byTestId(page, 'monitor-layout-table').click();
      await expect(page.getByTestId('monitor-table-automations-disabled')).toHaveCount(0);

      await pushHeld(page, true);
      await expect(page.getByTestId('monitor-table-automations-disabled')).toHaveCount(1);
      await byTestId(page, 'monitor-layout-list').click();
      await expect(page.getByTestId('monitor-row-automations-disabled')).toHaveCount(1);
      await byTestId(page, 'monitor-layout-cards').click();
      await expect(held.getByTestId('monitor-card-automations-disabled')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('per-task automations switch: the mock mirrors the desktop refusal', () => {
  const REFUSAL = 'This task is in a workflow. Pause the workflow to hold it.';

  type UpdateOutcome = { resolved: true; automationsDisabled: boolean } | { resolved: false; message: string };

  /** Call `tasks.update` directly, and hand back how it settled instead of letting a rejection cross. */
  async function updateAutomations(page: Page, input: Record<string, unknown>): Promise<UpdateOutcome> {
    return page.evaluate(async (payload) => {
      const tasksApi = (window as unknown as {
        electronAPI: { tasks: { update: (input: Record<string, unknown>) => Promise<{ automations_disabled: boolean }> } };
      }).electronAPI.tasks;
      try {
        const task = await tasksApi.update(payload);
        return { resolved: true as const, automationsDisabled: task.automations_disabled };
      } catch (error) {
        return { resolved: false as const, message: error instanceof Error ? error.message : String(error) };
      }
    }, input);
  }

  test('holding a workflow task is refused, releasing it is not, and an ordinary task can be held', async () => {
    const workflowTaskId = 'task-ad-ipc-workflow';
    const ordinaryTaskId = 'task-ad-ipc-ordinary';
    const workflowId = 'wf-ad-ipc';
    const { browser, page } = await launch({
      workflows: [{ workflow: { id: workflowId, title: 'Refusal', state: 'running', draft: null, color_slot: 5, source_task_id: null } }],
      tasks: [
        { id: workflowTaskId, displayId: 35, title: 'Task inside a workflow', lane: 'Executing', workflowId },
        { id: ordinaryTaskId, displayId: 36, title: 'Ordinary task', lane: 'To Do' },
      ],
    });
    try {
      expect(await updateAutomations(page, { id: workflowTaskId, automations_disabled: true }))
        .toEqual({ resolved: false, message: REFUSAL });
      expect(await updateAutomations(page, { id: workflowTaskId, automations_disabled: false }))
        .toEqual({ resolved: true, automationsDisabled: false });
      // The refusal is the workflow's, not a blanket one: a task outside any workflow can be held.
      expect(await updateAutomations(page, { id: ordinaryTaskId, automations_disabled: true }))
        .toEqual({ resolved: true, automationsDisabled: true });
    } finally {
      await browser.close();
    }
  });
});
