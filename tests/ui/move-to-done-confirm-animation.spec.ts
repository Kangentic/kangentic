/**
 * Regression test: the animated fly path runs after the worktree-delete confirm
 * dialog is confirmed (approveCompletion unlocks the gate set by the drop).
 *
 * Gap covered: the existing move-to-done-confirm.spec.ts only checks dialog
 * appearance/disappearance; it does NOT assert that setCompletingTask was
 * called before the dialog opened (the card is already in-flight) and that
 * approveCompletion releases the persistence gate. This spec guards two things:
 *   1. The card is already mounted (completingTaskSetCount >= 1) before the
 *      user clicks Move - the FlyingCard mounts on drop, not on confirm.
 *   2. The task is NOT archived until after the user confirms - the persistence
 *      gate must hold while the dialog is open (dirty probe path).
 *
 * Test strategy:
 *   - Task has worktree_path non-null (so checkPendingChanges fires)
 *   - window.__mockPendingChangesResult forces hasPendingChanges: true so the
 *     confirm dialog always opens (dirty probes always require confirmation)
 *   - A Zustand subscriber records completingTaskSetCount and recentlyArchivedId
 *   - The test drags to Done, asserts the dialog is open AND the task is not yet
 *     archived (gate held), clicks Move, then polls for archive completion
 *
 * Red-green reasoning:
 *   If approveCompletion did NOT release the gate (e.g. the handler was swapped
 *   to a no-op), the task would never appear in archivedTasks and the final
 *   expect.poll would time out. The persistence-gate assertion would fail if
 *   the task was archived before the dialog was confirmed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { clickPastDragSwallow, waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-confirm-anim';
const TASK_ID = 'task-done-confirm-anim';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // __mockPendingChangesResult forces hasPendingChanges: true so the confirm
  // dialog always opens - dirty probes always require confirmation.
  const preConfigScript = `
    window.__mockPendingChangesResult = {
      hasPendingChanges: true,
      uncommittedFileCount: 1,
      unpushedCommitCount: 0,
    };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Confirm Animation Test',
        path: '/mock/done-confirm-anim-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-ca-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Confirm Then Fly',
        description: 'Worktree task with pending changes - dialog then animated fly',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/wt/confirm-then-fly',
        branch_name: 'confirm-then-fly-abcd1234',
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
  await page.goto(VITE_URL);
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
    (window as unknown as { __animationProbeConfirmAnim: typeof probe }).__animationProbeConfirmAnim = probe;
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
    const probe = (window as unknown as { __animationProbeConfirmAnim?: AnimationProbeReadout }).__animationProbeConfirmAnim;
    if (!probe) throw new Error('__animationProbeConfirmAnim was not installed');
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

  await page.evaluate((targetCol: string) => {
    document.querySelector(`[data-swimlane-name="${targetCol}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush; post-scroll geometry is accurate
  // without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // The 10px shift + steps satisfies dnd-kit's PointerSensor activation
  // distance; poll the board store's activeTask instead of guessing with a sleep.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // DoneSwimlane toggles `.drop-zone-active` via dnd-kit's isOver. Poll for it
  // so the drop fires only after the hover state is registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Drop outcome (dialog appearance) is asserted by the caller.
}

test.describe('Move to Done - confirm dialog animated path', () => {
  test('clicking Move after the confirm dialog releases the gate and archives the task', async () => {
    // Under the new model: on drop, setCompletingTask fires synchronously
    // (FlyingCard mounts, card removed from tasks). The probe runs concurrently.
    // Because the probe returns dirty, a "Move to Done?" dialog opens WHILE the
    // FlyingCard is already mid-flight. The persistence gate holds (the task is
    // NOT archived while the dialog is open). Clicking Move calls approveCompletion
    // which releases the gate, finalizeCompletion runs moveTask, the task archives.
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator('[data-swimlane-name="Executing"]').locator('text=Confirm Then Fly'),
      ).toBeVisible();

      await installAnimationProbe(page);

      await dragTaskToColumn(page, 'Confirm Then Fly', 'Done');

      // The confirm dialog MUST open because __mockPendingChangesResult returns
      // hasPendingChanges: true (dirty probes always require confirmation).
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=1 uncommitted file will be lost')).toBeVisible();

      // FlyingCard mounts on DROP (before confirm), so completingTaskSetCount
      // must already be >= 1 while the dialog is still open.
      const probeDuringDialog = await readAnimationProbe(page);
      expect(probeDuringDialog.completingTaskSetCount).toBeGreaterThanOrEqual(1);

      // PERSISTENCE GATE: the task must NOT be archived while the dialog is
      // open - the gate must hold until the user confirms.
      const isArchivedBeforeConfirm = await page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID);
      expect(isArchivedBeforeConfirm).toBe(false);

      // Click the Move/confirm button to release the gate. The click comes
      // straight off a dnd-kit drop, so it has to survive a swallowed first
      // click; the assertion below is still what decides the test.
      await clickPastDragSwallow(
        page.locator('button:has-text("Move")').first(),
        page.locator('text=Move to Done?'),
      );

      // Dialog must close immediately.
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 3000 });

      // Poll for recentlyArchivedId reaching the task id. The FlyingCard
      // fallback is 700ms, plus moveTask IPC round-trip. 5s is generous for
      // a mocked IPC.
      await expect
        .poll(async () => (await readAnimationProbe(page)).lastRecentlyArchivedId, { timeout: 5000 })
        .toBe(TASK_ID);

      const probe = await readAnimationProbe(page);
      // recentlyArchivedId reached the task id, proving finalizeCompletion ran
      // the success path that sets recentlyArchivedId (drives .grow-in).
      expect(probe.seenRecentlyArchivedIds).toContain(TASK_ID);

      // The task must also be in archivedTasks (final persistence check).
      const isArchived = await page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID);
      expect(isArchived).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
