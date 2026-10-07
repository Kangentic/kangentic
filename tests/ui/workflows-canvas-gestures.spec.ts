/**
 * UI tests for the Workflows canvas's gestures (#732 boards 10, 10b): drawing
 * a link (which ports stay, the line, the hints, the ring on a target, the
 * refused pointer, the link just made), moving a card (the lift, arrow keys
 * and their save), and the double-click that selects and opens a card.
 *
 * Assertions read state: visibility, attributes, counts, classes React Flow
 * sets, and computed styles of a single element. Pointer positions are read
 * from live boxes right before each move, never asserted
 * (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser, which is slow under a full gate's load.
test.describe.configure({ mode: 'parallel', timeout: 30_000 });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-gestures-proj';

function plannedTask(key: string, title: string): Record<string, unknown> {
  return {
    key, title, description: `${title}, planned by the workflow agent.`, project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

/**
 * `draft`: a not-started workflow of three planned tasks, the second waiting
 * for the first and the third free, so a link onto the third is drawn (a link
 * the chain already implies is left out of the drawing). `started`: a running
 * workflow of two tasks in To Do, the second waiting for the first.
 */
function seedScript(seed: 'draft' | 'started'): string {
  const workflows = seed === 'draft'
    ? [{
      workflow: {
        id: 'wf-draft', title: 'Theme tokens', state: 'draft',
        draft: {
          tasks: [plannedTask('task-1', 'Token table'), plannedTask('task-2', 'Token picker'), plannedTask('task-3', 'Token docs')],
          links: [{ blocker: 'task-1', blocked: 'task-2' }],
        },
      },
    }]
    : [{ workflow: { id: 'wf-running', title: 'Relay reconnect', state: 'running', draft: null } }];
  const links = seed === 'started'
    ? [{ workflow_id: 'wf-running', blocker_task_id: 'run-task-1', blocked_task_id: 'run-task-2' }]
    : [];
  return `
    window.__mockWorkflows = ${JSON.stringify(workflows)};
    window.__mockWorkflowLinks = ${JSON.stringify(links)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'workflows-gestures', path: '/mock/workflows-gestures', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'wf-gestures-lane-' + index, position: index, created_at: ts }));
      });
      if (${seed === 'started'}) {
        ['run-task-1', 'run-task-2'].forEach(function (id, index) {
          state.tasks.push({
            id: id, display_id: 40 + index, title: 'Reconnect step ' + (index + 1), description: '',
            swimlane_id: 'wf-gestures-lane-0', position: index, agent: 'claude', session_id: null,
            worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null,
            base_branch: null, use_worktree: 0, labels: [], priority: 0, attachment_count: 0, archived_at: null,
            workflow_id: 'wf-running', workflow_project_id: '${PROJECT_ID}',
            route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
            canvas_x: null, canvas_y: null, created_at: ts, updated_at: ts,
          });
        });
      }
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(seed: 'draft' | 'started'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflow-canvas-card"]').first().waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);
const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);
const node = (page: Page, key: string) => page.locator(`.react-flow__node[data-id="${key}"]`);
const incomingPort = (page: Page, key: string) => node(page, key).locator('.workflow-port-in');
const outgoingPort = (page: Page, key: string) => node(page, key).locator('.workflow-port-out');
const cardTarget = (page: Page, key: string) => node(page, key).locator('.react-flow__handle[data-handleid="card"]');

/** A theme token's color as this page computes it, so a style check holds in every theme. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

async function centerOf(page: Page, locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box || box.width === 0) throw new Error('element not laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Press on a card's outgoing port and take a first step, then wait until the
 * canvas says a link is being drawn (`data-linking`), so the next moves draw
 * it. Under a full gate's load (the unit, UI and E2E tiers at once) the moves
 * that follow could otherwise run ahead of the drag's start and leave no hint.
 */
async function startLinkFrom(page: Page, key: string): Promise<void> {
  const start = await centerOf(page, outgoingPort(page, key));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y + 8, { steps: 2 });
  await expect(byTestId(page, 'workflow-canvas')).toHaveAttribute('data-linking', '', { timeout: 15_000 });
}

/** The first hint after a drag, given room for a loaded machine. */
const HINT_TIMEOUT = { timeout: 15_000 };

test.describe('Workflows canvas gestures', () => {
  test('a link drag keeps only the ports that can take it and draws a dashed accent line, with a hint over empty canvas', async () => {
    const { browser, page } = await launch('draft');
    try {
      // At rest every task that has not started has both ports.
      for (const key of ['task-1', 'task-2', 'task-3']) {
        await expect(incomingPort(page, key)).toBeVisible();
        await expect(outgoingPort(page, key)).toBeVisible();
      }

      const below = await card(page, 'task-2').boundingBox();
      if (!below) throw new Error('canvas not laid out');
      await startLinkFrom(page, 'task-1');
      await page.mouse.move(below.x + below.width / 2, below.y + below.height + 80, { steps: 10 });

      await expect(byTestId(page, 'workflow-link-canvas-hint')).toHaveText('Release on a task to make it wait for "Token table"', HINT_TIMEOUT);
      await expect(byTestId(page, 'workflow-link-hint')).toHaveCount(0);
      const line = page.locator('[data-testid="workflow-connection-line"] path');
      await expect(line).toHaveAttribute('style', /stroke-dasharray:\s*6,?\s*5/);
      await expect(line).toHaveAttribute('style', /stroke-width:\s*2(;|$)/);
      await expect(line).toHaveAttribute('style', /stroke:\s*var\(--color-accent-fg\)/);

      // Only "Token docs" can wait for "Token table": "Token picker" already
      // does, and a task cannot wait for itself. No outgoing port shows.
      await expect(incomingPort(page, 'task-3')).toBeVisible();
      await expect(incomingPort(page, 'task-2')).toBeHidden();
      await expect(incomingPort(page, 'task-1')).toBeHidden();
      for (const key of ['task-1', 'task-2', 'task-3']) await expect(outgoingPort(page, key)).toBeHidden();

      // Released on empty canvas, nothing changes and every port comes back.
      await page.mouse.up();
      await expect(byTestId(page, 'workflow-link-canvas-hint')).toHaveCount(0);
      await expect(page.locator('.react-flow__edge')).toHaveCount(1);
      await expect(incomingPort(page, 'task-2')).toBeVisible();
      await expect(outgoingPort(page, 'task-1')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('over a task that can take the link it rings, its port fills, and the link it makes stays in the accent until the selection moves', async () => {
    const { browser, page } = await launch('draft');
    try {
      await startLinkFrom(page, 'task-1');
      const target = await centerOf(page, card(page, 'task-3'));
      await page.mouse.move(target.x, target.y, { steps: 12 });

      const hint = node(page, 'task-3').locator('[data-testid="workflow-link-hint"]');
      await expect(hint).toHaveText('Release to make "Token docs" wait for "Token table"', HINT_TIMEOUT);
      await expect(hint).toHaveAttribute('data-link-verdict', 'valid');
      // A neutral menu box, left-aligned with the card and 44px above it.
      await expect(hint).toHaveCSS('top', '-44px');
      await expect(hint).toHaveCSS('left', '0px');
      await expect(hint).toHaveCSS('border-top-color', await tokenColor(page, '--color-edge-input'));
      await expect(hint).toHaveCSS('background-color', await tokenColor(page, '--color-surface-raised'));
      // The ring with its 7px halo, and the incoming port filled at 14px in the accent.
      const ring = node(page, 'task-3').locator('[data-testid="workflow-link-target"]');
      await expect(ring).toHaveCount(1);
      await expect(ring).toHaveCSS('box-shadow', /0px 0px 0px 7px/);
      const filledPort = node(page, 'task-3').locator('[data-testid="workflow-link-target-port"]');
      await expect(filledPort).toBeVisible();
      await expect(filledPort).toHaveCSS('width', '14px');
      await expect(filledPort).toHaveCSS('background-color', await tokenColor(page, '--color-accent'));
      await expect(byTestId(page, 'workflow-link-canvas-hint')).toHaveCount(0);
      // The card with the hint sits over its neighbors, so the hint above it is never under another card.
      await expect(node(page, 'task-3')).toHaveCSS('z-index', '2000');

      await page.mouse.up();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('.react-flow__edge')).toHaveCount(2);
      await expect(page.locator('.react-flow__edge-path[data-link-state="fresh"]')).toHaveCount(1);
      await expect(page.locator('.react-flow__edge-path[data-link-state="fresh"]')).toHaveAttribute('style', /stroke:\s*var\(--color-accent-fg\)/);

      // Another selection: the new link draws like any other.
      await card(page, 'task-1').click();
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
      await expect(page.locator('.react-flow__edge-path[data-link-state="fresh"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('over a task that cannot take the link the pointer is refused and the hint says why', async () => {
    const { browser, page } = await launch('draft');
    try {
      // "Token picker" waits for "Token table", so linking back closes a loop.
      await startLinkFrom(page, 'task-2');
      const target = await centerOf(page, card(page, 'task-1'));
      await page.mouse.move(target.x, target.y, { steps: 12 });

      const hint = node(page, 'task-1').locator('[data-testid="workflow-link-hint"]');
      await expect(hint).toHaveText('That link closes a loop. A workflow\'s links cannot go in a circle.', HINT_TIMEOUT);
      await expect(hint).toHaveAttribute('data-link-verdict', 'refused');
      // The same neutral box as an offer: no accent anywhere on a refusal.
      await expect(hint).toHaveCSS('border-top-color', await tokenColor(page, '--color-edge-input'));
      await expect(node(page, 'task-1').locator('[data-testid="workflow-link-target"]')).toHaveCount(0);
      await expect(cardTarget(page, 'task-1')).toHaveClass(/\bconnectingto\b/);
      await expect(cardTarget(page, 'task-1')).not.toHaveClass(/\bvalid\b/);
      await expect(cardTarget(page, 'task-1')).toHaveCSS('cursor', 'not-allowed');

      await page.mouse.up();
      await expect(byTestId(page, 'workflow-link-hint')).toHaveCount(0);
      await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a card being moved lifts, and settles when it is let go', async () => {
    const { browser, page } = await launch('draft');
    try {
      const box = await card(page, 'task-3').boundingBox();
      if (!box) throw new Error('no card to move');
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + 140, { steps: 8 });
      await expect(page.locator('.react-flow__node.dragging')).toHaveCount(1);
      await expect(node(page, 'task-3')).toHaveClass(/\bdragging\b/);
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('box-shadow', /0px 18px 40px/);
      await page.mouse.up();
      await expect(page.locator('.react-flow__node.dragging')).toHaveCount(0);
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('box-shadow', 'none');
    } finally {
      await browser.close();
    }
  });

  test('arrow keys move the selected card, and its place is saved once the keys rest', async () => {
    const { browser, page } = await launch('draft');
    try {
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();
      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowRight');

      // Saved the way a drag stop saves: the card now has a hand place, so
      // Auto layout turns live, and main holds the place for the next open.
      await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();
      const saved = await page.evaluate(async (projectId) => {
        const detail = await window.electronAPI.workflows.get(projectId, 'wf-draft');
        return detail.tasks.map((task) => ({ key: task.key, placed: task.canvasX !== null && task.canvasY !== null }));
      }, PROJECT_ID);
      expect(saved).toEqual([
        { key: 'task-1', placed: false },
        { key: 'task-2', placed: false },
        { key: 'task-3', placed: true },
      ]);
    } finally {
      await browser.close();
    }
  });

  test('a click that drifts under the drag threshold still selects, and a drag selects the card it moved', async () => {
    // A hand's click often moves a pixel or two between press and release.
    // With React Flow's click distance at 0 that was neither a click nor a
    // drag, and the card was not selected.
    const { browser, page } = await launch('draft');
    try {
      const pressAndDrift = async (key: string, drift: number) => {
        const box = await card(page, key).boundingBox();
        if (!box || box.width === 0) throw new Error('card not laid out');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + drift, y + 1, { steps: 2 });
        await page.mouse.up();
      };
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
      await pressAndDrift('task-3', 2);
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      // A drift that small is a click, so nothing was placed by hand.
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();

      await pressAndDrift('task-2', 8);
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('a card focused from the keyboard wears the app\'s accent ring, never the browser\'s', async () => {
    // The browser's ring is the OS accent on Windows, which read as a second
    // selection, on a card that was not the selected one.
    const { browser, page } = await launch('draft');
    try {
      // A key press first, so the focus that follows counts as keyboard focus,
      // as when a dialog closed with Escape hands focus back to the card.
      await page.keyboard.press('Shift');
      await node(page, 'task-3').evaluate((element) => (element as HTMLElement).focus());
      await expect(node(page, 'task-3')).toBeFocused();
      expect(await node(page, 'task-3').evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      await expect(node(page, 'task-3')).toHaveCSS('outline-style', 'none');
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('outline-style', 'solid');
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('outline-color', await tokenColor(page, '--color-accent'));
    } finally {
      await browser.close();
    }
  });

  test('a layout save main refuses puts the moved card back where the workflow says it is', async () => {
    const { browser, page } = await launch('draft');
    try {
      const transformOf = () => node(page, 'task-3').evaluate((element) => (element as HTMLElement).style.transform);
      const original = await transformOf();
      expect(original).not.toBe('');

      // Every transform the card is given from here on, so "it moved" does not
      // depend on a poll landing inside the 400ms the keys rest before the save.
      await node(page, 'task-3').evaluate((element) => {
        const win = window as unknown as { __cardTransforms: string[] };
        win.__cardTransforms = [];
        new MutationObserver(() => { win.__cardTransforms.push((element as HTMLElement).style.transform); })
          .observe(element, { attributes: true, attributeFilter: ['style'] });
      });
      await page.evaluate(() => {
        (window as unknown as { __mockWorkflowSetPositionsRejectOnce: string }).__mockWorkflowSetPositionsRejectOnce =
          'That workflow is no longer in this project.';
      });

      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowRight');

      // The keys rest, the save goes out, and main refuses it: no change push follows.
      const refusal = page.locator('[data-testid="toast"]').filter({ hasText: 'Could not save the layout' });
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText('That workflow is no longer in this project.');

      // The card was drawn where it was dropped, and is read back to where the workflow has it.
      const seen = await page.evaluate(() => (window as unknown as { __cardTransforms: string[] }).__cardTransforms);
      expect(seen.some((transform) => transform !== original)).toBe(true);
      await expect.poll(transformOf).toBe(original);
      // Nothing is placed by hand, so Auto layout has nothing to undo.
      await expect(byTestId(page, 'workflow-auto-layout')).toBeDisabled();
      await expect.poll(() => page.evaluate(async (projectId) => {
        const detail = await window.electronAPI.workflows.get(projectId, 'wf-draft');
        return detail.tasks.every((task) => task.canvasX === null && task.canvasY === null);
      }, PROJECT_ID)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a double-click on a planned card selects it and opens the task form', async () => {
    const { browser, page } = await launch('draft');
    try {
      await card(page, 'task-2').dblclick();
      await expect(byTestId(page, 'new-task-dialog')).toContainText('Edit Task');
      await expect(card(page, 'task-2')).toHaveAttribute('data-selected', 'true');
      await expect(byTestId(page, 'workflow-inspector-title')).toContainText('Token picker');
    } finally {
      await browser.close();
    }
  });

  test('a double-click on a started card selects it and opens its task window', async () => {
    const { browser, page } = await launch('started');
    try {
      await card(page, 'run-task-1').dblclick();
      await expect(byTestId(page, 'task-detail-dialog')).toBeVisible();
      await expect(card(page, 'run-task-1')).toHaveAttribute('data-selected', 'true');
    } finally {
      await browser.close();
    }
  });
});
