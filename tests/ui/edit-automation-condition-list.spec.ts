/**
 * UI tests for the Edit automation dialog's Condition list (#872): the Add
 * condition menu and what it leaves out, each line's field, and the template
 * variable button joined to a field's right edge.
 *
 * `edit-automation-guards.spec.ts` covers the accordion, the switches and the
 * row marks; this file is the list itself. Nothing here needs a real agent: the
 * Automation agent is a config choice, set through the config store.
 *
 * Tests share one page (one boot) and each opens its own dialog from a cleared
 * board, so none leans on what an earlier one left open.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Locator, Page } from '@playwright/test';

const PROJECT_NAME = `EditAutomationConditionList Test ${Date.now()}`;
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
const conditionCard = () => editDialog().locator('[data-testid="edit-automation-card-condition"]');
const addConditionMenu = () => page.locator('[data-testid="edit-automation-add-condition-menu"]');
const addConditionButton = () => conditionCard().locator('[data-testid="edit-automation-add-condition"]');
const settingsPanel = () => page.locator('[data-testid="settings-panel"]');

type TriggerName = 'enter' | 'turn_end' | 'exit';
type ConditionKind = 'priority' | 'labels' | 'reply' | 'prompt' | 'evaluation';

async function openColumn(columnName: string): Promise<void> {
  await page.locator(`[data-swimlane-name="${columnName}"]`).locator(`text=${columnName}`).click();
  await expect(dialog()).toBeVisible({ timeout: 3000 });
  await expect(dialog().locator(`[data-testid="board-manager-tab"][data-tab-name="${columnName}"]`))
    .toHaveAttribute('aria-selected', 'true');
}

async function cancelManager(): Promise<void> {
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  const discard = page.locator('button', { hasText: 'Discard' });
  const outcome = await Promise.race([
    discard.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'confirm' as const, () => 'none' as const),
    dialog().waitFor({ state: 'detached', timeout: 3000 }).then(() => 'closed' as const, () => 'none' as const),
  ]);
  if (outcome === 'confirm') await discard.click();
  await dialog().waitFor({ state: 'detached', timeout: 3000 });
}

async function saveManager(): Promise<void> {
  const save = dialog().locator('[data-testid="board-manager-save"]');
  await expect(save).toBeEnabled({ timeout: 5000 });
  await save.click();
  await dialog().waitFor({ state: 'detached', timeout: 5000 });
}

async function addThroughPicker(trigger: TriggerName, type: string): Promise<void> {
  await dialog().locator(`[data-testid="column-automation-add"][data-trigger="${trigger}"]`).click();
  const picker = page.locator('[data-testid="column-automation-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-testid="column-automation-picker-type"][data-type="${type}"]`).click();
  await expect(editDialog()).toBeVisible();
}

async function clearAllAutomations(): Promise<void> {
  await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    for (const lane of lanes) {
      await window.electronAPI.automations.replaceForColumn(lane.id, [], lane.id);
    }
  });
}

async function setAutomationAgent(choice: { agent: string | null; model: string | null }): Promise<void> {
  await page.evaluate(async (next) => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: object) => Promise<unknown> } } };
    }).__zustandStores;
    await stores.config.getState().updateConfig({ automation: next });
  }, choice);
}

async function closeSettingsPanel(): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { setSettingsOpen: (open: boolean) => void } } };
    }).__zustandStores;
    stores.config.getState().setSettingsOpen(false);
  });
  await expect(settingsPanel()).toHaveCount(0);
}

interface SavedRow {
  name: string;
  condition: string | null;
  final_line: string | null;
  text_match_source?: string;
  filter?: { priorities: number[]; labels: string[] } | null;
}

async function readSavedRow(columnName: string, rowName: string): Promise<SavedRow | undefined> {
  return page.evaluate(async ({ column, name }) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === column);
    const rows = await window.electronAPI.automations.list();
    return rows.find((entry) => entry.swimlane_id === lane?.id && entry.name === name) as unknown as SavedRow | undefined;
  }, { column: columnName, name: rowName });
}

async function openCondition(): Promise<void> {
  if ((await conditionCard().getAttribute('data-open')) !== 'true') {
    await conditionCard().locator('[data-testid="edit-automation-card-condition-header"]').click();
  }
  await expect(conditionCard()).toHaveAttribute('data-open', 'true');
}

/**
 * A Priority or Labels line takes the cursor when it is added, which opens that
 * field's suggestion list over the Add condition button. Escape closes the list
 * and leaves the dialog open (LabelInput consumes it).
 */
