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
import { waitForViteReady, gotoVite, computedColor, settleFrames, pressPortToStartLink } from './helpers';

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
 * `two-drafts`: the `draft` workflow, listed first so it opens, and a second
 * draft whose three planned tasks carry the SAME keys (a planned task's key is
 * only unique within its workflow), so a save aimed at the wrong workflow
 * places the wrong cards instead of missing. Each is planned by its own
 * workflow agent, so the pane starts it on open.
 */
type Seed = 'draft' | 'started' | 'two-drafts';

function seedScript(seed: Seed): string {
  const draftWorkflow = {
    workflow: {
      id: 'wf-draft', title: 'Theme tokens', state: 'draft', agent_name: 'claude',
      draft: {
        tasks: [plannedTask('task-1', 'Token table'), plannedTask('task-2', 'Token picker'), plannedTask('task-3', 'Token docs')],
        links: [{ blocker: 'task-1', blocked: 'task-2' }],
      },
    },
  };
  const otherDraftWorkflow = {
    workflow: {
      id: 'wf-other', title: 'Relay notes', state: 'draft', agent_name: 'claude',
      draft: {
        tasks: [plannedTask('task-1', 'Note table'), plannedTask('task-2', 'Note picker'), plannedTask('task-3', 'Note docs')],
        links: [],
      },
    },
  };
  let workflows: unknown[];
  if (seed === 'started') workflows = [{ workflow: { id: 'wf-running', title: 'Relay reconnect', state: 'running', draft: null, agent_name: 'claude' } }];
  else if (seed === 'two-drafts') workflows = [draftWorkflow, otherDraftWorkflow];
  else workflows = [draftWorkflow];
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

/**
 * `fakeClock`: the page's timers are Playwright's, which run at real speed until
 * the test pauses them (`page.clock.pauseAt`), so a test can hold a timed
 * window open for as long as its assertions need.
 */
async function launch(seed: Seed, options: { fakeClock?: boolean } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  if (options.fakeClock) await page.clock.install();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed));
  await gotoVite(page, VITE_URL);
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

async function centerOf(page: Page, locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box || box.width === 0) throw new Error('element not laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The place in a React Flow node's `translate(...)` transform, or null when it has none. */
function parseTranslate(transform: string): { x: number; y: number } | null {
  const match = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(transform);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

/** Where React Flow has put a card, from the translate it writes on the node: state, not a measured box. */
async function translateOf(page: Page, key: string): Promise<{ x: number; y: number }> {
  const style = await node(page, key).evaluate((element) => (element as HTMLElement).style.transform);
  const place = parseTranslate(style);
  if (!place) throw new Error(`card ${key} has no translate: "${style}"`);
  return place;
}

/** Press a card by hand, below its title, and move it by `dx`, `dy` with the button still down. */
async function pressAndMoveCard(page: Page, key: string, dx: number, dy: number, steps: number): Promise<void> {
  const box = await card(page, key).boundingBox();
  if (!box || box.width === 0) throw new Error('card not laid out');
  const start = { x: box.x + box.width / 2, y: box.y + 60 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps });
}

/** Make a card `extra` pixels taller than it is now (0 puts it back), the way new content would: React Flow's observer measures it. */
async function growCard(page: Page, key: string, extra: number): Promise<void> {
  await card(page, key).evaluate((element, added) => {
    const target = element as HTMLElement;
    if (added === 0) {
      target.style.minHeight = '';
      return;
    }
    target.style.minHeight = `${target.offsetHeight + added}px`;
  }, extra);
}

/** Animation frames in the page: a resize observer reports, and a render commits, within a few of them. */
async function waitFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

/**
 * How many animation frames pass before a card's place on the canvas changes,
 * or -1 if it never does within `limit` frames. Started before the change it
 * counts for, so it can only count more frames than the change took.
 */
async function framesUntilMoved(page: Page, key: string, limit = 300): Promise<number> {
  return page.evaluate(async ({ nodeKey, maxFrames }) => {
    const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeKey}"]`);
    if (!element) return -1;
    const before = element.style.transform;
    for (let frame = 1; frame <= maxFrames; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (element.style.transform !== before) return frame;
    }
    return -1;
  }, { nodeKey: key, maxFrames: limit });
}

