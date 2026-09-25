/**
 * A board card focused by the MOUSE must not become a keyboard drag on Space or
 * Enter, and a keyboard drag must end when the user's intent moves elsewhere.
 *
 * Every board card is `tabindex="0"` with dnd-kit's `onKeyDown` activator, so a
 * mouse press focuses it, and a pointer drag leaves it focused (dnd-kit swallows
 * the post-drag click, so no window opens and nothing takes focus back). The
 * stock KeyboardSensor then lifted the card on the next Enter into a DragOverlay
 * ghost that only a keydown reaching `document` could end. Once the user clicked
 * into a terminal, xterm stopped every key, and the ghost sat over the board for
 * 8m48s while no other card could be dragged and the reload gate parked every
 * board reload for 30s. `IntentKeyboardSensor` (src/renderer/utils) is the fix.
 *
 * Assertions are on `.drag-overlay` presence, a grip's `aria-pressed`, and the
 * lane highlight, never on a completed reorder: dnd-kit's keyboard pickup is
 * reliable under Playwright and the drop after an arrow move is not.
 *
 * The later cases cover what rode along with the fix: a focusable child keeps
 * its key, ArrowRight targets the next column (the overlay's tilt used to skew
 * the measured box), column grips are the columns' focus stops, and the
 * in-gesture Escape no longer closes the dialog under a lifted Board Manager
 * row.
 *
 * Each test launches its own page from a seeded state, so the file can fan out
 * across the UI workers.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { collectPageErrors, settleDndKitKeyboardSensor, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-kb-drag-intent-${RUN_SUFFIX}`;
const CARD_TASK_ID = `task-kb-intent-card-${RUN_SUFFIX}`;
const CARD_TITLE = 'Keyboard Intent Card';
const LIVE_TASK_ID = `task-kb-intent-live-${RUN_SUFFIX}`;
const LIVE_SESSION_ID = `sess-kb-intent-${RUN_SUFFIX}`;
const ARCHIVED_TASK_ID = `task-kb-intent-archived-${RUN_SUFFIX}`;

const LANE_CARD = `[data-testid="swimlane"] [data-task-id="${CARD_TASK_ID}"]`;
const OVERLAY = '.drag-overlay';
const TERMINAL_TEXTAREA = '[data-testid="terminal-session-pane"] .xterm-helper-textarea';
const PLANNING_COLUMN_GRIP = '[data-swimlane-name="Planning"] [data-testid="column-drag-handle"]';

/** The board with one To Do card, one archived task in the Done lane's preview
 *  list (a compact card with a focusable delete button), and, when asked, a
 *  second task whose running session mounts a terminal in the bottom panel. */