async function closeSuggestions(): Promise<void> {
  const suggestions = page.locator('[data-testid="label-suggestions"]');
  if (await suggestions.count() === 0) return;
  await page.keyboard.press('Escape');
  await expect(suggestions).toHaveCount(0);
  await expect(editDialog()).toBeVisible();
}

/**
 * Open the Condition section with its switch on and the Add condition menu open.
 * The list is inert while the switch is off, so the switch goes on first.
 */
async function openMenu(): Promise<void> {
  await openCondition();
  await closeSuggestions();
  const conditionSwitch = conditionCard().locator('[data-testid="edit-automation-card-condition-switch"]');
  if ((await conditionSwitch.getAttribute('aria-checked')) !== 'true') await conditionSwitch.click();
  await addConditionButton().click();
  await expect(addConditionMenu()).toBeVisible();
}

function menuItem(kind: ConditionKind): Locator {
  return addConditionMenu().locator(`[data-testid="edit-automation-add-condition-${kind}"]`);
}

async function pickKind(kind: ConditionKind): Promise<void> {
  await openMenu();
  await menuItem(kind).click();
  await expect(addConditionMenu()).toHaveCount(0);
  await expect(conditionCard().locator(`[data-testid="edit-automation-condition-line-${kind}"]`)).toBeVisible();
  if (kind === 'priority' || kind === 'labels') {
    // The new line's field takes the cursor, and its suggestions open with it.
    await expect(conditionCard().locator(`[data-testid="edit-automation-condition-${kind}"]`)).toBeFocused();
    await closeSuggestions();
  }
}

function line(kind: ConditionKind): Locator {
  return conditionCard().locator(`[data-testid="edit-automation-condition-line-${kind}"]`);
}

test.describe('Edit automation: the Condition list, first line', () => {
  test('adding the first line with the switch off switches the Condition on', async () => {
    await clearAllAutomations();
    await openColumn('Executing');
    await addThroughPicker('enter', 'send_message');
    await openCondition();
    const conditionSwitch = conditionCard().locator('[data-testid="edit-automation-card-condition-switch"]');
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'false');
    // Add condition is live with the switch off: the empty list has nothing to dim.
    await addConditionButton().click();
    await expect(addConditionMenu()).toBeVisible();
    await menuItem('labels').click();
    await expect(line('labels')).toBeVisible();
    await expect(conditionSwitch).toHaveAttribute('aria-checked', 'true');
    await closeSuggestions();
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    await cancelManager();
  });
});

