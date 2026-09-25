/**
 * UI tests for column automations in the Column Manager.
 *
 * The whole surface is new: two trigger groups per column, a picker that both
 * creates and copies, a nested edit dialog, the read-only All columns table, and
 * the board header glyph. Nothing here existed before, so this file is the only
 * automated cover it has.
 *
 * Two specs were deliberately moved here out of `board-manager-dialog-ext.spec.ts`
 * when the column's message field became an automation row: the message as a row
 * with its delivery mode, and the template picker portaling out of the dialog.
 * The second one matters more than it looks. The picker used to sit in the board
 * manager's own scrolling form; it now lives inside `EditAutomationDialog`, a
 * NESTED dialog, so `popover-escapes-clipping.md` is at HIGHER risk than when its
 * old test was deleted, not lower.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, clickPastDragSwallow } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch /
// goto reset), so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `BoardMgrAuto Test ${Date.now()}`;
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

const dialog = () => page.locator('[data-testid="board-manager-dialog"]');
const editDialog = () => page.locator('[data-testid="edit-automation-dialog"]');

/** Open the Column Manager on a column by clicking its board header. */
async function openColumn(columnName: string): Promise<void> {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(dialog()).toBeVisible({ timeout: 3000 });
  await expect(dialog().locator('[data-testid="board-manager-tab"][data-tab-name="' + columnName + '"]'))
    .toHaveAttribute('aria-selected', 'true');
}

/** Switch the open dialog to another column. */
async function selectColumn(columnName: string): Promise<void> {
  await dialog().locator(`[data-testid="board-manager-tab"][data-tab-name="${columnName}"]`).click();
  await expect(dialog().locator('[data-testid="board-manager-section-automations"]')).toBeVisible();
}

async function openOverview(): Promise<void> {
  await dialog().locator('[data-testid="board-manager-tab-all"]').click();
  await expect(dialog().locator('[data-testid="board-manager-overview-row"]').first()).toBeVisible();
}

/**
 * `detachTimeout` is a budget, not a guess: it must fit inside the caller's own
 * per-test timeout or the test dies first and the diagnostic below never runs.
 * The default suits a test that has spent a second or two getting here; the
 * drag case passes its own, because it also calls `test.slow()`.
 */
async function saveManager(detachTimeout = 10000): Promise<void> {
  const save = dialog().locator('[data-testid="board-manager-save"]');
  // Enabled FIRST, then click. Save is disabled until the draft is dirty, and
  // under load the state that makes it dirty can land a tick after the
  // interaction that caused it; clicking a disabled button is a no-op Playwright
  // reports as success.
  await expect(save).toBeEnabled({ timeout: 5000 });
  // A click can be SWALLOWED here, and the cause is dnd-kit rather than this
  // app: `AbstractPointerSensor` arms a capture-phase `click` -> stopPropagation
  // on the DOCUMENT for the whole drag and removes it on a `setTimeout(..., 50)`
  // after the drop (`@dnd-kit/core`'s `detach`). That timer is a main-thread
  // task, so under three workers it lands late while the test keeps issuing
  // commands, and the first click anywhere on the page goes nowhere. Measured:
  // Save was enabled, hit-tested to itself, had `pointer-events: auto`, raised
  // no toast and did nothing for 25s, and a second click closed the dialog
  // immediately. So re-click rather than wait.
  //
  // Note the measurement says it HIT-TESTED TO ITSELF, which is what separates
  // this from the toast-over-the-footer swallow that `toast-click-through.spec.ts`
  // covers: there, elementFromPoint returned the toast. Do not conflate them.
  //
  // `clickPastDragSwallow` is the shared form of that retry (bounded, and it
  // stops as soon as the dialog is gone, so a save that worked is never issued
  // twice). The diagnostic poll below is what this helper adds on top.
  await clickPastDragSwallow(save, dialog(), 'detached');
  if (await dialog().count() === 0) return;
  // Poll for the close rather than waiting on it, and collect every notice seen
  // along the way. Save blocks on an empty or duplicate name and says so in a
  // toast that clears after four seconds, so reading the live DOM only once the
  // wait has given up reads an empty page and blames the timeout. Collecting as
  // we go is what turns "it did not close" into which column refused and why.
  const notices = new Set<string>();
  const deadline = Date.now() + detachTimeout;
  while (Date.now() < deadline) {
    if (await dialog().count() === 0) return;
    for (const text of await page.locator('[role="status"]').allTextContents().catch(() => [])) {
      const trimmed = text.trim();
      // dnd-kit narrates every drag into its own live region. That is not a
      // notice about the save, and printing it buries the one that is.
      if (trimmed && !trimmed.startsWith('Draggable item')) notices.add(trimmed);
    }
    await page.waitForTimeout(150);
  }
  const reason = [...notices].join(' | ');
  throw new Error(
    `The Column Manager did not close ${detachTimeout}ms after Save.`
    + (reason ? ` Notices seen while waiting: ${reason}` : ' No notice appeared at any point.'),
  );
}

async function cancelManager(): Promise<void> {
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  const discard = page.locator('button', { hasText: 'Discard' });
  if (await discard.isVisible({ timeout: 500 }).catch(() => false)) await discard.click();
  await dialog().waitFor({ state: 'detached', timeout: 3000 });
}

/** Every persisted automation, straight from the IPC surface. */
function readRows(): Promise<Array<{
  id: string;
  swimlane_id: string;
  name: string;
  type: string;
  trigger: string;
  position: number;
  enabled: boolean;
  config: Record<string, unknown>;
}>> {
  return page.evaluate(() => window.electronAPI.automations.list());
}

/** The persisted automations of one column, by column NAME. */
async function readColumnRows(columnName: string): ReturnType<typeof readRows> {
  return page.evaluate(async (name) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === name);
    const rows = await window.electronAPI.automations.list();
    return rows.filter((row) => row.swimlane_id === lane?.id);
  }, columnName);
}

