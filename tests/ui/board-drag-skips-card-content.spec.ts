import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { waitForViteReady, gotoVite } from './helpers';

/**
 * A board drag re-renders every card's ROOT, never its content.
 *
 * dnd-kit's `useSortable` reads its context, and a drag start changes that
 * context in several commits (the active card, its measured rect, every
 * droppable's rect, the overlay), then again each time the drag's target
 * changes. Each of those re-renders every card on the board, and `React.memo`
 * on `TaskCard` cannot stop it. `TaskCard` hands React its content as one
 * memoized element, so all of those renders stop at the card's root.
 *
 * The probe is the activity mark: `ActivityMark` anchors its spin in a layout
 * effect that runs on every render and calls `getAnimations()`. Counting those
 * calls on lane cards counts content renders. The first test proves the probe
 * sees a real one, so the drag's zero cannot pass vacuously.
 */

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-card-content';
const RUNNING_CARDS = 6;
const DRAG_TASK_ID = 'task-card-content-drag';

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Card Content', path: '/mock/card-content',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push({
          id: 'lane-content-' + index, name: swimlane.name, role: swimlane.role, color: swimlane.color,
          icon: swimlane.icon, is_archived: swimlane.is_archived,
          permission_strategy: swimlane.permission_strategy ?? null,
          auto_spawn: false, position: index, created_at: ts,
        });
      });
      var todoLane = state.swimlanes.find(function (swimlane) { return swimlane.role === 'todo'; });
      var executingLane = state.swimlanes.find(function (swimlane) { return swimlane.name === 'Executing'; });
      function task(id, title, laneId, position, sessionId) {
        return {
          id: id, title: title, description: '', swimlane_id: laneId, position: position, agent: 'claude',
          model_override: null, effort_override: null, session_id: sessionId,
          worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
          base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
        };
      }
      for (var index = 0; index < ${RUNNING_CARDS}; index++) {
        var sessionId = 'sess-card-content-' + index;
        state.sessions.push({
          id: sessionId, taskId: 'task-card-content-' + index, projectId: '${PROJECT_ID}', pid: 9000 + index,
          status: 'running', shell: 'bash', cwd: '/mock/card-content', startedAt: ts, exitCode: null,
        });
        state.activityCache[sessionId] = 'thinking';
        state.tasks.push(task('task-card-content-' + index, 'Running card ' + index, executingLane.id, index, sessionId));
      }
      state.tasks.push(task('${DRAG_TASK_ID}', 'Card to drag', todoLane.id, 0, null));
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  // Motion on, whatever the machine prefers: a reduced-motion mark is static
  // and has no spin for the probe to see.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference' });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-swimlane-name="Executing"] [data-mark="agent-working"] .kng-spin'))
    .toHaveCount(RUNNING_CARDS, { timeout: 15000 });

  // Count every `getAnimations()` on an element inside a lane card: one per
  // render of that card's activity mark.
  await page.evaluate(() => {
    const probeWindow = window as unknown as { __cardMarkRenders: number };
    probeWindow.__cardMarkRenders = 0;
    const original = Element.prototype.getAnimations;
    Element.prototype.getAnimations = function countedGetAnimations(this: Element, options?: GetAnimationsOptions) {
      if (this.closest('[data-swimlane-task-list] > [data-task-id]')) probeWindow.__cardMarkRenders += 1;
      return original.call(this, options);
    };
  });
});

test.afterAll(async () => {
  await browser?.close();
});

async function resetCount(): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __cardMarkRenders: number }).__cardMarkRenders = 0; });
}

async function readCount(): Promise<number> {
  return page.evaluate(() => (window as unknown as { __cardMarkRenders: number }).__cardMarkRenders);
}

async function frames(count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

interface SessionStoreHandle {
  getState: () => { activeSessionId: string | null };
  setState: (partial: { activeSessionId: string | null }) => void;
}

async function setActiveSession(sessionId: string | null): Promise<string | null> {
  return page.evaluate((nextSessionId) => {
    const sessionStore = (window as unknown as { __zustandStores: { session: SessionStoreHandle } }).__zustandStores.session;
    const previousSessionId = sessionStore.getState().activeSessionId;
    sessionStore.setState({ activeSessionId: nextSessionId });
    return previousSessionId;
  }, sessionId);
}

test('the probe counts a card whose content does change', async () => {
  await resetCount();
  // The highlighted card follows the active session (the bottom panel picks
  // one at load), so moving it to the last card is a real change to the view
  // of two cards.
  const previousSessionId = await setActiveSession(`sess-card-content-${RUNNING_CARDS - 1}`);
  expect(previousSessionId).not.toBe(`sess-card-content-${RUNNING_CARDS - 1}`);
  await expect.poll(readCount, { timeout: 3000 }).toBeGreaterThan(0);

  await setActiveSession(previousSessionId);
  await frames(4);
  // At rest nothing re-renders a card, so the count holds still.
  await resetCount();
  await frames(10);
  expect(await readCount()).toBe(0);
});

test('a drag start and a change of target re-render no card content', async () => {
  const card = page.locator(`[data-task-id="${DRAG_TASK_ID}"]`);
  const cardBox = await card.boundingBox();
  const executingBox = await page.locator('[data-swimlane-name="Executing"] [data-swimlane-task-list]').boundingBox();
  if (!cardBox || !executingBox) throw new Error('board not laid out');
  expect(executingBox.width).toBeGreaterThan(0);

  await resetCount();
  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay')).toBeVisible({ timeout: 3000 });
  // Past the drag start's measuring commits, still over To Do.
  await frames(10);
  expect(await readCount()).toBe(0);

  // Into Executing, below its cards: the drag's target changes, which is
  // another context change that reaches every card.
  const targetX = executingBox.x + executingBox.width / 2;
  const targetY = executingBox.y + executingBox.height - 40;
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await expect(page.locator('[data-swimlane-name="Executing"].drop-highlight')).toHaveCount(1, { timeout: 3000 });
  await frames(10);
  expect(await readCount()).toBe(0);

  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.drag-overlay')).toHaveCount(0, { timeout: 3000 });
});
