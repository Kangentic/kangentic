/**
 * UI tests for the Text match field's keyboard and paste behavior
 * (`PatternLinesField`): one input per pattern line, edited like a text editor.
 *
 * `edit-automation-guards.spec.ts` has the one-pass walkthrough. This file pins
 * each editing rule on its own, with line count, every line's value, and where
 * it matters the focused line and the caret offset, so a regression names the
 * rule it broke. Each test opens its own fresh Edit automation dialog.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Locator, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `PatternLinesField Test ${Date.now()}`;
const CONDITION_DESCRIPTION = 'Runs only when this holds.';

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
const lineInputs = () => conditionCard().locator('[data-testid="edit-automation-final-line-line"]');

async function closeDialogs(): Promise<void> {
  if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
    await expect(editDialog()).toBeHidden();
  }
  if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) {
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    const discard = page.locator('button', { hasText: 'Discard' });
    const outcome = await Promise.race([
      discard.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'confirm' as const, () => 'none' as const),
      dialog().waitFor({ state: 'detached', timeout: 3000 }).then(() => 'closed' as const, () => 'none' as const),
    ]);
    if (outcome === 'confirm') await discard.click();
    await dialog().waitFor({ state: 'detached', timeout: 3000 });
  }
}

/** Clear every column's automations and the Automation agent, so a new row starts on Text match. */
async function resetBoard(): Promise<void> {
  await page.evaluate(async () => {
    const lanes = await window.electronAPI.swimlanes.list();
    for (const lane of lanes) {
      await window.electronAPI.automations.replaceForColumn(lane.id, [], lane.id);
    }
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: object) => Promise<unknown> } } };
    }).__zustandStores;
    await stores.config.getState().updateConfig({ automation: { agent: null, model: null } });
  });
}