function buildPreConfig(options: { withLiveSession: boolean }): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Keyboard Drag Intent Test',
        path: '/mock/keyboard-drag-intent-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-kdi-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${CARD_TASK_ID}',
        display_id: 1,
        title: '${CARD_TITLE}',
        description: '',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.archivedTasks.push({
        id: '${ARCHIVED_TASK_ID}',
        display_id: 3,
        title: 'Archived Intent Card',
        description: '',
        swimlane_id: laneIds['Done'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      if (${options.withLiveSession ? 'true' : 'false'}) {
        state.sessions.push({
          id: '${LIVE_SESSION_ID}',
          taskId: '${LIVE_TASK_ID}',
          projectId: '${PROJECT_ID}',
          pid: 5001,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/keyboard-drag-intent-test',
          startedAt: ts,
          exitCode: null,
          resuming: false,
          isolatedSwimlaneId: null,
        });
        state.tasks.push({
          id: '${LIVE_TASK_ID}',
          display_id: 2,
          title: 'Live Session Task',
          description: '',
          swimlane_id: laneIds['Executing'],
          position: 0,
          agent: 'claude',
          session_id: '${LIVE_SESSION_ID}',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
        state.activityCache['${LIVE_SESSION_ID}'] = 'idle';
      }

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.locator(LANE_CARD).waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

/** Which task id the focused element carries, or null. */
async function focusedTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-task-id') ?? null);
}

/** Put focus on `selector` the way a keyboard user does: the LAST focus move is
 *  Tab's own default action. A script `focus()` alone is pointer-or-script
 *  placed by the sensor's rule, so Shift+Tab steps off the element and Tab
 *  steps back on. Every element this spec targets has a previous Tab stop (a
 *  column header control, or the card before it). */
async function focusByKeyboard(page: Page, selector: string): Promise<void> {
  const isFocused = () => page.locator(selector).evaluate((element) => element === document.activeElement);
  await page.locator(selector).evaluate((element) => (element as HTMLElement).focus());
  await page.keyboard.press('Shift+Tab');
  await expect.poll(isFocused).toBe(false);
  await page.keyboard.press('Tab');
  await expect.poll(isFocused).toBe(true);
}

async function focusCardByKeyboard(page: Page): Promise<void> {
  await focusByKeyboard(page, LANE_CARD);
  await expect.poll(() => focusedTaskId(page)).toBe(CARD_TASK_ID);
}

/** Put focus on the card the way the bug did: press, move past the pointer
 *  sensor's 5px threshold, release where it started. The press focuses the
 *  card; the activated drag swallows the click, so no window opens. */
async function focusCardByPointerDrag(page: Page): Promise<void> {
  const card = page.locator(LANE_CARD);
  const box = await card.boundingBox();
  if (!box) throw new Error('card has no bounding box');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 12, centerY, { steps: 4 });
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 3000 });
  await page.mouse.move(centerX, centerY, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
  // Asserted so the test cannot pass vacuously: the card is what holds focus.
  await expect.poll(() => focusedTaskId(page)).toBe(CARD_TASK_ID);
}

async function pickUpWithSpace(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 3000 });
  await settleDndKitKeyboardSensor(page);
}

/** Lift a grip (a column header's or a Board Manager row's) with Space and
 *  wait for dnd-kit to mark it pressed. Column and rail drags render no
 *  DragOverlay, so `aria-pressed` is the pickup signal. */
async function liftGripWithSpace(page: Page, selector: string): Promise<void> {
  await page.keyboard.press('Space');
  await expect(page.locator(selector)).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
  await settleDndKitKeyboardSensor(page);
}

async function expectNoPickup(page: Page): Promise<void> {
  // Intentional fixed wait - we cannot poll for non-occurrence.
  await page.waitForTimeout(500);
  await expect(page.locator(OVERLAY)).toHaveCount(0);
}

test('a card focused by a pointer drag does not pick up on Space or Enter', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await focusCardByPointerDrag(page);

    await page.keyboard.press('Space');
    await expectNoPickup(page);

    await page.keyboard.press('Enter');
    await expectNoPickup(page);

    // Still focused and still where it was: the keys did nothing at all.
    expect(await focusedTaskId(page)).toBe(CARD_TASK_ID);
    await expect(page.locator(`[data-swimlane-name="To Do"] [data-task-id="${CARD_TASK_ID}"]`)).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a card focused by Tab picks up on Space, cancels on Escape, and drops on Space', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await focusCardByKeyboard(page);

    await pickUpWithSpace(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });

    // The card keeps keyboard-placed focus across a cancel, so it can be
    // picked up again, and a keyboard drop still ends the drag.
    await expect.poll(() => focusedTaskId(page)).toBe(CARD_TASK_ID);
    await pickUpWithSpace(page);
    await page.keyboard.press('Space');
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('a pointer press anywhere cancels a keyboard drag', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await focusCardByKeyboard(page);
    await pickUpWithSpace(page);

    // Empty space near the bottom of another lane: nothing there to drop on,
    // and nothing there that opens anything.
    const planning = page.locator('[data-swimlane-name="Planning"]');
    const box = await planning.boundingBox();
    if (!box) throw new Error('Planning lane has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 40);

    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
    // A cancel, not a drop: the card is still in its source lane.
    await expect(page.locator(`[data-swimlane-name="To Do"] [data-task-id="${CARD_TASK_ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-swimlane-name="Planning"] [data-task-id="${CARD_TASK_ID}"]`)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('focus entering a terminal cancels a keyboard drag, and the terminal keeps its keys', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: true }));
  try {
    // The running session's terminal mounts in the bottom panel.
    const textarea = page.locator(TERMINAL_TEXTAREA).first();
    await textarea.waitFor({ state: 'attached', timeout: 10000 });

    await focusCardByKeyboard(page);
    await pickUpWithSpace(page);

    // A script focus, no pointer involved: this is the focusin trigger alone,
    // the path an arriving terminal takes when it claims focus.
    await textarea.evaluate((element) => (element as HTMLElement).focus());
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });

    // The keys the incident typed into the terminal. xterm stops them, and
    // with the drag already cancelled there is nothing for them to end.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expectNoPickup(page);
    await expect(page.locator(`[data-swimlane-name="To Do"] [data-task-id="${CARD_TASK_ID}"]`)).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a focusable child of a card keeps its key: Space on the delete button never lifts the card', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    // The Done lane's preview list renders the archived task as a compact card
    // whose delete button is a real <button> inside the sortable node. With the
    // stock activator, Space here started a drag and prevented the button.
    const deleteButton = `[data-swimlane-name="Done"] [data-task-id="${ARCHIVED_TASK_ID}"] button`;
    await page.locator(deleteButton).waitFor({ state: 'attached', timeout: 10000 });
    await focusByKeyboard(page, deleteButton);

    await page.keyboard.press('Space');
    await expect(page.getByText('Delete completed task')).toBeVisible({ timeout: 3000 });
    await expectNoPickup(page);
  } finally {
    await browser.close();
  }
});