/**
 * Press on a card's outgoing port and take a first step, returning once the
 * canvas says a link is being drawn (`data-linking`), so the next moves draw it.
 * Under a full gate's load (the unit, UI and E2E tiers at once) the moves that
 * follow could otherwise run ahead of the drag's start and leave no hint, and a
 * press could start no link at all, which `pressPortToStartLink` re-presses.
 */
async function startLinkFrom(page: Page, key: string): Promise<void> {
  await pressPortToStartLink(page, outgoingPort(page, key));
}

/** The first hint after a drag, given room for a loaded machine. */
const HINT_TIMEOUT = { timeout: 15_000 };

/** Draw a link from one card's outgoing port onto another card, releasing once the canvas offers it. */
async function drawLink(page: Page, blockerKey: string, blockedKey: string): Promise<void> {
  await startLinkFrom(page, blockerKey);
  const target = await centerOf(page, card(page, blockedKey));
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await expect(node(page, blockedKey).locator('[data-testid="workflow-link-hint"]'))
    .toHaveAttribute('data-link-verdict', 'valid', HINT_TIMEOUT);
  await page.mouse.up();
}

interface HeldLinkSave {
  workflowId: string;
  blockerKey: string;
  blockedKey: string;
}

/**
 * Make main take a link save only when the test says so. The renderer reads
 * `window.electronAPI.workflows.setLink` at call time, so a patch made after boot
 * holds the next save in flight: it is recorded, waits for `releaseLinkSave`, and
 * then goes through to the mock unchanged, so the workflow changes only on release.
 */
async function holdLinkSaves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = window as unknown as { __heldLinkSaves: HeldLinkSave[]; __releaseLinkSave: (() => void) | null };
    held.__heldLinkSaves = [];
    held.__releaseLinkSave = null;
    const workflowsApi = window.electronAPI.workflows;
    const original = workflowsApi.setLink;
    workflowsApi.setLink = async (projectId, workflowId, blockerKey, blockedKey, linked) => {
      held.__heldLinkSaves.push({ workflowId, blockerKey, blockedKey });
      await new Promise<void>((resolve) => { held.__releaseLinkSave = resolve; });
      return original.call(workflowsApi, projectId, workflowId, blockerKey, blockedKey, linked);
    };
  });
}

/** The saves `holdLinkSaves` has taken in, in order. */
async function heldLinkSaves(page: Page): Promise<HeldLinkSave[]> {
  return page.evaluate(() => (window as unknown as { __heldLinkSaves: HeldLinkSave[] }).__heldLinkSaves);
}

/** Let the held save go to main. Its answer arrives after this returns: poll for what it changed. */
async function releaseLinkSave(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __releaseLinkSave: (() => void) | null }).__releaseLinkSave?.());
}

/** The workflow and task the Workflows view has selected, read off its store. */
async function workflowSelection(page: Page): Promise<{ selectedWorkflowId: string | null; selectedTaskKey: string | null }> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { workflow: { getState: () => { selectedWorkflowId: string | null; selectedTaskKey: string | null } } };
    }).__zustandStores;
    const { selectedWorkflowId, selectedTaskKey } = stores.workflow.getState();
    return { selectedWorkflowId, selectedTaskKey };
  });
}

