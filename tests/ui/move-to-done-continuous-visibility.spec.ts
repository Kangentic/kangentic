/**
 * Regression test: the overlay-to-FlyingCard handoff is gapless.
 *
 * Under the pre-fix model, setCompletingTask was called AFTER the git probe
 * resolved, meaning there was a ~130ms window after mouse.up() where the
 * drag overlay had detached but the FlyingCard had not yet mounted. During
 * that window the task was invisible - a blank frame visible to the user.
 *
 * The fix calls setCompletingTask synchronously on drop (before the probe),
 * so the FlyingCard mounts in the same commit as the overlay detaches. The
 * handoff is a same-frame swap: there must be zero frames where neither
 * .drag-overlay nor .flying-card is present after the overlay first appeared.
 *
 * Two assertions:
 *   1. Continuous visibility: a per-frame rAF sampler detects zero blank frames
 *      between the overlay appearing and the FlyingCard completing.
 *   2. Persistence gate: tasks.move is NOT called before the probe resolves
 *      (event ordering, not wall-clock) and the task eventually archives after
 *      the probe + fly settle.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-cont-vis';
const TASK_ID = 'task-done-cont-vis';
const TASK_TITLE = 'Continuous Visibility Task';
const SOURCE_COLUMN = 'Executing';
// Wide probe delay so the concurrent window is observable across many frames.
const PROBE_DELAY_MS = 400;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Clean probe result (no dialog) + artificially delayed so the concurrent
  // window is wide enough for the rAF sampler to catch any blank frame.
  const preConfigScript = `
    window.__mockCheckPendingChangesDelayMs = ${PROBE_DELAY_MS};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Continuous Visibility Test',
        path: '/mock/cont-vis-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-cv-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
        description: 'Worktree task - overlay/FlyingCard handoff must be gapless',
        swimlane_id: laneIds['${SOURCE_COLUMN}'],
        position: 0,
        agent: 'claude',
        session_id: null,
        // worktree_path triggers the git probe path.
        worktree_path: '/mock/wt/cont-vis',
        branch_name: 'cont-vis-abcd1234',
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
  // The 10px shift satisfies dnd-kit's PointerSensor activation distance;
  // poll the board store's activeTask rather than the .drag-overlay element.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // DoneSwimlane toggles .drop-zone-active via dnd-kit's isOver; poll for it
  // so the drop fires only after the hover state has registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Caller asserts drop outcome.
}

test.describe('Move to Done - continuous overlay/FlyingCard visibility', () => {
  test('no blank frames between drag-overlay detach and FlyingCard mount', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible();

      // Install the rAF-based visibility sampler BEFORE the drag. The sampler:
      //   - Waits until the .drag-overlay has appeared at least once (overlaySeenOnce).
      //   - After that, counts frames where NEITHER .drag-overlay NOR .flying-card
      //     is present (blank frames). These are the regression frames.
      //   - Stops counting once a .flying-card has appeared and then disappeared
      //     (flyingSettled), which marks end of the completion sequence.
      await page.evaluate(() => {
        const tracker = {
          overlaySeenOnce: false,
          flyingSeenOnce: false,
          flyingSettled: false,
          blankFrameCount: 0,
        };
        (window as unknown as { __visibilityTracker: typeof tracker }).__visibilityTracker = tracker;

        const tick = () => {
          if (tracker.flyingSettled) return; // stop sampling after settle

          const hasOverlay = !!document.querySelector('.drag-overlay');
          const hasFly = !!document.querySelector('.flying-card');

          if (hasOverlay) tracker.overlaySeenOnce = true;
          if (hasFly) tracker.flyingSeenOnce = true;

          // Once the fly has been seen and is now gone, the sequence is done.
          if (tracker.flyingSeenOnce && !hasFly) {
            tracker.flyingSettled = true;
            return;
          }

          // Count blank frames only AFTER the overlay first appeared.
          if (tracker.overlaySeenOnce && !hasOverlay && !hasFly) {
            tracker.blankFrameCount++;
          }

          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      // Instrument the probe and move IPC to verify ordering.
      // probeResolved flag: set when checkPendingChanges promise resolves.
      // moveCalledBeforeProbe flag: set on the first tasks.move call if the
      // probe has not yet resolved - proves the gate is held.
      await page.evaluate(() => {
        const win = window as unknown as {
          __probeResolved: boolean;
          __moveCalledBeforeProbe: boolean | null;
          electronAPI: {
            git: {
              checkPendingChanges: (...args: unknown[]) => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }>;
            };
            tasks: {
              move: (input: unknown) => Promise<unknown>;
            };
          };
        };
        win.__probeResolved = false;
        win.__moveCalledBeforeProbe = null;

        // Wrap checkPendingChanges to set __probeResolved when it resolves.
        const originalProbe = win.electronAPI.git.checkPendingChanges.bind(win.electronAPI.git);
        win.electronAPI.git.checkPendingChanges = async function (...args) {
          const result = await originalProbe(...args);
          win.__probeResolved = true;
          return result;
        };

        // Wrap tasks.move to record whether probe had resolved on first call.
        const originalMove = win.electronAPI.tasks.move.bind(win.electronAPI.tasks);
        let moveCalled = false;
        win.electronAPI.tasks.move = async function (input: unknown) {
          if (!moveCalled) {
            moveCalled = true;
            win.__moveCalledBeforeProbe = !win.__probeResolved;
          }
          return originalMove(input);
        };
      });

      await dragTaskToColumn(page, TASK_TITLE, 'Done');

      // Wait for the sequence to settle: FlyingCard appeared and is now gone,
      // the task is archived.
      await expect.poll(async () => page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID), { timeout: 5000 }).toBe(true);

      // --- Assertion 1: zero blank frames ---
      // The overlay/FlyingCard handoff must be same-commit. Any blank frame
      // indicates the pre-fix regression where setCompletingTask was deferred
      // until after the probe resolved (leaving a ~130ms gap).
      const blankFrameCount = await page.evaluate(() => {
        const tracker = (window as unknown as { __visibilityTracker: { blankFrameCount: number } }).__visibilityTracker;
        return tracker.blankFrameCount;
      });
      expect(blankFrameCount).toBe(0);

      // --- Assertion 2: persistence gate ---
      // tasks.move must NOT have been called before the probe resolved.
      // Nothing is archived until BOTH the fly finishes AND the probe returns
      // clean (or the user confirms dirty). This is an event-ordering assertion,
      // not a wall-clock budget.
      const moveCalledBeforeProbe = await page.evaluate(
        () => (window as unknown as { __moveCalledBeforeProbe: boolean | null }).__moveCalledBeforeProbe,
      );
      // moveCalledBeforeProbe should be false (probe resolved before move was called).
      expect(moveCalledBeforeProbe).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