test('ArrowRight moves a keyboard drag into the next column, not onto the card below', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await focusCardByKeyboard(page);
    await pickUpWithSpace(page);

    // dnd-kit measures the overlay's first child for the collision rect. With
    // the tilt on that node, the rect leaned 1.6px left of the card and every
    // same-column sibling passed the "to the right" test, so this landed on
    // the neighbouring card and highlighted the source lane.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-swimlane-name="Planning"].drop-highlight')).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator('[data-swimlane-name="To Do"].drop-highlight')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('a column grip lifts its column from Tab-placed focus only', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    const grip = page.locator(PLANNING_COLUMN_GRIP);
    await grip.waitFor({ state: 'visible', timeout: 10000 });

    // Click-placed focus: Enter must not lift the column.
    await grip.click();
    await expect.poll(() => grip.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(500);
    await expect(grip).not.toHaveAttribute('aria-pressed', 'true');

    // Tab-placed focus: Space lifts, Escape cancels, and the column has not moved.
    await focusByKeyboard(page, PLANNING_COLUMN_GRIP);
    await liftGripWithSpace(page, PLANNING_COLUMN_GRIP);
    await page.keyboard.press('Escape');
    await expect(grip).not.toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
    const columnNames = await page.locator('[data-testid="swimlane"]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-swimlane-name')));
    expect(columnNames.slice(0, 3)).toEqual(['To Do', 'Planning', 'Executing']);
  } finally {
    await browser.close();
  }
});

test('Escape cancels a lifted Board Manager row without closing the Board Manager', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await page.locator('[data-swimlane-name="Planning"] [data-testid="edit-column-btn"]').click();
    const railTab = page.locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]');
    await railTab.waitFor({ state: 'visible', timeout: 10000 });
    const gripSelector = 'div:has(> [data-testid="board-manager-tab"][data-tab-name="Executing"]) > [data-drag-handle]';
    const grip = page.locator(gripSelector);

    // Click-placed focus: Enter must not lift the row (it used to, and a later
    // Enter in a field of the same dialog then dropped it).
    await grip.click();
    await expect.poll(() => grip.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(500);
    await expect(grip).not.toHaveAttribute('aria-pressed', 'true');

    // Tab-placed focus: Space lifts. Escape is the in-gesture cancel and must
    // not reach BaseDialog's document-level dismissal.
    await focusByKeyboard(page, gripSelector);
    await liftGripWithSpace(page, gripSelector);
    await page.keyboard.press('Escape');
    await expect(grip).not.toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
    await expect(railTab).toBeVisible();

    // A second Escape, with nothing lifted, is not a keyboard drag the tracker
    // owns, so it is not consumed and reaches the Board Manager's own Escape
    // listener. Red against the tracker swallowing Escape with no keyboard
    // drag registered.
    await page.keyboard.press('Escape');
    await expect(railTab).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('Space on a pointer-focused card is swallowed rather than scrolling the lane', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await focusCardByPointerDrag(page);

    // Bubble phase on document runs AFTER React's root listener, where the
    // activator's own event.preventDefault() would already have fired.
    // Recorded on a window global because the assertion reads it back in a
    // later evaluate call, once the Space keydown has finished dispatching.
    await page.evaluate(() => {
      (window as unknown as { __kdiSpaceDefaultPrevented: boolean | null }).__kdiSpaceDefaultPrevented = null;
      document.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
          (window as unknown as { __kdiSpaceDefaultPrevented: boolean | null }).__kdiSpaceDefaultPrevented = event.defaultPrevented;
        }
      });
    });

    await page.keyboard.press('Space');

    // Red against dropping the activator's `event.preventDefault()` on a
    // pointer-focused node: without it this reads false, and Space would
    // page-scroll the lane instead of doing nothing.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __kdiSpaceDefaultPrevented: boolean | null }).__kdiSpaceDefaultPrevented))
      .toBe(true);
    await expectNoPickup(page);
  } finally {
    await browser.close();
  }
});

