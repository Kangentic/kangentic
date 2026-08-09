/**
 * UI tests for the window drag FREE-MOVE BUDGET.
 *
 * Background:
 * Every dock reads the POINTER - screen docks from the cursor reaching an overlay
 * edge (`snap.ts`), window docks from the pane under the cursor (`drop-zone.ts`).
 * Within a pane, priority bands resolve the side with no positional dead zone,
 * deliberately: a dead zone reintroduces the left <-> top/bottom flip-flopping the
 * bands were introduced to fix.
 *
 * With no dead zone, grabbing a header that happens to sit over another window
 * means the dock condition is already true at pointer-down, and the smallest move
 * docked. The fix is a travel budget (`FREE_MOVE_RADIUS_PX` in `dnd/drop-zone.ts`):
 * a WINDOW dock arms only once the drag has displaced the pointer past it.
 *
 * The budget is deliberately NOT applied to SCREEN docks (half / maximize). Those
 * key off the pointer reaching an overlay edge, which is self-committing and always
 * reachable. Layering the budget over them made maximize impossible for a window
 * already near the top - only a few dozen px of upward pointer room exist there,
 * less than the budget. The first two tests below are that boundary.
 *
 * `dnd/drop-zone.test.ts` and `window-manager.test.ts` pin the pure math; these
 * tests are the only end-to-end coverage that a real pointer drag behaves the same
 * way, since nothing else in the suite drives a title-bar drag.
 *
 * Assertions are on window-store state, never on pixels or the preview element,
 * so headless Linux and local Windows agree (`.claude/rules/cross-platform-parity.md`).
 *
 * Tier: UI (headless Chromium). Pure renderer state; no PTY, no real IPC.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';
import { FREE_MOVE_RADIUS_PX } from '../../src/renderer/window-manager/dnd/drop-zone';
import { SCREEN_DOCK_EDGE_PX } from '../../src/renderer/window-manager/dnd/snap';

// Each test drives the windows to a terminal layout, so a shared page would leak
// a tile tree into the next test.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-free-move-${RUN_ID}`;
const DRAGGED_TASK_ID = `task-free-move-dragged-${RUN_ID}`;
const TARGET_TASK_ID = `task-free-move-target-${RUN_ID}`;

/** A wide viewport, so two 45%-wide panes clear the 650px min-pane floor. */
const VIEWPORT = { width: 1920, height: 1080 };

/** Overlapping start geometry. Docking reads the POINTER, so what has to overlap is
 *  the dragged window's TITLE BAR (where the cursor grabs) and the target's rect -
 *  that is the state where the dock condition is already true at pointer-down. The
 *  title bar's center sits at x ~0.275, y ~0.06, inside the target on both axes. */
const DRAGGED_GEOMETRY = { x: 0.05, y: 0.05, w: 0.45, h: 0.6 };
const TARGET_GEOMETRY = { x: 0.2, y: 0, w: 0.45, h: 0.6 }; // spans x .20-.65, y 0-.6

/** A pointer offset just inside the `SCREEN_DOCK_EDGE_PX` (6px) armed band - close
 *  enough to an overlay edge to trigger a screen dock. Self-documents against the
 *  same constant the detector arms on, instead of an unexplained magic number.
 *  Floored at 1px rather than a plain subtraction, so a future retune of
 *  `SCREEN_DOCK_EDGE_PX` down to 4 or below can never produce a zero or negative
 *  inset (which would put the pointer AT or PAST the overlay edge, outside the
 *  band it is meant to test). */
const WITHIN_DOCK_BAND_PX = Math.max(1, SCREEN_DOCK_EDGE_PX - 4);

interface WindowSnapshot {
  draggedWindowId: string;
  draggedState: string;
  targetState: string;
  hasTileTree: boolean;
}

