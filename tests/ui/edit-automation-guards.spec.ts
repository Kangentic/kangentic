/**
 * UI tests for what #732 Phase A added to the automation editor and the pane
 * that lists it: the Condition and Frequency cards, the third trigger (On agent
 * turn end), the Move to column type, and the board glyph's turn-end count.
 *
 * `board-manager-automations.spec.ts` covers the dialog's older half (add, edit,
 * reorder, copy, delete). This file is the new half, and is split out so a
 * failure here names the guard or the trigger rather than the whole surface.
 *
 * Nothing here needs a real agent. The Automation agent is a config choice
 * (`automation.agent` and `automation.model`), so each test sets exactly the
 * one it is about, through the config store, because the Column Manager reads
 * that store and a raw `config.set` would leave it stale.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Locator, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch /
// goto reset), so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `EditAutomationGuards Test ${Date.now()}`;
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

/** One of the editor's cards: trigger, condition, frequency or action. */
function card(name: 'trigger' | 'condition' | 'frequency' | 'action'): Locator {
  return editDialog().locator(`[data-testid="edit-automation-card-${name}"]`);
}

/** The line each guard card prints under its title. Clicked, not the switch beside it. */
const CONDITION_DESCRIPTION = 'Describe it in plain words; an agent checks it.';
const FREQUENCY_DESCRIPTION = 'How many times it can run on a task.';

type AutomationTriggerName = 'enter' | 'turn_end' | 'exit';

/** Open the Column Manager on a column by clicking its board header. */
async function openColumn(columnName: string): Promise<void> {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(dialog()).toBeVisible({ timeout: 3000 });
  await expect(dialog().locator('[data-testid="board-manager-tab"][data-tab-name="' + columnName + '"]'))
    .toHaveAttribute('aria-selected', 'true');
}

async function cancelManager(): Promise<void> {
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  const discard = page.locator('button', { hasText: 'Discard' });
  if (await discard.isVisible({ timeout: 500 }).catch(() => false)) await discard.click();
  await dialog().waitFor({ state: 'detached', timeout: 3000 });
}

/** No drag happens in this file, so unlike the older spec there is no swallowed click to retry past. */
async function saveManager(): Promise<void> {
  const save = dialog().locator('[data-testid="board-manager-save"]');
  await expect(save).toBeEnabled({ timeout: 5000 });
  await save.click();
  await dialog().waitFor({ state: 'detached', timeout: 5000 });
}

interface PersistedRow {
  id: string;
  swimlane_id: string;
  name: string;
  type: string;
  trigger: string;
  position: number;
  enabled: boolean;
  config: Record<string, unknown>;
  condition: string | null;
  max_runs: number | null;
}

/** The persisted automations of one column, by column NAME, straight from the IPC surface. */
async function readColumnRows(columnName: string): Promise<PersistedRow[]> {
  return page.evaluate(async (name) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === name);
    const rows = await window.electronAPI.automations.list();
    return rows.filter((entry) => entry.swimlane_id === lane?.id) as unknown as PersistedRow[];
  }, columnName);
}

interface SeedRow {
  name: string;
  type: string;
  trigger: AutomationTriggerName;
  enabled?: boolean;
  config?: Record<string, unknown>;
  condition?: string | null;
  maxRuns?: number | null;
}

/** Seed a column's automations directly, bypassing the dialog. */
async function seedColumn(columnName: string, rows: SeedRow[]): Promise<void> {
  await page.evaluate(async ({ name, seeded }) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === name);
    if (!lane) throw new Error(`No column named ${name}`);
    await window.electronAPI.automations.replaceForColumn(
      lane.id,
      seeded.map((entry) => ({
        id: '',
        swimlane_id: lane.id,
        name: entry.name,
        type: entry.type,
        trigger: entry.trigger,
        position: 0,
        enabled: entry.enabled !== false,
        config: entry.config ?? {},
        condition: entry.condition ?? null,
        max_runs: entry.maxRuns ?? null,
        created_at: '',
        updated_at: '',
      })) as never,
      lane.id,
    );
  }, { name: columnName, seeded: rows });
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