test('a real click into a terminal cancels a keyboard drag and the terminal takes focus', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: true }));
  try {
    // The running session's terminal mounts in the bottom panel. A fresh mock
    // session has produced no output, so TerminalTab covers it with the launch
    // overlay ("Starting agent...") until first output is reported - a real
    // click at this point would hit the overlay's own label, not the terminal.
    // Firing it through the mock's onFirstOutput hook is what a real PTY's
    // alternate-screen-buffer detection does, and it is what actually clears
    // the overlay in production.
    const textarea = page.locator(TERMINAL_TEXTAREA).first();
    await textarea.waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate((sessionId) => {
      (window as unknown as { __mockFireFirstOutput?: (id: string) => void }).__mockFireFirstOutput?.(sessionId);
    }, LIVE_SESSION_ID);
    const pane = page.locator('[data-testid="terminal-session-pane"]').first();
    await pane.locator('[data-testid="launch-overlay"]').waitFor({ state: 'hidden', timeout: 5000 });
    // The arrival-focus arbiter claims the newly-ready terminal a moment after
    // the overlay drops. Waiting for that settle first, rather than racing it,
    // is what makes the Tab sequence below land on the card deterministically.
    await expect.poll(() => textarea.evaluate((element) => element === document.activeElement)).toBe(true);

    await focusCardByKeyboard(page);
    await pickUpWithSpace(page);

    // A real mouse press, the shape that shipped the incident: dnd-kit's base
    // handleCancel(event) calls event.preventDefault() on the pointerdown,
    // which suppresses the compat mousedown that would otherwise focus xterm.
    // The subclass's cancel calls detach() + onCancel() instead, so the
    // mousedown survives and the terminal claims focus exactly as a plain
    // click would.
    const screen = pane.locator('.xterm-screen');
    const box = await screen.boundingBox();
    if (!box) throw new Error('terminal screen has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
    await expect.poll(() => textarea.evaluate((element) => element === document.activeElement)).toBe(true);
  } finally {
    await browser.close();
  }
});