/** The links main holds for a workflow of the seeded project. */
async function savedLinks(page: Page, workflowId: string): Promise<Array<{ blockerKey: string; blockedKey: string }>> {
  return page.evaluate(async ({ projectId, id }) => (await window.electronAPI.workflows.get(projectId, id)).links, { projectId: PROJECT_ID, id: workflowId });
}

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
      await expect(hint).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-edge-input)'));
      await expect(hint).toHaveCSS('background-color', await computedColor(page, 'var(--color-surface-raised)'));
      // The ring with its 7px halo, and the incoming port filled at 14px in the accent.
      const ring = node(page, 'task-3').locator('[data-testid="workflow-link-target"]');
      await expect(ring).toHaveCount(1);
      await expect(ring).toHaveCSS('box-shadow', /0px 0px 0px 7px/);
      const filledPort = node(page, 'task-3').locator('[data-testid="workflow-link-target-port"]');
      await expect(filledPort).toBeVisible();
      await expect(filledPort).toHaveCSS('width', '14px');
      await expect(filledPort).toHaveCSS('background-color', await computedColor(page, 'var(--color-accent)'));
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
      await expect(hint).toHaveCSS('border-top-color', await computedColor(page, 'var(--color-edge-input)'));
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

  test('a link whose save is still on its way selects the task that now waits, once the save lands', async () => {
    // The control for the next test: the same held save, with no workflow picked
    // meanwhile. It also proves the hold itself passes the save through to main
    // and answers it as saved, so the next test's "nothing selected" cannot be a
    // save that quietly failed.
    const { browser, page } = await launch('two-drafts');
    try {
      await holdLinkSaves(page);
      await drawLink(page, 'task-1', 'task-3');
      await expect.poll(() => heldLinkSaves(page)).toEqual([{ workflowId: 'wf-draft', blockerKey: 'task-1', blockedKey: 'task-3' }]);

      // The selection is the save's to make: with the save held, the task that
      // now waits is not selected yet.
      await settleFrames(page);
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
      expect(await savedLinks(page, 'wf-draft')).toEqual([{ blockerKey: 'task-1', blockedKey: 'task-2' }]);

      await releaseLinkSave(page);
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      expect(await workflowSelection(page)).toEqual({ selectedWorkflowId: 'wf-draft', selectedTaskKey: 'task-3' });
      expect(await savedLinks(page, 'wf-draft')).toContainEqual({ blockerKey: 'task-1', blockedKey: 'task-3' });
    } finally {
      await browser.close();
    }
  });

  test('a link saved after another workflow is picked leaves that workflow\'s own selection alone', async () => {
    // A task key names a task only within its own workflow, and both drafts here
    // have a task-3. The link is drawn in "Theme tokens" and its save is held;
    // "Relay notes" is picked while it is on its way. When the save lands, the
    // view must not select "Relay notes"' task-3 because "Theme tokens"' task-3
    // is the one that now waits.
    const { browser, page } = await launch('two-drafts');
    try {
      await expect(byTestId(page, 'workflow-picker')).toContainText('Theme tokens');
      await holdLinkSaves(page);
      await drawLink(page, 'task-1', 'task-3');
      await expect.poll(() => heldLinkSaves(page)).toEqual([{ workflowId: 'wf-draft', blockerKey: 'task-1', blockedKey: 'task-3' }]);

      await byTestId(page, 'workflow-picker').click();
      await page.locator('[data-testid="workflow-picker-option"][data-workflow-id="wf-other"]').click();
      await expect(byTestId(page, 'workflow-picker')).toContainText('Relay notes');
      // The keys collide across the two drafts, so wait on a card only "Relay notes" has.
      await expect(card(page, 'task-3')).toContainText('Note docs');
      // A selection of its own that is not the task the link names, so the
      // view's pick of a first task on opening cannot decide this test.
      await card(page, 'task-1').click();
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
      expect(await workflowSelection(page)).toEqual({ selectedWorkflowId: 'wf-other', selectedTaskKey: 'task-1' });

      await releaseLinkSave(page);
      // The save landed in the workflow it was drawn in...
      await expect.poll(async () => (await savedLinks(page, 'wf-draft')).some((link) => link.blockerKey === 'task-1' && link.blockedKey === 'task-3')).toBe(true);
      // ...and the frames its answer needs to select anything have passed.
      await settleFrames(page, 3);
      expect(await workflowSelection(page)).toEqual({ selectedWorkflowId: 'wf-other', selectedTaskKey: 'task-1' });
      await expect(card(page, 'task-3')).toContainText('Note docs');
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'false');
      await expect(card(page, 'task-1')).toHaveAttribute('data-selected', 'true');
    } finally {
      await browser.close();
    }
  });

  test('a card being moved lifts, and settles when it is let go', async () => {
    const { browser, page } = await launch('draft');
    try {
      // A card is something to click, so it shows the pointer; the empty
      // canvas around it keeps the pan's grab. React Flow gives both grab.
      await expect(node(page, 'task-3')).toHaveCSS('cursor', 'pointer');
      await expect(card(page, 'task-3')).toHaveCSS('cursor', 'pointer');
      await expect(page.locator('.workflow-canvas .react-flow__pane')).toHaveCSS('cursor', 'grab');

      await pressAndMoveCard(page, 'task-3', 60, 80, 8);
      await expect(page.locator('.react-flow__node.dragging')).toHaveCount(1);
      await expect(node(page, 'task-3')).toHaveClass(/\bdragging\b/);
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('box-shadow', /0px 18px 40px/);
      await expect(node(page, 'task-3')).toHaveCSS('cursor', 'grabbing');
      await page.mouse.up();
      await expect(page.locator('.react-flow__node.dragging')).toHaveCount(0);
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('box-shadow', 'none');
      await expect(node(page, 'task-3')).toHaveCSS('cursor', 'pointer');
    } finally {
      await browser.close();
    }
  });

  test('grabbing a card while Auto layout slides the cards ends the slide at once', async () => {
    // The slide ends on its own after 340ms, which would end it with or without
    // the grab. So the page's clock is paused once a card is placed by hand:
    // from then on nothing but the grab can take `data-arranging` off.
    const { browser, page } = await launch('draft', { fakeClock: true });
    try {
      const canvas = byTestId(page, 'workflow-canvas');
      await pressAndMoveCard(page, 'task-3', 60, 80, 8);
      await page.mouse.up();
      await expect(byTestId(page, 'workflow-auto-layout')).toBeEnabled();

      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await byTestId(page, 'workflow-auto-layout').click();
      // The new places land through the mock's own zero-delay timer: advance the
      // paused clock a few milliseconds at a time, far short of the slide's 340.
      await expect.poll(async () => {
        await page.clock.runFor(20);
        return canvas.getAttribute('data-arranging');
      }, { timeout: 10_000 }).toBe('');

      // The slide is on. Grab a card that is not sliding, and move it.
      await pressAndMoveCard(page, 'task-1', 40, 40, 6);
      await expect(node(page, 'task-1')).toHaveClass(/\bdragging\b/);
      await expect(canvas).not.toHaveAttribute('data-arranging');
      await page.mouse.up();
    } finally {
      await browser.close();
    }
  });

  test('a card that grows while another is dragged re-spaces its column at the drop, not mid-drag', async () => {
    // Column one stacks Token table over Token docs, and column two centres
    // Token picker against that stack. So Token table growing by G pushes
    // Token docs down by G and Token picker down by G / 2, once the layout
    // reads the new height.
    const { browser, page } = await launch('draft');
    try {
      const GROWTH = 120;
      const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1;
      const rest = { picker: await translateOf(page, 'task-2'), docs: await translateOf(page, 'task-3') };

      // Control: with no drag, the same growth re-lays the column, and putting
      // it back puts the column back. This is what the drag below must differ
      // from, and how long the layout took here sets how long the drag waits.
      const counting = framesUntilMoved(page, 'task-2');
      await growCard(page, 'task-1', GROWTH);
      const framesToRelayout = await counting;
      expect(framesToRelayout, 'the grown card never re-laid its column when idle').toBeGreaterThan(0);
      await expect.poll(async () => near((await translateOf(page, 'task-2')).y, rest.picker.y + GROWTH / 2)).toBe(true);
      expect(near((await translateOf(page, 'task-3')).y, rest.docs.y + GROWTH)).toBe(true);
      await growCard(page, 'task-1', 0);
      await expect.poll(async () => near((await translateOf(page, 'task-2')).y, rest.picker.y)).toBe(true);
      await expect.poll(async () => near((await translateOf(page, 'task-3')).y, rest.docs.y)).toBe(true);

      // Press Token docs, move it off its slot, and hold.
      await pressAndMoveCard(page, 'task-3', 60, 80, 8);
      await expect(node(page, 'task-3')).toHaveClass(/\bdragging\b/);
      const held = await translateOf(page, 'task-3');
      expect(near(held.y, rest.docs.y)).toBe(false);

      // Token table grows under the held card. A frame budget on purpose: a
      // layout that did not happen cannot be polled for. It is three times what
      // the idle control took (ten frames at least), so the observer has
      // reported and a render would have committed if the layout were going to run.
      await growCard(page, 'task-1', GROWTH);
      await waitFrames(page, Math.max(10, framesToRelayout * 3));
      expect(await translateOf(page, 'task-3')).toEqual(held);
      expect(await translateOf(page, 'task-2')).toEqual(rest.picker);

      // Let go: the column reads the new height now, and the card stays where it was dropped.
      await node(page, 'task-3').evaluate((element) => {
        const recorded = window as unknown as { __droppedTransforms: string[] };
        recorded.__droppedTransforms = [];
        new MutationObserver(() => { recorded.__droppedTransforms.push((element as HTMLElement).style.transform); })
          .observe(element, { attributes: true, attributeFilter: ['style'] });
      });
      await page.mouse.up();
      await expect.poll(async () => near((await translateOf(page, 'task-2')).y, rest.picker.y + GROWTH / 2)).toBe(true);
      const dropped = await translateOf(page, 'task-3');
      expect(near(dropped.x, held.x) && near(dropped.y, held.y)).toBe(true);
      // Never drawn back in its slot on the way: every place it was given is the drop's.
      const seen = await page.evaluate(() => (window as unknown as { __droppedTransforms: string[] }).__droppedTransforms);
      for (const transform of seen) {
        const place = parseTranslate(transform);
        expect(place, transform).not.toBeNull();
        expect(near(place!.x, held.x) && near(place!.y, held.y), transform).toBe(true);
      }
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

  test('arrow-key places still waiting when another workflow is picked are saved to the workflow they were made on', async () => {
    // Picking another workflow selects it in the store, which empties the canvas
    // and unmounts it; the unmount is what saves the places waiting for the keys
    // to rest. That save used to address the workflow now selected, so the moved
    // card kept no place and the other workflow's card with the same key got one.
    // The page's clock is paused before the keys go down, so the 400ms rest can
    // never be what saves them: only the unmount can.
    const { browser, page } = await launch('two-drafts', { fakeClock: true });
    try {
      await expect(byTestId(page, 'workflow-picker')).toContainText('Theme tokens');
      // Paused BEFORE the click, not after. The workflow agent's terminal takes
      // focus from a requestAnimationFrame it queues when it arrives, and that
      // frame is the page clock's: pausing is what fires any still queued, and
      // a clock that stays paused fires none later. Paused after the click, a
      // starved runner still had one queued, so the pause itself handed focus to
      // the terminal after the click had given it to the card, and the arrow key
      // went to xterm (12 of 12 runs at 12x CPU throttle).
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await card(page, 'task-3').click();
      await expect(card(page, 'task-3')).toHaveAttribute('data-selected', 'true');
      // The arrow key goes to the focused element, and React Flow moves a card
      // only from its own node: assert the click left focus there.
      await expect(node(page, 'task-3')).toBeFocused();

      const placedKeys = (workflowId: string) => page.evaluate(async ({ projectId, id }) => {
        const detail = await window.electronAPI.workflows.get(projectId, id);
        return detail.tasks.filter((task) => task.canvasX !== null && task.canvasY !== null).map((task) => task.key);
      }, { projectId: PROJECT_ID, id: workflowId });

      const beforeMove = await translateOf(page, 'task-3');
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => translateOf(page, 'task-3')).not.toEqual(beforeMove);
      // The card moved and nothing is saved: the rest timer is paused with the clock.
      expect(await placedKeys('wf-draft')).toEqual([]);

      await byTestId(page, 'workflow-picker').click();
      await page.locator('[data-testid="workflow-picker-option"][data-workflow-id="wf-other"]').click();
      await expect(byTestId(page, 'workflow-picker')).toContainText('Relay notes');

      // The place the keys made lands on the workflow it was made on...
      await expect.poll(() => placedKeys('wf-draft'), { timeout: 5_000 }).toEqual(['task-3']);
      // ...and the workflow picked in the meantime is left as it was.
      expect(await placedKeys('wf-other')).toEqual([]);
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
      await expect(node(page, 'task-3').locator('.workflow-node')).toHaveCSS('outline-color', await computedColor(page, 'var(--color-accent)'));
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
      const refusal = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't save the layout" });
      await expect(refusal).toBeVisible();
      await expect(refusal.getByTestId('toast-title')).toHaveText("Couldn't save the layout");
      await expect(refusal.getByTestId('toast-body')).toHaveText('That workflow is no longer in this project.');

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