/**
 * Pull the seeded rows into the board store, which is what the header glyph
 * reads. Opening the Column Manager runs its mount effect, which calls
 * `loadAutomations()`. A `page.reload()` would wipe the mock's in-page state.
 */
async function refreshAutomationStore(columnName: string): Promise<void> {
  await openColumn(columnName);
  await cancelManager();
}

/**
 * Choose (or clear) the Automation agent through the config store. The Column
 * Manager reads `globalConfig` from that store, so a bare `config.set` would
 * persist the value and leave the mounted dialog on the old answer.
 *
 * The mock's Claude entry answers with a model, so an agent alone is still not
 * set up: both are needed.
 */
async function setAutomationAgent(choice: { agent: string | null; model: string | null }): Promise<void> {
  await page.evaluate(async (next) => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: object) => Promise<unknown> } } };
    }).__zustandStores;
    await stores.config.getState().updateConfig({ automation: next });
  }, choice);
}

/** The group's Add control, then the picker option for a type. */
async function addThroughPicker(trigger: AutomationTriggerName, type: string): Promise<void> {
  await dialog().locator(`[data-testid="column-automation-add"][data-trigger="${trigger}"]`).click();
  const picker = page.locator('[data-testid="column-automation-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-testid="column-automation-picker-type"][data-type="${type}"]`).click();
  await expect(editDialog()).toBeVisible();
}

/** Change Type in the edit dialog. The Type field is a button-backed listbox, not a native select. */
async function pickType(type: string): Promise<void> {
  await editDialog().locator('[data-testid="edit-automation-type"]').click();
  const option = page.locator(`[data-testid="edit-automation-type-option"][data-type="${type}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(editDialog().locator('[data-testid="edit-automation-type"]')).toHaveAttribute('data-value', type);
}

function row(name: string): Locator {
  return dialog().locator(`[data-testid="column-automation-row"][data-name="${name}"]`);
}

test.describe('Edit automation: guards, turn end and Move to column', () => {
  test.beforeEach(async () => {
    if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
      await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    }
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
    // Every test starts with no Automation agent; the ones that need one say so.
    await setAutomationAgent({ agent: null, model: null });
  });

  test.afterEach(async () => {
    if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
      await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    }
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
  });

  // 1 - A click on a card header flips its switch ────────────────────────────

  test('a click on the Condition header flips its switch and unlocks the field, and Frequency does the same', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    const conditionSwitch = card('condition').locator('[data-testid="edit-automation-card-condition-switch"]');
    const conditionField = editDialog().locator('[data-testid="edit-automation-condition"]');

    // Off, the field keeps its place: dimmed and not editable.
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(conditionField).toBeDisabled();

    // The description line, not the switch: a click anywhere on the header flips it.
    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(conditionField).toBeEnabled();
    await conditionField.fill('The review is clean');

    // Off again: locked, and showing nothing. On again: what was written returns.
    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(conditionField).toBeDisabled();
    await expect(conditionField).toHaveValue('');
    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(conditionField).toHaveValue('The review is clean');

    const frequencySwitch = card('frequency').locator('[data-testid="edit-automation-card-frequency-switch"]');
    const stepperValue = editDialog().locator('[data-testid="edit-automation-max-runs-value"]');
    const stepperMore = editDialog().locator('[data-testid="edit-automation-max-runs-increment"]');

    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'false');
    await expect(stepperValue).toBeDisabled();
    await expect(stepperMore).toBeDisabled();

    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'true');
    await expect(stepperValue).toBeEnabled();
    await expect(stepperMore).toBeEnabled();
    await expect(stepperValue).toHaveValue('1');
    await stepperMore.click();
    await expect(stepperValue).toHaveValue('2');

    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'false');
    await expect(stepperValue).toBeDisabled();
    await expect(stepperMore).toBeDisabled();
  });

  test('the guards set in the dialog show on the row, and Save persists them', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Ping');

    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await editDialog().locator('[data-testid="edit-automation-condition"]').fill('CI is green');
    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    await editDialog().locator('[data-testid="edit-automation-max-runs-increment"]').click();
    await editDialog().locator('[data-testid="edit-automation-max-runs-increment"]').click();
    await expect(editDialog().locator('[data-testid="edit-automation-max-runs-value"]')).toHaveValue('3');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();

    await expect(row('Ping').locator('[data-testid="column-automation-guards"]'))
      .toHaveText('Only if CI is green. At most 3 times for each task.');

    await saveManager();
    const saved = (await readColumnRows('Executing')).find((entry) => entry.name === 'Ping');
    expect(saved?.condition).toBe('CI is green');
    expect(saved?.max_runs).toBe(3);
  });

  // 2 - Move to column is a turn-end type ────────────────────────────────────

  test('Move to column disables the enter and exit triggers with the reason, and keeps turn end', async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'move_to_column');

    const enter = editDialog().locator('[data-testid="edit-automation-trigger-enter"]');
    const turnEnd = editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]');
    const exit = editDialog().locator('[data-testid="edit-automation-trigger-exit"]');

    await expect(turnEnd).toHaveAttribute('aria-checked', 'true');
    await expect(turnEnd).toBeEnabled();
    for (const blocked of [enter, exit]) {
      await expect(blocked).toBeDisabled();
      // The reason rides the option as its hover tip, so a disabled option
      // says why instead of just refusing.
      await expect(blocked).toHaveAttribute('title', /\S/);
      await expect(blocked).toHaveAttribute('title', /turn end/i);
    }

    // A click on a blocked option changes nothing.
    await enter.click({ force: true });
    await expect(turnEnd).toHaveAttribute('aria-checked', 'true');
    await expect(enter).toHaveAttribute('aria-checked', 'false');
  });

  test('switching a row to Move to column moves it to turn end, the one trigger it takes', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');
    const enter = editDialog().locator('[data-testid="edit-automation-trigger-enter"]');
    const turnEnd = editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]');
    await expect(enter).toHaveAttribute('aria-checked', 'true');
    await expect(enter).toBeEnabled();

    await pickType('move_to_column');
    await expect(turnEnd).toHaveAttribute('aria-checked', 'true');
    await expect(enter).toBeDisabled();
    await expect(editDialog().locator('[data-testid="edit-automation-trigger-exit"]')).toBeDisabled();
  });

  // 3 - The pane's groups and the guard line ─────────────────────────────────

  test('the pane stacks enter, turn end and exit, and a guarded row says so under its sentence', async () => {
    await seedColumn('Executing', [
      { name: 'Plain', type: 'run_script', trigger: 'enter', config: { script: 'echo plain' } },
      {
        name: 'Hand off',
        type: 'move_to_column',
        trigger: 'turn_end',
        config: { targetColumn: 'Testing' },
        condition: 'The review is clean',
        maxRuns: 3,
      },
      { name: 'Tell me', type: 'notify', trigger: 'exit', config: { title: 'Done here' } },
    ]);
    await openColumn('Executing');

    const groups = dialog().locator('[data-testid="column-automation-group"]');
    await expect(groups).toHaveCount(3);
    expect(await groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-trigger'))))
      .toEqual(['enter', 'turn_end', 'exit']);
    await expect(groups.nth(0)).toContainText('On task enter');
    await expect(groups.nth(1)).toContainText('On agent turn end');
    await expect(groups.nth(2)).toContainText('On task exit');
    // A normal column can add to all three.
    for (const trigger of ['enter', 'turn_end', 'exit']) {
      await expect(dialog().locator(`[data-testid="column-automation-add"][data-trigger="${trigger}"]`)).toBeVisible();
    }

    // The row lands in its own group, and carries both guards in the order the rule runs.
    await expect(groups.nth(1).locator('[data-testid="column-automation-row"]')).toHaveCount(1);
    await expect(row('Hand off')).toHaveAttribute('data-trigger', 'turn_end');
    await expect(row('Hand off').locator('[data-testid="column-automation-guards"]'))
      .toHaveText('Only if the review is clean. At most 3 times for each task.');

    // A row with no guard stays two lines: nothing is printed for it.
    await expect(row('Plain').locator('[data-testid="column-automation-guards"]')).toHaveCount(0);
    await expect(row('Tell me').locator('[data-testid="column-automation-guards"]')).toHaveCount(0);
  });

  test('a row with one guard prints only that guard', async () => {
    await seedColumn('Executing', [
      { name: 'Only condition', type: 'notify', trigger: 'exit', config: { title: 'a' }, condition: 'CI is green.' },
      { name: 'Only once', type: 'notify', trigger: 'exit', config: { title: 'b' }, maxRuns: 1 },
    ]);
    await openColumn('Executing');

    // A leading acronym keeps its capitals, and the sentence's own full stop is not doubled.
    await expect(row('Only condition').locator('[data-testid="column-automation-guards"]'))
      .toHaveText('Only if CI is green.');
    await expect(row('Only once').locator('[data-testid="column-automation-guards"]'))
      .toHaveText('At most once for each task.');
  });

  // 4 - The Condition card without an Automation agent ───────────────────────

  test('with no Automation agent the Condition card offers setup, not a field', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    const conditionSwitch = card('condition').locator('[data-testid="edit-automation-card-condition-switch"]');
    await expect(conditionSwitch).toBeDisabled();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');

    const setup = card('condition').locator('[data-testid="edit-automation-condition-setup"]');
    await expect(setup).toBeVisible();
    await expect(setup).toContainText('Set up an Automation agent');
    await expect(setup.locator('[data-testid="edit-automation-open-settings"]')).toHaveText('Open Settings');

    // Nothing to write a condition into, and no variable to put in it.
    await expect(card('condition').locator('[data-testid="edit-automation-condition"]')).toHaveCount(0);
    await expect(card('condition').locator('[data-testid="template-variable-trigger"]')).toHaveCount(0);

    // A click on the header cannot switch it on either.
    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(setup).toBeVisible();
  });

  test('an agent without a model is still not set up', async () => {
    // The mock's Claude entry answers with a model, so an agent alone leaves the
    // card on its notice. This is what keeps the card from offering a switch the
    // engine would then skip.
    await setAutomationAgent({ agent: 'claude', model: null });
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    await expect(card('condition').locator('[data-testid="edit-automation-condition-setup"]')).toBeVisible();
    await expect(card('condition').locator('[data-testid="edit-automation-card-condition-switch"]')).toBeDisabled();
    await expect(card('condition').locator('[data-testid="edit-automation-condition"]')).toHaveCount(0);
  });

  test('with an agent and a model the Condition card has its field, picker and a live switch', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    await expect(card('condition').locator('[data-testid="edit-automation-condition-setup"]')).toHaveCount(0);
    await expect(card('condition').locator('[data-testid="edit-automation-open-settings"]')).toHaveCount(0);
    const conditionSwitch = card('condition').locator('[data-testid="edit-automation-card-condition-switch"]');
    await expect(conditionSwitch).toBeEnabled();
    await expect(card('condition').locator('[data-testid="edit-automation-condition"]')).toBeVisible();
    await expect(card('condition').locator('[data-testid="template-variable-trigger"]')).toBeVisible();

    await conditionSwitch.click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(card('condition').locator('[data-testid="edit-automation-condition"]')).toBeEnabled();
  });

  // 5 - Move to column's fields, and the new row's name ──────────────────────

  test("Move to column's Message is tagged Optional and has no placeholder, and Column starts at Next column", async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'move_to_column');

    const message = card('action').locator('[data-testid="automation-config-message"]');
    await expect(message).toBeVisible();
    // No placeholder: an example in a field that is allowed to stay empty reads as a default.
    expect((await message.getAttribute('placeholder')) ?? '').toBe('');
    // The tag sits in the Message label's own row, not elsewhere in the card.
    const labelRow = card('action').getByText('Message', { exact: true }).locator('xpath=..');
    await expect(labelRow.getByText('Optional', { exact: true })).toBeVisible();
    // Column is the required half, so it carries no tag.
    const columnLabelRow = card('action').getByText('Column', { exact: true }).locator('xpath=..');
    await expect(columnLabelRow.getByText('Optional', { exact: true })).toHaveCount(0);

    const target = card('action').locator('[data-testid="automation-config-targetColumn"]');
    await expect(target.locator('option').first()).toHaveText('Next column');
    await expect(target).toHaveValue('');
    // The board's other columns follow, and the column being edited is not offered.
    await expect(target.locator('option', { hasText: 'Testing' })).toHaveCount(1);
    await expect(target.locator('option', { hasText: 'Executing' })).toHaveCount(0);
  });

  test('a new automation opens with its generated name selected, so typing replaces it', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    const name = editDialog().locator('[data-testid="edit-automation-name"]');
    await expect(name).toBeFocused();
    await expect.poll(() => name.evaluate((node) => {
      const input = node as HTMLInputElement;
      return input.value.length > 0
        && input.selectionStart === 0
        && input.selectionEnd === input.value.length;
    }), { message: 'the generated name should be fully selected' }).toBe(true);

    await page.keyboard.type('Reviewed');
    await expect(name).toHaveValue('Reviewed');
  });

  // 6 - The board glyph counts turn-end rows ─────────────────────────────────

  test('the header glyph shows the turn-end count for a column with one turn-end row', async () => {
    await seedColumn('Testing', [
      { name: 'Tell me', type: 'notify', trigger: 'turn_end', config: { title: 'Turn ended' } },
    ]);
    await refreshAutomationStore('Testing');

    const glyph = page.locator('[data-swimlane-name="Testing"] [data-testid="column-automation-glyph"]');
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveAttribute('data-turn-end', '1');
    await expect(glyph).toHaveAttribute('data-enter', '0');
    await expect(glyph).toHaveAttribute('data-exit', '0');
    await expect(glyph).toHaveText('1');
    await expect(glyph).toHaveAttribute('title', /1 at a turn end/);
  });

  test('the glyph adds turn-end rows to the other two counts, and skips a column no agent works in', async () => {
    await seedColumn('Merge', [
      { name: 'On the way in', type: 'notify', trigger: 'enter', config: { title: 'in' } },
      { name: 'Each turn', type: 'notify', trigger: 'turn_end', config: { title: 'turn' } },
      { name: 'On the way out', type: 'notify', trigger: 'exit', config: { title: 'out' } },
    ]);
    // To Do has no agent, so a turn-end row there can never fire and is not counted.
    await seedColumn('To Do', [
      { name: 'Never fires', type: 'notify', trigger: 'turn_end', config: { title: 'x' } },
    ]);
    await refreshAutomationStore('Merge');

    const mergeGlyph = page.locator('[data-swimlane-name="Merge"] [data-testid="column-automation-glyph"]');
    await expect(mergeGlyph).toHaveAttribute('data-enter', '1');
    await expect(mergeGlyph).toHaveAttribute('data-turn-end', '1');
    await expect(mergeGlyph).toHaveAttribute('data-exit', '1');
    await expect(mergeGlyph).toHaveText('3');
    await expect(page.locator('[data-swimlane-name="To Do"] [data-testid="column-automation-glyph"]')).toHaveCount(0);
  });
});