async function launchWithTwoTasks(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Free Move Test ${RUN_ID}',
        path: '/mock/free-move-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var todoLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-fm-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'To Do') todoLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      [
        { id: '${DRAGGED_TASK_ID}', title: 'Dragged Window ${RUN_ID}', position: 0 },
        { id: '${TARGET_TASK_ID}', title: 'Target Window ${RUN_ID}', position: 1 },
      ].forEach(function (task) {
        state.tasks.push({
          id: task.id,
          title: task.title,
          description: 'Free-move budget fixture',
          swimlane_id: todoLaneId,
          position: task.position,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          labels: [],
          priority: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/**
 * Open both detail windows and place them in the overlapping start layout.
 * `setDetailTaskId` is the shared entry point every card click funnels into, and
 * it is needed for the second window because the first covers the board.
 */
async function openTwoOverlappingWindows(page: Page): Promise<string> {
  const card = page.locator(`[data-task-id="${DRAGGED_TASK_ID}"]`);
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();
  await page.evaluate((taskId) => {
    (window as unknown as {
      __zustandStores: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
    }).__zustandStores.session.getState().setDetailTaskId(taskId);
  }, TARGET_TASK_ID);
  await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(2, { timeout: 10000 });

  return page.evaluate(
    ({ draggedTaskId, targetTaskId, draggedGeometry, targetGeometry }) => {
      const store = (window as unknown as {
        __zustandStores: {
          window: {
            getState: () => {
              windows: Record<string, { id: string; kind: string; anchor: string }>;
              setGeometry: (id: string, geometry: { x: number; y: number; w: number; h: number }) => void;
              focusWindow: (id: string) => void;
            };
          };
        };
      }).__zustandStores.window.getState();
      // A task-detail window's durable `anchor` IS its task id.
      const byTask = (taskId: string) =>
        Object.values(store.windows).find(
          (managed) => managed.kind === 'task-detail' && managed.anchor === taskId,
        );
      const dragged = byTask(draggedTaskId);
      const target = byTask(targetTaskId);
      if (!dragged || !target) throw new Error('both task-detail windows must be open');
      store.setGeometry(target.id, targetGeometry);
      store.setGeometry(dragged.id, draggedGeometry);
      // The dragged window must be front-most, or the target's frame swallows the
      // pointer-down on its title bar.
      store.focusWindow(dragged.id);
      return dragged.id;
    },
    {
      draggedTaskId: DRAGGED_TASK_ID,
      targetTaskId: TARGET_TASK_ID,
      draggedGeometry: DRAGGED_GEOMETRY,
      targetGeometry: TARGET_GEOMETRY,
    },
  );
}

async function snapshotWindows(page: Page, draggedWindowId: string): Promise<WindowSnapshot> {
  return page.evaluate(
    ({ windowId, targetTaskId }) => {
      const store = (window as unknown as {
        __zustandStores: {
          window: {
            getState: () => {
              windows: Record<string, { id: string; kind: string; anchor: string; state: string }>;
              tileTree: unknown;
            };
          };
        };
      }).__zustandStores.window.getState();
      const target = Object.values(store.windows).find(
        (managed) => managed.kind === 'task-detail' && managed.anchor === targetTaskId,
      );
      return {
        draggedWindowId: windowId,
        draggedState: store.windows[windowId]?.state ?? 'gone',
        targetState: target?.state ?? 'gone',
        hasTileTree: store.tileTree !== null,
      };
    },
    { windowId: draggedWindowId, targetTaskId: TARGET_TASK_ID },
  );
}

/** Close the target window, for the tests that want only one window in play. */
async function closeTargetWindow(page: Page) {
  await page.evaluate((targetTaskId) => {
    const store = (window as unknown as {
      __zustandStores: {
        window: {
          getState: () => {
            windows: Record<string, { id: string; kind: string; anchor: string }>;
            closeWindow: (id: string) => void;
          };
        };
      };
    }).__zustandStores.window.getState();
    const target = Object.values(store.windows).find(
      (managed) => managed.kind === 'task-detail' && managed.anchor === targetTaskId,
    );
    if (target) store.closeWindow(target.id);
  }, TARGET_TASK_ID);
}

async function setGeometry(
  page: Page,
  windowId: string,
  geometry: { x: number; y: number; w: number; h: number },
) {
  await page.evaluate(({ id, rect }) => {
    const store = (window as unknown as {
      __zustandStores: {
        window: {
          getState: () => {
            setGeometry: (id: string, geometry: { x: number; y: number; w: number; h: number }) => void;
            focusWindow: (id: string) => void;
          };
        };
      };
    }).__zustandStores.window.getState();
    store.setGeometry(id, rect);
    store.focusWindow(id);
  }, { id: windowId, rect: geometry });
}

/**
 * Poll a locator's `boundingBox()` until two consecutive reads are identical.
 *
 * A freshly opened task-detail window plays a ~200ms transform-based entrance
 * animation (`.overlay-content-in` -> `dialog-content-in`,
 * `scale(0.96) translateY(8px)` -> none - `useOverlayPhase({ variant: 'dialog' })`
 * in `WindowFrame.tsx`; these windows are freshly opened, not workspace-restored,
 * so `skipEnterAnimation` is unset and the animation runs). `boundingBox()` does
 * NOT wait for animation stability the way Playwright's actionability checks do,
 * and every drag helper below drives raw `page.mouse` events, which bypass
 * actionability entirely - so a grab point computed mid-animation can land off
 * the title bar and the drag never starts. Settling here, once, covers every
 * caller instead of each one racing the animation on its own.
 */
async function waitForStableBoundingBox(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let previousBox: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        const isStable =
          box !== null &&
          box.width > 0 &&
          previousBox !== null &&
          box.x === previousBox.x &&
          box.y === previousBox.y &&
          box.width === previousBox.width &&
          box.height === previousBox.height;
        previousBox = box;
        return isStable;
      },
      { timeout: 5000, intervals: [30, 30, 50, 50, 100, 150, 200] },
    )
    .toBe(true);
  if (!previousBox) throw new Error('the dragged window has no laid-out title bar');
  return previousBox;
}

/** Drag the window's title bar until the POINTER lands at a viewport point derived
 *  from the live overlay box. Screen docks read the pointer, so the assertions have
 *  to steer the pointer rather than the window. */
async function dragTitleBarToOverlayPoint(
  page: Page,
  windowId: string,
  pointFor: (overlay: { left: number; top: number; width: number; height: number }) => { x: number; y: number },
) {
  const overlay = await page.evaluate((id) => {
    const frame = document.querySelector(`[data-testid="window-frame-${id}"]`) as HTMLElement;
    const box = (frame.parentElement as HTMLElement).getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }, windowId);
  const destination = pointFor(overlay);
  const titleBar = page.locator(`[data-testid="window-frame-${windowId}"] [data-testid="task-detail-titlebar"]`);
  const box = await waitForStableBoundingBox(titleBar);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 14 });
  await page.mouse.up();
}

