/**
 * Regression test for the "card snaps back to origin before disappearing" bug
 * and the single coordinated drop motion.
 *
 * Root cause: <DragOverlay> had no `dropAnimation` prop, so dnd-kit ran its
 * default 250ms drop animation, tweening the overlay clone back to the source
 * draggable's rect. That clone (our `.drag-overlay` subtree) stayed mounted for
 * ~250ms and competed with the separate `FlyingCard` flying toward Done - the
 * user saw the card animate back to its original column, then vanish.
 *
 * The fix sets `dropAnimation={null}`, so the overlay detaches synchronously on
 * release and `FlyingCard` is the only element in motion. The fly itself was
 * also rewritten to animate compositor-friendly transform + opacity (never
 * left/top or `all`, no shrink-to-scale(0.01)).
 *
 * This spec drags a task to Done and, at the instant the fly flips into its
 * flying transform, snapshots the DOM atomically: exactly one `.flying-card`
 * and zero `.drag-overlay` clones coexist (no snap-back), and the fly's inline
 * style uses transform/opacity rather than `all` or layout properties.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-no-snapback';
const TASK_ID = 'task-done-no-snapback';
const TASK_ID_2 = 'task-done-no-snapback-2';

async function launch(
  opts: { reducedMotion?: 'reduce' | 'no-preference' } = {},
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: opts.reducedMotion,
  });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'No Snapback Test',
        path: '/mock/no-snapback-test',
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
      [
        { id: '${TASK_ID}', title: 'No Snapback', position: 0 },
        { id: '${TASK_ID_2}', title: 'Second Drop', position: 1 },
      ].forEach(function (t) {
        state.tasks.push({
          id: t.id,
          title: t.title,
          description: 'Dragged to Done',
          swimlane_id: laneIds['Executing'],
          position: t.position,
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
  // 10px shift satisfies dnd-kit's PointerSensor activation distance; poll the
  // board store's `activeTask` rather than the `.drag-overlay` element.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Wait for DoneSwimlane's `.drop-zone-active` (dnd-kit isOver) so the drop
  // fires only once the hover state has registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
}

interface BoardSettleState {
  completingTask: boolean;
  completingTaskIdCount: number;
  archivedIds: string[];
}

async function readBoardSettleState(page: Page): Promise<BoardSettleState> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            completingTask: unknown;
            completingTaskIds: Set<string>;
            archivedTasks: Array<{ id: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      completingTask: state.completingTask !== null && state.completingTask !== undefined,
      completingTaskIdCount: state.completingTaskIds.size,
      archivedIds: state.archivedTasks.map((task) => task.id),
    };
  });
}

interface FlySnapshot {
  flyingCount: number;
  overlayCount: number;
  transform: string;
  transition: string;
}

test.describe('Move to Done - single coordinated drop (no snap-back)', () => {
  test('flying card is the only element in motion; no overlay clone competes', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('[data-swimlane-name="Executing"]').locator('text=No Snapback')).toBeVisible();

      await dragTaskToColumn(page, 'No Snapback', 'Done');

      // The fly mounts (flying=false) then, after 2 rAF, flips into its flying
      // transform. Capture the DOM atomically at the flip moment and stash it on
      // window so the later read doesn't race the fly's ~500ms unmount.
      await expect.poll(async () => page.evaluate(() => {
        const fly = document.querySelector('.flying-card') as HTMLElement | null;
        if (!fly || !fly.style.transform.includes('scale(0.6)')) return false;
        (window as unknown as { __flySnapshot: unknown }).__flySnapshot = {
          flyingCount: document.querySelectorAll('.flying-card').length,
          overlayCount: document.querySelectorAll('.drag-overlay').length,
          transform: fly.style.transform,
          transition: fly.style.transition,
        };
        return true;
      }), { timeout: 3000 }).toBe(true);

      const snapshot = await page.evaluate(
        () => (window as unknown as { __flySnapshot: FlySnapshot }).__flySnapshot,
      );

      // Exactly one element in motion: the fly. With dropAnimation={null} the
      // dnd-kit overlay clone (.drag-overlay) detaches synchronously on release,
      // so it never coexists with the fly. Under the old default drop animation
      // it would persist ~250ms and overlayCount would be >= 1 here.
      expect(snapshot.flyingCount).toBe(1);
      expect(snapshot.overlayCount).toBe(0);

      // Compositor-friendly motion: transform + opacity only, never left/top/all,
      // and no shrink-to-nothing scale(0.01).
      expect(snapshot.transform).toContain('translate3d');
      expect(snapshot.transform).toContain('scale(0.6)');
      expect(snapshot.transition).toContain('transform');
      expect(snapshot.transition).toContain('opacity');
      expect(snapshot.transition).not.toContain('all');

      // The drop resolves: the fly unmounts, the completion guard releases, and
      // the task lands in the archived list.
      await expect.poll(async () => {
        const state = await readBoardSettleState(page);
        return state.completingTask === false
          && state.completingTaskIdCount === 0
          && state.archivedIds.includes(TASK_ID);
      }, { timeout: 3000 }).toBe(true);
      await expect(page.locator('.flying-card')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('prefers-reduced-motion collapses the fly to an in-place fade (no transform)', async () => {
    const { browser, page } = await launch({ reducedMotion: 'reduce' });

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('[data-swimlane-name="Executing"]').locator('text=No Snapback')).toBeVisible();

      await dragTaskToColumn(page, 'No Snapback', 'Done');

      // Under reduced motion the fly is an opacity-only fade in place - no
      // translate3d/scale transform. The transition string is on the static
      // style, so capture as soon as the fly mounts; stash on window so the
      // read doesn't race the ~150ms fade's unmount.
      await expect.poll(async () => page.evaluate(() => {
        const fly = document.querySelector('.flying-card') as HTMLElement | null;
        if (!fly) return false;
        (window as unknown as { __reducedSnapshot: unknown }).__reducedSnapshot = {
          transform: fly.style.transform,
          transition: fly.style.transition,
        };
        return true;
      }), { timeout: 3000 }).toBe(true);

      const snapshot = await page.evaluate(
        () => (window as unknown as { __reducedSnapshot: { transform: string; transition: string } }).__reducedSnapshot,
      );
      expect(snapshot.transition).toContain('opacity');
      expect(snapshot.transition).not.toContain('transform');
      expect(snapshot.transform).toBe('');

      // The fade still finalizes (onTransitionEnd fires on opacity) and archives.
      await expect.poll(async () => {
        const state = await readBoardSettleState(page);
        return state.completingTask === false
          && state.completingTaskIdCount === 0
          && state.archivedIds.includes(TASK_ID);
      }, { timeout: 3000 }).toBe(true);
      await expect(page.locator('.flying-card')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a second consecutive completion still flies visibly (flying state does not leak)', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // First completion - archives task 1.
      await dragTaskToColumn(page, 'No Snapback', 'Done');
      await expect.poll(async () => {
        const state = await readBoardSettleState(page);
        return state.completingTask === false
          && state.completingTaskIdCount === 0
          && state.archivedIds.includes(TASK_ID);
      }, { timeout: 3000 }).toBe(true);
      await expect(page.locator('.flying-card')).toHaveCount(0);

      // Sample the fly's peak opacity during the SECOND completion via rAF. With
      // the leaked-flying-state bug the second card mounted at the first fly's end
      // frame (opacity 0) and flew invisibly; per-completion remount restores the
      // visible start frame (opacity 0.85 fading to 0).
      await page.evaluate(() => {
        const win = window as unknown as { __maxFlyOpacity: number; __flyRaf: number };
        win.__maxFlyOpacity = 0;
        const sample = () => {
          const fly = document.querySelector('.flying-card');
          if (fly) {
            const opacity = parseFloat(getComputedStyle(fly).opacity);
            if (!Number.isNaN(opacity) && opacity > win.__maxFlyOpacity) win.__maxFlyOpacity = opacity;
          }
          win.__flyRaf = requestAnimationFrame(sample);
        };
        sample();
      });

      // Second completion - archives task 2.
      await dragTaskToColumn(page, 'Second Drop', 'Done');
      await expect.poll(async () => {
        const state = await readBoardSettleState(page);
        return state.completingTask === false
          && state.completingTaskIdCount === 0
          && state.archivedIds.includes(TASK_ID_2);
      }, { timeout: 3000 }).toBe(true);

      const maxOpacity = await page.evaluate(() => {
        const win = window as unknown as { __maxFlyOpacity: number; __flyRaf: number };
        cancelAnimationFrame(win.__flyRaf);
        return win.__maxFlyOpacity;
      });
      // A visible fly peaks near 0.85; the leaked-state regression keeps it <= ~0.05.
      expect(maxOpacity).toBeGreaterThan(0.5);
    } finally {
      await browser.close();
    }
  });
});
