/**
 * A column's agent limit, in the UI: the switch, the All columns table, and how a
 * queued task reads on its card and in its window. The line itself is main's, so
 * these specs seed the snapshot main would send (`__mockQueueSnapshot`).
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchPage } from './helpers';

const PROJECT_ID = 'proj-limit';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({ id: '${PROJECT_ID}', name: 'Sample app', path: '/mock/sample-app', github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var id = 'lane-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
    });
    function add(id, displayId, title, status, position) {
      state.sessions.push({ id: 'sess-' + id, taskId: 'task-' + id, projectId: '${PROJECT_ID}', pid: null, status: status, shell: 'bash', cwd: '/mock/sample-app', startedAt: ts, exitCode: null });
      state.tasks.push({ id: 'task-' + id, display_id: displayId, title: title, description: 'Details of ' + title, swimlane_id: laneIds['Merge'], position: position, agent: 'claude', session_id: 'sess-' + id, worktree_path: '/mock/wt/' + id, branch_name: 'feature/' + id, pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts });
    }
    add('running', 412, 'Migrate settings', 'running', 0);
    add('second', 420, 'Add CSV export', 'queued', 1);
    add('third', 421, 'Fix login redirect', 'queued', 2);
  });
`;

function queueTask(id: string, displayId: number, title: string, projectName = 'Sample app', projectId = PROJECT_ID) {
  return { sessionId: `sess-${id}`, taskId: `task-${id}`, projectId, projectName, title, displayId };
}

const RUNNING = queueTask('running', 412, 'Migrate settings');
const SECOND = queueTask('second', 420, 'Add CSV export');
const THIRD = queueTask('third', 421, 'Fix login redirect');

const COLUMN_SNAPSHOT = {
  columns: [{ projectId: PROJECT_ID, swimlaneId: 'lane-merge', columnName: 'Merge', maxAgents: 1, holders: [RUNNING], waiting: [SECOND, THIRD] }],
  global: [SECOND, THIRD],
};

const GLOBAL_SNAPSHOT = {
  columns: [],
  global: [queueTask('other', 88, 'Update the pricing page', 'Docs site', 'proj-docs'), SECOND, THIRD],
};

test.describe('column agent limit', () => {
  let browser: Browser;
  let page: Page;

  async function open(snapshot: unknown, monitorRows?: unknown[]): Promise<void> {
    const launched = await launchPage({
      beforeLoad: async (target) => {
        await target.addInitScript(preConfig);
        await target.addInitScript((seed) => {
          (window as unknown as { __mockQueueSnapshot: unknown }).__mockQueueSnapshot = seed;
        }, snapshot);
        if (monitorRows) {
          await target.addInitScript((rows) => {
            (window as unknown as { __mockMonitorRows: unknown }).__mockMonitorRows = rows;
          }, monitorRows);
        }
      },
    });
    browser = launched.browser;
    page = launched.page;
    await page.getByText('Sample app', { exact: true }).first().click();
    await page.locator('[data-swimlane-name="Merge"]').waitFor({ state: 'visible', timeout: 15000 });
  }

  test.afterEach(async () => {
    await browser?.close();
  });

  const cardOf = (title: string) => page.locator('[data-swimlane-name="Merge"] [data-task-id]').filter({ hasText: title });

  async function openManager(columnName: string): Promise<void> {
    await page.locator(`[data-swimlane-name="${columnName}"]`).locator(`text=${columnName}`).first().click();
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
  }

  /** A rename done on the board only: main sends no queue snapshot for it. */
  async function renameOnBoard(taskId: string, title: string): Promise<void> {
    await page.evaluate(({ id, next }) => {
      const stores = (window as unknown as {
        __zustandStores: { board: { setState: (update: (state: { tasks: Array<{ id: string; title: string }> }) => object) => void } };
      }).__zustandStores;
      stores.board.setState((state) => ({
        tasks: state.tasks.map((task) => (task.id === id ? { ...task, title: next } : task)),
      }));
    }, { id: taskId, next: title });
  }

  async function openQueuedTask(title: string): Promise<void> {
    await cardOf(title).click();
    await expect(page.getByTestId('queued-placeholder')).toBeVisible();
  }

  test.describe('Column Manager', () => {
    test('the switch closes the Sessions section, off by default, and saves one agent at a time', async () => {
      await open(COLUMN_SNAPSHOT);
      await openManager('Merge');
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      await expect(dialog.getByText('Sessions', { exact: true })).toBeVisible();

      const toggle = dialog.getByTestId('column-one-at-a-time');
      await expect(toggle).toContainText('Run one agent in this column at a time');
      await expect(toggle).toContainText('Other tasks wait in this column and start in the order they arrived.');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => page.evaluate(async () => {
        const swimlanes = await window.electronAPI.swimlanes.list();
        return swimlanes.find((lane) => lane.name === 'Merge')?.max_agents;
      })).toBe(1);
    });

    test('All columns shows the limit as a read-only switch, dashed where no agent runs', async () => {
      await open(COLUMN_SNAPSHOT);
      await openManager('Merge');
      const dialog = page.locator('[data-testid="board-manager-dialog"]');
      await dialog.getByTestId('column-one-at-a-time').click();
      await dialog.getByTestId('board-manager-tab-all').click();

      await expect(dialog.getByRole('columnheader', { name: 'One at a time' })).toBeVisible();
      const label = 'Run one agent in this column at a time';
      const rowOf = (name: string) => dialog.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: name });
      await expect(rowOf('Merge').getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'true');
      await expect(rowOf('Merge').getByRole('switch', { name: label })).toBeDisabled();
      await expect(rowOf('Testing').getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'false');
      await expect(rowOf('To Do').getByRole('switch', { name: label })).toHaveCount(0);
    });
  });

  test.describe('cards', () => {
    test('a queued card reads its place in line with a still clock, and no context track', async () => {
      await open(COLUMN_SNAPSHOT);
      const footer = cardOf('Add CSV export').getByTestId('status-bar');

      await expect(footer).toHaveText('Queued 2/3...');
      await expect(cardOf('Fix login redirect').getByTestId('status-bar')).toHaveText('Queued 3/3...');
      await expect(footer.locator('.animate-spin')).toHaveCount(0);
      await expect(footer.locator('.h-1')).toHaveCount(0);
    });

    test('its tip names the column it waits for', async () => {
      await open(COLUMN_SNAPSHOT);
      await cardOf('Add CSV export').getByText('Queued 2/3...').hover();
      await expect(page.getByRole('tooltip')).toHaveText('Waiting for a slot in Merge.');
    });

    test('a task held by Max concurrent sessions counts among all queued tasks', async () => {
      await open(GLOBAL_SNAPSHOT);
      await expect(cardOf('Fix login redirect').getByTestId('status-bar')).toHaveText('Queued 3/3...');
      await cardOf('Fix login redirect').getByText('Queued 3/3...').hover();
      await expect(page.getByRole('tooltip')).toHaveText('Waiting for a free agent slot.');
    });

    test('a compact card says it in place of the description', async () => {
      await open(COLUMN_SNAPSHOT);
      await page.evaluate(() => {
        const target = window as unknown as { __zustandStores: { config: { setState: (update: (state: { config: object }) => object) => void } } };
        target.__zustandStores.config.setState((state) => ({ config: { ...state.config, cardDensity: 'compact' } }));
      });

      const card = cardOf('Add CSV export');
      await expect(card.getByTestId('task-card-queued-line')).toHaveText('Queued 2/3...');
      await expect(card.getByTestId('task-card-description')).toHaveCount(0);
    });

    test('the card follows the line as main pushes it', async () => {
      await open(COLUMN_SNAPSHOT);
      await expect(cardOf('Fix login redirect').getByTestId('status-bar')).toHaveText('Queued 3/3...');

      await page.evaluate((snapshot) => {
        (window as unknown as { __mockFireQueueChanged: (next: unknown) => void }).__mockFireQueueChanged(snapshot);
      }, { ...COLUMN_SNAPSHOT, columns: [{ ...COLUMN_SNAPSHOT.columns[0], holders: [SECOND], waiting: [THIRD] }], global: [THIRD] });

      await expect(cardOf('Fix login redirect').getByTestId('status-bar')).toHaveText('Queued 2/2...');
    });
  });

  test.describe('Agent Monitor', () => {
    function monitorRow(id: string, displayId: number, title: string, status: string) {
      return {
        sessionId: `sess-${id}`, projectId: PROJECT_ID, projectName: 'Sample app',
        taskId: `task-${id}`, taskTitle: title, outputPeek: [], displayId,
        columnName: 'Merge', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
        agentName: 'claude', modelDisplayName: null, effort: null, permissionMode: null,
        startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
        status, activity: null, activityReason: null,
        lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false,
      };
    }

    test('a queued session\'s card reads its place in line from the seeded snapshot', async () => {
      await open(COLUMN_SNAPSHOT, [
        monitorRow('running', 412, 'Migrate settings', 'running'),
        monitorRow('second', 420, 'Add CSV export', 'queued'),
        monitorRow('third', 421, 'Fix login redirect', 'queued'),
      ]);
      await page.getByTestId('agent-monitor-button').click();
      await page.getByTestId('monitor-grid').waitFor({ state: 'visible', timeout: 10000 });

      const statusOf = (sessionId: string) => page.locator(`[data-testid="monitor-card"][data-session-id="${sessionId}"]`).getByTestId('monitor-card-status');
      await expect(statusOf('sess-second')).toHaveText('Queued 2/3...');
      await expect(statusOf('sess-third')).toHaveText('Queued 3/3...');

      // It follows the line as main pushes it, like the board's card.
      await page.evaluate((snapshot) => {
        (window as unknown as { __mockFireQueueChanged: (next: unknown) => void }).__mockFireQueueChanged(snapshot);
      }, { ...COLUMN_SNAPSHOT, columns: [{ ...COLUMN_SNAPSHOT.columns[0], holders: [SECOND], waiting: [THIRD] }], global: [THIRD] });
      await expect(statusOf('sess-third')).toHaveText('Queued 2/2...');
    });
  });

  test.describe('task detail', () => {
    test('a column limit shows the count as the title over the line, this task dashed', async () => {
      await open(COLUMN_SNAPSHOT);
      await openQueuedTask('Fix login redirect');

      await expect(page.getByTestId('queued-title')).toHaveText('Queued 3/3');
      await expect(page.getByTestId('queue-row')).toHaveCount(2);
      await expect(page.getByTestId('queue-row').first()).toContainText('Migrate settings');
      await expect(page.getByTestId('queue-row').nth(1)).toContainText('2');
      await expect(page.getByTestId('queue-row-self')).toContainText('Fix login redirect');
      await expect(page.getByTestId('queue-row-self')).toContainText('#421');
      await expect(page.getByText('agent slots in use')).toHaveCount(0);
    });

    test('Max concurrent sessions uses the same shape, led by what holds the slots', async () => {
      await open(GLOBAL_SNAPSHOT);
      await openQueuedTask('Fix login redirect');

      await expect(page.getByTestId('queued-title')).toHaveText('Queued 3/3');
      await expect(page.getByTestId('queue-agents-running')).toContainText('of 8 agents running');
      // A task from another project says which.
      await expect(page.getByTestId('queue-row').first()).toContainText('Update the pricing page');
      await expect(page.getByTestId('queue-row').first()).toContainText('Docs site');
      await expect(page.getByTestId('queue-row').nth(1)).not.toContainText('Sample app');
      await expect(page.getByText('agent slots in use')).toHaveCount(0);
    });

    test('the row that replaced the pill still opens Settings', async () => {
      await open(GLOBAL_SNAPSHOT);
      await openQueuedTask('Fix login redirect');

      await page.getByTestId('queue-agents-running').click();

      await expect(page.getByTestId('settings-panel')).toBeVisible();
    });

    test('a row opens its task', async () => {
      await open(COLUMN_SNAPSHOT);
      await openQueuedTask('Fix login redirect');

      await page.getByTestId('queue-row').nth(1).click();

      await expect(page.getByTestId('queued-title').filter({ hasText: 'Queued 2/3' })).toBeVisible();
    });

    test('a restart keeping its slot reads as working, not as needing you', async () => {
      // A holder with no session is an agent restarting in place: it keeps the slot
      // and has nothing to ask yet.
      const restarting = {
        ...COLUMN_SNAPSHOT,
        columns: [{ ...COLUMN_SNAPSHOT.columns[0], holders: [{ ...RUNNING, sessionId: null }] }],
      };
      await open(restarting);
      await openQueuedTask('Fix login redirect');

      const holderRow = page.getByTestId('queue-row').first();
      await expect(holderRow).toContainText('Migrate settings');
      await expect(holderRow.getByRole('img', { name: 'Working' })).toBeVisible();
      await expect(holderRow.getByRole('img', { name: 'Needs you' })).toHaveCount(0);
    });

    test('a holder whose live session has reported no activity reads as needing you', async () => {
      // The contrast to the restart above, and what keeps that case honest: the same
      // row with a session id and no activity pushed yet is not "working".
      await open(COLUMN_SNAPSHOT);
      await openQueuedTask('Fix login redirect');

      const holderRow = page.getByTestId('queue-row').first();
      await expect(holderRow).toContainText('Migrate settings');
      await expect(holderRow.getByRole('img', { name: 'Needs you' })).toBeVisible();
      await expect(holderRow.getByRole('img', { name: 'Working' })).toHaveCount(0);
    });

    test('a row shows the title the board has now, since a rename sends no new snapshot', async () => {
      await open(COLUMN_SNAPSHOT);
      await openQueuedTask('Fix login redirect');
      await expect(page.getByTestId('queue-row').nth(1)).toContainText('Add CSV export');

      await renameOnBoard('task-second', 'Add Excel export');

      const renamedRow = page.getByTestId('queue-row').nth(1);
      await expect(renamedRow).toContainText('Add Excel export');
      await expect(renamedRow).not.toContainText('Add CSV export');
      // The task's own row and the holder are the board's too, and unchanged here.
      await expect(page.getByTestId('queue-row').first()).toContainText('Migrate settings');
      await expect(page.getByTestId('queue-row-self')).toContainText('Fix login redirect');
    });

    test('a row for a task not on this board keeps the snapshot title', async () => {
      await open(GLOBAL_SNAPSHOT);
      await openQueuedTask('Fix login redirect');
      const otherProjectRow = page.getByTestId('queue-row').first();
      await expect(otherProjectRow).toContainText('Update the pricing page');

      // A rename on this board reaches the row of a task on it, and only that row.
      await renameOnBoard('task-second', 'Add Excel export');

      await expect(page.getByTestId('queue-row').nth(1)).toContainText('Add Excel export');
      await expect(otherProjectRow).toContainText('Update the pricing page');
    });

    test('the title holds its height as the line changes', async () => {
      await open(COLUMN_SNAPSHOT);
      await openQueuedTask('Fix login redirect');
      const before = await page.getByTestId('queued-title').boundingBox();

      await page.evaluate((snapshot) => {
        (window as unknown as { __mockFireQueueChanged: (next: unknown) => void }).__mockFireQueueChanged(snapshot);
      }, { ...COLUMN_SNAPSHOT, columns: [{ ...COLUMN_SNAPSHOT.columns[0], holders: [SECOND], waiting: [THIRD] }], global: [THIRD] });

      await expect(page.getByTestId('queued-title')).toHaveText('Queued 2/2');
      const after = await page.getByTestId('queued-title').boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    });
  });
});