/** A window's committed fractional geometry, for asserting a cancel put it back
 *  exactly where it started (store state, not measured pixels). */
async function windowRect(page: Page, windowId: string) {
  return page.evaluate((id) => {
    const store = (window as unknown as {
      __zustandStores: {
        window: { getState: () => { windows: Record<string, { geometry: { x: number; y: number; w: number; h: number } }> } };
      };
    }).__zustandStores.window.getState();
    return store.windows[id]?.geometry ?? null;
  }, windowId);
}

/** The windowId of the tile tree's FIRST leaf in document order, so a test can
 *  assert which side a dock landed on without re-measuring pixels. */
async function firstLeafWindowId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    interface Node { kind: string; windowId?: string; children?: Node[] }
    const tree = (window as unknown as {
      __zustandStores: { window: { getState: () => { tileTree: Node | null } } };
    }).__zustandStores.window.getState().tileTree;
    const firstLeaf = (node: Node | null): string | null => {
      if (!node) return null;
      if (node.kind === 'leaf') return node.windowId ?? null;
      return firstLeaf(node.children?.[0] ?? null);
    };
    return firstLeaf(tree);
  });
}

/** Whether the point the drag will grab actually sits over the target window's
 *  rect. The nudge test is vacuous unless it does, so it asserts this rather than
 *  trusting the fixture geometry to stay overlapping. */