/** Seed a column's automations directly, bypassing the dialog. */
async function seedColumn(
  columnName: string,
  rows: Array<{ name: string; type: string; trigger: string; enabled?: boolean; config?: Record<string, unknown> }>,
): Promise<void> {
  await page.evaluate(async ({ name, seeded }) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === name);
    if (!lane) throw new Error(`No column named ${name}`);
    await window.electronAPI.automations.replaceForColumn(
      lane.id,
      seeded.map((row) => ({
        id: '',
        swimlane_id: lane.id,
        name: row.name,
        type: row.type,
        trigger: row.trigger,
        position: 0,
        enabled: row.enabled !== false,
        config: row.config ?? {},
        created_at: '',
        updated_at: '',
      })),
      lane.id,
    );
  }, { name: columnName, seeded: rows });
}

/**
 * Pull the seeded rows into the board store, which is what the rail count and
 * the header glyph read.
 *
 * A `page.reload()` would do it in the real app and is wrong here: the mock
 * API's state lives IN the page, so a reload wipes the rows this helper just
 * seeded. Opening the Column Manager runs its mount effect, which calls
 * `loadAutomations()`, so cancelling straight back out leaves the store
 * refreshed and the board untouched.
 */
async function refreshAutomationStore(columnName: string): Promise<void> {
  await openColumn(columnName);
  await cancelManager();
}

/** Clear every column's automations, so each test starts from a known board. */
async function clearAllAutomations(): Promise<void> {
  await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    for (const lane of lanes) {
      await window.electronAPI.automations.replaceForColumn(lane.id, [], lane.id);
    }
  });
}

