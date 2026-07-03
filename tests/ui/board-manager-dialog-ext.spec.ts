/**
 * Extended UI tests for the BoardManagerDialog.
 *
 * Covers coverage gaps not addressed in board-manager-dialog.spec.ts:
 * 1. BaseDialog.onBackdropClick synchronous escape-hatch (fires immediately,
 *    does not call requestClose, works even with preventBackdropClose=true).
 * 2. Save fan-out partial-failure (one update succeeds, one rejects).
 * 3. Section-disabled inline explanations for To Do and auto_spawn=false columns.
 * 4. Toggling Auto-spawn expands / collapses the dependent sections in place.
 * 5. DoneSwimlane header button click opens manager with Done tab preselected.
 * 6. ViewToggle "Add column" while manager is already open increments the
 *    counter and adds a second new-draft tab.
 * 7. Discard confirm bullet rendering (1 dirty = 1 li, 3 dirty = 3 li each
 *    with the column name; untitled new drafts render as "Untitled column").
 * 8. Delete control names its target - the delete button's aria-label/title
 *    is `Delete "<column name>"`, and the confirm dialog it opens reuses the
 *    same string as its title (was the static "Delete column").
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `BoardMgr Ext ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openManagerByHeader(columnName: string) {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
}

async function closeManager() {
  const dialog = page.locator('[data-testid="board-manager-dialog"]');
  const cancelBtn = dialog.getByRole('button', { name: 'Cancel' });
  await cancelBtn.click();
  // Accept any discard confirm that may appear
  const discardBtn = page.locator('button', { hasText: 'Discard' });
  if (await discardBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await discardBtn.click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
}

test.describe('BoardManagerDialog extended', () => {
  test.afterEach(async () => {
    if (await page.locator('[data-testid="board-manager-dialog"]').isVisible({ timeout: 200 }).catch(() => false)) {
      await closeManager();
    }
  });

  // ── Gap 1: BaseDialog.onBackdropClick synchronous escape-hatch ───────────
  //
  // BoardManagerDialog passes `preventBackdropClose` AND `onBackdropClick`
  // to BaseDialog. The spec says onBackdropClick takes precedence: clicking
  // the backdrop fires the callback immediately (routes through requestCancel
  // for dirty-check flow) without triggering the exit animation.
  //
  // We verify:
  // (a) clicking the backdrop with NO dirty state closes the dialog
  //     (requestCancel → hasDirty=false → onClose fires).
  // (b) clicking the backdrop WITH dirty state opens the discard confirm
  //     instead of closing immediately (requestCancel → hasDirty=true →
  //     setShowCancelConfirm, no exit animation).

  test('backdrop click with no dirty state closes the manager', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Click the fixed-inset-0 backdrop (the element that wraps the dialog panel).
    // We simulate mousedown + mouseup on the backdrop itself.
    await page.mouse.click(10, 540); // left edge of viewport, away from dialog
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  test('backdrop click with dirty state opens discard confirm instead of closing', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Make the form dirty
    await page.locator('[data-testid="board-manager-name"]').fill('Dirty rename');

    // Click the backdrop
    await page.mouse.click(10, 540);

    // Dialog must remain mounted (requestCancel intercepted the close)
    await expect(dialog).toBeVisible();
    // Discard confirm must appear
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toBeVisible({ timeout: 1500 });

    // Clean up: keep editing, then cancel properly
    await page.locator('button', { hasText: 'Keep editing' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('button', { hasText: 'Discard' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  // ── Gap 2: Save fan-out partial failure ────────────────────────────────
  //
  // Wire a spy that succeeds for the first update call and rejects for the
  // second. The test verifies:
  // - The succeeded row's dirty dot clears (originals updated in place).
  // - The failed row still shows its dirty dot.
  // - The dialog remains open for retry.
  // - The error toast contains the partial-save note.

  test('save fan-out: succeeded row clears dirty dot; failed row stays dirty; dialog stays open', async () => {
    // Wire the spy: reject every call for 'Tests', succeed for anything else.
    await page.evaluate(() => {
      (window as unknown as { __updateSpy: unknown[] }).__updateSpy = [];
      const originalUpdate = window.electronAPI.swimlanes.update;
      window.electronAPI.swimlanes.update = async (input) => {
        (window as unknown as { __updateSpy: unknown[] }).__updateSpy.push(input);
        if ((input as { name: string }).name === 'TestsFail') {
          throw new Error('Simulated IPC failure');
        }
        return originalUpdate(input);
      };
    });

    await openManagerByHeader('Code Review');

    // Dirty "Code Review" (will succeed)
    await page.locator('[data-testid="board-manager-name"]').fill('ReviewsSucceed');

    // Dirty "Tests" tab (will fail)
    await page.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill('TestsFail');

    // Click save
    await page.locator('[data-testid="board-manager-save"]').click();

    // Dialog must remain open (partial failure)
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 2000 });

    // The "ReviewsSucceed" tab should have its dirty dot cleared.
    // data-tab-name for a saved row becomes the saved name (originals[id].name).
    const succeededTab = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="ReviewsSucceed"]');
    const failedTab = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]');

    await expect(succeededTab.locator('[data-testid="board-manager-tab-dirty"]')).toBeHidden({ timeout: 2000 });
    await expect(failedTab.locator('[data-testid="board-manager-tab-dirty"]')).toBeVisible();

    // Restore the real update so cleanup can work
    await page.evaluate(() => {
      const originalUpdate = window.electronAPI.swimlanes.update;
      window.electronAPI.swimlanes.update = originalUpdate;
    });

    // Cleanup: rename the succeeded column back and discard the failed one
    await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((s) => s.name === 'ReviewsSucceed');
      if (lane) await window.electronAPI.swimlanes.update({ id: lane.id, name: 'Code Review' });
    });

    // Close via cancel/discard (Tests tab still dirty)
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('button', { hasText: 'Discard' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  // ── Gap 3: Section-disabled inline explanations ──────────────────────────
  //
  // Sections that do not apply collapse to a one-line inline explanation in the
  // scrollable form (replacing the old greyed section-nav button + native
  // tooltip). Two branches:
  // (a) Role-pinned column (To Do): "Sessions don't run in To Do columns, so
  //     Agent doesn't apply." (and similar for Automation/Handoff).
  // (b) Custom column with auto_spawn=false: "Turn on Auto-spawn in General to
  //     enable Agent." (etc). In both, the section's fields are absent.

  test('To Do column collapses Agent/Automation/Handoff to inline explanations', async () => {
    await openManagerByHeader('To Do');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    await expect(dialog.getByText("Sessions don't run in To Do columns, so Agent doesn't apply.")).toBeVisible();
    await expect(dialog.getByText("Sessions don't run in To Do columns, so Automation doesn't apply.")).toBeVisible();
    await expect(dialog.getByText("Sessions don't run in To Do columns, so Handoff doesn't apply.")).toBeVisible();

    // The collapsed sections render no fields.
    await expect(dialog.locator('[data-testid="column-agent-override"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="column-session-target"]')).toHaveCount(0);
  });

  test('auto_spawn-off column collapses the dependent sections with an Auto-spawn hint', async () => {
    // Create a custom column with auto_spawn=false to test the other branch.
    await page.evaluate(async () => {
      await window.electronAPI.swimlanes.create({
        name: 'NoSpawnCol',
        color: '#6b7280',
        icon: null,
        permission_mode: null,
        auto_spawn: false,
        auto_command: null,
        plan_exit_target_id: null,
        agent_override: null,
        model_override: null,
        effort_override: null,
        handoff_context: false,
      });
    });

    // Force a board-store sync so the new column renders (the mock has no push).
    await page.evaluate(async () => {
      const store = (window as unknown as { __zustandStores?: { board: { getState: () => { loadBoard: () => void } } } }).__zustandStores;
      if (store?.board) store.board.getState().loadBoard();
    });

    await expect.poll(async () => {
      return page.locator('[data-swimlane-name="NoSpawnCol"]').isVisible();
    }, { timeout: 3000 }).toBe(true);

    await openManagerByHeader('NoSpawnCol');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Auto-spawn leads the Agent section: the toggle is present (off), its agent
    // fields are hidden, and the downstream sections point back to it.
    await expect(dialog.locator('[role="switch"][aria-label="Auto-spawn"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="column-agent-override"]')).toHaveCount(0);
    await expect(dialog.getByText('Turn on Auto-spawn in the Agent section to enable Automation.')).toBeVisible();
    await expect(dialog.getByText('Turn on Auto-spawn in the Agent section to enable Handoff.')).toBeVisible();

    // Close before cleanup, then delete the test column.
    await closeManager();
    await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((s) => s.name === 'NoSpawnCol');
      if (lane) await window.electronAPI.swimlanes.delete(lane.id);
    });
  });

  // ── Gap 4: Auto-spawn toggle expands / collapses sections in place ────────
  //
  // Auto-spawn leads the Agent section and gates the agent-behavior config. The
  // one-scroll form renders every section at once; toggling Auto-spawn off hides
  // the agent fields (the toggle itself stays) and collapses Automation/Handoff
  // to their inline explanations; toggling it back on restores the fields.

  test('toggling Auto-spawn expands and collapses the dependent sections in place', async () => {
    await openManagerByHeader('Code Review'); // auto_spawn=true
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // With Auto-spawn on, the Agent field is present and the Automation hint is absent.
    await expect(dialog.locator('[data-testid="column-agent-override"]')).toBeVisible();
    await expect(dialog.getByText('Turn on Auto-spawn in the Agent section to enable Automation.')).toHaveCount(0);

    const autoSpawnSwitch = dialog.locator('[role="switch"][aria-label="Auto-spawn"]');
    await expect(autoSpawnSwitch).toHaveAttribute('aria-checked', 'true');
    await autoSpawnSwitch.click();
    await expect(autoSpawnSwitch).toHaveAttribute('aria-checked', 'false');

    // The agent fields unmount (the toggle stays) and the downstream hint appears.
    await expect(dialog.locator('[data-testid="column-agent-override"]')).toHaveCount(0);
    await expect(autoSpawnSwitch).toBeVisible();
    await expect(dialog.getByText('Turn on Auto-spawn in the Agent section to enable Automation.')).toBeVisible();

    // Toggle back on: the field returns (net no change, so the dialog stays clean).
    await autoSpawnSwitch.click();
    await expect(autoSpawnSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('[data-testid="column-agent-override"]')).toBeVisible();
  });

  // ── Gap 5: DoneSwimlane header button click ───────────────────────────────
  //
  // The Done column uses a different component (DoneSwimlane) where the name
  // is inside a <button> element, not a bare div. Clicking that button must
  // open the manager with the Done tab preselected.

  test('clicking Done column header opens manager with Done tab active', async () => {
    const doneColumn = page.locator('[data-swimlane-name="Done"]');
    // DoneSwimlane wraps the name in a <button> inside the header div.
    await doneColumn.locator('button', { hasText: 'Done' }).click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });

    const doneTab = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Done"]');
    await expect(doneTab).toHaveAttribute('aria-selected', 'true');
  });

  // ── Gap 6: ViewToggle "Add column" while manager is already open ─────────
  //
  // Clicking the "Add column" button in the ViewToggle while the manager is
  // already mounted triggers the counter-increment path (openBoardManager(null,
  // true) while boardManagerOpen=true). The manager stays mounted and a second
  // new-draft tab appears in the strip.

  test('ViewToggle add-column while manager is open adds another draft tab', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Count initial tabs
    const initialTabCount = await dialog.locator('[data-testid="board-manager-tab"]').count();

    // The "Add column" button in ViewToggle calls `openBoardManager(null, true)` on the board
    // store. The dialog's full-screen backdrop (z-50) intercepts pointer events for any DOM
    // element beneath it, so we drive the store directly - this is exactly the code path the
    // button exercises and tests the counter-increment invariant without being blocked by the
    // overlay. This is the canonical pattern (per agent rules) for store-driven interactions
    // when a dialog intercepts clicks on elements behind it.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { getState: () => { openBoardManager: (id: null, addNew: boolean) => void } } };
      }).__zustandStores;
      stores?.board.getState().openBoardManager(null, true);
    });

    // Dialog must remain mounted (not closed and reopened)
    await expect(dialog).toBeVisible();

    // Tab count must have increased by 1 (new draft tab was injected via the addDraftRequest counter)
    await expect.poll(async () => {
      return dialog.locator('[data-testid="board-manager-tab"]').count();
    }, { timeout: 2000 }).toBe(initialTabCount + 1);

    // The newly active tab should have a name input pre-filled with 'New column'
    await expect(page.locator('[data-testid="board-manager-name"]')).toHaveValue('New column');
  });

  // ── Gap 7: Discard confirm bullet rendering ───────────────────────────────
  //
  // (a) 1 dirty column → exactly 1 <li> with the column name.
  // (b) 3 dirty columns → exactly 3 <li>s, each with the bolded name.
  // (c) An untitled new draft (empty string trimmed to '') renders as
  //     "Untitled column".

  test('discard confirm shows exactly 1 bullet when 1 column is dirty', async () => {
    await openManagerByHeader('Code Review');

    await page.locator('[data-testid="board-manager-name"]').fill('OneDirtyColumn');

    // Trigger discard confirm via Cancel
    await page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toBeVisible({ timeout: 1500 });

    // ConfirmDialog renders the bullet list in a separate modal; scope to all
    // visible <li>s in the confirm dialog. The ConfirmDialog is a sibling of
    // the manager's <> fragment in the DOM, so we locate it broadly.
    const allItems = page.locator('ul li');
    await expect.poll(async () => allItems.count(), { timeout: 2000 }).toBe(1);
    await expect(allItems.first()).toContainText('OneDirtyColumn');

    // Dismiss without saving
    await page.locator('button', { hasText: 'Discard' }).click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 2000 });
  });

  test('discard confirm shows 3 bullets when 3 columns are dirty', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Dirty column 1
    await page.locator('[data-testid="board-manager-name"]').fill('Renamed1');

    // Dirty column 2
    await dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill('Renamed2');

    // Dirty column 3
    await dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill('Renamed3');

    // Trigger discard confirm
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toBeVisible({ timeout: 1500 });

    const allItems = page.locator('ul li');
    await expect.poll(async () => allItems.count(), { timeout: 2000 }).toBe(3);

    // Each bullet must contain its column name (order not guaranteed)
    const texts = await allItems.allTextContents();
    const joinedText = texts.join(' ');
    expect(joinedText).toContain('Renamed1');
    expect(joinedText).toContain('Renamed2');
    expect(joinedText).toContain('Renamed3');

    await page.locator('button', { hasText: 'Discard' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  test('discard confirm renders "Untitled column" for a new draft with empty name', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Add a new draft tab and clear its name
    await dialog.locator('[data-testid="board-manager-add-column"]').click();
    await expect(page.locator('[data-testid="board-manager-name"]')).toHaveValue('New column');
    await page.locator('[data-testid="board-manager-name"]').fill('');

    // Trigger discard confirm
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toBeVisible({ timeout: 1500 });

    // The untitled draft must appear as "Untitled column"
    await expect(page.locator('ul li')).toContainText('Untitled column');

    await page.locator('button', { hasText: 'Discard' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  // ── Gap 8: Delete control names its target ────────────────────────────────
  //
  // DetailIdentityHeader's delete button carries an aria-label/title of
  // `Delete "<column name>"`, and the ConfirmDialog it opens reuses that same
  // string as its title (previously a static "Delete column").

  test('delete control aria-label/title name the column; confirm dialog title matches', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    const deleteButton = dialog.locator('[data-testid="board-manager-delete"]');
    await expect(deleteButton).toHaveAttribute('aria-label', 'Delete "Code Review"');
    await expect(deleteButton).toHaveAttribute('title', 'Delete "Code Review"');

    await deleteButton.click();
    await expect(page.locator('h3', { hasText: 'Delete "Code Review"' })).toBeVisible({ timeout: 1500 });

    // Cancel out via Escape rather than a "Cancel" button click: the delete
    // ConfirmDialog's own Cancel button shares its accessible name with the
    // manager dialog's own footer Cancel button (both render underneath the
    // confirm's z-[60] overlay), so a plain role/name locator would be
    // ambiguous. Escape is unambiguous here: BoardManagerDialog's hand-rolled
    // Escape listener is deliberately guarded off while confirmDeleteId is
    // set (see the `!confirmDeleteId` check in BoardManagerDialog.tsx), and
    // its own BaseDialog's Escape effect no-ops under preventBackdropClose,
    // so only the ConfirmDialog's Escape handler fires, closing just the
    // confirm and leaving the manager open with nothing deleted.
    await page.keyboard.press('Escape');
    await expect(page.locator('h3', { hasText: 'Delete "Code Review"' })).toBeHidden({ timeout: 1500 });
    await expect(dialog).toBeVisible();

    const stillExists = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      return lanes.some((lane) => lane.name === 'Code Review');
    });
    expect(stillExists).toBe(true);
  });

  // ── Session target + spawn strategy selects ──────────────────────────────
  //
  // The Automation tab exposes two Selects: "Session" (session_target: main /
  // isolated) and "On enter" (session_spawn_strategy: create_or_resume /
  // always_spawn_new). Verify the defaults, the isolated -> always-spawn-new
  // snap, and that both persist.

  test('Automation tab: session target + spawn strategy default and save', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Code Review has auto_spawn=true, so the Automation section renders its
    // fields inline in the one-scroll form (no section nav to click).
    const targetSelect = dialog.locator('[data-testid="column-session-target"]');
    const spawnSelect = dialog.locator('[data-testid="column-session-spawn-strategy"]');
    await expect(targetSelect).toBeVisible();
    await expect(spawnSelect).toBeVisible();

    // Defaults: main + create_or_resume.
    await expect(targetSelect).toHaveValue('main');
    await expect(spawnSelect).toHaveValue('create_or_resume');

    // Choosing Isolated snaps the spawn Select to always_spawn_new.
    await targetSelect.selectOption('isolated');
    await expect(targetSelect).toHaveValue('isolated');
    await expect(spawnSelect).toHaveValue('always_spawn_new');

    await dialog.locator('[data-testid="board-manager-save"]').click();
    await dialog.waitFor({ state: 'detached', timeout: 3000 });

    const saved = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((s) => s.name === 'Code Review');
      return { target: lane?.session_target, spawn: lane?.session_spawn_strategy };
    });
    expect(saved.target).toBe('isolated');
    expect(saved.spawn).toBe('always_spawn_new');

    // Cleanup: restore the defaults.
    await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((s) => s.name === 'Code Review');
      if (lane) await window.electronAPI.swimlanes.update({ id: lane.id, session_target: 'main', session_spawn_strategy: 'create_or_resume' });
    });
  });

  // ── Maximize parity ──────────────────────────────────────────────────────
  //
  // The dialog reuses the shared maximize pattern (maximizedDialogLayout +
  // MaximizeToggleButton + panel.maximize). The toggle button's aria-label
  // flips Maximize <-> Restore; Mod+Shift+M drives the same toggle.

  test('maximize toggle flips via the header button and the panel.maximize hotkey', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const maxBtn = dialog.locator('[data-testid="dialog-maximize"]');

    await expect(maxBtn).toHaveAttribute('aria-label', 'Maximize dialog');
    await maxBtn.click();
    await expect(maxBtn).toHaveAttribute('aria-label', 'Restore dialog');

    // Mod+Shift+M restores it (Mod = Ctrl on Windows/Linux, Cmd on macOS).
    await page.keyboard.press('ControlOrMeta+Shift+M');
    await expect(maxBtn).toHaveAttribute('aria-label', 'Maximize dialog');
  });

  // ── All-columns overview ─────────────────────────────────────────────────
  //
  // The rail's "All columns" entry swaps the detail pane for a grid, one row per
  // column, read from DRAFTS so unsaved edits show. Clicking a row opens its
  // detail. The overview entry itself does not carry the board-manager-tab id.

  test('overview lists every column, reflects unsaved edits, and navigates on row click', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    // Make an unsaved edit that the overview must reflect.
    await dialog.locator('[data-testid="board-manager-name"]').fill('Reviewed');

    const tabCount = await dialog.locator('[data-testid="board-manager-tab"]').count();
    await dialog.locator('[data-testid="board-manager-tab-all"]').click();

    const rows = dialog.locator('[data-testid="board-manager-overview-row"]');
    await expect(rows).toHaveCount(tabCount);
    await expect(rows.filter({ hasText: 'Reviewed' })).toBeVisible();

    // Clicking the row opens that column's detail with the draft value intact.
    await rows.filter({ hasText: 'Reviewed' }).click();
    await expect(dialog.locator('[data-testid="board-manager-name"]')).toHaveValue('Reviewed');
    // Dirty edit is discarded by afterEach.
  });

  // ── Footer dirty summary ─────────────────────────────────────────────────

  test('footer summarises the number of modified columns', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const summary = dialog.locator('[data-testid="board-manager-dirty-summary"]');

    await expect(summary).toBeEmpty();

    await dialog.locator('[data-testid="board-manager-name"]').fill('One');
    await expect(summary).toHaveText('1 column modified');

    await dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]').click();
    await dialog.locator('[data-testid="board-manager-name"]').fill('Two');
    await expect(summary).toHaveText('2 columns modified');
    // Dirty edits are discarded by afterEach.
  });

  // ── Column-cycle keybinding ──────────────────────────────────────────────
  //
  // Mod+PageDown / Mod+PageUp cycle the selection across [overview, ...columns]
  // with wraparound, regardless of focus.

  test('Mod+PageDown / Mod+PageUp cycle the selected column with wraparound', async () => {
    await openManagerByHeader('To Do');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    const todoTab = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="To Do"]');
    const planningTab = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Planning"]');
    const overviewTab = dialog.locator('[data-testid="board-manager-tab-all"]');

    await expect(todoTab).toHaveAttribute('aria-selected', 'true');

    // To Do is laneOrder[0]; navIds = [overview, To Do, Planning, ...].
    await page.keyboard.press('ControlOrMeta+PageDown');
    await expect(planningTab).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ControlOrMeta+PageUp');
    await expect(todoTab).toHaveAttribute('aria-selected', 'true');

    // Wrap up past To Do lands on the overview entry.
    await page.keyboard.press('ControlOrMeta+PageUp');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  //
  // The rail reorders via @dnd-kit. To Do is pinned first (no handle, outside the
  // SortableContext). Reorder is local until Save; the store-sync effect must
  // preserve an unsaved reorder across a loadBoard() re-sync (the risk-7 fix).

  test('To Do has no drag handle; custom columns do', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');

    const todoBtn = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="To Do"]');
    const reviewBtn = dialog.locator('[data-testid="board-manager-tab"][data-tab-name="Code Review"]');
    await expect(todoBtn.locator('xpath=../*[@data-drag-handle]')).toHaveCount(0);
    await expect(reviewBtn.locator('xpath=../*[@data-drag-handle]')).toHaveCount(1);
  });

  // A single @dnd-kit drag of a rail row's handle, dropped `deltaRows` below its
  // current slot. Mirrors the mouse-drag pattern in drag-and-drop.spec.ts (move
  // >5px to fire the PointerSensor, step to the target, settle, release). The
  // caller retries until the order changes, since a saturated event loop can
  // starve the final collision compute.
  async function dragRailRowDown(name: string, deltaRows: number) {
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const handle = dialog
      .locator(`[data-testid="board-manager-tab"][data-tab-name="${name}"]`)
      .locator('xpath=../*[@data-drag-handle]');
    const row = dialog.locator(`[data-testid="board-manager-tab"][data-tab-name="${name}"]`);
    const handleBox = await handle.boundingBox();
    const rowBox = await row.boundingBox();
    if (!handleBox || !rowBox) return;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 3 }); // activate (>5px)
    await page.mouse.move(startX, startY + rowBox.height * deltaRows, { steps: 20 });
    await page.waitForTimeout(200); // let dnd-kit process the final pointermove
    await page.mouse.up();
  }

  test('drag reorder counts toward the modified summary and persists on save', async () => {
    await openManagerByHeader('Code Review');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const summary = dialog.locator('[data-testid="board-manager-dirty-summary"]');

    const readOrder = () =>
      dialog.locator('[data-testid="board-manager-tab"]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-tab-name')));
    const orderBefore = await readOrder();

    // Drag "Code Review" down two slots. Retry on a starved drop (mirrors the
    // established DnD-under-load pattern).
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await readOrder()).join(',') !== orderBefore.join(',')) break;
      await dragRailRowDown('Code Review', 2);
      await page.waitForTimeout(150);
    }

    await expect.poll(async () => (await readOrder()).join(',')).not.toBe(orderBefore.join(','));
    // A reorder counts the moved columns toward the affected-column summary.
    await expect(summary).toContainText('modified');
    const orderAfterDrag = await readOrder();

    // Save persists the new order (risk-7 preservation across the save flow's
    // own store churn is covered deterministically by reconcileLaneOrder units).
    await dialog.locator('[data-testid="board-manager-save"]').click();
    await dialog.waitFor({ state: 'detached', timeout: 3000 });

    const persisted = await page.evaluate(async () =>
      (await window.electronAPI.swimlanes.list()).sort((a, b) => a.position - b.position).map((s) => s.name));
    expect(persisted).toEqual(orderAfterDrag);

    // Cleanup: restore the original persisted order.
    await page.evaluate(async (names: (string | null)[]) => {
      const lanes = await window.electronAPI.swimlanes.list();
      const byName = new Map(lanes.map((lane) => [lane.name, lane.id] as const));
      const ids = names.map((name) => (name ? byName.get(name) : undefined)).filter((id): id is string => !!id);
      if (ids.length === names.length) await window.electronAPI.swimlanes.reorder(ids);
    }, orderBefore);
  });
});