async function grabPointIsOverTarget(page: Page, windowId: string): Promise<boolean> {
  const titleBar = page.locator(`[data-testid="window-frame-${windowId}"] [data-testid="task-detail-titlebar"]`);
  const box = await waitForStableBoundingBox(titleBar);
  return page.evaluate(
    ({ point, targetTaskId }) => {
      const store = (window as unknown as {
        __zustandStores: {
          window: { getState: () => { windows: Record<string, { id: string; kind: string; anchor: string }> } };
        };
      }).__zustandStores.window.getState();
      const target = Object.values(store.windows).find(
        (managed) => managed.kind === 'task-detail' && managed.anchor === targetTaskId,
      );
      if (!target) return false;
      const rect = document.querySelector(`[data-testid="window-frame-${target.id}"]`)?.getBoundingClientRect();
      if (!rect) return false;
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    },
    { point: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, targetTaskId: TARGET_TASK_ID },
  );
}

/** Press on the dragged window's title bar and move by a pixel delta, in steps so
 *  the hook sees real intermediate `pointermove`s, then release. */
async function dragTitleBarBy(page: Page, windowId: string, deltaX: number, deltaY: number) {
  const titleBar = page.locator(`[data-testid="window-frame-${windowId}"] [data-testid="task-detail-titlebar"]`);
  const box = await waitForStableBoundingBox(titleBar);
  // Grab a blank stretch of the bar, well clear of the leading and trailing
  // control clusters (`isInteractiveTarget` refuses a drag from a control).
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 12 });
  await page.mouse.up();
}

test('a nudge over an overlapping window repositions it instead of docking', async () => {
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);
    // The grab point starts OVER the target, so position alone would dock: the
    // budget is the only thing keeping this a move.
    expect((await snapshotWindows(page, draggedWindowId)).draggedState).toBe('floating');
    expect(await grabPointIsOverTarget(page, draggedWindowId)).toBe(true);

    // Comfortably inside the budget, on both axes.
    const nudge = Math.round(FREE_MOVE_RADIUS_PX * 0.4);
    await dragTitleBarBy(page, draggedWindowId, nudge, nudge);

    await expect
      .poll(async () => await snapshotWindows(page, draggedWindowId), { timeout: 5000 })
      .toMatchObject({ draggedState: 'floating', targetState: 'floating', hasTileTree: false });
  } finally {
    await browser.close();
  }
});

test('maximize is reachable for a window already at the top of the overlay', async () => {
  // The regression this exists for: a travel budget was briefly layered over the
  // screen docks too. A window already near the top has only a few dozen px of
  // upward pointer room before the cursor hits the screen, which is less than the
  // budget - so maximize became physically impossible in exactly the position a
  // user is in when they want it. Screen docks key off the pointer instead.
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);
    await closeTargetWindow(page);
    // Park it flush against the top, the state that made maximize unreachable.
    await setGeometry(page, draggedWindowId, { x: 0.25, y: 0, w: 0.5, h: 0.6 });

    await dragTitleBarToOverlayPoint(page, draggedWindowId, (overlay) => ({
      x: overlay.left + overlay.width / 2,
      y: overlay.top + WITHIN_DOCK_BAND_PX,
    }));
    await expect
      .poll(async () => (await snapshotWindows(page, draggedWindowId)).draggedState, { timeout: 5000 })
      .toBe('maximized');
  } finally {
    await browser.close();
  }
});

test('a screen dock arms at the overlay edge, not before it', async () => {
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);
    await closeTargetWindow(page);
    await setGeometry(page, draggedWindowId, { x: 0.25, y: 0.2, w: 0.5, h: 0.6 });

    // Pointer well short of the right edge: no dock, however far the window's own
    // right edge has gone past the boundary.
    await dragTitleBarToOverlayPoint(page, draggedWindowId, (overlay) => ({
      x: overlay.left + overlay.width - 120,
      y: overlay.top + overlay.height / 2,
    }));
    await expect
      .poll(async () => (await snapshotWindows(page, draggedWindowId)).draggedState, { timeout: 5000 })
      .toBe('floating');

    // Re-establish a controlled starting rect: the first drag committed a
    // clamped plain move (it asserted 'floating', not a dock), so without this
    // the second drag would start from wherever that landed instead of a known
    // position.
    await setGeometry(page, draggedWindowId, { x: 0.25, y: 0.2, w: 0.5, h: 0.6 });

    // Pointer buried in the right edge: docks right.
    await dragTitleBarToOverlayPoint(page, draggedWindowId, (overlay) => ({
      x: overlay.left + overlay.width - WITHIN_DOCK_BAND_PX,
      y: overlay.top + overlay.height / 2,
    }));
    await expect
      .poll(async () => (await snapshotWindows(page, draggedWindowId)).draggedState, { timeout: 5000 })
      .toBe('snapped');
  } finally {
    await browser.close();
  }
});