test('the tracker survives the Board Manager closing', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    await page.locator('[data-swimlane-name="Planning"] [data-testid="edit-column-btn"]').click();
    const railTab = page.locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]');
    await railTab.waitFor({ state: 'visible', timeout: 10000 });

    // Close with nothing lifted: ColumnRail's and AutomationsPane's own
    // DndContexts unmount, dropping the tracker's ref count from 3 back to 1
    // (the board's own).
    await page.locator('[data-testid="board-manager-dialog"] button[aria-label="Close"]').click();
    await railTab.waitFor({ state: 'hidden', timeout: 5000 });

    // Red against a setup() teardown that uninstalls the tracker unconditionally
    // instead of at ref count zero: with the tracker gone, no focus is ever
    // recorded as keyboard-placed and Space lifts nothing on the board.
    await focusCardByKeyboard(page);
    await pickUpWithSpace(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('a keyboard drag lifted in the Board Manager disposes cleanly when the dialog unmounts mid-drag', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  const getPageErrors = collectPageErrors(page);
  try {
    await page.locator('[data-swimlane-name="Planning"] [data-testid="edit-column-btn"]').click();
    const railTab = page.locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]');
    await railTab.waitFor({ state: 'visible', timeout: 10000 });
    const gripSelector = 'div:has(> [data-testid="board-manager-tab"][data-tab-name="Executing"]) > [data-drag-handle]';

    await focusByKeyboard(page, gripSelector);
    await liftGripWithSpace(page, gripSelector);

    // A SCRIPT click, not a Playwright pointer click: the native `.click()`
    // method dispatches only a `click` event, with no pointerdown ahead of it.
    // A real pointerdown here would hit the sensor's own
    // `listeners.add('pointerdown', cancel, ...)` and release the registration
    // through the ordinary cancel path - the dialog closing would then be
    // exercising that path again, not the unmount-time dispose this pins.
    const closeButton = page.locator('[data-testid="board-manager-dialog"] button[aria-label="Close"]');
    await closeButton.evaluate((element) => (element as HTMLElement).click());
    await railTab.waitFor({ state: 'hidden', timeout: 5000 });

    // BaseDialog's trapFocus restores focus to the opener (edit-column-btn) on
    // close. `isAimedAt` only claims body once the dragged node is gone, so
    // drive focus there explicitly rather than assume where it landed.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);

    // The tracker consumes Escape from a CAPTURE-phase document listener, so a
    // bubble-phase recorder only sees the key when the tracker did NOT claim
    // it. Initialized to null, not a boolean, so a tracker that wrongly
    // swallows the event leaves this null forever instead of misreading as
    // "not prevented".
    await page.evaluate(() => {
      (window as unknown as { __kdiUnmountEscapeDefaultPrevented: boolean | null }).__kdiUnmountEscapeDefaultPrevented = null;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          (window as unknown as { __kdiUnmountEscapeDefaultPrevented: boolean | null }).__kdiUnmountEscapeDefaultPrevented = event.defaultPrevented;
        }
      });
    });
    await page.keyboard.press('Escape');

    // Red against a setup() teardown that leaves the dead sensor's
    // registration in place: without dispose(), the stale drag claims this
    // Escape (isAimedAt falls back to `target === document.body` once its
    // node is gone) and swallows it - the incident this pins, where the next
    // Escape on the board was consumed by a dialog the user had already
    // closed.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __kdiUnmountEscapeDefaultPrevented: boolean | null }).__kdiUnmountEscapeDefaultPrevented))
      .toBe(false);

    expect(getPageErrors()).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('column wrappers are not Tab stops and only custom columns carry a grip', async () => {
  const { browser, page } = await launchWithState(buildPreConfig({ withLiveSession: false }));
  try {
    const swimlanes = page.locator('[data-testid="swimlane"]');
    const laneCount = await swimlanes.count();
    expect(laneCount).toBeGreaterThan(0);

    // Red against `attributes` spreading onto the column wrapper (or its
    // sortable parent) instead of the header grip: dnd-kit's `attributes`
    // carries tabindex="0" and role="button", so a wrapper regression would
    // leave one of the two on the swimlane node itself or its parent.
    const wrapperAttributes = await swimlanes.evaluateAll((elements) =>
      elements.map((element) => ({
        swimlaneTabIndex: element.getAttribute('tabindex'),
        swimlaneRole: element.getAttribute('role'),
        parentTabIndex: element.parentElement?.getAttribute('tabindex') ?? null,
        parentRole: element.parentElement?.getAttribute('role') ?? null,
      })));
    for (const attributes of wrapperAttributes) {
      expect(attributes.swimlaneTabIndex).toBeNull();
      expect(attributes.swimlaneRole).toBeNull();
      expect(attributes.parentTabIndex).toBeNull();
      expect(attributes.parentRole).toBeNull();
    }

    // Only custom columns (role === null) get a grip; the system columns (To
    // Do, Done) get none.
    await expect(page.locator('[data-swimlane-name="To Do"] [data-testid="column-drag-handle"]')).toHaveCount(0);
    await expect(page.locator('[data-swimlane-name="Done"] [data-testid="column-drag-handle"]')).toHaveCount(0);
    const gripCount = await page.locator('[data-testid="column-drag-handle"]').count();
    expect(gripCount).toBe(laneCount - 2);
  } finally {
    await browser.close();
  }
});