/** Open a new turn-end row's editor with the Text match field enabled and empty. */
async function openField(): Promise<void> {
  const column = page.locator('[data-swimlane-name="Executing"]');
  await column.locator('text=Executing').click();
  await expect(dialog()).toBeVisible({ timeout: 3000 });
  await dialog().locator('[data-testid="column-automation-add"][data-trigger="turn_end"]').click();
  const picker = page.locator('[data-testid="column-automation-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator('[data-testid="column-automation-picker-type"][data-type="notify"]').click();
  await expect(editDialog()).toBeVisible();
  await conditionCard().getByText(CONDITION_DESCRIPTION).click();
  await expect(lineInputs()).toHaveCount(1);
  await expect(lineInputs().nth(0)).toBeEnabled();
}

/** Type the lines in as a user would: text, then Enter for each new line. */
async function typeLines(lines: string[]): Promise<void> {
  const inputs = lineInputs();
  await inputs.nth(0).fill(lines[0]);
  for (let index = 1; index < lines.length; index++) {
    await page.keyboard.press('Enter');
    await expect(inputs).toHaveCount(index + 1);
    await expect(inputs.nth(index)).toBeFocused();
    if (lines[index] !== '') await page.keyboard.type(lines[index]);
  }
  await expectLines(lines);
}

async function readLines(): Promise<string[]> {
  return lineInputs().evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}

/** Count and every value together, polled until the field settles. */
async function expectLines(expected: string[]): Promise<void> {
  await expect(lineInputs()).toHaveCount(expected.length);
  await expect.poll(readLines).toEqual(expected);
}

/** Focus a line and put the caret (or a selection) at an offset. */
async function placeCaret(line: Locator, start: number, end: number = start): Promise<void> {
  await line.evaluate((input, range) => {
    const field = input as HTMLInputElement;
    field.focus();
    field.setSelectionRange(range.start, range.end);
  }, { start, end });
}

async function caretOf(line: Locator): Promise<number | null> {
  return line.evaluate((input) => (input as HTMLInputElement).selectionStart);
}

/** Paste text into a line as a synthetic ClipboardEvent. Resolves to whether the paste was left alone (not prevented). */
async function pasteInto(line: Locator, text: string): Promise<boolean> {
  return line.evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    return input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test.describe('Text match pattern lines: keyboard and paste', () => {
  test.beforeEach(async () => {
    await closeDialogs();
    await resetBoard();
    await openField();
  });

  test.afterEach(async () => {
    await closeDialogs();
    await resetBoard();
  });

  test('Delete at the end of a line joins the next line and leaves the caret at the join', async () => {
    await typeLines(['A', 'B']);
    await placeCaret(lineInputs().nth(0), 1);
    await page.keyboard.press('End');
    await page.keyboard.press('Delete');
    await expectLines(['AB']);
    await expect(lineInputs().nth(0)).toBeFocused();
    expect(await caretOf(lineInputs().nth(0))).toBe(1);

    await page.keyboard.type('x');
    await expectLines(['AxB']);
  });

  test('Backspace at the start of a non-empty line joins it to the non-empty line above', async () => {
    await typeLines(['Ready', 'Done']);
    await placeCaret(lineInputs().nth(1), 0);
    await page.keyboard.press('Backspace');
    await expectLines(['ReadyDone']);
    await expect(lineInputs().nth(0)).toBeFocused();
    expect(await caretOf(lineInputs().nth(0))).toBe(5);

    await page.keyboard.type('X');
    await expectLines(['ReadyXDone']);
  });

  test('Backspace on an empty middle line removes it and moves focus to the end of the line above', async () => {
    await typeLines(['abc', '', 'z']);
    await placeCaret(lineInputs().nth(1), 0);
    await page.keyboard.press('Backspace');
    await expectLines(['abc', 'z']);
    await expect(lineInputs().nth(0)).toBeFocused();
    expect(await caretOf(lineInputs().nth(0))).toBe(3);
  });

  test('ArrowDown moves to the next line with the caret clamped to its length, and the first and last lines stay put', async () => {
    await typeLines(['long pattern', 'ab']);
    const inputs = lineInputs();

    await placeCaret(inputs.nth(0), 8);
    await page.keyboard.press('ArrowDown');
    await expect(inputs.nth(1)).toBeFocused();
    expect(await caretOf(inputs.nth(1))).toBe(2);

    // The last line has nothing below: focus stays.
    await page.keyboard.press('ArrowDown');
    await expect(inputs.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(inputs.nth(0)).toBeFocused();

    // The first line has nothing above: focus stays.
    await page.keyboard.press('ArrowUp');
    await expect(inputs.nth(0)).toBeFocused();
    await expectLines(['long pattern', 'ab']);
  });

  test('Shift+ArrowUp and Shift+ArrowDown are left to the input instead of moving between lines', async () => {
    await typeLines(['abcd', 'efgh']);
    const inputs = lineInputs();

    await placeCaret(inputs.nth(1), 2);
    await page.keyboard.press('Shift+ArrowUp');
    await expect(inputs.nth(1)).toBeFocused();

    await placeCaret(inputs.nth(0), 2);
    await page.keyboard.press('Shift+ArrowDown');
    await expect(inputs.nth(0)).toBeFocused();
    await expectLines(['abcd', 'efgh']);
  });

  test('Enter with a selection drops the selected text, and Ctrl+Enter does not split', async () => {
    await typeLines(['abcdef']);
    await placeCaret(lineInputs().nth(0), 2, 4);
    await page.keyboard.press('Enter');
    await expectLines(['ab', 'ef']);
    await expect(lineInputs().nth(1)).toBeFocused();

    await placeCaret(lineInputs().nth(0), 1);
    await page.keyboard.press('Control+Enter');
    // A key that must do nothing: the count is checked after the press has been handled.
    await expectLines(['ab', 'ef']);
  });

  test('an Enter pressed while an IME is composing does not split the line', async () => {
    await typeLines(['abcd']);
    await placeCaret(lineInputs().nth(0), 2);
    const prevented = await lineInputs().nth(0).evaluate((input) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await expectLines(['abcd']);
  });

  test('a paste with line breaks splices into the middle of a line, a lone CR splits too, and a plain paste is left to the input', async () => {
    await typeLines(['abcd']);
    const inputs = lineInputs();

    await placeCaret(inputs.nth(0), 2);
    expect(await pasteInto(inputs.nth(0), 'X\r\nY')).toBe(false);
    await expectLines(['abX', 'Ycd']);
    await expect(inputs.nth(1)).toBeFocused();
    expect(await caretOf(inputs.nth(1))).toBe(1);

    // A lone carriage return is a line break as well.
    await inputs.nth(1).fill('');
    await expectLines(['abX', '']);
    expect(await pasteInto(inputs.nth(1), 'P\rQ')).toBe(false);
    await expectLines(['abX', 'P', 'Q']);
    await expect(inputs.nth(2)).toBeFocused();

    // No line break: not intercepted, so the input's own paste runs.
    expect(await pasteInto(inputs.nth(2), 'zz')).toBe(true);
    await expectLines(['abX', 'P', 'Q']);
  });

  test('a multi-line draft survives a Trigger switch, and turning the Condition off disables the lines', async () => {
    await typeLines(['one', 'two', '']);

    await editDialog().locator('[data-testid="edit-automation-trigger-enter"]').click();
    await editDialog().locator('[data-testid="edit-automation-trigger-turn_end"]').click();
    await expect(editDialog().locator('[data-testid="edit-automation-condition-kind-text"]'))
      .toHaveAttribute('aria-checked', 'true');
    await expectLines(['one', 'two', '']);

    await conditionCard().locator('[data-testid="edit-automation-card-condition-switch"]').click();
    await expect(conditionCard().locator('[data-testid="edit-automation-card-condition-switch"]'))
      .toHaveAttribute('aria-checked', 'false');
    // The switched-off card may show fewer lines than the draft held; whatever it shows is disabled.
    await expect.poll(async () => lineInputs().evaluateAll(
      (inputs) => inputs.length > 0 && inputs.every((input) => (input as HTMLInputElement).disabled),
    )).toBe(true);
  });
});