test('a screen dock at the bottom edge snaps to the bottom half, never a tile pair', async () => {
  // Nothing else in the suite drives a drag to the BOTTOM overlay edge, so
  // `useWindowDrag.ts`'s `finishDrag` branch for `snapEdge === 'bottom'` - which
  // routes to `snapWindow`, not `dockWindow` (a bottom half has no opposite
  // HORIZONTAL half to seam with) - has no coverage. `dockWindow`'s own
  // partner-less fallback resolves an edge that is not `'left'` through the
  // RIGHT half, so a misroute through it would still leave `state === 'snapped'`
  // and no tile tree - the geometry assertion below is what actually catches it.
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);
    await closeTargetWindow(page);
    await setGeometry(page, draggedWindowId, { x: 0.25, y: 0.2, w: 0.5, h: 0.4 });

    await dragTitleBarToOverlayPoint(page, draggedWindowId, (overlay) => ({
      x: overlay.left + overlay.width / 2,
      y: overlay.top + overlay.height - WITHIN_DOCK_BAND_PX,
    }));

    await expect
      .poll(async () => await snapshotWindows(page, draggedWindowId), { timeout: 5000 })
      .toMatchObject({ draggedState: 'snapped', hasTileTree: false });
    expect(await windowRect(page, draggedWindowId)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  } finally {
    await browser.close();
  }
});

test('Escape mid-drag cancels the drag and does NOT close the window', async () => {
  // The focused window closes itself on a bubble-phase document Escape, and
  // nothing used to make that drag-aware: a mid-drag Escape closed the user's task
  // window instead of cancelling the gesture. It is also the always-available way
  // to decline a dock.
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);
    const before = await windowRect(page, draggedWindowId);

    const titleBar = page.locator(`[data-testid="window-frame-${draggedWindowId}"] [data-testid="task-detail-titlebar"]`);
    const box = await waitForStableBoundingBox(titleBar);
    // Press, drag well past the budget and onto the other window so a dock is
    // armed, then Escape before releasing.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + FREE_MOVE_RADIUS_PX * 2, box.y + box.height / 2 + 150, { steps: 12 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    // Still open, still floating, still where it started, and nothing tiled.
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(2);
    await expect
      .poll(async () => await snapshotWindows(page, draggedWindowId), { timeout: 5000 })
      .toMatchObject({ draggedState: 'floating', hasTileTree: false });
    expect(await windowRect(page, draggedWindowId)).toEqual(before);

    // The other direction: the drag listener is a GLOBAL capture-phase Escape, so
    // it must not swallow Escape when no drag is in flight. Escape still closes.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

test('a deliberate drag onto another window still docks', async () => {
  const { browser, page } = await launchWithTwoTasks();
  try {
    const draggedWindowId = await openTwoOverlappingWindows(page);

    // POINT the cursor into the target's LEFT third, well clear of the overlay's
    // own edges so this exercises the window dock and not a screen dock. The side
    // the bands resolve is then unambiguous, and the travel is far past the budget.
    await dragTitleBarToOverlayPoint(page, draggedWindowId, (overlay) => ({
      x: overlay.left + (TARGET_GEOMETRY.x + TARGET_GEOMETRY.w * 0.12) * overlay.width,
      y: overlay.top + (TARGET_GEOMETRY.y + TARGET_GEOMETRY.h * 0.5) * overlay.height,
    }));

    await expect
      .poll(async () => await snapshotWindows(page, draggedWindowId), { timeout: 5000 })
      .toMatchObject({ draggedState: 'tiled', targetState: 'tiled', hasTileTree: true });
    // The cursor was in the target's left third, so the dragged window is the LEFT
    // child of a horizontal split.
    expect(await firstLeafWindowId(page)).toBe(draggedWindowId);
  } finally {
    await browser.close();
  }
});
