/**
 * Regression test for the "Done transition silently bypassed" bug.
 *
 * The Done drop has two animations: the FlyingCard fly-into-dropzone and
 * the grow-in intro on the new Completed card. Both are driven by the
 * board store - FlyingCard renders while `completingTask` is non-null,
 * and grow-in renders while `recentlyArchivedId` matches the card. If
 * `handleDragEnd` ever skips `setCompletingTask` and calls `moveTask`
 * directly (the rect-bypass path), the move still succeeds but neither
 * value ever transitions to a non-null state, so both animations
 * silently disappear.
 *
 * This spec installs a Zustand subscriber before the drag and asserts
 * the entry path was taken: `completingTask` was set at least once, and
 * `recentlyArchivedId` reached the dragged task's id. The existing
 * `move-to-done-archives.spec.ts` only checks final state and would
 * still pass if both animations got skipped.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-animations';
const TASK_ID = 'task-done-animations';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Animations Test',
        path: '/mock/done-animations-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Animate Me',
        description: 'Dragged to Done',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

async function installAnimationProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          subscribe: (listener: (state: unknown) => void) => () => void;
          getState: () => {
            completingTask: unknown;
            recentlyArchivedId: string | null;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const probe = {
      completingTaskSetCount: 0,
      lastRecentlyArchivedId: null as string | null,
      seenRecentlyArchivedIds: [] as string[],
    };
    (window as unknown as { __animationProbe: typeof probe }).__animationProbe = probe;
    stores.board.subscribe((state) => {
      const typed = state as { completingTask: unknown; recentlyArchivedId: string | null };
      if (typed.completingTask !== null && typed.completingTask !== undefined) {
        probe.completingTaskSetCount += 1;
      }
      if (typed.recentlyArchivedId) {
        probe.lastRecentlyArchivedId = typed.recentlyArchivedId;
        if (!probe.seenRecentlyArchivedIds.includes(typed.recentlyArchivedId)) {
          probe.seenRecentlyArchivedIds.push(typed.recentlyArchivedId);
        }
      }
    });
  });
}

interface AnimationProbeReadout {
  completingTaskSetCount: number;
  lastRecentlyArchivedId: string | null;
  seenRecentlyArchivedIds: string[];
}

async function readAnimationProbe(page: Page): Promise<AnimationProbeReadout> {
  return page.evaluate(() => {
    // The `AnimationProbeReadout` reference in this cast is purely for the
    // outer TypeScript compiler's benefit at call sites - inside this
    // evaluate() callback the interface is erased at runtime, so what
    // actually runs in the browser is `window.__animationProbe`.
    const probe = (window as unknown as { __animationProbe?: AnimationProbeReadout }).__animationProbe;
    if (!probe) throw new Error('__animationProbe was not installed');
    return {
      completingTaskSetCount: probe.completingTaskSetCount,
      lastRecentlyArchivedId: probe.lastRecentlyArchivedId,
      seenRecentlyArchivedIds: [...probe.seenRecentlyArchivedIds],
    };
  });
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col: string) => {
    document.querySelector(`[data-swimlane-name="${col}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush, so the post-scroll geometry is
  // accurate without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 10px shift + steps satisfies dnd-kit's PointerSensor activation
  // distance; poll the board store's `activeTask` instead of relying on
  // the `.drag-overlay` element, which can detach before dnd-kit has
  // fully settled the drop state on slow VMs.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Done is the target. DoneSwimlane toggles `.drop-zone-active` via
  // dnd-kit's isOver - wait for it so the drop fires only once the hover
  // state has actually registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
}

test.describe('Move to Done - animation entry path', () => {
  test('completingTask is set and recentlyArchivedId fires for the dragged task', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('[data-swimlane-name="Executing"]').locator('text=Animate Me')).toBeVisible();

      await installAnimationProbe(page);

      await dragTaskToColumn(page, 'Animate Me', 'Done');

      // The FlyingCard fallback is 700ms, plus moveTask IPC + reload. 3s is
      // generous for a mocked IPC.
      await expect
        .poll(async () => (await readAnimationProbe(page)).lastRecentlyArchivedId, { timeout: 3000 })
        .toBe(TASK_ID);

      const probe = await readAnimationProbe(page);
      // setCompletingTask was actually called (proves the animation entry
      // path was used, not the rect-bypass path that skips it).
      expect(probe.completingTaskSetCount).toBeGreaterThanOrEqual(1);
      // recentlyArchivedId reached the dragged task's id (proves
      // finalizeCompletion ran the success path that drives `.grow-in`).
      expect(probe.seenRecentlyArchivedIds).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });
});
