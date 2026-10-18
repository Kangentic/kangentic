/**
 * UI tests for the Workflows view's canvas: the third view, its empty state,
 * a workflow's cards and links drawn on the canvas, selection, and the
 * shortcut that opens the view and returns from it.
 *
 * Assertions read state the view exposes (`data-selected`, the active
 * segment's `aria-checked`, counts of cards and drawn links), never pixel
 * geometry (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, computedColor } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-canvas-proj';

function plannedTask(key: string, title: string): Record<string, unknown> {
  return {
    key, title, description: `${title}, planned by the workflow agent.`, project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

/**
 * A started workflow's two tasks, both in To Do, the second waiting for the
 * first. Planned by its own workflow agent, so the pane starts it on open.
 */
function startedSeedScript(): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: 'wf-running', title: 'Relay reconnect', state: 'running', draft: null, agent_name: 'claude' } }];
    window.__mockWorkflowLinks = [{ workflow_id: 'wf-running', blocker_task_id: 'run-task-1', blocked_task_id: 'run-task-2' }];
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'workflows-canvas', path: '/mock/workflows-canvas', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-canvas-lane-' + index, position: index, created_at: ts }));
      });
      ['run-task-1', 'run-task-2'].forEach(function (id, index) {
        state.tasks.push({
          id: id, display_id: 40 + index, title: 'Reconnect step ' + (index + 1), description: '',
          swimlane_id: 'wf-canvas-lane-0', position: index, agent: 'claude', session_id: null,
          worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null,
          base_branch: null, use_worktree: 0, labels: [], priority: 0, attachment_count: 0, archived_at: null,
          workflow_id: 'wf-running', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          canvas_x: null, canvas_y: null, created_at: ts, updated_at: ts,
        });
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

const OTHER_PROJECT_ID = 'workflows-canvas-mobile';

/**
 * One project; with `withWorkflow`, one not-started workflow of three tasks and
 * two links. With `acrossBoards`, its third task goes on a second project's board.
 */
function seedScript(withWorkflow: boolean, acrossBoards = false): string {
  const workflows = withWorkflow ? [{
    workflow: {
      // Planned by its own workflow agent, so the pane starts it on open.
      id: 'wf-usage', title: 'Usage budgets', state: 'draft', agent_name: 'claude',
      draft: {
        tasks: [
          plannedTask('task-1', 'Budget table and repository'),
          plannedTask('task-2', 'Budget checks on spawn'),
          { ...plannedTask('task-3', 'Budgets in board_summary'), project_id: acrossBoards ? OTHER_PROJECT_ID : null },
        ],
        links: [{ blocker: 'task-1', blocked: 'task-2' }, { blocker: 'task-2', blocked: 'task-3' }],
      },
    },
  }] : [];
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'workflows-canvas', path: '/mock/workflows-canvas', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts,
      });
      state.projects.push({
        id: '${OTHER_PROJECT_ID}', name: 'workflows-mobile', path: '/mock/workflows-mobile', github_url: null,
        default_agent: 'claude', group_id: null, position: 1, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-canvas-lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: boolean | 'started' | 'acrossBoards'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seed === 'started' ? startedSeedScript() : seed === 'acrossBoards' ? seedScript(true, true) : seedScript(seed));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

/**
 * One of a card's two link ports, the one links arrive at (left) or leave from
 * (right). The editable canvas also gives each node a whole-card drop target
 * (handle id "card") on the left, which is not a port and is left out here.
 */
const port = (page: Page, key: string, side: 'left' | 'right') =>
  page.locator(`.react-flow__node[data-id="${key}"] .react-flow__handle-${side}:not([data-handleid="card"])`);

/** The ports sit on the title row, so the node sets where from its own inline `top`, state rather than measured pixels. */
const portTop = (offset: number) => new RegExp(`(^|;)\\s*top:\\s*${offset}px`);

test.describe('Workflows canvas', () => {
  test('a project with no workflows shows the empty state', async () => {
    const { browser, page } = await launch(false);
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      const empty = page.locator('[data-testid="workflows-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('No workflows');
      await expect(page.locator('[data-testid="workflows-empty-line"]')).toHaveText('Linked tasks that run through your board on their own.');
      await expect(page.locator('[data-testid="workflows-create-first"]')).toHaveText('Create your first workflow');
      await expect(page.locator('[data-testid="workflows-empty-hint"]')).toHaveText('Or right-click a task and choose New workflow.');
      // The Workflows segment carries no mark with nothing running.
      await expect(page.locator('[data-testid="view-toggle-workflows"]')).toHaveAttribute('aria-label', 'Workflows');

      // The drawing (Final 7): four linked cards, the first done, two running,
      // one waiting, the links from the done one in the done green and the
      // rest in the waiting grey, all in theme tokens.
      const illustration = page.locator('[data-testid="workflows-empty-illustration"]');
      await expect(illustration).toBeVisible();
      await expect(illustration).toHaveAttribute('aria-hidden', 'true');
      const states = await illustration.locator('[data-illustration-card]').evaluateAll((groups) => groups.map((group) => group.getAttribute('data-illustration-card')));
      expect(states).toEqual(['done', 'running', 'running', 'waiting']);
      await expect(illustration.locator('[data-illustration-link="satisfied"]')).toHaveCount(2);
      await expect(illustration.locator('[data-illustration-link="pending"]')).toHaveCount(2);
      const active = await computedColor(page, 'var(--color-active)');
      await expect(illustration.locator('[data-illustration-card="done"] [data-illustration-frame]')).toHaveCSS('stroke', active);
      await expect(illustration.locator('[data-illustration-link="satisfied"]').first()).toHaveCSS('stroke', active);
      await expect(illustration.locator('[data-illustration-card="waiting"] [data-illustration-frame]')).toHaveCSS('stroke', await computedColor(page, 'var(--color-edge)'));
      await expect(illustration.locator('[data-illustration-card="waiting"] [data-illustration-frame]')).toHaveCSS('fill', await computedColor(page, 'var(--color-surface-raised)'));
      // Static: nothing in the empty state animates.
      expect(await empty.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('draws a workflow\'s cards and the links between them', async () => {
    const { browser, page } = await launch(true);
    try {
      // Not started, so nothing runs: no mark on the Workflows segment.
      await expect(page.locator('[data-testid="view-toggle-workflows"]')).toHaveAttribute('aria-label', 'Workflows');
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await expect(card(page, 'task-2')).toContainText('Budget checks on spawn');
      // Two links, one per blocker; the layout puts each task a column right of what it waits for.
      await expect(page.locator('.react-flow__edge')).toHaveCount(2);
      // A not-started task has no ticket number yet.
      await expect(card(page, 'task-1')).not.toContainText('#');
      // Every task on one board, and every card still names its project
      // (sign-off 4b), so a card has one shape whatever the workflow spans.
      await expect(page.locator('[data-testid="workflow-card-project"]')).toHaveCount(3);
      await expect(card(page, 'task-1').locator('[data-testid="workflow-card-strip"] [data-testid="workflow-card-project"]')).toHaveText('workflows-canvas');
      // The name sits in the strip, so the title row is the first thing under
      // it, and the link ports stay at the middle of it, 49px down.
      for (const key of ['task-1', 'task-2', 'task-3']) {
        await expect(port(page, key, 'left')).toHaveAttribute('style', portTop(49));
        await expect(port(page, key, 'right')).toHaveAttribute('style', portTop(49));
      }
      // A port is a dot ringed in the accent on the canvas's own fill (boards 1, 10).
      const accentForeground = await computedColor(page, 'var(--color-accent-fg)');
      const surface = await computedColor(page, 'var(--color-surface)');
      for (const side of ['left', 'right'] as const) {
        await expect(port(page, 'task-2', side)).toHaveCSS('border-top-color', accentForeground);
        await expect(port(page, 'task-2', side)).toHaveCSS('border-top-width', '2px');
        await expect(port(page, 'task-2', side)).toHaveCSS('background-color', surface);
      }
    } finally {
      await browser.close();
    }
  });

  test('once a task is on another board, every card names its project', async () => {
    const { browser, page } = await launch('acrossBoards');
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      // Home cards too, not only the one on the other board (board 17).
      await expect(card(page, 'task-1').locator('[data-testid="workflow-card-project"]')).toHaveText('workflows-canvas');
      await expect(card(page, 'task-3').locator('[data-testid="workflow-card-project"]')).toHaveText('workflows-mobile');
      await expect(page.locator('[data-testid="workflow-card-project"]')).toHaveCount(3);
      // The project sits in the strip's left side, where the phone puts it, so
      // the title row and the ports stay where they are on one board: 49px down.
      for (const key of ['task-1', 'task-2', 'task-3']) {
        await expect(card(page, key).locator('[data-testid="workflow-card-strip"] [data-testid="workflow-card-project"]')).toHaveCount(1);
        await expect(port(page, key, 'left')).toHaveAttribute('style', portTop(49));
        await expect(port(page, key, 'right')).toHaveAttribute('style', portTop(49));
      }
      // The name reads at 12px in the tertiary grey, its folder in the muted grey.
      const projectLabel = card(page, 'task-1').locator('[data-testid="workflow-card-project"]');
      await expect(projectLabel).toHaveCSS('font-size', '12px');
      await expect(projectLabel).toHaveCSS('color', await computedColor(page, 'var(--color-fg-tertiary)'));
      await expect(projectLabel.locator('svg')).toHaveCSS('color', await computedColor(page, 'var(--color-fg-muted)'));
    } finally {
      await browser.close();
    }
  });

  test('a selected task\'s links: what feeds it, what it feeds, flowing, and every other link faded', async () => {
    // Sign-off B and 2: the board overlay's colors (a pending blocker's link a
    // brighter grey, a dependent's the accent), dashes flowing from blocker to
    // dependent, every other link at 20%.
    const { browser, page } = await launch(true);
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      const link = (blocker: string, blocked: string) => page.locator(`.react-flow__edge[data-id="${blocker}->${blocked}"] path.react-flow__edge-path`);
      const look = (blocker: string, blocked: string) => link(blocker, blocked).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          relation: element.getAttribute('data-link-relation'),
          stroke: style.stroke,
          opacity: style.opacity,
          flowing: element.classList.contains('workflow-link-flow') && style.strokeDasharray !== 'none',
          animated: style.animationName !== 'none',
          // A flowing link repaints every frame, so its own <svg> is its own layer.
          layered: getComputedStyle(element.closest('svg')!).willChange === 'transform',
        };
      });

      await card(page, 'task-2').click();
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect.poll(() => look('task-1', 'task-2')).toMatchObject({ relation: 'blocker', opacity: '1', flowing: true, animated: true, layered: true });
      expect((await look('task-1', 'task-2')).stroke).toBe(await computedColor(page, 'var(--color-fg-muted)'));
      await expect.poll(() => look('task-2', 'task-3')).toMatchObject({ relation: 'dependent', opacity: '1', flowing: true });
      expect((await look('task-2', 'task-3')).stroke).toBe(await computedColor(page, 'var(--color-accent-fg)'));

      // Another selection: the link it has no part in fades back and holds still.
      await card(page, 'task-1').click();
      await expect.poll(() => look('task-2', 'task-3')).toMatchObject({ relation: 'muted', opacity: '0.2', flowing: false, layered: false });
      await expect.poll(() => look('task-1', 'task-2')).toMatchObject({ relation: 'dependent', flowing: true });

      // Nothing selected: every link back to its state's own look.
      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect.poll(() => look('task-1', 'task-2')).toMatchObject({ relation: 'none', opacity: '0.7', flowing: false });

      // With reduced motion the flow holds still.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await card(page, 'task-2').click();
      await expect.poll(() => look('task-1', 'task-2')).toMatchObject({ relation: 'blocker', animated: false, layered: false });
    } finally {
      await browser.close();
    }
  });

  test('a click selects a card, and a click on empty canvas or Escape clears it', async () => {
    const { browser, page } = await launch(true);
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      // The workflow opens on the first task in its run order (Final 4).
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('[data-testid="workflow-inspector-title"]')).toContainText('Budget table and repository');

      await card(page, 'task-2').click();
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'false');
      // Selected (sign-off S3): the theme's accent at the border's own 1px,
      // with no ring or halo outside it. An unselected planned card draws like
      // any To Do card: a solid 1px edge, no dash (Final 3).
      const edge = await computedColor(page, 'var(--color-edge)');
      await expect(card(page, 'task-2')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 'task-2')).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-accent)'));
      await expect(card(page, 'task-2')).toHaveCSS('border-top-style', 'solid');
      await expect(card(page, 'task-2')).toHaveCSS('box-shadow', 'none');
      await expect(card(page, 'task-1')).toHaveCSS('border-top-width', '1px');
      await expect(card(page, 'task-1')).toHaveCSS('border-top-style', 'solid');
      await expect(card(page, 'task-1')).toHaveCSS('border-top-color', edge);
      await expect(card(page, 'task-3')).toHaveCSS('border-top-style', 'solid');

      await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'false');
      await expect(card(page, 'task-2')).toHaveCSS('border-top-style', 'solid');
      // Cleared, it stays cleared: the inspector shows the run order, with no prompt.
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="workflow-run-order-row"]')).toHaveCount(3);
      await expect(page.locator('[data-testid="workflow-inspector-prompt"]')).toHaveCount(0);

      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
      await expect(page.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a started task\'s card follows the board when an agent renames it', async () => {
    // An agent's rename (MCP) reloads the board and announces no workflow
    // change, so the card has to read the board's live row, not the workflow's
    // snapshot, or it shows the old title until the view reopens.
    const { browser, page } = await launch('started');
    try {
      await page.locator('[data-testid="view-toggle-workflows"]').click();
      await expect(card(page, 'run-task-1')).toContainText('Reconnect step 1');
      await page.evaluate(async (projectId) => {
        await window.electronAPI.tasks.update({ id: 'run-task-1', title: 'Reconnect with backoff' });
        (window as unknown as { __mockFireTaskUpdatedByAgent: (taskId: string, title: string, project: string) => void })
          .__mockFireTaskUpdatedByAgent('run-task-1', 'Reconnect with backoff', projectId);
      }, PROJECT_ID);
      await expect(card(page, 'run-task-1')).toContainText('Reconnect with backoff');
      // A task in To Do that waits shows why, in the card's own footer.
      await expect(card(page, 'run-task-2')).toContainText('Blocked by #40...');
    } finally {
      await browser.close();
    }
  });

  test('Mod+Shift+L opens Workflows and returns to the view it came from', async () => {
    const { browser, page } = await launch(true);
    try {
      const segment = (view: string) => page.locator(`[data-testid="view-toggle-${view}"]`);
      await page.locator('body').click({ position: { x: 600, y: 500 } });
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('workflows')).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(3);
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('board')).toHaveAttribute('aria-checked', 'true');

      await segment('backlog').click();
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('workflows')).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Control+Shift+L');
      await expect(segment('backlog')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await browser.close();
    }
  });
});
