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
const CONDITION_DESCRIPTION = 'Runs only when this holds.';
/** The hover reason a disabled Text match option carries off a turn end. */
const TEXT_MATCH_UNAVAILABLE = "Text match reads the agent's last message, so it runs on agent turn end only.";
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
  // Cancel either closes the manager or, with a dirty draft, raises the
  // Discard confirm first. Wait for whichever happens: `isVisible` takes no
  // timeout (Playwright ignores it), so it could look before the confirm drew.
  const discard = page.locator('button', { hasText: 'Discard' });
  const outcome = await Promise.race([
    discard.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'confirm' as const, () => 'none' as const),
    dialog().waitFor({ state: 'detached', timeout: 3000 }).then(() => 'closed' as const, () => 'none' as const),
  ]);
  if (outcome === 'confirm') await discard.click();
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
  final_line: string | null;
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
  finalLine?: string | null;
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
        final_line: entry.finalLine ?? null,
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

/** One entry of the Type field's open listbox. */
function typeOption(type: string): Locator {
  return page.locator(`[data-testid="edit-automation-type-option"][data-type="${type}"]`);
}

/** Open the Type field's listbox and return its entries. */
async function openTypeOptions(): Promise<Locator> {
  await editDialog().locator('[data-testid="edit-automation-type"]').click();
  const options = page.locator('[data-testid="edit-automation-type-option"]');
  await expect(options.first()).toBeVisible();
  return options;
}

/** Escape closes the open listbox and leaves the editor under it open. */
async function closeTypeOptions(options: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(editDialog()).toBeVisible();
}

function row(name: string): Locator {
  return dialog().locator(`[data-testid="column-automation-row"][data-name="${name}"]`);
}

/** A row's first line: its name, then its guard marks. */
function titleLine(name: string): Locator {
  return row(name).locator('[data-testid="column-automation-row-title"]');
}

/** The Condition mark, looked up on the name's line so a mark anywhere else does not count. */
function conditionMark(name: string): Locator {
  return titleLine(name).locator('[data-testid="column-automation-condition-mark"]');
}

/** The Text match mark: a Condition of the other kind, on the name's line the same way. */
function textMatchMark(name: string): Locator {
  return titleLine(name).locator('[data-testid="column-automation-text-match-mark"]');
}

/** One option of the Condition card's kind control. */
function conditionKind(kind: 'agent' | 'text'): Locator {
  return card('condition').locator(`[data-testid="edit-automation-condition-kind-${kind}"]`);
}

/** The Frequency mark, looked up on the name's line for the same reason. */
function frequencyMark(name: string): Locator {
  return titleLine(name).locator('[data-testid="column-automation-frequency-mark"]');
}

/** An action's own mark (Delivery or Message), on the name's line like the guards. */
function markOf(name: string, kind: 'delivery' | 'message'): Locator {
  return titleLine(name).locator(`[data-testid="column-automation-${kind}-mark"]`);
}

/**
 * A mark says its guard in its aria-label, which is also its accessible name. Its tip is the
 * same text, so it is not read a second time as a description.
 */
async function expectMarkSays(mark: Locator, sentence: string): Promise<void> {
  await expect(mark).toHaveAttribute('role', 'img');
  await expect(mark).toHaveAttribute('aria-label', sentence);
  await expect(mark).toHaveAccessibleName(sentence);
  await expect(mark).toHaveAccessibleDescription('');
  await expect(mark.locator('svg')).toHaveCount(1);
}

/**
 * The row is two lines whatever its guards: the name's line and the action
 * sentence. The old third line (its test id, and the words it printed) is gone,
 * and no guard word sits beside the icons. `toContainText` reads text content,
 * not attributes, so the tooltips do not count against it.
 */
