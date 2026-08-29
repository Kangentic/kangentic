/**
 * UI tests for the draggable vertical divider between the terminal pane and
 * the right-hand panel (Changes or Browser) inside the Task Detail dialog.
 *
 * Feature:
 *   - A divider element (`[data-testid="task-detail-split-divider"]`) renders
 *     between the terminal and a right panel when both a session is active and
 *     a panel (Changes or Browser) is open in split mode.
 *   - Dragging the divider changes the terminal pane's flex-basis percentage,
 *     clamped to [25%, 75%].
 *   - The chosen ratio is persisted in the session store and survives dialog
 *     close/reopen for the same task.
 *   - One shared ratio per task: switching between Changes and Browser views
 *     keeps the same divider position.
 *
 * Note on the Browser pane: in headless Chromium the <webview> element is
 * inserted into the DOM as an unknown element, but Electron-specific methods
 * (loadURL, getURL, executeJavaScript, etc.) do not exist on it. The Browser
 * toggle pill can be clicked to flip `browserOpen`, which is enough to assert
 * that the divider appears/disappears. Interaction tests that would call
 * loadURL are out of scope at the UI tier; they belong in E2E tests.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-split-divider';
const TASK_ID = 'task-split-divider';
const SESSION_ID = 'sess-split-divider';

/**
 * Pre-configuration script injected via addInitScript before React mounts.
 * Creates a project with a single task that has a running session in the
 * Code Review lane (not To Do / Done), so:
 *   - canShowChanges = true (!isArchived && !isInTodo && !isInDone)
 *   - canShowBrowser = true (running session, browser not disabled)
 *   - displayKind = 'running' -> TaskDetailBody renders the active-session branch
 *     with the terminal, which is the only branch that shows the divider.
 */
const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Split Divider Test',
      path: '/mock/split-divider-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-sd-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // A running session so displayKind === 'running' inside the dialog,
    // which is required for the active-session branch of TaskDetailBody to
    // render the split container and the divider element.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/split-divider-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Split Divider Task',
      description: 'Task used for the split-divider tests',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/split-divider',
      branch_name: 'feature/split-divider',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Open the task detail dialog for the split-divider task. */
async function openTaskDialog(page: Page): Promise<void> {
  const card = page
    .locator('[data-swimlane-name="Code Review"]')
    .locator('text=Split Divider Task')
    .first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
}

/** Close the task detail dialog via keyboard (document-level dispatch, safe inside xterm). */
async function closeTaskDialog(page: Page): Promise<void> {
  // Discard the Browser pane first. The fixture's task has a RUNNING session,
  // so closing the window with the pane mounted (showing OR hidden-and-held
  // after a pill toggle, on its empty state OR a page) would PARK it (hidden in
  // place so its guest survives for the agent) rather than remove it, and an
  // opacity-0 frame never reads as hidden to Playwright. The pill would only
  // HOLD the pane, so the discard is an agent's close_pane push, the one path
  // that unmounts it. Idempotent when no pane is mounted.
  await page.evaluate(({ projectId, taskId }) => {
    window.__mockBrowser?.emitPaneCloseRequest(projectId, [taskId]);
  }, { projectId: PROJECT_ID, taskId: TASK_ID });
  await expect(page.locator('[data-testid="browser-pane"], [data-testid="browser-empty-state"]')).toHaveCount(0, { timeout: 3000 });
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
}

/**
 * Read the terminal pane's inline flex-basis style percentage as a number.
 * Returns NaN if the element has no inline flex-basis (panel is not open).
 *
 * The terminal pane is the first sibling before the divider element, which is
 * the first sibling before the right panel in the split container.
 */
async function getTerminalPaneFlexBasisPercent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const divider = document.querySelector('[data-testid="task-detail-split-divider"]');
    if (!divider) return NaN;
    const terminalPane = divider.previousElementSibling as HTMLElement | null;
    if (!terminalPane) return NaN;
    const basis = terminalPane.style.flexBasis;
    if (!basis || !basis.endsWith('%')) return NaN;
    return parseFloat(basis);
  });
}

/**
 * Read the persisted divider ratio for the task from the Zustand session store.
 * Returns null when the store is not yet available (Vite DEV mode required).
 */