/** The group's Add control, then the picker option for a type. */
async function addThroughPicker(trigger: 'enter' | 'exit', type: string): Promise<void> {
  await dialog().locator(`[data-testid="column-automation-add"][data-trigger="${trigger}"]`).click();
  const picker = page.locator('[data-testid="column-automation-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-testid="column-automation-picker-type"][data-type="${type}"]`).click();
  await expect(editDialog()).toBeVisible();
}

/**
 * Change Type in the edit dialog.
 *
 * Not `selectOption`: the Type field is a button-backed listbox, not a native
 * `<select>`, because an `<option>` cannot carry the type's icon and the row and
 * the Add menu both show it.
 */
async function pickType(type: string): Promise<void> {
  await editDialog().locator('[data-testid="edit-automation-type"]').click();
  const option = page.locator(`[data-testid="edit-automation-type-option"][data-type="${type}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(editDialog().locator('[data-testid="edit-automation-type"]')).toHaveAttribute('data-value', type);
}

function row(name: string) {
  return dialog().locator(`[data-testid="column-automation-row"][data-name="${name}"]`);
}

test.describe('Column automations', () => {
  test.beforeEach(async () => {
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
  });

  test.afterEach(async () => {
    if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
      await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    }
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
  });

  // 1 ─ Add through the picker and the dialog, persist ────────────────────────

  test('adds through the picker and the dialog, and the group decides the trigger', async () => {
    await openColumn('Executing');

    await addThroughPicker('enter', 'run_script');
    // A new row opens with its name focused and selected, so typing REPLACES
    // "New Run script" rather than appending to it.
    const name = editDialog().locator('[data-testid="edit-automation-name"]');
    await expect(name).toBeFocused();
    await name.fill('Install deps');
    await editDialog().locator('[data-testid="automation-config-script"]').fill('npm ci');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();

    await addThroughPicker('enter', 'webhook');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Ping the channel');
    await editDialog().locator('[data-testid="automation-config-url"]').fill('https://hooks.example.com/abc');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();

    // Adding from the OTHER group's control needs no further step: where you
    // add is what decides when it runs.
    await addThroughPicker('exit', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Tell me');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();

    await saveManager();

    await expect.poll(async () => {
      const rows = await readColumnRows('Executing');
      return rows.map((entry) => `${entry.name}:${entry.trigger}:${entry.position}:${entry.enabled}`).join('|');
    }).toBe('Install deps:enter:0:true|Ping the channel:enter:1:true|Tell me:exit:0:true');

    const saved = await readColumnRows('Executing');
    expect(saved.find((entry) => entry.name === 'Install deps')?.config.script).toBe('npm ci');
  });

  // 2 ─ Trigger round-trip through the dialog ─────────────────────────────────

  test('changing When in the dialog moves the row between groups and renumbers both', async () => {
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
    ]);
    await openColumn('Executing');

    await row('First').locator('[data-testid="column-automation-edit"]').click();
    await editDialog().locator('[data-testid="edit-automation-trigger-exit"]').click();
    await editDialog().locator('[data-testid="edit-automation-done"]').click();

    // It leaves the enter group, which renumbers from 1, and joins the exit one.
    await expect(row('First')).toHaveAttribute('data-trigger', 'exit');
    await expect(row('Second')).toHaveAttribute('data-index', '0');

    await saveManager();
    const rows = await readColumnRows('Executing');
    expect(rows.find((entry) => entry.name === 'First')?.trigger).toBe('exit');
    expect(rows.find((entry) => entry.name === 'Second')?.trigger).toBe('enter');

    // And the overview's two counts follow it across.
    await openColumn('Executing');
    await openOverview();
    const overviewRow = dialog().locator('[data-testid="board-manager-overview-row"]', { hasText: 'Executing' });
    await expect(overviewRow.locator('[data-enter]')).toHaveAttribute('data-enter', '1');
    await expect(overviewRow.locator('[data-exit]')).toHaveAttribute('data-exit', '1');
  });

  // 3 ─ The row's own switch ──────────────────────────────────────────────────

  // The switch is the ONLY thing that says on or off. The row itself keeps the
  // same control surface either way, so there is no dimming to assert - an off
  // automation is still a thing you are configuring.
  test('the row switch is the last control, flips the row state, and persists', async () => {
    await seedColumn('Executing', [
      { name: 'Off me', type: 'run_script', trigger: 'enter', config: { script: 'echo hi' } },
    ]);
    await openColumn('Executing');

    const target = row('Off me');
    await expect(target).toHaveAttribute('data-enabled', 'true');
    await target.locator('[data-testid="column-automation-enabled"]').click();
    await expect(target).toHaveAttribute('data-enabled', 'false');

    await saveManager();
    const rows = await readColumnRows('Executing');
    expect(rows[0].enabled).toBe(false);
  });

  // Clicking the row opens the editor, but the controls inside it keep their
  // own jobs. Each of the three is its own assertion because each fails a
  // different way: the switch would toggle AND open, the trash would delete a
  // row and then open a dialog on it, and the grip would open the editor for
  // the row someone was trying to drag.
  test('clicking the row opens the editor, and its own controls do not', async () => {
    // A second row so the first one HAS a grip: a group of one is given none,
    // and the last assertion here is about what a grip click does.
    await seedColumn('Executing', [
      { name: 'Row click', type: 'run_script', trigger: 'enter', config: { script: 'echo hi' } },
      { name: 'Other', type: 'run_script', trigger: 'enter', config: { script: 'echo other' } },
    ]);
    await openColumn('Executing');

    const target = row('Row click');
    const editor = page.locator('[data-testid="edit-automation-dialog"]');

    // The row body, away from every control.
    await target.locator('[data-testid="column-automation-row-label"]').click();
    await expect(editor).toBeVisible();
    await page.locator('[data-testid="edit-automation-cancel"]').click();
    await expect(editor).toHaveCount(0);

    // The switch flips the row and leaves the editor closed.
    await target.locator('[data-testid="column-automation-enabled"]').click();
    await expect(target).toHaveAttribute('data-enabled', 'false');
    await expect(editor).toHaveCount(0);

    // The grip is for dragging; a click on it opens nothing.
    await target.locator('[data-drag-handle]').click();
    await expect(editor).toHaveCount(0);
  });

  // 4 ─ The message is a row ──────────────────────────────────────────────────
  //
  // Ported from `board-manager-dialog-ext.spec.ts`, where it tested the Session
  // card's textarea. The setting did not disappear: it became a row with the
  // same two values, edited in the nested dialog.

  test('a message is a row with its delivery mode, and the Conversation card has no message field', async () => {
    await seedColumn('Code Review', [
      { name: 'Review', type: 'send_message', trigger: 'enter', config: { message: '/code-review', mode: 'deferred' } },
    ]);
    await openColumn('Code Review');

    const target = row('Review');
    await expect(target).toBeVisible();
    // The row's sentence carries the delivery mode, which is what the pill used
    // to do in the old Session card.
    await expect(target).toContainText('after the current turn');

    // The field it replaced is gone from the settings pane entirely.
    await expect(dialog().locator('[data-testid="auto-command-input"]')).toHaveCount(0);
    await expect(dialog().locator('[data-testid="auto-command-mode"]')).toHaveCount(0);

    await target.locator('[data-testid="column-automation-edit"]').click();
    await editDialog().locator('[data-testid="automation-config-message"]').fill('/code-review main');
    await editDialog().locator('[data-testid="auto-command-mode-immediate"]').click();
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await saveManager();

    const rows = await readColumnRows('Code Review');
    expect(rows[0].config.message).toBe('/code-review main');
    expect(rows[0].config.mode).toBe('immediate');
  });

  // 5 ─ "Start an agent here" off blocks the rows that need the agent ─────────

  test('turning the agent off disables the message row and its picker option, leaving a script alone', async () => {
    await seedColumn('Code Review', [
      { name: 'Review', type: 'send_message', trigger: 'enter', config: { message: '/code-review' } },
      { name: 'Archive', type: 'run_script', trigger: 'enter', config: { script: 'echo archive' } },
    ]);
    await openColumn('Code Review');

    const autoSpawn = dialog().locator('[role="switch"][aria-label="Start an agent here"]');
    await autoSpawn.click();

    const message = row('Review');
    await expect(message).toHaveAttribute('data-can-run', 'false');
    // The DRAFT keeps its stored `enabled`, so turning the setting back on
    // restores the row rather than leaving the user to re-enable it by hand.
    await expect(message).toHaveAttribute('data-enabled', 'true');
    const messageSwitch = message.locator('[data-testid="column-automation-enabled"]');
    await expect(messageSwitch).toBeDisabled();
    await expect(messageSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(messageSwitch).toHaveAttribute('title', /Start an agent here/);

    // A script needs nothing and is untouched.
    await expect(row('Archive')).toHaveAttribute('data-can-run', 'true');

    // The picker shows the type disabled WITH the reason, rather than hiding it.
    await dialog().locator('[data-testid="column-automation-add"][data-trigger="enter"]').click();
    const picker = page.locator('[data-testid="column-automation-picker"]');
    const sendOption = picker.locator('[data-testid="column-automation-picker-type"][data-type="send_message"]');
    await expect(sendOption).toHaveAttribute('aria-disabled', 'true');
    await expect(sendOption).toContainText('Start an agent here is off.');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    // Toggle back on: the row returns to its stored state.
    await autoSpawn.click();
    await expect(message).toHaveAttribute('data-can-run', 'true');
    await expect(message.locator('[data-testid="column-automation-enabled"]')).toHaveAttribute('aria-checked', 'true');
  });

  // 6 ─ To Do and Done take exit rows only ───────────────────────────────────

  test('To Do renders the exit group only, with the reason where On enter would be', async () => {
    await openColumn('To Do');

    await expect(dialog().locator('[data-testid="column-automation-group"]')).toHaveCount(2);
    const enterGroup = dialog().locator('[data-testid="column-automation-group"][data-trigger="enter"]');
    await expect(enterGroup).toContainText('Nothing runs when a task enters To Do');
    // No Add control in the blocked group: it would only build something inert.
    await expect(enterGroup.locator('[data-testid="column-automation-add"]')).toHaveCount(0);
    await expect(dialog().locator('[data-testid="column-automation-add"][data-trigger="exit"]')).toBeVisible();

    await addThroughPicker('exit', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Reset notice');
    // The dialog's When offers On exit only, and the blocked option is disabled
    // rather than absent, so the reader can see the rule.
    await expect(editDialog().locator('[data-testid="edit-automation-trigger-enter"]')).toBeDisabled();
    await expect(editDialog().locator('[data-testid="edit-automation-trigger-exit"]')).toHaveAttribute('aria-checked', 'true');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await saveManager();

    const rows = await readColumnRows('To Do');
    expect(rows.map((entry) => `${entry.name}:${entry.trigger}`)).toEqual(['Reset notice:exit']);
  });

  // 7 ─ Delete, and Cancel undoing it ────────────────────────────────────────

  test('the trash removes the row on save, and Cancel puts it back', async () => {
    await seedColumn('Testing', [
      { name: 'Doomed', type: 'run_script', trigger: 'enter', config: { script: 'echo doomed' } },
    ]);

    // Cancel first: a delete is only real at Save.
    await openColumn('Testing');
    await row('Doomed').locator('[data-testid="column-automation-delete"]').click();
    await expect(row('Doomed')).toHaveCount(0);
    await cancelManager();
    expect((await readColumnRows('Testing')).map((entry) => entry.name)).toEqual(['Doomed']);

    // Then for real.
    await openColumn('Testing');
    await row('Doomed').locator('[data-testid="column-automation-delete"]').click();
    await saveManager();
    expect(await readColumnRows('Testing')).toEqual([]);
  });

  // 8 ─ The board header glyph counts what RUNS ──────────────────────────────

  test('the header glyph counts runnable rows, and disappears when none are left', async () => {
    await seedColumn('Merge', [
      { name: 'One', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Two', type: 'run_script', trigger: 'exit', config: { script: 'echo 2' } },
    ]);
    await refreshAutomationStore('Merge');

    const glyph = page.locator('[data-swimlane-name="Merge"] [data-testid="column-automation-glyph"]');
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveText('2');

    // A switched-off row is not counted: this answers "what happens when a task
    // moves", not "what exists".
    await openColumn('Merge');
    await row('One').locator('[data-testid="column-automation-enabled"]').click();
    await row('Two').locator('[data-testid="column-automation-enabled"]').click();
    await saveManager();

    await expect(glyph).toHaveCount(0);
  });

  // 9 ─ A copy is independent ────────────────────────────────────────────────

  test('copying a row from another column leaves the original alone', async () => {
    await seedColumn('Code Review', [
      { name: 'Shared step', type: 'run_script', trigger: 'enter', config: { script: 'echo shared' } },
    ]);
    await openColumn('Executing');

    await dialog().locator('[data-testid="column-automation-add"][data-trigger="enter"]').click();
    const picker = page.locator('[data-testid="column-automation-picker"]');
    await picker.locator('[data-testid="column-automation-picker-copy"][data-name="Shared step"]').click();

    // A copy LANDS, it does not open the dialog: it already has a name and a
    // configuration, which is exactly what a new row does not. It keeps the
    // source's trigger and arrives with the source's name, legal here because
    // uniqueness is per column.
    await expect(editDialog()).toHaveCount(0);
    await expect(row('Shared step')).toHaveAttribute('data-trigger', 'enter');

    await row('Shared step').locator('[data-testid="column-automation-edit"]').click();
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('My own step');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await saveManager();

    expect((await readColumnRows('Executing')).map((entry) => entry.name)).toEqual(['My own step']);
    const original = await readColumnRows('Code Review');
    expect(original.map((entry) => entry.name)).toEqual(['Shared step']);
    expect(original[0].config.script).toBe('echo shared');
  });

  // 10 ─ Names are unique within a column ────────────────────────────────────

  test('a duplicate name blocks Done, and the same name on another column is fine', async () => {
    await seedColumn('Executing', [
      { name: 'Taken', type: 'run_script', trigger: 'enter', config: { script: 'echo taken' } },
    ]);
    await openColumn('Executing');

    await addThroughPicker('enter', 'run_script');
    const name = editDialog().locator('[data-testid="edit-automation-name"]');
    const done = editDialog().locator('[data-testid="edit-automation-done"]');

    await name.fill('Taken');
    await expect(editDialog().locator('[data-testid="edit-automation-name-error"]')).toHaveText('Already used on this column.');
    await expect(done).toBeDisabled();

    // Case-insensitive and trimmed, so neither is a way around it.
    await name.fill('  taken  ');
    await expect(done).toBeDisabled();

    // An empty name is blocked the same way, with no error text: there is
    // nothing wrong with it yet, it is just not finished.
    await name.fill('');
    await expect(done).toBeDisabled();

    await name.fill('Not taken');
    await expect(editDialog().locator('[data-testid="edit-automation-name-error"]')).toHaveCount(0);
    await expect(done).toBeEnabled();
    await editDialog().locator('[data-testid="automation-config-script"]').fill('echo ok');
    await done.click();

    // The same name on a DIFFERENT column is fine.
    await selectColumn('Testing');
    await addThroughPicker('enter', 'run_script');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Taken');
    await expect(editDialog().locator('[data-testid="edit-automation-name-error"]')).toHaveCount(0);
    await editDialog().locator('[data-testid="automation-config-script"]').fill('echo elsewhere');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();

    await saveManager();
    expect((await readColumnRows('Executing')).map((entry) => entry.name).sort()).toEqual(['Not taken', 'Taken']);
    expect((await readColumnRows('Testing')).map((entry) => entry.name)).toEqual(['Taken']);
  });

  // 11 ─ The dialog's Cancel and Done ────────────────────────────────────────

  test('Cancel discards the dialog edit, and a cancelled NEW row leaves nothing behind', async () => {
    await seedColumn('Executing', [
      { name: 'Keep me', type: 'run_script', trigger: 'enter', config: { script: 'echo original' } },
    ]);
    await openColumn('Executing');

    await row('Keep me').locator('[data-testid="column-automation-edit"]').click();
    await editDialog().locator('[data-testid="automation-config-script"]').fill('echo replaced');
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    await expect(editDialog()).toBeHidden();
    // Untouched, so the board is still clean and Save stays disabled.
    await expect(dialog().locator('[data-testid="board-manager-save"]')).toBeDisabled();

    // A NEW row is added before it has a name, so cancelling has to remove it.
    await addThroughPicker('enter', 'webhook');
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    await expect(dialog().locator('[data-testid="column-automation-row"]')).toHaveCount(1);
    await expect(dialog().locator('[data-testid="board-manager-save"]')).toBeDisabled();
  });

  // 11b ─ Escape while editing does not fall through to the Column Manager ───
  //
  // The editor and the Column Manager both listen for Escape on `document`
  // (EditAutomationDialog's own BaseDialog, and the manager's hand-rolled
  // listener gated by `nestedModalOpen`). Before `editing` was added to that
  // set, an Escape aimed at the editor also reached the manager underneath
  // and closed the WHOLE Column Manager - with no discard confirm, since
  // merely opening the editor for an existing row leaves nothing dirty. The
  // same set gates the column-cycle keybinding, so it must stay inert too.

  test('Escape while editing an existing automation closes only the editor', async () => {
    await seedColumn('Executing', [
      { name: 'Existing row', type: 'run_script', trigger: 'enter', config: { script: 'echo hi' } },
    ]);
    await openColumn('Executing');

    await row('Existing row').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(editDialog()).toBeHidden();
    await expect(dialog()).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toHaveCount(0);

    // Reopen and confirm the column-cycle keybinding is also suppressed while
    // the editor is open: the active rail tab must not move.
    await row('Existing row').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();
    const executingTab = dialog().locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]');
    await expect(executingTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ControlOrMeta+PageDown');
    await expect(executingTab).toHaveAttribute('aria-selected', 'true');

    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
  });

  // 12 ─ Changing Type keeps what was typed ──────────────────────────────────

  test('switching Type away and back keeps the fields, and Done saves only the chosen type', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Shape shifter');
    await editDialog().locator('[data-testid="automation-config-script"]').fill('npm run build');

    await pickType('webhook');
    await expect(editDialog().locator('[data-testid="automation-config-script"]')).toHaveCount(0);
    await editDialog().locator('[data-testid="automation-config-url"]').fill('https://example.com/hook');

    await pickType('run_script');
    await expect(editDialog().locator('[data-testid="automation-config-script"]')).toHaveValue('npm run build');

    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await saveManager();

    const rows = await readColumnRows('Executing');
    expect(rows[0].type).toBe('run_script');
    expect(rows[0].config.script).toBe('npm run build');
    // The other type's key is dropped on save rather than riding along.
    expect(rows[0].config.url).toBeUndefined();
  });

  // 13 ─ When is a real radiogroup ───────────────────────────────────────────

  test('When is a two-option radiogroup its arrow keys drive', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');

    const trigger = editDialog().locator('[data-testid="edit-automation-trigger"]');
    await expect(trigger).toHaveAttribute('role', 'radiogroup');
    const enter = editDialog().locator('[data-testid="edit-automation-trigger-enter"]');
    const exit = editDialog().locator('[data-testid="edit-automation-trigger-exit"]');
    await expect(enter).toHaveAttribute('aria-checked', 'true');

    await enter.focus();
    await page.keyboard.press('ArrowRight');
    await expect(exit).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(enter).toHaveAttribute('aria-checked', 'true');
  });

  // 14 ─ All columns: one cell vocabulary ────────────────────────────────────

  test('All columns prints the real value and says only whether anyone changed it', async () => {
    await seedColumn('Executing', [
      { name: 'A', type: 'run_script', trigger: 'enter', config: { script: 'echo a' } },
      { name: 'B', type: 'run_script', trigger: 'enter', config: { script: 'echo b' } },
      { name: 'C', type: 'run_script', trigger: 'enter', enabled: false, config: { script: 'echo c' } },
    ]);
    await openColumn('Executing');
    await openOverview();

    const overviewRow = (name: string) =>
      dialog().locator('[data-testid="board-manager-overview-row"]', { hasText: name });

    // The band row spans every column exactly once. `DataTable` throws when the
    // spans do not sum, so this also proves the guard is wired rather than dead.
    const headerCells = await dialog().locator('thead tr').first().locator('th').count();
    const bodyCells = await overviewRow('Executing').locator('td').count();
    expect(headerCells).toBeGreaterThan(0);
    expect(bodyCells).toBe(10);

    // A column nobody touched prints the value its select sits on, unemphasised.
    const testing = overviewRow('Testing');
    for (const key of ['Default']) {
      await expect(testing.locator(`[data-state="unchanged"]`, { hasText: key }).first()).toBeVisible();
    }

    // A switched-off row is not counted: 3 rows, 2 of them runnable.
    await expect(overviewRow('Executing').locator('[data-enter]')).toHaveAttribute('data-enter', '2');

    // To Do has no agent at all, so those cells dash with a reason rather than
    // claiming a default they could never use. An enter row can never fire
    // there either.
    const todo = overviewRow('To Do');
    await expect(todo.locator('[data-enter] [data-state="not-applicable"]')).toBeVisible();
    await expect(todo.locator('[data-enter] [data-state="not-applicable"]')).toHaveAttribute('title', /.+/);
    await expect(todo.locator('[data-exit] [data-state="unchanged"]')).toHaveText('0');

    // The two booleans render the same switch the column page uses, read-only.
    const startSwitch = overviewRow('Executing').locator('[role="switch"]').first();
    await expect(startSwitch).toBeDisabled();
    await expect(startSwitch).toHaveAttribute('aria-checked', 'true');

    // Clicking the row selects that column, which is the only interaction here.
    await overviewRow('Executing').click();
    await expect(dialog().locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]'))
      .toHaveAttribute('aria-selected', 'true');
  });

  test('the rail glyph, the overview count and the board glyph share one predicate', async () => {
    await seedColumn('Merge', [
      { name: 'Runs', type: 'run_script', trigger: 'enter', config: { script: 'echo runs' } },
      { name: 'Off', type: 'run_script', trigger: 'enter', enabled: false, config: { script: 'echo off' } },
    ]);
    // A column whose ONLY row is switched off. This is what separates
    // presence-from-runnable (nothing shown) from presence-from-existence (a
    // glyph for a row that will never fire).
    await seedColumn('Testing', [
      { name: 'Dormant', type: 'run_script', trigger: 'enter', enabled: false, config: { script: 'echo off' } },
    ]);
    await refreshAutomationStore('Merge');

    await expect(page.locator('[data-swimlane-name="Merge"] [data-testid="column-automation-glyph"]')).toHaveText('1');

    await openColumn('Merge');
    // The rail shows PRESENCE only: a glyph, no digit. The number the two other
    // surfaces print still reaches the rail as the glyph's tooltip.
    const railRow = (name: string) => dialog().locator(`[data-testid="board-manager-tab"][data-tab-name="${name}"]`);
    const mergeGlyph = railRow('Merge').locator('[data-testid="board-manager-tab-automation"]');
    await expect(mergeGlyph).toBeVisible();
    await expect(mergeGlyph).toHaveText('');
    await expect(mergeGlyph).toHaveAttribute('title', '1 automation runs here');
    await expect(railRow('Testing').locator('[data-testid="board-manager-tab-automation"]')).toHaveCount(0);

    await openOverview();
    const mergeRow = dialog().locator('[data-testid="board-manager-overview-row"]', { hasText: 'Merge' });
    await expect(mergeRow.locator('[data-enter]')).toHaveAttribute('data-enter', '1');
  });

  // 15 ─ Reorder ────────────────────────────────────────────────────────────
  //
  // Asserted through the persisted rows rather than by driving dnd-kit's
  // KeyboardSensor, which is unreliable under Playwright. The mouse drag is the
  // real gesture and the store is the ground truth.

  test('the drag target is the full-height strip, not just the grip glyph', async () => {
    // Two rows, because one row in a group is deliberately given no grip at all.
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
    ]);
    await openColumn('Executing');

    // Hit-testing, not the class list: what the user feels is which pixels
    // start a drag, and `elementFromPoint` is the only thing that answers that.
    // The glyph alone was 13 x 13 in a 50px row, so the top and bottom thirds
    // of the gutter looked grabbable and were not.
    const probe = await row('First').evaluate((node) => {
      const rowBox = node.getBoundingClientRect();
      const handle = node.querySelector('[data-drag-handle]');
      if (!handle) throw new Error('No drag handle');
      const handleBox = handle.getBoundingClientRect();
      const at = (x: number, y: number): string => {
        const hit = document.elementFromPoint(x, y);
        if (!hit) return 'nothing';
        if (hit.closest('[data-drag-handle]')) return 'handle';
        if (hit.closest('[data-testid="column-automation-row"]')) return 'row';
        return 'other';
      };
      // Probed against the ROW's box, deliberately. Probing the handle's own
      // box asks whether the handle is where the handle is, which is true at
      // any size: the small glyph passed a top-and-bottom check written that
      // way. What the user is reaching for is the top-left of the ROW.
      const gutterX = rowBox.left + 10;
      return {
        top: at(gutterX, rowBox.top + 4),
        bottom: at(gutterX, rowBox.bottom - 4),
        besideIt: at(handleBox.right + 4, rowBox.top + rowBox.height / 2),
        // The row's own border is the 1px it does not cover, top and bottom.
        coversRowHeight: Math.round(handleBox.height) >= Math.round(rowBox.height) - 2,
        widerThanTheGlyph: handleBox.width > 20,
      };
    });

    expect(probe.top).toBe('handle');
    expect(probe.bottom).toBe('handle');
    expect(probe.coversRowHeight).toBe(true);
    expect(probe.widerThanTheGlyph).toBe(true);
    // The rest of the row still opens the editor, which is the thing the bigger
    // handle could have eaten.
    expect(probe.besideIt).toBe('row');

    // Size alone does not tell anyone where the zone ENDS, which was the other
    // half of the complaint. Hovering the row paints the strip, so the boundary
    // is visible before the drag rather than discovered by missing it.
    const handle = row('First').locator('[data-drag-handle]');
    const background = () => handle.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await background()).toBe('rgba(0, 0, 0, 0)');
    await row('First').hover();
    await expect.poll(background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a lone row in a group has no grip, and still lines up with the group above', async () => {
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
      { name: 'Only', type: 'run_script', trigger: 'exit', config: { script: 'echo 3' } },
    ]);
    await openColumn('Executing');

    const group = (trigger: string) =>
      dialog().locator(`[data-testid="column-automation-group"][data-trigger="${trigger}"]`);

    // Two rows can be ordered against each other, so both keep a grip.
    await expect(group('enter').locator('[data-drag-handle]')).toHaveCount(2);
    // One row has nothing to reorder against, so the affordance would be a lie.
    await expect(group('exit').locator('[data-drag-handle]')).toHaveCount(0);

    // The gutter survives the grip, or the lone row's text slides left of every
    // row above it. Both groups sit in one card, so that edge is read straight
    // down and a 13px step in it is obvious.
    // Both measured in ONE evaluate, and each against its OWN row's left edge.
    //
    // Two separate round trips reading absolute viewport x was wrong twice over:
    // the dialog enters at scale(0.96), so the two reads land on different
    // animation frames and the whole row moves between them, which produced a
    // spurious 2px gap that a rounding tolerance would have hidden rather than
    // fixed. A box-model probe showed the three rows byte-identical, label at
    // the same offset in each. This is the same trap `SegmentedControl` fell
    // into: absolute geometry means nothing while an ancestor is animating.
    const offsets = await dialog().evaluate((node) => {
      const read = (name: string): number | null => {
        const row = node.querySelector(`[data-testid="column-automation-row"][data-name="${name}"]`);
        const label = row?.querySelector('[data-testid="column-automation-row-label"]');
        if (!row || !label) return null;
        return label.getBoundingClientRect().left - row.getBoundingClientRect().left;
      };
      return { only: read('Only'), first: read('First') };
    });

    expect(offsets.only).not.toBeNull();
    expect(offsets.first).not.toBeNull();
    // Row-relative and same-frame, so what is left is float noise. The
    // regression this guards moves it by the whole width of the grip.
    expect(Math.abs(offsets.only! - offsets.first!)).toBeLessThan(0.5);
  });

  test('the exit budget is stated before it bites, and only where it can', async () => {
    // The cap is real and was invisible: an exit group shares 60 seconds in
    // aggregate whatever an adapter declares, so a script written for the five
    // minutes its own default allows is killed at sixty and the rows behind it
    // are skipped. A run log is too late to learn that.
    await seedColumn('Executing', [
      { name: 'Script', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Ping', type: 'notify', trigger: 'enter', config: { title: 'hi', body: 'there' } },
    ]);
    await openColumn('Executing');

    const budget = editDialog().locator('[data-testid="edit-automation-exit-budget"]');

    await row('Script').locator('[data-testid="column-automation-row-label"]').click();
    // On enter it says nothing: the enter path has no aggregate cap.
    await expect(budget).toHaveCount(0);
    await editDialog().locator('[data-testid="edit-automation-trigger-exit"]').click();
    await expect(budget).toBeVisible();
    await expect(budget).toContainText('60 seconds');
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();

    // A notify cannot outlast the budget, so warning about it there would be
    // noise on a row that will never see it fire.
    await row('Ping').locator('[data-testid="column-automation-row-label"]').click();
    await editDialog().locator('[data-testid="edit-automation-trigger-exit"]').click();
    await expect(budget).toHaveCount(0);
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
  });

  test('a dragged row stops at the bottom of its own group', async () => {
    test.slow();
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
      { name: 'Exit one', type: 'run_script', trigger: 'exit', config: { script: 'echo 3' } },
      { name: 'Exit two', type: 'run_script', trigger: 'exit', config: { script: 'echo 4' } },
    ]);
    await openColumn('Executing');

    const enterGroup = dialog().locator('[data-testid="column-automation-group"][data-trigger="enter"]');
    const groupBottom = await enterGroup.locator('ul').evaluate((node) => node.getBoundingClientRect().bottom);
    const exitRowTop = await row('Exit one').evaluate((node) => node.getBoundingClientRect().top);

    const handleBox = await row('First').locator('[data-drag-handle]').boundingBox();
    if (!handleBox) throw new Error('Row did not lay out');
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 3 });
    // Far past the On exit heading, into the other group's rows, which is what
    // the row used to follow the pointer into.
    await page.mouse.move(startX, exitRowTop + 400, { steps: 20 });
    await page.waitForTimeout(200);

    const draggedBottom = await row('First').evaluate((node) => node.getBoundingClientRect().bottom);

    // Walked back to where it started before releasing, so the drop lands the row
    // on itself and changes nothing. What is under test is how far the row may
    // travel, not where it ends up, and a drop at the far position reorders the
    // group and leaves the Column Manager dirty for whatever runs next. Escape
    // was tried for this and is worse: it cancels the drag AND closes the dialog,
    // so the release then clicks whatever was under the pointer.
    await page.mouse.move(startX, startY, { steps: 10 });
    await page.mouse.up();
    await page.mouse.move(10, 10);

    // dnd-kit arms a capture-phase click suppressor on drop, so the NEXT click
    // anywhere is swallowed. Left alone, that click is afterEach's Cancel, the
    // Column Manager stays open, and the failure surfaces in the following
    // test's setup rather than here. Spending it on the dialog's own title
    // keeps the damage inside this test.
    await dialog().locator('h3').first().click();

    // A pixel of slack for the float, and no more: the row must stop at its own
    // group's last row rather than travelling into On exit's.
    expect(draggedBottom).toBeLessThanOrEqual(groupBottom + 1);
  });

  test('dragging a row down cannot scroll the pane into empty space', async () => {
    test.slow();
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
    ]);
    await openColumn('Executing');

    const scroller = dialog().locator('[data-testid="column-automations-scroller"]');
    const metrics = () => scroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      overflow: node.scrollHeight - node.clientHeight,
    }));

    // The pane fits its rows, so it has nothing to scroll before the drag.
    expect(await metrics()).toEqual({ scrollTop: 0, overflow: 0 });

    const handleBox = await row('First').locator('[data-drag-handle]').boundingBox();
    const scrollerBox = await scroller.boundingBox();
    if (!handleBox || !scrollerBox) throw new Error('Pane did not lay out');

    // Hold the row well past the bottom of the pane. A transformed element still
    // counts toward its ancestor's scrollable overflow, so an unclamped drag
    // MAKES the pane scrollable, auto-scroll then chases the pointer into the
    // space it just created, and the row rides off the bottom of the card.
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 3 });
    await page.mouse.move(startX, scrollerBox.y + scrollerBox.height + 300, { steps: 20 });
    // Long enough for auto-scroll to have run away if it were going to: it
    // accelerates while the pointer is held past the edge.
    await page.waitForTimeout(600);

    const held = await metrics();
    await page.mouse.up();
    await page.mouse.move(10, 10);
    // Spend dnd-kit's post-drop click suppressor here rather than letting it eat
    // afterEach's Cancel, which leaves the Column Manager open and fails the NEXT
    // test's setup instead of this one.
    await dialog().locator('h3').first().click();

    expect(held).toEqual({ scrollTop: 0, overflow: 0 });
  });

  test('dragging a row above another persists the new order', async () => {
    // Headroom, not a fix. The gesture is 23 synthetic pointer events plus a
    // 200ms settle and is retried up to three times when a saturated event loop
    // starves dnd-kit's collision compute, and Save can re-click behind it; the
    // worst legal path does not fit the default budget even though the ordinary
    // one runs in under a second.
    test.slow();
    await seedColumn('Executing', [
      { name: 'First', type: 'run_script', trigger: 'enter', config: { script: 'echo 1' } },
      { name: 'Second', type: 'run_script', trigger: 'enter', config: { script: 'echo 2' } },
    ]);
    await openColumn('Executing');

    // Mirrors `board-manager-dialog-ext.spec.ts`'s rail drag, which is the one
    // gesture shape that works here: past the PointerSensor's 4px activation
    // distance first, step to the target, let dnd-kit process the final
    // pointermove, then release. A saturated event loop can still starve the
    // collision compute, so the whole gesture retries.
    const readOrder = () =>
      dialog().locator('[data-testid="column-automation-row"]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-name')).join(','));

    const dragFirstDown = async (): Promise<void> => {
      const handleBox = await row('First').locator('[data-drag-handle]').boundingBox();
      // Measured live rather than as a row-height delta: `closestCenter` only
      // swaps once the dragged row's centre passes the target's, and the target
      // translates upward as it goes, so a fixed delta can land just short.
      const targetBox = await row('Second').boundingBox();
      if (!handleBox || !targetBox) throw new Error('Rows did not lay out');
      const startX = handleBox.x + handleBox.width / 2;
      const startY = handleBox.y + handleBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY + 8, { steps: 3 });
      await page.mouse.move(startX, targetBox.y + targetBox.height * 0.9, { steps: 20 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      // Off the list afterwards. A pointer left resting on a sortable row keeps
      // dnd-kit's hover state alive, and the next click in this test is the
      // footer's Save.
      await page.mouse.move(10, 10);
    };

    // POLL after each attempt, never read once. A single read taken before
    // React has committed the drop reports the old order and sends out a second
    // gesture that was never needed, which is how a test that works serially
    // starts issuing three drags under load.
    const orderLanded = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await readOrder() === 'Second,First') return true;
        await page.waitForTimeout(100);
      }
      return false;
    };

    let reordered = false;
    for (let attempt = 0; attempt < 3 && !reordered; attempt += 1) {
      await dragFirstDown();
      reordered = await orderLanded(3000);
    }
    expect(reordered, 'the drag never reordered the group').toBe(true);

    await saveManager();
    const rows = await readColumnRows('Executing');
    expect(rows.sort((left, right) => left.position - right.position).map((entry) => entry.name))
      .toEqual(['Second', 'First']);
  });

  // ── Ported: the template picker escapes the NESTED dialog ─────────────────
  //
  // `popover-escapes-clipping.md`: a menu popover portals to `document.body`
  // with `strategy: 'fixed'`, because `z-index` cannot escape an ancestor's
  // overflow clip. The picker's old home was the board manager's scrolling
  // form; it now sits inside `EditAutomationDialog`, one dialog deeper, so the
  // invariant matters MORE here than it did where this test came from.

  test('the template-variable picker portals out of the nested dialog and inserts at the caret', async () => {
    await openColumn('Code Review');
    await addThroughPicker('enter', 'send_message');

    const message = editDialog().locator('[data-testid="automation-config-message"]');
    await message.fill('/review ');

    await editDialog().locator('[data-testid="template-variable-trigger"]').click();
    const menu = page.locator('[data-testid="template-variable-menu"]');
    await expect(menu).toBeVisible();

    // The structural property, which geometry cannot see: `boundingBox()`
    // ignores overflow clipping, so a clipped menu measures as visible.
    const nesting = await menu.evaluate((node) => ({
      inEditDialog: !!node.closest('[data-testid="edit-automation-dialog"]'),
      inBoardManager: !!node.closest('[data-testid="board-manager-dialog"]'),
    }));
    expect(nesting.inEditDialog).toBe(false);
    expect(nesting.inBoardManager).toBe(false);

    await menu.getByText('{{title}}', { exact: true }).click();
    await expect(menu).toBeHidden();
    // The trailing space comes with the chip: accepting a variable leaves the
    // caret ready for the rest of the sentence rather than butted against `}}`.
    await expect(message).toHaveValue('/review {{title}} ');
  });

  test('the picker offers the automation context variables and says which are usually empty', async () => {
    await openColumn('Code Review');
    await addThroughPicker('enter', 'send_message');

    await editDialog().locator('[data-testid="template-variable-trigger"]').click();
    const menu = page.locator('[data-testid="template-variable-menu"]');

    // Move variables exist only for an automation, and are the pair this whole
    // feature made possible.
    await expect(menu.getByText('{{fromColumn}}', { exact: true })).toBeVisible();
    await expect(menu.getByText('{{toColumn}}', { exact: true })).toBeVisible();
    await expect(menu.getByText('{{trigger}}', { exact: true })).toBeVisible();

    // A value that is usually empty says so, rather than being offered as if it
    // always resolves.
    await expect(menu).toContainText('Empty until a PR is linked');

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });
});