async function expectTwoLines(name: string, sentence?: string): Promise<void> {
  const label = row(name).locator('[data-testid="column-automation-row-label"]');
  expect(await label.evaluate((node) => Array.from(node.children).map((child) => child.getAttribute('data-testid'))))
    .toEqual(['column-automation-row-title', 'column-automation-row-sentence']);
  if (sentence !== undefined) {
    await expect(row(name).locator('[data-testid="column-automation-row-sentence"]')).toHaveText(sentence);
  }
  await expect(row(name).locator('[data-testid="column-automation-guards"]')).toHaveCount(0);
  await expect(row(name)).not.toContainText('Only if');
  await expect(row(name)).not.toContainText('for each task');
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

    // Off, the whole panel reads dimmed: the Maximum runs label as well as
    // the stepper (board 15c), not the stepper alone.
    const maxRunsLabel = editDialog().locator('[data-testid="edit-automation-max-runs-label"]');

    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'false');
    await expect(stepperValue).toBeDisabled();
    await expect(stepperMore).toBeDisabled();
    await expect(maxRunsLabel).toHaveAttribute('data-dimmed', 'true');

    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'true');
    await expect(stepperValue).toBeEnabled();
    await expect(stepperMore).toBeEnabled();
    await expect(maxRunsLabel).toHaveAttribute('data-dimmed', 'false');
    await expect(stepperValue).toHaveValue('1');
    await stepperMore.click();
    await expect(stepperValue).toHaveValue('2');

    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    await expect(frequencySwitch).toHaveAttribute('aria-checked', 'false');
    await expect(stepperValue).toBeDisabled();
    await expect(stepperMore).toBeDisabled();
    await expect(maxRunsLabel).toHaveAttribute('data-dimmed', 'true');
  });

  // 1b - Maximum runs: the arrow keys step from what is typed ───────────────

  /**
   * Open a new Notify automation named Ping, turn Frequency on, and step
   * Maximum runs to 3 with the plus button. A click commits, so 3 is the
   * committed value and nothing is being typed yet. Returns the value input.
   */
  async function openMaximumRunsAtThree(): Promise<Locator> {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Ping');
    await card('frequency').getByText(FREQUENCY_DESCRIPTION).click();
    const increment = editDialog().locator('[data-testid="edit-automation-max-runs-increment"]');
    await increment.click();
    await increment.click();
    const maxRuns = editDialog().locator('[data-testid="edit-automation-max-runs-value"]');
    await expect(maxRuns).toHaveValue('3');
    return maxRuns;
  }

  test('ArrowUp in Maximum runs steps from what is typed and commits it, so the blur keeps the step', async () => {
    const maxRuns = await openMaximumRunsAtThree();

    // 7 is typed over the committed 3 and not yet committed. ArrowUp must step
    // from the 7 (to 8) and clear the typed text. Stepping from the committed
    // 3 left the typed 7 showing, and the blur then committed 7 over the step.
    await maxRuns.fill('7');
    await expect(maxRuns).toHaveValue('7');
    await maxRuns.press('ArrowUp');
    await expect(maxRuns).toHaveValue('8');

    // After the blur the field shows the committed value, so this reads what
    // the dialog's draft holds, not leftover typed text.
    await maxRuns.blur();
    await expect(maxRuns).toHaveValue('8');

    // The draft carries it out of the dialog: the row's Frequency mark says 8.
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();
    await expect(frequencyMark('Ping')).toHaveAttribute('aria-label', 'Frequency: at most 8 times for each task.');
  });

  test('ArrowDown in Maximum runs steps from what is typed and commits it, so the blur keeps the step', async () => {
    const maxRuns = await openMaximumRunsAtThree();

    await maxRuns.fill('7');
    await expect(maxRuns).toHaveValue('7');
    await maxRuns.press('ArrowDown');
    await expect(maxRuns).toHaveValue('6');

    await maxRuns.blur();
    await expect(maxRuns).toHaveValue('6');
  });

  test('an arrow key in Maximum runs with nothing typed steps from the committed value', async () => {
    const maxRuns = await openMaximumRunsAtThree();

    await maxRuns.press('ArrowUp');
    await expect(maxRuns).toHaveValue('4');
    await maxRuns.press('ArrowDown');
    await expect(maxRuns).toHaveValue('3');

    // Nothing was typed, so the blur has nothing to commit over the steps.
    await maxRuns.blur();
    await expect(maxRuns).toHaveValue('3');
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

    // Marks beside the name, not words under the sentence.
    await expectMarkSays(conditionMark('Ping'), 'Condition: only if CI is green.');
    await expectMarkSays(frequencyMark('Ping'), 'Frequency: at most 3 times for each task.');
    await expect(frequencyMark('Ping').locator('[data-testid="column-automation-frequency-count"]')).toHaveText('3');
    await expectTwoLines('Ping');

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
      // says why instead of just refusing. One short line (board 15c).
      await expect(blocked).toHaveAccessibleDescription('Move to column runs only at a turn end.');
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

  // 2b - The Type picker lists what the column can run ───────────────────────

  test('the Type picker leaves Move to column out of To Do, where no agent ever ends a turn', async () => {
    await openColumn('To Do');
    await addThroughPicker('exit', 'notify');

    const options = await openTypeOptions();
    // The listbox is really open, and still offers what To Do can run on exit.
    await expect(typeOption('run_script')).toBeVisible();
    await expect(typeOption('notify')).toBeVisible();
    await expect(typeOption('move_to_column')).toHaveCount(0);

    await closeTypeOptions(options);
  });

  test('the Type picker leaves Move to column out of a column that starts no agent', async () => {
    await openColumn('Testing');
    await dialog().locator('[role="switch"][aria-label="Start an agent here"]').click();
    await addThroughPicker('exit', 'run_script');

    const options = await openTypeOptions();
    await expect(typeOption('run_script')).toBeVisible();
    await expect(typeOption('notify')).toBeVisible();
    await expect(typeOption('move_to_column')).toHaveCount(0);

    await closeTypeOptions(options);
  });

  // The other half, a column that CAN end a turn offering Move to column and
  // landing on turn end when it is chosen, is the test above this group:
  // "switching a row to Move to column moves it to turn end". `pickType` there
  // waits for the option to be visible before it clicks it.

  test('a row on a turn end the column can no longer run keeps its type listed, and a type change lands it on a trigger that runs', async () => {
    await seedColumn('Testing', [
      { name: 'Tell me', type: 'notify', trigger: 'turn_end', config: { title: 'Turn ended' } },
    ]);
    await openColumn('Testing');
    // The column stops starting an agent after the row was written, so its turn
    // end is now a trigger nothing runs on.
    await dialog().locator('[role="switch"][aria-label="Start an agent here"]').click();
    await row('Tell me').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();
    const enter = editDialog().locator('[data-testid="edit-automation-trigger-enter"]');
    const turnEnd = editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]');
    await expect(turnEnd).toHaveAttribute('aria-checked', 'true');
    await expect(turnEnd).toBeDisabled();

    const options = await openTypeOptions();
    // The row's own type stays listed so it still reads what it is.
    await expect(typeOption('notify')).toBeVisible();
    await expect(typeOption('move_to_column')).toHaveCount(0);
    await typeOption('run_script').click();
    await expect(options).toHaveCount(0);

    // Run script is allowed at a turn end by its type, but this column cannot
    // run one, so the row moves to the first trigger that does.
    await expect(editDialog().locator('[data-testid="edit-automation-type"]')).toHaveAttribute('data-value', 'run_script');
    await expect(enter).toHaveAttribute('aria-checked', 'true');
    await expect(turnEnd).toHaveAttribute('aria-checked', 'false');
  });

  // 3 - The pane's groups and the guard marks ────────────────────────────────

  test('the pane stacks enter, turn end and exit, and a guarded row marks its guards beside its name', async () => {
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

    // The row lands in its own group, and marks both guards on the name's line,
    // in the order the rule runs. The words are in the marks' labels, not on the row.
    await expect(groups.nth(1).locator('[data-testid="column-automation-row"]')).toHaveCount(1);
    await expect(row('Hand off')).toHaveAttribute('data-trigger', 'turn_end');
    await expectMarkSays(conditionMark('Hand off'), 'Condition: only if the review is clean.');
    // An Agent evaluation's mark is its kind's icon, the same one the kind control shows.
    await expect(conditionMark('Hand off').locator('svg.lucide-bot')).toHaveCount(1);
    await expectMarkSays(frequencyMark('Hand off'), 'Frequency: at most 3 times for each task.');
    await expect(frequencyMark('Hand off').locator('[data-testid="column-automation-frequency-count"]')).toHaveText('3');
    expect(await titleLine('Hand off').evaluate((node) =>
      Array.from(node.children).map((child) => child.getAttribute('data-testid')).filter((id) => id !== null)))
      .toEqual(['column-automation-condition-mark', 'column-automation-frequency-mark']);
    // Line two is the action sentence, with no full stop, and there is no line three.
    await expectTwoLines('Hand off', 'Moves the task to Testing');

    // A row with no guard has no mark, and the same two lines.
    for (const [name, sentence] of [['Plain', 'Runs echo plain'], ['Tell me', 'Notifies "Done here"']]) {
      await expect(conditionMark(name)).toHaveCount(0);
      await expect(frequencyMark(name)).toHaveCount(0);
      await expectTwoLines(name, sentence);
    }
  });

  test('a row with one guard shows only that guard\'s mark', async () => {
    await seedColumn('Executing', [
      { name: 'Only condition', type: 'notify', trigger: 'exit', config: { title: 'a' }, condition: 'CI is green.' },
      { name: 'Only once', type: 'notify', trigger: 'exit', config: { title: 'b' }, maxRuns: 1 },
    ]);
    await openColumn('Executing');

    // A leading acronym keeps its capitals, and the sentence's own full stop is not doubled.
    await expectMarkSays(conditionMark('Only condition'), 'Condition: only if CI is green.');
    await expect(frequencyMark('Only condition')).toHaveCount(0);
    await expectTwoLines('Only condition', 'Notifies "a"');

    // One run reads "once" in the label, and the mark shows the bare count.
    await expectMarkSays(frequencyMark('Only once'), 'Frequency: at most once for each task.');
    await expect(frequencyMark('Only once').locator('[data-testid="column-automation-frequency-count"]')).toHaveText('1');
    await expect(conditionMark('Only once')).toHaveCount(0);
    await expectTwoLines('Only once', 'Notifies "b"');
  });

  test('a long name truncates before the guard marks give ground', async () => {
    const longName = 'Hand the task back to planning whenever the review finds anything the implementer can still fix';
    await seedColumn('Executing', [
      {
        name: longName,
        type: 'move_to_column',
        trigger: 'turn_end',
        config: { targetColumn: 'Testing' },
        condition: 'The review is clean',
        maxRuns: 3,
      },
    ]);
    await openColumn('Executing');
    await expect(conditionMark(longName)).toBeVisible();

    // Read in one evaluate, each box against its own line, so the dialog's
    // entrance scale cannot land the reads on different frames.
    const layout = await titleLine(longName).evaluate((line) => {
      const name = line.firstElementChild as HTMLElement;
      const condition = line.querySelector('[data-testid="column-automation-condition-mark"]') as HTMLElement;
      const frequency = line.querySelector('[data-testid="column-automation-frequency-mark"]') as HTMLElement;
      const lineBox = line.getBoundingClientRect();
      return {
        nameTruncated: name.scrollWidth > name.clientWidth,
        conditionWidth: condition.getBoundingClientRect().width,
        conditionIconWidth: (condition.querySelector('svg') as SVGElement).getBoundingClientRect().width,
        frequencyFits: frequency.scrollWidth <= frequency.clientWidth + 1,
        frequencyInsideLine: frequency.getBoundingClientRect().right <= lineBox.right + 1,
      };
    });
    expect(layout.nameTruncated).toBe(true);
    expect(layout.conditionWidth).toBeGreaterThanOrEqual(layout.conditionIconWidth - 1);
    expect(layout.frequencyFits).toBe(true);
    expect(layout.frequencyInsideLine).toBe(true);
    await expect(frequencyMark(longName).locator('[data-testid="column-automation-frequency-count"]')).toHaveText('3');
  });

  // 3b - One grammar: the action's own marks, the sentence's look ─────────────

  test('a waiting Send message on enter or exit carries the Delivery mark, and only there', async () => {
    await seedColumn('Executing', [
      { name: 'Waits on enter', type: 'send_message', trigger: 'enter', config: { message: 'Review it', mode: 'deferred' } },
      { name: 'Waits on exit', type: 'send_message', trigger: 'exit', config: { message: 'Wrap up', mode: 'deferred' } },
      { name: 'Right away', type: 'send_message', trigger: 'enter', config: { message: 'Go', mode: 'immediate' } },
      { name: 'At turn end', type: 'send_message', trigger: 'turn_end', config: { message: 'Summarize', mode: 'deferred' } },
    ]);
    await openColumn('Executing');

    for (const name of ['Waits on enter', 'Waits on exit']) {
      await expectMarkSays(markOf(name, 'delivery'), 'Delivery: waits for the current turn to end.');
    }
    // Run immediately is the default, and a turn end has no turn left to wait for.
    await expect(markOf('Right away', 'delivery')).toHaveCount(0);
    await expect(markOf('At turn end', 'delivery')).toHaveCount(0);

    // The timing is no longer words in the sentence, whichever Delivery is set.
    await expectTwoLines('Waits on enter', 'Sends "Review it"');
    await expectTwoLines('Right away', 'Sends "Go"');
    await expectTwoLines('At turn end', 'Sends "Summarize"');
  });

  test("Move to column's message is a mark after the guards, all in one tone", async () => {
    await seedColumn('Executing', [
      {
        name: 'Back for revisions',
        type: 'move_to_column',
        trigger: 'turn_end',
        config: { targetColumn: 'Planning', message: '{{agentReply}}\nand the rest' },
        condition: 'The review found work the implementer can do',
        maxRuns: 3,
      },
      { name: 'Hand off', type: 'move_to_column', trigger: 'turn_end', config: { targetColumn: '' } },
    ]);
    await openColumn('Executing');

    // The editor's card order: Condition, Frequency, then the action's own.
    expect(await titleLine('Back for revisions').evaluate((node) =>
      Array.from(node.children).map((child) => child.getAttribute('data-testid')).filter((id) => id !== null)))
      .toEqual(['column-automation-condition-mark', 'column-automation-frequency-mark', 'column-automation-message-mark']);
    // The label is the whole message, every line: the mark is the one place
    // the row names it.
    await expectMarkSays(markOf('Back for revisions', 'message'), 'Message: {{agentReply}}\nand the rest');
    // The message left the sentence.
    await expectTwoLines('Back for revisions', 'Moves the task to Planning');

    // No message, no mark, and the next column needs no full stop either.
    await expect(markOf('Hand off', 'message')).toHaveCount(0);
    await expectTwoLines('Hand off', 'Moves the task to the next column');

    // One tone: every mark's icon, and the Frequency's count, paint the same
    // color. Read off the svg, not the wrapper, since a class on the icon
    // itself is what would break it.
    const colors = await titleLine('Back for revisions').evaluate((line) => {
      const marks = Array.from(line.querySelectorAll('[role="img"]'));
      const icons = marks.map((mark) => getComputedStyle(mark.querySelector('svg') as SVGElement).color);
      const count = line.querySelector('[data-testid="column-automation-frequency-count"]') as HTMLElement;
      return { icons, count: getComputedStyle(count).color, wrappers: marks.map((mark) => getComputedStyle(mark).color) };
    });
    expect(colors.icons).toHaveLength(3);
    expect(new Set([...colors.icons, colors.count, ...colors.wrappers]).size).toBe(1);
  });

  test('a long value ends where the row ends, and the sentence tooltip holds all of it', async () => {
    const message = 'Review the latest changes against the plan, fix anything the tests or the type checker report, then summarize what you changed';
    await seedColumn('Executing', [
      { name: 'Review on arrival', type: 'send_message', trigger: 'enter', config: { message } },
    ]);
    await openColumn('Executing');

    const sentence = row('Review on arrival').locator('[data-testid="column-automation-row-sentence"]');
    const expected = `Sends "${message}"`;
    // The whole value is in the text: no fixed character cut, no "...".
    await expect(sentence).toHaveText(expected);
    // The tip is the same text, so it is not read as a description; hovering shows it whole.
    await sentence.hover();
    await expect(page.locator('[data-tooltip]')).toHaveText(expected);
    // CSS ends it instead: the line overflows its box and draws an ellipsis.
    const overflow = await sentence.evaluate((node) => ({
      overflows: node.scrollWidth > node.clientWidth,
      textOverflow: getComputedStyle(node).textOverflow,
    }));
    expect(overflow.overflows).toBe(true);
    expect(overflow.textOverflow).toBe('ellipsis');
  });

  test('a multi-line message shows its first line, and the tooltips hold every line', async () => {
    await seedColumn('Executing', [
      {
        name: 'Review on arrival',
        type: 'send_message',
        trigger: 'enter',
        config: { message: 'Review the diff.\nThen run the tests\nand report back.' },
        condition: 'The plan is approved\nand CI is green',
      },
    ]);
    await openColumn('Executing');

    await expectTwoLines('Review on arrival', 'Sends "Review the diff."');
    await expect(row('Review on arrival').locator('[data-testid="column-automation-row-sentence"]'))
      .toHaveAccessibleDescription('Sends "Review the diff.\nThen run the tests\nand report back."');
    await expectMarkSays(conditionMark('Review on arrival'), 'Condition: only if the plan is approved\nand CI is green.');
  });

  test("a script's sentence is set in the mono font, and an empty one is not", async () => {
    await seedColumn('Executing', [
      { name: 'Lint', type: 'run_script', trigger: 'enter', config: { script: 'npm run lint' } },
      { name: 'Not yet', type: 'run_script', trigger: 'enter', config: {} },
      { name: 'Tell me', type: 'notify', trigger: 'exit', config: { title: 'Done here' } },
    ]);
    await openColumn('Executing');

    const fontOf = (name: string) => row(name).locator('[data-testid="column-automation-row-sentence"]')
      .evaluate((node) => getComputedStyle(node).fontFamily);
    const script = await fontOf('Lint');
    const prose = await fontOf('Tell me');
    expect(script).not.toBe(prose);
    expect(script.toLowerCase()).toContain('mono');
    // The empty state is prose, not code.
    expect(await fontOf('Not yet')).toBe(prose);
    await expectTwoLines('Lint', 'Runs npm run lint');
    await expectTwoLines('Not yet', 'No script yet.');
  });

  test('Delivery on a turn-end Send message is disabled with the reason, and keeps its value', async () => {
    await seedColumn('Executing', [
      { name: 'Summarize', type: 'send_message', trigger: 'turn_end', config: { message: 'Summarize', mode: 'deferred' } },
    ]);
    await openColumn('Executing');
    await row('Summarize').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();

    const reason = 'At a turn end the turn is over, so it sends at once.';
    const options = [
      editDialog().locator('[data-testid="auto-command-mode-immediate"]'),
      editDialog().locator('[data-testid="auto-command-mode-deferred"]'),
    ];
    // In place, not hidden, with the stored choice still showing.
    await expect(card('action').locator('[data-testid="automation-config-mode-row"]')).toBeVisible();
    await expect(options[1]).toHaveAttribute('aria-checked', 'true');
    for (const option of options) {
      await expect(option).toBeDisabled();
      await expect(option).toHaveAccessibleDescription(reason);
    }
    await options[0].click({ force: true });
    await expect(options[1]).toHaveAttribute('aria-checked', 'true');

    // Moving the row to enter brings Delivery back, with no reason on it.
    await editDialog().locator('[data-testid="edit-automation-trigger-enter"]').click();
    for (const option of options) {
      await expect(option).toBeEnabled();
      await expect(option).not.toHaveAccessibleDescription(reason);
    }
    // And back to turn end, where Done keeps the stored value untouched. The
    // rename is a real edit, so Save has something to write.
    await editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]').click();
    await expect(options[0]).toBeDisabled();
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Summarize the turn');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();

    await saveManager();
    const saved = (await readColumnRows('Executing')).find((entry) => entry.name === 'Summarize the turn');
    expect(saved?.trigger).toBe('turn_end');
    expect(saved?.config.mode).toBe('deferred');
  });

  // 4 - The Condition card without an Automation agent ───────────────────────

  test('with no Automation agent an Agent evaluation offers setup, not a field', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    // The switch stays live: a Condition no longer means an agent, so having
    // none never locks the card. On enter, the one kind that runs is this one.
    const conditionSwitch = card('condition').locator('[data-testid="edit-automation-card-condition-switch"]');
    await expect(conditionSwitch).toBeEnabled();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(conditionKind('agent')).toHaveAttribute('aria-checked', 'true');

    const setup = card('condition').locator('[data-testid="edit-automation-condition-setup"]');
    await expect(setup).toBeVisible();
    await expect(setup).toContainText('Set up an Automation agent');
    const openSettings = setup.locator('[data-testid="edit-automation-open-settings"]');
    await expect(openSettings).toHaveText('Open Settings');

    // Board 15c: the notice reads as the way forward. Its line is semibold in
    // the body color, and Open Settings carries a gear and the accent, the same
    // tone as the notice's own info icon. Compared to each other, not to a hex.
    await expect(openSettings.locator('svg')).toHaveCount(1);
    const tones = await setup.evaluate((node) => {
      const text = node.querySelector('[data-testid="edit-automation-condition-setup-text"]');
      const icon = node.querySelector(':scope > svg');
      const button = node.querySelector('[data-testid="edit-automation-open-settings"]');
      if (!text || !icon || !button) return null;
      // The body text color, read off a probe so the theme decides it.
      const probe = document.createElement('span');
      probe.className = 'text-fg';
      node.appendChild(probe);
      const bodyColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        textWeight: getComputedStyle(text).fontWeight,
        textIsBodyColor: getComputedStyle(text).color === bodyColor,
        buttonMatchesIcon: getComputedStyle(button).color === getComputedStyle(icon).color,
      };
    });
    expect(tones).toEqual({ textWeight: '600', textIsBodyColor: true, buttonMatchesIcon: true });

    // Nothing to write a condition into, and no variable to put in it.
    await expect(card('condition').locator('[data-testid="edit-automation-condition"]')).toHaveCount(0);
    await expect(card('condition').locator('[data-testid="template-variable-trigger"]')).toHaveCount(0);

    // A click on the header switches it on, and the notice stays where the field
    // would be: an evaluation still has no agent to make it.
    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(setup).toBeVisible();

    // Done with nothing written saves no Condition, rather than an empty one.
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Lint on arrival');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();
    await expect(conditionMark('Lint on arrival')).toHaveCount(0);
  });

  test('an agent without a model is still not set up', async () => {
    // The mock's Claude entry answers with a model, so an agent alone leaves the
    // Agent evaluation on its notice. This is what keeps the card from offering
    // a field the engine would then skip.
    await setAutomationAgent({ agent: 'claude', model: null });
    await openColumn('Executing');
    await addThroughPicker('enter', 'run_script');

    await expect(card('condition').locator('[data-testid="edit-automation-condition-setup"]')).toBeVisible();
    await expect(card('condition').locator('[data-testid="edit-automation-card-condition-switch"]')).toBeEnabled();
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

  // 4b - The two Condition kinds ─────────────────────────────────────────────

  test('the kind control lists Agent evaluation then Text match, and Text match is turn end only, with the reason', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');

    const kinds = card('condition').locator('[data-testid^="edit-automation-condition-kind-"]');
    expect(await kinds.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))))
      .toEqual(['edit-automation-condition-kind-agent', 'edit-automation-condition-kind-text']);
    // With an agent set up, a new Condition starts on the kind that has always been the default.
    await expect(conditionKind('agent')).toHaveAttribute('aria-checked', 'true');
    await expect(conditionKind('text')).toBeEnabled();

    // Off a turn end there is no final message: shown, disabled, and saying why.
    for (const trigger of ['enter', 'exit'] as const) {
      await editDialog().locator(`[data-testid="edit-automation-trigger-${trigger}"]`).click();
      await expect(conditionKind('text')).toBeDisabled();
      await expect(conditionKind('text')).toHaveAccessibleDescription(TEXT_MATCH_UNAVAILABLE);
      await expect(conditionKind('agent')).toBeEnabled();
    }

    await editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]').click();
    await expect(conditionKind('text')).toBeEnabled();
    await expect(conditionKind('text')).not.toHaveAccessibleDescription(TEXT_MATCH_UNAVAILABLE);
  });

  test('with no Automation agent a new turn-end Condition starts on Text match, which needs no setup', async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Ready ping');

    await expect(conditionKind('text')).toHaveAttribute('aria-checked', 'true');
    const finalLine = card('condition').locator('[data-testid="edit-automation-final-line"]');
    const setup = card('condition').locator('[data-testid="edit-automation-condition-setup"]');
    await expect(finalLine).toBeVisible();
    await expect(finalLine).toHaveAttribute('placeholder', 'Ready for review');
    await expect(card('condition').locator('[data-testid="edit-automation-final-line-hint"]'))
      .toHaveText("Matches the agent's last line, ignoring case and punctuation, with * as a wildcard.");
    await expect(setup).toBeHidden();

    await card('condition').getByText(CONDITION_DESCRIPTION).click();
    await expect(finalLine).toBeEnabled();
    await finalLine.fill('Ready for *');

    // Agent evaluation shows its notice in the same slot; the line waits and comes back.
    await conditionKind('agent').click();
    await expect(setup).toBeVisible();
    await expect(finalLine).toBeHidden();
    await expect(card('condition').locator('[data-testid="edit-automation-condition-text-body"]')).toHaveAttribute('aria-hidden', 'true');
    await conditionKind('text').click();
    await expect(finalLine).toHaveValue('Ready for *');
    await expect(setup).toBeHidden();

    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();

    // Its own mark, the kind's icon, and the same "Condition:" lead as the other kind.
    await expectMarkSays(textMatchMark('Ready ping'), 'Condition: only if the last line reads "Ready for *".');
    await expect(textMatchMark('Ready ping').locator('svg.lucide-text-search')).toHaveCount(1);
    await expect(conditionMark('Ready ping')).toHaveCount(0);

    await saveManager();
    const saved = (await readColumnRows('Executing')).find((entry) => entry.name === 'Ready ping');
    expect(saved?.final_line).toBe('Ready for *');
    expect(saved?.condition).toBeNull();
  });

  test('a Text match line waits while the Trigger is off a turn end, comes back on return, and Done off a turn end saves the row without it', async () => {
    await seedColumn('Executing', [
      { name: 'Verdict ping', type: 'notify', trigger: 'turn_end', config: { title: 'Ready' }, finalLine: 'Verdict: Ready' },
    ]);
    await openColumn('Executing');
    await expectMarkSays(textMatchMark('Verdict ping'), 'Condition: only if the last line reads "Verdict: Ready".');
    await row('Verdict ping').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();

    const conditionSwitch = card('condition').locator('[data-testid="edit-automation-card-condition-switch"]');
    const finalLine = card('condition').locator('[data-testid="edit-automation-final-line"]');
    await expect(conditionKind('text')).toHaveAttribute('aria-checked', 'true');
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(finalLine).toHaveValue('Verdict: Ready');

    // On enter the card shows the kind that runs there, holding nothing.
    await editDialog().locator('[data-testid="edit-automation-trigger-enter"]').click();
    await expect(conditionKind('agent')).toHaveAttribute('aria-checked', 'true');
    await expect(conditionKind('text')).toBeDisabled();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');

    // Back to a turn end before Done: the line returns.
    await editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]').click();
    await expect(conditionKind('text')).toHaveAttribute('aria-checked', 'true');
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(finalLine).toHaveValue('Verdict: Ready');

    // Done on enter keeps the move and drops the line.
    await editDialog().locator('[data-testid="edit-automation-trigger-enter"]').click();
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();
    await expect(textMatchMark('Verdict ping')).toHaveCount(0);

    await saveManager();
    const saved = (await readColumnRows('Executing')).find((entry) => entry.name === 'Verdict ping');
    expect(saved?.trigger).toBe('enter');
    expect(saved?.final_line).toBeNull();
    expect(saved?.condition).toBeNull();
  });

  test('the Condition card holds its height across both kinds, with a field or with the setup notice', async () => {
    /** The card's height on each kind, switched off, as the user flips between them. */
    async function heightsByKind(): Promise<number[]> {
      const heights: number[] = [];
      for (const kind of ['agent', 'text', 'agent'] as const) {
        await conditionKind(kind).click();
        await expect(conditionKind(kind)).toHaveAttribute('aria-checked', 'true');
        const box = await card('condition').boundingBox();
        if (!box) throw new Error('The Condition card has no box');
        heights.push(box.height);
      }
      return heights;
    }

    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');
    const withField = await heightsByKind();
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    await cancelManager();

    await setAutomationAgent({ agent: null, model: null });
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');
    await expect(card('condition').locator('[data-testid="edit-automation-condition-setup"]')).toHaveCount(1);
    const withNotice = await heightsByKind();

    // Sub-pixel rounding differs across platforms, so a small tolerance, never zero.
    const all = [...withField, ...withNotice];
    expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(1);
  });

  test('the wildcard tip opens on hover and on keyboard focus, with its examples', async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');
    await expect(conditionKind('text')).toHaveAttribute('aria-checked', 'true');

    const info = card('condition').locator('[data-testid="edit-automation-wildcard-info"]');
    const tip = page.locator('[data-testid="edit-automation-wildcard-tip"]');
    await expect(info).toHaveAttribute('aria-label', 'Wildcard examples');
    await expect(tip).toHaveCount(0);

    await info.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('role', 'tooltip');
    await expect(tip).toContainText('Wildcard examples');
    for (const pattern of ['Ready for review', 'Ready for *', '* for review', '*review*']) {
      await expect(tip.locator('code', { hasText: pattern })).toHaveCount(1);
    }

    await editDialog().locator('[data-testid="edit-automation-name"]').hover();
    await expect(tip).toHaveCount(0);

    // Tab focus opens it. Step off with Shift+Tab and back with Tab, so the
    // last move is Tab's own; a script or mouse focus opens nothing.
    await info.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(info).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(info).toBeFocused();
    await expect(tip).toBeVisible();
    await info.blur();
    await expect(tip).toHaveCount(0);
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
    await expect(target).toHaveAttribute('data-value', '');
    await expect(target).toHaveText('Next column');
    await target.click();
    const options = page.locator('[data-testid="automation-config-targetColumn-option"]');
    await expect(options.first()).toHaveText('Next column');
    await expect(options.first()).toHaveAttribute('data-value', '');
    // The board's other columns follow, and the column being edited is not offered.
    await expect(options.filter({ hasText: 'Testing' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Executing' })).toHaveCount(0);
    // Closed again, since the open menu sits over the dialog's footer.
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
  });

  // 5b - The Column picker carries each column's color ──────────────────────

  test("the Column picker shows each column's color dot, and Next column has none", async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'move_to_column');

    const target = card('action').locator('[data-testid="automation-config-targetColumn"]');
    await target.click();
    const menu = page.locator('[data-testid="automation-config-targetColumn-menu"]');
    await expect(menu).toBeVisible();
    const options = menu.locator('[data-testid="automation-config-targetColumn-option"]');

    // Next column is not one column, so it has no color of its own.
    await expect(options.first().locator('[data-testid="automation-column-dot"]')).toHaveCount(0);

    // Testing's dot is Testing's own color, read from the board, as the
    // browser resolves it (so a hex and its rgb() compare equal).
    const testingOption = options.filter({ hasText: 'Testing' });
    const colors = await testingOption.locator('[data-testid="automation-column-dot"]').evaluate(async (dot) => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((swimlane) => swimlane.name === 'Testing');
      const probe = document.createElement('span');
      probe.style.backgroundColor = lane?.color ?? '';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual: getComputedStyle(dot).backgroundColor, expected };
    });
    expect(colors.actual).toBe(colors.expected);

    // Choosing it closes the menu and the field shows the name with its dot.
    await testingOption.click();
    await expect(menu).toBeHidden();
    await expect(target).toHaveAttribute('data-value', 'Testing');
    await expect(target).toHaveText('Testing');
    await expect(target.locator('[data-testid="automation-column-dot"]')).toHaveCount(1);

    // Escape closes the menu, not the editor under it.
    await target.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(editDialog()).toBeVisible();
  });

  test('a column renamed in the open Board Manager keeps its dot in the Column picker', async () => {
    // The choices come from the Board Manager's drafts, not the saved board, so
    // a rename that is not saved yet still carries the column's color.
    await openColumn('Testing');
    await dialog().locator('[data-testid="board-manager-name"]').fill('Verify');
    await dialog().locator('[data-testid="board-manager-tab"][data-tab-name="Executing"]').click();
    await addThroughPicker('turn_end', 'move_to_column');

    await card('action').locator('[data-testid="automation-config-targetColumn"]').click();
    const options = page.locator('[data-testid="automation-config-targetColumn-option"]');
    await expect(options.filter({ hasText: 'Testing' })).toHaveCount(0);
    const renamed = options.filter({ hasText: 'Verify' });
    await expect(renamed).toHaveCount(1);
    const colors = await renamed.locator('[data-testid="automation-column-dot"]').evaluate(async (dot) => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((swimlane) => swimlane.name === 'Testing');
      const probe = document.createElement('span');
      probe.style.backgroundColor = lane?.color ?? '';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual: getComputedStyle(dot).backgroundColor, expected };
    });
    expect(colors.actual).toBe(colors.expected);
    await page.keyboard.press('Escape');
  });

  test('the Column picker works from the keyboard alone, as the native select it replaced did', async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'move_to_column');

    const target = card('action').locator('[data-testid="automation-config-targetColumn"]');
    await target.focus();
    // ArrowDown opens the menu with focus on the current choice, Next column.
    await page.keyboard.press('ArrowDown');
    const menu = page.locator('[data-testid="automation-config-targetColumn-menu"]');
    await expect(menu).toBeVisible();
    const options = menu.locator('[data-testid="automation-config-targetColumn-option"]');
    await expect(options.first()).toBeFocused();

    // The options sit in a body portal, out of the Tab order: the arrows reach them.
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toBeFocused();
    const chosen = await options.nth(1).getAttribute('data-value');
    expect(chosen).not.toBe('');

    // Enter picks it, closes the menu, and hands focus back to the field.
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(target).toHaveAttribute('data-value', chosen ?? '');
    await expect(target).toBeFocused();
    await expect(editDialog()).toBeVisible();
  });

  test('a Column the board no longer has stays listed, marked, and without a dot', async () => {
    await seedColumn('Executing', [
      { name: 'Hand off', type: 'move_to_column', trigger: 'turn_end', config: { targetColumn: 'Gone' } },
    ]);
    await openColumn('Executing');
    await row('Hand off').locator('[data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();

    const target = card('action').locator('[data-testid="automation-config-targetColumn"]');
    // Opening the dialog never re-points the row.
    await expect(target).toHaveAttribute('data-value', 'Gone');
    await expect(target).toHaveText('Gone (not on this board)');
    await expect(target.locator('[data-testid="automation-column-dot"]')).toHaveCount(0);

    await target.click();
    const options = page.locator('[data-testid="automation-config-targetColumn-option"]');
    const stale = options.last();
    await expect(stale).toHaveAttribute('data-value', 'Gone');
    await expect(stale).toHaveText('Gone (not on this board)');
    await expect(stale).toHaveAttribute('aria-selected', 'true');
    await expect(stale.locator('[data-testid="automation-column-dot"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
  });

  // 5c - The Action card follows Type ────────────────────────────────────────

  test("Send message's Action card: its own icon, info on Type, Message and Delivery, Delivery on one row, a growing Message", async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'send_message');

    // The header icon is the chosen type's (a speech bubble), and follows Type.
    const headerIcon = card('action').locator('svg[data-icon]');
    await expect(headerIcon).toHaveAttribute('data-icon', 'message-square');

    // Short notes behind info icons, the manifest's for Message and Delivery.
    for (const label of ['Type', 'Message', 'Delivery']) {
      const info = card('action').getByRole('button', { name: `About ${label}`, exact: true });
      await expect(info).toBeVisible();
      await expect(info).toHaveAccessibleDescription(/\S/);
    }

    // Delivery is a choice row: its label and its control share one row.
    const deliveryRow = card('action').locator('[data-testid="automation-config-mode-row"]');
    await expect(deliveryRow.getByText('Delivery', { exact: true })).toBeVisible();
    await expect(deliveryRow.locator('[data-testid="automation-config-mode"]')).toBeVisible();
    expect(await deliveryRow.evaluate((node) => getComputedStyle(node).flexDirection)).toBe('row');

    // Run immediately types the message and presses Enter, so it shows the
    // Enter key glyph. The bolt is the Trigger card's mark in this same dialog.
    const immediate = deliveryRow.locator('[data-testid="auto-command-mode-immediate"]');
    await expect(immediate.locator('svg.lucide-corner-down-left')).toHaveCount(1);
    await expect(immediate.locator('svg.lucide-zap')).toHaveCount(0);
    await expect(deliveryRow.locator('[data-testid="auto-command-mode-deferred"] svg.lucide-clock')).toHaveCount(1);
    // On enter, Delivery is live.
    await expect(immediate).toBeEnabled();

    // The Message starts one row tall and grows with its text, as Condition does.
    const message = card('action').locator('[data-testid="automation-config-message"]');
    await expect(message).toHaveAttribute('rows', '1');
    const before = await message.evaluate((node) => node.clientHeight);
    await message.fill('First line\nSecond line\nThird line\nFourth line');
    await expect.poll(() => message.evaluate((node) => node.clientHeight)).toBeGreaterThan(before);

    // A script keeps its fixed rows: it has a shape of its own.
    await pickType('run_script');
    await expect(headerIcon).toHaveAttribute('data-icon', 'square-terminal');
    await expect(card('action').locator('[data-testid="automation-config-script"]')).toHaveAttribute('rows', '3');

    await pickType('move_to_column');
    await expect(headerIcon).toHaveAttribute('data-icon', 'square-arrow-right');
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
    await expect(glyph).toHaveAccessibleName(/1 at a turn end/);
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