async function getStoredDividerRatio(page: Page, taskId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: { getState: () => { dividerRatio: Record<string, number> } };
      };
    }).__zustandStores;
    if (!stores) return null;
    const ratio = stores.session.getState().dividerRatio[id];
    return ratio !== undefined ? ratio : null;
  }, taskId);
}

/**
 * Set the divider ratio for a task via the Zustand session store.
 *
 * This drives the hook's re-sync path (the useEffect that reads storedRatio
 * and calls setRatio when isResizing is false). Calling this before a drag
 * guarantees a known flex-basis starting point, making drag-direction
 * assertions immune to whatever ratio a prior test left behind.
 *
 * The dialog must be open and the Changes panel visible before calling this,
 * otherwise the hook is not mounted and the flex-basis won't update.
 */
async function setStoredDividerRatioAndWait(page: Page, taskId: string, ratio: number): Promise<void> {
  await page.evaluate(
    ([id, value]: [string, number]) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: {
            getState: () => {
              setDividerRatio: (taskId: string, ratio: number) => void;
            };
          };
        };
      }).__zustandStores;
      if (!stores) throw new Error('__zustandStores not available');
      stores.session.getState().setDividerRatio(id, value);
    },
    [taskId, ratio] as [string, number],
  );
  // Wait for the hook's useEffect to flush the store update into local state
  // and for the DOM flex-basis to reflect the new ratio.
  await expect.poll(
    async () => getTerminalPaneFlexBasisPercent(page),
    { timeout: 3000 },
  ).toBeCloseTo(ratio * 100, 0);
}

