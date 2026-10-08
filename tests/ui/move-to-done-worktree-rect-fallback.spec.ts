/**
 * Regression test: Done animation survives a null dnd-kit rect when a
 * worktree exists and checkPendingChanges fires.
 *
 * The original bug (v0.19.0): in useBoardDragDrop.handleDragEnd, when
 * `active.rect.current.initial` was null (cleared by structural-sharing
 * re-renders triggered mid-drag by a checkPendingChanges IPC round-trip),
 * the code bypassed setCompletingTask entirely and called moveTask directly.
 * Both the FlyingCard fly-into-dropzone animation and the grow-in intro were
 * silently skipped even though the move still landed.
 *
 * The fix: dragStartRectRef snapshots getBoundingClientRect() in handleDragStart
 * and is used as a fallback when dnd-kit's initial rect is null. The direct-
 * bypass branch now only fires when BOTH sources are unavailable.
 *
 * This spec covers the gap left by move-to-done-animations.spec.ts, which
 * uses worktree_path: null. With no worktree, checkPendingChanges is never
 * called, so the structural-sharing reshuffle that cleared dnd-kit's rect
 * (the original trigger) cannot happen. This spec uses worktree_path: non-null
 * so the IPC round-trip does fire, matching the real failure mode.
 *
 * Test strategy:
 *   - Task has worktree_path so checkPendingChanges IS called
 *   - checkPendingChanges returns clean (hasPendingChanges: false) so the
 *     animated path fires without a dialog (clean drops never show the dialog)
 *   - A Zustand subscriber installed before the drag records whether
 *     setCompletingTask was ever called (completingTaskSetCount > 0) and
 *     whether recentlyArchivedId reached the dragged task's id
 *   - Both must be true; if the rect-bypass path is active, setCompletingTask
 *     is never called and completingTaskSetCount stays at 0
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-wt-rect-fallback';
const TASK_ID = 'task-done-wt-rect-fallback';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // checkPendingChanges returns clean (hasPendingChanges: false) so the
  // animated path fires without a dialog - clean drops never show the dialog.
  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Worktree Rect Fallback Test',
        path: '/mock/wt-rect-fallback-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-wt-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Worktree Animate Me',
        description: 'Task with a worktree - checkPendingChanges will fire',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/wt/animate-me',
        branch_name: 'animate-me-abcd1234',
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

interface AnimationProbeReadout {
  completingTaskSetCount: number;
  lastRecentlyArchivedId: string | null;
  seenRecentlyArchivedIds: string[];
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
    (window as unknown as { __animationProbeWt: typeof probe }).__animationProbeWt = probe;
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

async function readAnimationProbe(page: Page): Promise<AnimationProbeReadout> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __animationProbeWt?: AnimationProbeReadout }).__animationProbeWt;
    if (!probe) throw new Error('__animationProbeWt was not installed');
    return {
      completingTaskSetCount: probe.completingTaskSetCount,
      lastRecentlyArchivedId: probe.lastRecentlyArchivedId,
      seenRecentlyArchivedIds: [...probe.seenRecentlyArchivedIds],
    };
  });
}

/**
 * Drag a task card to a named column using the robust pattern from
 * move-to-done-confirm.spec.ts: polls the board store's activeTask instead of
 * relying on fixed waits, and polls the drop-zone-active class before releasing
 * the mouse so the drop registers after the hover state is confirmed.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col: string) => {
    document.querySelector(`[data-swimlane-name="${col}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush - scroll geometry is accurate without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // The 10px shift + steps satisfies dnd-kit's PointerSensor activation distance.
  // Poll the store's activeTask instead of guessing with a sleep.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // DoneSwimlane toggles the `drop-zone-active` class via dnd-kit's isOver.
  // Poll for it so the drop fires only after the hover state is registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Drop outcome is asserted by the caller via the animation probe.
}

test.describe('Move to Done - worktree-path rect fallback', () => {
  test('setCompletingTask fires when worktree_path is non-null and the probe returns clean', async () => {
    // This test covers the most representative failure mode of the original bug.
    // With worktree_path set, checkPendingChanges is called concurrently with
    // setCompletingTask (which fires synchronously on drop). The probe causes a
    // structural-sharing re-render mid-drag that could clear dnd-kit's initial rect.
    // The fix (dragStartRectRef snapshot) ensures setCompletingTask is still
    // called even when active.rect.current.initial is null at drop time.
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator('[data-swimlane-name="Executing"]').locator('text=Worktree Animate Me'),
      ).toBeVisible();

      await installAnimationProbe(page);

      await dragTaskToColumn(page, 'Worktree Animate Me', 'Done');

      // The FlyingCard fallback is 700ms, plus moveTask IPC + reload. 3s is
      // generous for a mocked IPC.
      await expect
        .poll(async () => (await readAnimationProbe(page)).lastRecentlyArchivedId, { timeout: 3000 })
        .toBe(TASK_ID);

      const probe = await readAnimationProbe(page);
      // setCompletingTask was actually called (proves the animated entry path
      // was used, not the rect-bypass path that skips it).
      expect(probe.completingTaskSetCount).toBeGreaterThanOrEqual(1);
      // recentlyArchivedId reached the dragged task's id (proves
      // finalizeCompletion ran the success path that drives .grow-in).
      expect(probe.seenRecentlyArchivedIds).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  test('the probe always fires for worktree tasks', async () => {
    // Guards against a regression where the worktree probe is short-circuited
    // before calling checkPendingChanges. If the IPC never fires, dirty
    // worktrees cannot be detected and the safety net is silently removed.
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // Install a spy before the drag so we can verify the IPC was called.
      await page.evaluate(() => {
        (window as unknown as { __checkPendingChangesCalledWt: boolean }).__checkPendingChangesCalledWt = false;
        const original = (window as unknown as {
          electronAPI: { git: { checkPendingChanges: (...args: unknown[]) => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }> } };
        }).electronAPI.git.checkPendingChanges;
        (window as unknown as {
          electronAPI: { git: { checkPendingChanges: (...args: unknown[]) => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }> } };
        }).electronAPI.git.checkPendingChanges = async function (...args) {
          (window as unknown as { __checkPendingChangesCalledWt: boolean }).__checkPendingChangesCalledWt = true;
          return original.apply(this, args as []);
        };
      });

      await dragTaskToColumn(page, 'Worktree Animate Me', 'Done');

      // No dialog because the probe returns clean (hasPendingChanges: false).
      // (intentional fixed wait - we cannot poll for non-occurrence)
      await page.waitForTimeout(1000);
      await expect(page.locator('text=Move to Done?')).toBeHidden();

      // The IPC probe MUST have fired despite the skip flag.
      const wasCalled = await page.evaluate(() => {
        return (window as unknown as { __checkPendingChangesCalledWt: boolean }).__checkPendingChangesCalledWt;
      });
      expect(wasCalled).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
