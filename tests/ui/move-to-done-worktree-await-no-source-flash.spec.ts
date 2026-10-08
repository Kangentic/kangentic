/**
 * Regression test for the "card flashes back to its source column" bug on a
 * WORKTREE-backed task dropped on Done.
 *
 * Distinct from move-to-done-reload-no-source-flash.spec.ts (a racing
 * loadBoard()): here the flash comes from the git probe window. On drop,
 * setCompletingTask fires SYNCHRONOUSLY (the FlyingCard mounts immediately),
 * while checkPendingChanges runs CONCURRENTLY. The card is removed from
 * state.tasks at the same tick via addCompletingTaskId, so the source lane
 * never shows it again. This spec seeds a worktree task, slows the mock git
 * probe so the concurrent window is wide (400ms), drags to Done, and asserts
 * the source-lane card never returns to full opacity once the drag has begun.
 * Without the synchronous hide the card would sit at opacity 1 during the probe
 * window (red); with it the card is filtered out the same commit (green).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-await-flash';
const TASK_ID = 'task-await-flash';
const SOURCE_COLUMN = 'Executing';
const TASK_TITLE = 'Await Flash Probe';
// Wide enough that the await window spans many frames; the rAF sampler cannot
// miss it.
const PROBE_DELAY_MS = 400;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    // Slow the git probe so the concurrent window is observable (clean result,
    // so no dialog appears - the card flies without interruption).
    window.__mockCheckPendingChangesDelayMs = ${PROBE_DELAY_MS};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Await Flash Test',
        path: '/mock/await-flash-test',
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
        title: '${TASK_TITLE}',
        description: 'Worktree-backed task dragged to Done',
        swimlane_id: laneIds['${SOURCE_COLUMN}'],
        position: 0,
        agent: 'claude',
        session_id: null,
        // A worktree_path is what makes handleDragEnd await checkPendingChanges.
        worktree_path: '/mock/wt/await-flash',
        branch_name: 'await-flash',
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

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col: string) => {
    document.querySelector(`[data-swimlane-name="${col}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
}

test.describe('Move to Done - no source-column flash on a worktree task (git-probe await)', () => {
  test('the source card never returns to full opacity during the checkPendingChanges await', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible();

      // Sample the source-lane card's opacity every frame, but only once the
      // drag has actually started (an overlay clone exists). Before the drag the
      // card is legitimately at opacity 1; during the drag dnd-kit dims it to
      // 0.4; the bug is it snapping back to 1 in the source lane after release,
      // while the git probe is still awaiting. The overlay/flying clones share
      // the data-task-id but live outside the lane, so scoping to the lane
      // isolates the real source card.
      await page.evaluate((args: { column: string; taskId: string }) => {
        const win = window as unknown as {
          __awaitFlash: { dragStarted: boolean; maxOpAfterDrag: number };
          __awaitRaf: number;
        };
        win.__awaitFlash = { dragStarted: false, maxOpAfterDrag: 0 };
        const tick = () => {
          if (document.querySelector('.drag-overlay')) win.__awaitFlash.dragStarted = true;
          if (win.__awaitFlash.dragStarted) {
            const lane = document.querySelector(`[data-swimlane-name="${args.column}"]`);
            const card = lane ? lane.querySelector(`[data-task-id="${args.taskId}"]`) : null;
            if (card) {
              const op = parseFloat(getComputedStyle(card).opacity);
              if (!Number.isNaN(op) && op > win.__awaitFlash.maxOpAfterDrag) {
                win.__awaitFlash.maxOpAfterDrag = op;
              }
            }
          }
          win.__awaitRaf = requestAnimationFrame(tick);
        };
        tick();
      }, { column: SOURCE_COLUMN, taskId: TASK_ID });

      await dragTaskToColumn(page, TASK_TITLE, 'Done');

      // Let the probe await resolve and the completion settle (task archived).
      await expect.poll(async () => page.evaluate((taskId: string) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { archivedTasks: Array<{ id: string }> } } };
        }).__zustandStores;
        return !!stores?.board.getState().archivedTasks.some((task) => task.id === taskId);
      }, TASK_ID), { timeout: 5000 }).toBe(true);

      const maxOpAfterDrag = await page.evaluate(() => {
        const win = window as unknown as {
          __awaitFlash: { maxOpAfterDrag: number };
          __awaitRaf: number;
        };
        cancelAnimationFrame(win.__awaitRaf);
        return win.__awaitFlash.maxOpAfterDrag;
      });

      // During the drag the card is dimmed to 0.4; it must never return to a
      // near-full opacity in its source lane. Without the synchronous hide it
      // sits at 1.0 for the whole ~400ms probe window.
      expect(maxOpAfterDrag).toBeLessThan(0.9);

      await expect(
        page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