// ---------------------------------------------------------------------------
// Suite 1: Divider presence
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: presence', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('divider is absent when no right panel is open', async () => {
    await openTaskDialog(page);

    // No panel open: divider must not be in the DOM.
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).not.toBeVisible();

    await closeTaskDialog(page);
  });

  test('divider appears when Changes panel is opened in split mode', async () => {
    await openTaskDialog(page);

    const changesPill = page.locator('[data-testid="changes-toggle"]');
    await expect(changesPill).toBeVisible();
    await changesPill.click();

    // Split mode is the default on first open; the divider must now be visible.
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).toBeVisible();

    await closeTaskDialog(page);
  });

  test('divider disappears when Changes panel is closed', async () => {
    await openTaskDialog(page);

    // Changes panel is already open from the previous test (store persists).
    // Confirm it is open by checking the controls visible in split mode.
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await expect(divider).toBeVisible();

    // Close the Changes panel (the pill now owns close).
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(divider).not.toBeVisible();

    await closeTaskDialog(page);
  });

  test('divider is absent in Changes expanded mode', async () => {
    await openTaskDialog(page);

    // Reopen Changes panel.
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).toBeVisible();

    // Expand to full-width mode.
    await page.locator('[data-testid="changes-expand"]').click();
    // Expanded mode hides the terminal entirely, so the divider must not show.
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).not.toBeVisible();

    // Collapse back to split: divider reappears.
    await page.locator('[data-testid="changes-collapse"]').click();
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).toBeVisible();

    // Close Changes panel to leave clean state for the next suite.
    await page.locator('[data-testid="changes-toggle"]').click();

    await closeTaskDialog(page);
  });

  test('divider appears when Browser pane is toggled open', async () => {
    await openTaskDialog(page);

    // Browser pane: toggle via the pill. canShowBrowser is true for a running
    // session in a non-Todo/non-Done column without browser.enabled=false override.
    const browserToggle = page.locator('[data-testid="browser-toggle"]');
    await expect(browserToggle).toBeVisible();
    await browserToggle.click();

    // Divider must be visible alongside the browser pane.
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).toBeVisible();

    // Toggle browser closed: divider disappears.
    await browserToggle.click();
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).not.toBeVisible();

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Drag interaction
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: drag to resize', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('dragging the divider right increases the terminal pane flex-basis', async () => {
    await openTaskDialog(page);

    // Open the Changes panel so the divider is visible.
    await page.locator('[data-testid="changes-toggle"]').click();
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    // Establish a known starting ratio of 50% via the store so this test
    // is not affected by any ratio left over from a prior run or test.
    await setStoredDividerRatioAndWait(page, TASK_ID, 0.5);

    // Compute a target X position well to the right of the current divider
    // position (a large rightward delta so the effect is unambiguous).
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;

    // Drag 200px to the right. At a 1920-wide viewport, the divider starts at
    // ~960px; 200px right takes it to ~1160px, yielding ~60.4% which is within
    // [25%, 75%] and is unambiguously greater than 50%.
    const targetX = startX + 200;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 10 });
    await page.mouse.up();

    // After mouseup, the store is updated and the local ratio state syncs.
    // The terminal pane flex-basis must be larger than the known 50% start.
    await expect.poll(
      async () => getTerminalPaneFlexBasisPercent(page),
      { timeout: 3000 },
    ).toBeGreaterThan(50);

    await closeTaskDialog(page);
  });

  test('dragging the divider left decreases the terminal pane flex-basis', async () => {
    // Fully self-contained: opens the Changes panel itself and pre-sets the
    // divider ratio to a known 50% via the store before dragging. We start from
    // 50% (the default), the same position the drag-right and clamp tests use:
    // on headless Linux the mousedown/drag only engaged reliably from the 50%
    // divider position. This test is the mirror of "drag right increases".
    await openTaskDialog(page);

    // Open the Changes panel (may already be open if store persisted from the
    // previous test, but clicking the toggle when already open closes it, so
    // we check first via the divider visibility).
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    if (!(await divider.isVisible().catch(() => false))) {
      await page.locator('[data-testid="changes-toggle"]').click();
      await divider.waitFor({ state: 'visible', timeout: 3000 });
    }

    // Pre-set the ratio to 50% so we have a known, unambiguous starting point.
    await setStoredDividerRatioAndWait(page, TASK_ID, 0.5);

    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;

    // Move 200px to the left. From ~50% (~960px of 1920), this targets ~760px
    // which yields ~40% - clearly less than the 50% start, with ample margin.
    const targetX = startX - 200;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 10 });
    await page.mouse.up();

    // The terminal pane flex-basis must drop below the known 50% start.
    await expect.poll(
      async () => getTerminalPaneFlexBasisPercent(page),
      { timeout: 3000 },
    ).toBeLessThan(50);

    await closeTaskDialog(page);
  });

  test('ratio is clamped: dragging far left does not take terminal below 25%', async () => {
    // Fully self-contained: opens Changes panel explicitly and sets a known
    // starting ratio before dragging. Does not rely on previous test state.
    await openTaskDialog(page);

    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    if (!(await divider.isVisible().catch(() => false))) {
      await page.locator('[data-testid="changes-toggle"]').click();
      await divider.waitFor({ state: 'visible', timeout: 3000 });
    }

    // Pre-set to 50% for a clean, predictable starting position.
    await setStoredDividerRatioAndWait(page, TASK_ID, 0.5);

    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;

    // Drag to x=0 (far past the left edge) -- should clamp to 25%.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(0, startY, { steps: 15 });
    await page.mouse.up();

    await expect.poll(
      async () => getTerminalPaneFlexBasisPercent(page),
      { timeout: 3000 },
    ).toBeCloseTo(25, 0);

    await closeTaskDialog(page);
  });

  test('ratio is clamped: dragging far right does not take terminal above 75%', async () => {
    // Fully self-contained: opens Changes panel explicitly and sets a known
    // starting ratio before dragging. Does not rely on previous test state.
    await openTaskDialog(page);

    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    if (!(await divider.isVisible().catch(() => false))) {
      await page.locator('[data-testid="changes-toggle"]').click();
      await divider.waitFor({ state: 'visible', timeout: 3000 });
    }

    // Pre-set to 50% for a clean, predictable starting position.
    await setStoredDividerRatioAndWait(page, TASK_ID, 0.5);

    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;

    // Drag to x=9999 (far past the right edge) -- should clamp to 75%.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(9999, startY, { steps: 15 });
    await page.mouse.up();

    await expect.poll(
      async () => getTerminalPaneFlexBasisPercent(page),
      { timeout: 3000 },
    ).toBeCloseTo(75, 0);

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Persistence across dialog close/reopen
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: persistence', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('ratio persists in the session store after a drag', async () => {
    // Start: no stored ratio for this task (first launch).
    const initialStored = await getStoredDividerRatio(page, TASK_ID);
    expect(initialStored).toBeNull();

    await openTaskDialog(page);
    await page.locator('[data-testid="changes-toggle"]').click();
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    // Drag the divider 150px to the right.
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;
    const targetX = startX + 150;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 10 });
    await page.mouse.up();

    // Wait for the store to be updated.
    await expect.poll(
      async () => getStoredDividerRatio(page, TASK_ID),
      { timeout: 3000 },
    ).not.toBeNull();

    const storedRatioAfterDrag = await getStoredDividerRatio(page, TASK_ID);
    expect(storedRatioAfterDrag).not.toBeNull();
    // A right drag from 50% by 150px should yield a value above 50% (above 0.5).
    expect(storedRatioAfterDrag!).toBeGreaterThan(0.5);

    await closeTaskDialog(page);
  });

  test('reopened dialog shows the previously persisted ratio', async () => {
    // Read the ratio that was stored in the previous test.
    const storedRatio = await getStoredDividerRatio(page, TASK_ID);
    expect(storedRatio).not.toBeNull();

    // Reopen the dialog (same session store, same page).
    await openTaskDialog(page);

    // Changes panel should already be open (browserOpenTasks and changesOpenTasks
    // are also persisted in the store). If not, toggle it.
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    if (!(await divider.isVisible().catch(() => false))) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    // The flex-basis must reflect the previously stored ratio.
    const basisAfterReopen = await getTerminalPaneFlexBasisPercent(page);
    expect(basisAfterReopen).toBeCloseTo(storedRatio! * 100, 0);

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Shared ratio across Changes and Browser views
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: shared ratio across panel views', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('switching from Changes to Browser view keeps the same divider position', async () => {
    // Note: in headless Chromium the <webview> element exists in the DOM but
    // lacks Electron-specific methods. Clicking the Browser toggle to open it
    // does not navigate anywhere, which is sufficient for asserting the divider
    // position because we are only reading the terminal pane's flex-basis style.

    await openTaskDialog(page);

    // Open Changes panel and drag to a non-default position.
    await page.locator('[data-testid="changes-toggle"]').click();
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;
    // Drag 120px to the right.
    const targetX = startX + 120;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 10 });
    await page.mouse.up();

    await expect.poll(
      async () => getTerminalPaneFlexBasisPercent(page),
      { timeout: 3000 },
    ).toBeGreaterThan(50);

    const basisWithChanges = await getTerminalPaneFlexBasisPercent(page);

    // Close Changes and open Browser pane. Both panels toggle the SAME
    // dividerRatio key in the store, so the basis must not change.
    await page.locator('[data-testid="changes-toggle"]').click();
    await expect(divider).not.toBeVisible();

    const browserToggle = page.locator('[data-testid="browser-toggle"]');
    await expect(browserToggle).toBeVisible();
    await browserToggle.click();
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    const basisWithBrowser = await getTerminalPaneFlexBasisPercent(page);
    expect(basisWithBrowser).toBeCloseTo(basisWithChanges, 0);

    // Clean up: close Browser pane.
    await browserToggle.click();
    await expect(divider).not.toBeVisible();

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: isSplitResizing drag overlay
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: resize overlay visibility', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('resize overlay mounts during a drag and unmounts on mouseup', async () => {
    await openTaskDialog(page);

    // Open Changes panel so the divider is present.
    await page.locator('[data-testid="changes-toggle"]').click();
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    // Before dragging: the fixed inset-0 drag overlay must NOT be in the DOM.
    // The overlay is a sibling of the split container children; it is rendered
    // conditionally on `isSplitResizing` inside the active-session branch of
    // TaskDetailBody. We identify it by its unique combination of classes.
    // There is no data-testid on it intentionally (it is an implementation detail),
    // but `cursor-col-resize` combined with `fixed inset-0 z-50` is unique
    // enough to locate without ambiguity while the divider is visible.
    const resizeOverlay = page.locator('.fixed.inset-0.z-50.cursor-col-resize');
    await expect(resizeOverlay).not.toBeVisible();

    // Begin a drag: press down and move a few pixels to activate isSplitResizing.
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // A small initial move triggers the document mousemove listener and sets
    // isSplitResizing = true in the hook, which makes TaskDetailBody render the overlay.
    await page.mouse.move(startX + 5, startY, { steps: 2 });

    // Overlay must now be visible.
    await expect.poll(
      () => resizeOverlay.isVisible(),
      { timeout: 2000 },
    ).toBe(true);

    // Release the mouse: onMouseUp fires, setIsResizing(false), overlay unmounts.
    await page.mouse.up();

    await expect.poll(
      () => resizeOverlay.isVisible(),
      { timeout: 2000 },
    ).toBe(false);

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: terminal-panel-resize CustomEvent dispatch on mouseup
// ---------------------------------------------------------------------------