test.describe('Edit automation: the Condition list', () => {
  test.beforeEach(async () => {
    if (await settingsPanel().isVisible({ timeout: 200 }).catch(() => false)) await closeSettingsPanel();
    if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
      await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    }
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
    await setAutomationAgent({ agent: null, model: null });
  });

  test.afterEach(async () => {
    if (await settingsPanel().isVisible({ timeout: 200 }).catch(() => false)) await closeSettingsPanel();
    if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
      await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    }
    if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) await cancelManager();
    await clearAllAutomations();
  });

  test('on a turn end the menu offers all five kinds in three groups, and leaves out what is added', async () => {
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');

    await test.step('an empty list says it runs for every task, and the menu holds every kind', async () => {
      await openCondition();
      await expect(conditionCard().locator('[data-testid="edit-automation-condition-empty"]')).toHaveText('Runs for every task.');
      await openMenu();
      for (const group of ['Task', 'Text match', 'Agent']) {
        await expect(addConditionMenu().getByText(group, { exact: true })).toBeVisible();
      }
      for (const kind of ['priority', 'labels', 'reply', 'prompt', 'evaluation'] as const) {
        await expect(menuItem(kind)).toBeVisible();
      }
    });

    await test.step('picking Priority adds its line with the cursor in it, and the menu then leaves it out', async () => {
      await menuItem('priority').click();
      await expect(line('priority')).toBeVisible();
      await expect(conditionCard().locator('[data-testid="edit-automation-condition-priority"]')).toBeFocused();
      await closeSuggestions();
      await addConditionButton().click();
      await expect(addConditionMenu()).toBeVisible();
      await expect(menuItem('priority')).toHaveCount(0);
      await expect(menuItem('labels')).toBeVisible();
    });

    await test.step('Reply takes Prompt out of the menu with it, since they share one stored field', async () => {
      await menuItem('reply').click();
      await expect(line('reply')).toBeVisible();
      await expect(conditionCard().locator('[data-testid="edit-automation-final-line-line"]')).toBeFocused();
      await addConditionButton().click();
      await expect(menuItem('reply')).toHaveCount(0);
      await expect(menuItem('prompt')).toHaveCount(0);
      // The whole group goes when nothing in it is left.
      await expect(addConditionMenu().getByText('Text match', { exact: true })).toHaveCount(0);
      await expect(menuItem('labels')).toBeVisible();
      await expect(menuItem('evaluation')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(addConditionMenu()).toHaveCount(0);
      await expect(editDialog()).toBeVisible();
    });

    await test.step('removing Reply offers Reply and Prompt again, and Prompt then excludes Reply', async () => {
      await line('reply').locator('xpath=following-sibling::*[2]').click();
      await expect(line('reply')).toHaveCount(0);
      await pickKind('prompt');
      await addConditionButton().click();
      await expect(menuItem('reply')).toHaveCount(0);
      await expect(menuItem('prompt')).toHaveCount(0);
      await page.keyboard.press('Escape');
    });
  });

  test('on enter the menu leaves out the whole Text match group, and Add condition hides once every kind is added', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');

    await openMenu();
    await expect(addConditionMenu().getByText('Task', { exact: true })).toBeVisible();
    await expect(addConditionMenu().getByText('Agent', { exact: true })).toBeVisible();
    await expect(addConditionMenu().getByText('Text match', { exact: true })).toHaveCount(0);
    await expect(menuItem('reply')).toHaveCount(0);
    await expect(menuItem('prompt')).toHaveCount(0);
    await menuItem('priority').click();
    await expect(line('priority')).toBeVisible();
    await expect(conditionCard().locator('[data-testid="edit-automation-condition-priority"]')).toBeFocused();
    await closeSuggestions();

    await pickKind('labels');
    await pickKind('evaluation');
    // Nothing is left to add on this trigger, so the button goes.
    await expect(addConditionButton()).toHaveCount(0);
    await expect(conditionCard().locator('[data-testid="edit-automation-condition-list"] [data-testid^="edit-automation-condition-line-"][data-testid$="-remove"]'))
      .toHaveCount(3);
  });

  test('Priority takes levels from its suggestions as chips, and a saved row reopens with both', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Urgent ping');
    await pickKind('priority');

    const field = conditionCard().locator('[data-testid="edit-automation-condition-priority"]');
    const chips = conditionCard().locator('[data-testid="edit-automation-condition-priority-chip"]');
    const suggestions = page.locator('[data-testid="label-suggestion"]');

    // pickKind closed the list the new line opened; focusing the field opens it again.
    await field.evaluate((node) => (node as HTMLInputElement).blur());
    await field.click();
    await expect(suggestions.filter({ hasText: 'High' })).toBeVisible();
    await suggestions.filter({ hasText: 'High' }).click();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute('data-value', '3');

    // A picked level leaves the list; the next pick reopens it from the field.
    await expect(suggestions.filter({ hasText: 'High' })).toHaveCount(0);
    await field.evaluate((node) => (node as HTMLInputElement).blur());
    await field.click();
    await expect(suggestions.filter({ hasText: 'Urgent' })).toBeVisible();
    await suggestions.filter({ hasText: 'Urgent' }).click();
    await expect(chips).toHaveCount(2);
    await expect.poll(() => chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-value')))).toEqual(['3', '4']);

    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();
    await expect(dialog().locator('[data-testid="column-automation-row"][data-name="Urgent ping"] [data-testid="column-automation-condition-mark"]'))
      .toHaveAttribute('aria-label', 'Condition: for priority "High" or "Urgent".');

    // Reopened from the row, the lines are as they were left.
    await dialog().locator('[data-testid="column-automation-row"][data-name="Urgent ping"] [data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();
    await openCondition();
    await expect(chips).toHaveCount(2);
    await expect.poll(() => chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-value')))).toEqual(['3', '4']);
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();

    await saveManager();
    const saved = await readSavedRow('Executing', 'Urgent ping');
    expect(saved?.filter?.priorities).toEqual([3, 4]);
  });

  test('Priority keeps typed text that names no level on Enter, clears it on blur, and still adds an exact name', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');
    await pickKind('priority');

    const field = conditionCard().locator('[data-testid="edit-automation-condition-priority"]');
    const chips = conditionCard().locator('[data-testid="edit-automation-condition-priority-chip"]');

    await test.step('Enter on text that matches no level leaves it in the field and adds nothing', async () => {
      await field.click();
      await field.fill('zz');
      await field.press('Enter');
      await expect(field).toHaveValue('zz');
      await expect(chips).toHaveCount(0);
    });

    await test.step('blurring the field clears the unmatched text and still adds nothing', async () => {
      await editDialog().locator('[data-testid="edit-automation-name"]').click();
      await expect(field).toHaveValue('');
      await expect(chips).toHaveCount(0);
    });

    await test.step('Enter on a name that matches one level still adds its chip', async () => {
      await field.click();
      await field.fill('Urgent');
      await field.press('Enter');
      await expect(chips).toHaveCount(1);
      await expect(chips.first()).toHaveAttribute('data-value', '4');
      await expect(field).toHaveValue('');
    });
  });

  test('an Evaluation with no Automation agent shows the setup box, and Set up opens Settings', async () => {
    await openColumn('Executing');
    await addThroughPicker('enter', 'notify');
    await pickKind('evaluation');

    const setup = conditionCard().locator('[data-testid="edit-automation-condition-setup"]');
    await expect(setup).toBeVisible();
    await expect(conditionCard().locator('[data-testid="edit-automation-condition"]')).toHaveCount(0);
    await expect(settingsPanel()).toHaveCount(0);

    await setup.locator('[data-testid="edit-automation-open-settings"]').click();
    await expect(settingsPanel()).toBeVisible();
  });

  test('a Reply and an Evaluation save together and reopen as two lines, and the Reply never offers the agent reply as a variable', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'notify');
    await editDialog().locator('[data-testid="edit-automation-name"]').fill('Both checks');

    await pickKind('reply');
    await conditionCard().locator('[data-testid="edit-automation-final-line-line"]').fill('*all green*');
    await pickKind('evaluation');
    const evaluation = conditionCard().locator('[data-testid="edit-automation-condition"]');
    await expect(evaluation).toBeVisible();
    await evaluation.fill('The review is clean');

    await test.step('the Reply line\'s variable menu omits {{agentReply}}, and the Evaluation\'s lists it', async () => {
      await conditionCard().locator('[data-testid="edit-automation-final-line-variable-trigger"]').click();
      const replyMenu = page.locator('[data-testid="edit-automation-final-line-variable-menu"]');
      await expect(replyMenu).toBeVisible();
      await expect(replyMenu.getByText('{{title}}', { exact: true })).toBeVisible();
      await expect(replyMenu.getByText('{{agentReply}}', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(replyMenu).toHaveCount(0);

      await conditionCard().locator('[data-testid="edit-automation-condition-variable-trigger"]').click();
      const evaluationMenu = page.locator('[data-testid="edit-automation-condition-variable-menu"]');
      await expect(evaluationMenu.getByText('{{agentReply}}', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(evaluationMenu).toHaveCount(0);
    });

    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toBeHidden();
    await expect(dialog().locator('[data-testid="column-automation-row"][data-name="Both checks"] [data-testid="column-automation-condition-mark"]'))
      .toHaveAttribute('aria-label', 'Condition: only if the last line reads "*all green*"; only if the review is clean.');
    await saveManager();

    const saved = await readSavedRow('Executing', 'Both checks');
    expect(saved?.final_line).toBe('*all green*');
    expect(saved?.text_match_source).toBe('agent');
    expect(saved?.condition).toBe('The review is clean');

    await openColumn('Executing');
    await dialog().locator('[data-testid="column-automation-row"][data-name="Both checks"] [data-testid="column-automation-edit"]').click();
    await expect(editDialog()).toBeVisible();
    await openCondition();
    await expect(line('reply')).toBeVisible();
    await expect(line('evaluation')).toBeVisible();
    await expect(conditionCard().locator('[data-testid="edit-automation-final-line-line"]')).toHaveValue('*all green*');
    await expect(conditionCard().locator('[data-testid="edit-automation-condition"]')).toHaveValue('The review is clean');
  });

  test('the template variable button sits flush against the right edge of its field', async () => {
    await setAutomationAgent({ agent: 'claude', model: 'sonnet' });
    await openColumn('Executing');
    await addThroughPicker('turn_end', 'send_message');

    /** The field's right edge and the button's left edge, read in one evaluate so one frame decides both. */
    const gapBetween = async (field: Locator, trigger: Locator): Promise<number> => {
      await expect(trigger).toBeVisible();
      return field.evaluate((node, triggerTestId) => {
        const button = document.querySelector(`[data-testid="${triggerTestId}"]`);
        if (!button) throw new Error(`No ${triggerTestId}`);
        return button.getBoundingClientRect().left - node.getBoundingClientRect().right;
      }, await trigger.getAttribute('data-testid') as string);
    };

    await test.step('the Action message field', async () => {
      const field = editDialog().locator('[data-testid="automation-config-message"]');
      const trigger = editDialog().locator('[data-testid="automation-config-message-variable-trigger"]');
      await expect(trigger).toHaveAttribute('aria-label', 'Template variable');
      expect(Math.abs(await gapBetween(field, trigger))).toBeLessThanOrEqual(1);
    });

    await test.step('a Reply line, whose field is the pattern lines', async () => {
      await pickKind('reply');
      const field = conditionCard().locator('[data-testid="edit-automation-final-line"]');
      const trigger = conditionCard().locator('[data-testid="edit-automation-final-line-variable-trigger"]');
      expect(Math.abs(await gapBetween(field, trigger))).toBeLessThanOrEqual(1);
    });

    await test.step('an Evaluation line', async () => {
      await pickKind('evaluation');
      const field = conditionCard().locator('[data-testid="edit-automation-condition"]');
      const trigger = conditionCard().locator('[data-testid="edit-automation-condition-variable-trigger"]');
      // The field's own text area may leave room for the info icon inside its frame, so the frame is the field.
      const frame = field.locator('xpath=ancestor::div[contains(@class,"flex-1")][1]');
      expect(Math.abs(await gapBetween(frame, trigger))).toBeLessThanOrEqual(1);
    });
  });
});