test.describe('Task Detail split divider: terminal-panel-resize event', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchWithState();
    browser = result.browser;
    page = result.page;
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('mouseup after a drag dispatches terminal-panel-resize on window', async () => {
    await openTaskDialog(page);

    // Open Changes panel so the divider is present.
    await page.locator('[data-testid="changes-toggle"]').click();
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    await divider.waitFor({ state: 'visible', timeout: 3000 });

    // Install a listener on the page that records whether the event fired.
    // The flag is written to window.__terminalPanelResizeCount so we can
    // read it back without any polling overhead.
    await page.evaluate(() => {
      (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount = 0;
      window.addEventListener('terminal-panel-resize', () => {
        (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount += 1;
      });
    });

    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;
    const targetX = startX + 100;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 10 });
    await page.mouse.up();

    // The event is dispatched via requestAnimationFrame inside onMouseUp, so
    // it fires asynchronously after the next animation frame. Poll until it
    // arrives (typically within one rAF tick, well under 100ms).
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount,
      ),
      { timeout: 2000 },
    ).toBeGreaterThanOrEqual(1);

    await closeTaskDialog(page);
  });

  /**
   * A SECOND dispatch site exists besides the drag above: `TaskDetailBody`'s own
   * `useLayoutEffect`, keyed on `rightPanelPresent` / `changesExpanded`, fires
   * whenever a right panel appears or leaves - opening/closing Changes or
   * Browser - so the terminal refits in the same frame instead of waiting out
   * the ResizeObserver's 200ms debounce. Nothing above exercises it: the drag
   * test only ever installs its listener AFTER Changes is already open.
   * Deleting the effect (or the `rightPanelPresent` half of its dependency
   * array) throws nothing and fails nothing else - the terminal would just sit
   * at its old width for ~300ms after the panel moves, which is exactly the
   * silent regression this closes. Verified red: this test fails when the
   * effect's dependency array is emptied. (The `changesExpanded` half is NOT
   * covered here - see the comment below the test for why.)
   */
  test('opening/closing a right panel dispatches terminal-panel-resize, not only a divider drag', async () => {
    await openTaskDialog(page);
    // `changesOpen` is a per-task boolean that survives a dialog close/reopen
    // (that persistence is Suite 3's own feature), so the prior test in this
    // shared-page describe block can leave Changes open. Start from a known
    // baseline rather than assuming one.
    const divider = page.locator('[data-testid="task-detail-split-divider"]');
    if (await divider.isVisible().catch(() => false)) {
      await page.locator('[data-testid="changes-toggle"]').click();
      await divider.waitFor({ state: 'hidden', timeout: 3000 });
    }
    await expect(page.locator('[data-testid="task-detail-split-divider"]')).toHaveCount(0);

    await page.evaluate(() => {
      (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount = 0;
      window.addEventListener('terminal-panel-resize', () => {
        (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount += 1;
      });
    });

    // rightPanelPresent false -> true.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.locator('[data-testid="task-detail-split-divider"]').waitFor({ state: 'visible', timeout: 3000 });
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount),
      { timeout: 2000 },
    ).toBeGreaterThanOrEqual(1);

    // rightPanelPresent true -> false.
    await page.evaluate(() => {
      (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount = 0;
    });
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.locator('[data-testid="task-detail-split-divider"]').waitFor({ state: 'hidden', timeout: 3000 });
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __terminalPanelResizeCount: number }).__terminalPanelResizeCount),
      { timeout: 2000 },
    ).toBeGreaterThanOrEqual(1);

    await closeTaskDialog(page);
  });

  // A `changesExpanded` (Changes going full-row) case was tried here too and
  // deliberately dropped: red-green showed it passes even with the
  // TaskDetailBody effect's dependency array broken, because expanding Changes
  // also perturbs the WINDOW's own measured pixelRect (WindowFrame.tsx's own
  // `scheduleWindowTerminalResize` layout effect, keyed on
  // `[pixelRect.width, pixelRect.height, managedWindow.state]`), which
  // independently dispatches the same event within the poll window. A test
  // that stays green against the broken behavior it claims to guard proves
  // nothing; the `rightPanelPresent` case above does not share that confound
  // (verified red under the same break) and is the one kept.
});
