/**
 * UI tests for `TemplateTextField`, the highlighted textarea every automation
 * field with template variables uses.
 *
 * The control renders the value TWICE at once: a transparent textarea over a
 * mirror that paints the same characters with the `{{variables}}` picked out.
 * That is the whole risk. Nothing in the renderer did this before, and the two
 * layers only stay aligned while their type metrics are identical, so the first
 * test here is a computed-style comparison rather than anything visual: it
 * fails the day someone edits one layer's className and not the other, which no
 * screenshot diff on a short value would catch.
 *
 * Deliberately NOT pixel assertions. `cross-platform-parity.md` bans them, and
 * headless Linux and Windows disagree about font metrics by a pixel or two at
 * every size. Comparing the two layers to EACH OTHER has a real tolerance of
 * zero on every platform, because both read one class string.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `TemplateField Test ${Date.now()}`;
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
const field = () => page.locator('[data-testid="automation-config-message"]');
const mirror = () => page.locator('[data-testid="automation-config-message-mirror"]');
const inlinePicker = () => page.locator('[data-testid="automation-config-message-inline-picker"]');

/**
 * Open a Send message to agent row's editor on Code Review, which is the one
 * column the mock seeds with a message.
 *
 * Seeded through the IPC surface rather than the picker: this file is about the
 * field, and driving four dialogs to reach it would make every failure here
 * read as a failure of something else.
 */
async function openMessageField(initialMessage: string): Promise<void> {
  await page.evaluate(async (message) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === 'Code Review');
    if (!lane) throw new Error('No Code Review column');
    await window.electronAPI.automations.replaceForColumn(lane.id, [{
      id: '',
      swimlane_id: lane.id,
      name: 'Review',
      type: 'send_message',
      trigger: 'enter',
      position: 0,
      enabled: true,
      config: { message },
      created_at: '',
      updated_at: '',
    }], lane.id);
  }, initialMessage);

  const column = page.locator('[data-swimlane-name="Code Review"]');
  await column.locator('text=Code Review').click();
  await expect(dialog()).toBeVisible({ timeout: 3000 });
  await dialog().locator('[data-testid="column-automation-row"][data-name="Review"]')
    .locator('[data-testid="column-automation-edit"]').click();
  await expect(editDialog()).toBeVisible();
  await expect(field()).toHaveValue(initialMessage);
}

async function closeEverything(): Promise<void> {
  if (await editDialog().isVisible({ timeout: 200 }).catch(() => false)) {
    await editDialog().locator('[data-testid="edit-automation-cancel"]').click();
  }
  if (await dialog().isVisible({ timeout: 200 }).catch(() => false)) {
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    const discard = page.locator('button', { hasText: 'Discard' });
    if (await discard.isVisible({ timeout: 500 }).catch(() => false)) await discard.click();
    await dialog().waitFor({ state: 'detached', timeout: 5000 });
  }
}

/** Every `{{...}}` the mirror painted, with whether the field recognised it. */
function paintedVariables(): Promise<Array<{ name: string; known: string; text: string }>> {
  return mirror().locator('[data-template-variable]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.getAttribute('data-template-variable') ?? '',
      known: node.getAttribute('data-known') ?? '',
      text: node.textContent ?? '',
    })));
}

test.describe('TemplateTextField', () => {
  test.afterEach(async () => {
    await closeEverything();
  });

  // ── The alignment guard ────────────────────────────────────────────────────

  test('the textarea and its mirror agree on every property that moves a character', async () => {
    await openMessageField('/code-review');

    const drift = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="automation-config-message"]');
      const mirrorNode = document.querySelector('[data-testid="automation-config-message-mirror"]');
      if (!textarea || !mirrorNode) return ['one of the two layers is missing'];
      // Everything that decides WHERE a character lands. Colour, background and
      // border are deliberately absent: those are supposed to differ.
      const keys = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing',
        'lineHeight', 'textIndent', 'textTransform', 'whiteSpace', 'overflowWrap', 'wordBreak',
        'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      ];
      const front = getComputedStyle(textarea);
      const back = getComputedStyle(mirrorNode);
      return keys
        .filter((key) => front[key as never] !== back[key as never])
        .map((key) => `${key}: textarea "${front[key as never]}" vs mirror "${back[key as never]}"`);
    });

    expect(drift, 'the two layers must resolve these identically or the paint slides off the caret').toEqual([]);
  });

  /**
   * The blank-field guard.
   *
   * The textarea sits LATER in DOM order than the mirror and is positioned, so
   * any background on it paints over the mirror and the field renders empty.
   * That shipped for exactly one preview, and every other test in this file
   * passed through it: they assert DOM attributes, and a field whose text is
   * hidden behind an opaque panel has all the right ones. Assert what is
   * actually on screen instead.
   */
  test('the painted text is not covered by the textarea that sits over it', async () => {
    await openMessageField('/review {{baseBranch}}');

    const painted = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="automation-config-message"]');
      const variable = document.querySelector('[data-template-variable="baseBranch"]');
      if (!textarea || !variable) return null;
      const box = variable.getBoundingClientRect();
      const onTop = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        textareaBackground: getComputedStyle(textarea).backgroundColor,
        // The variable's own ink must be visible, which means nothing opaque
        // may sit between it and the viewer. The textarea itself IS over it,
        // and that is fine precisely because it is transparent both ways.
        topmostIsTheTextarea: onTop === textarea,
        variableHasSize: box.width > 0 && box.height > 0,
      };
    });

    expect(painted).not.toBeNull();
    expect(painted?.textareaBackground, 'an opaque textarea hides the mirror entirely').toBe('rgba(0, 0, 0, 0)');
    expect(painted?.variableHasSize).toBe(true);
    expect(painted?.topmostIsTheTextarea, 'the textarea must stay the hit target').toBe(true);
  });

  test('the two layers occupy the same box', async () => {
    await openMessageField('/code-review');

    // BOTH boxes in one evaluate, so they are read in the same frame. Two
    // separate round trips straddle the dialog's entrance animation, and at
    // three workers that reported a 3px width difference that did not exist by
    // the time anything rendered.
    const deltas = () => page.evaluate(() => {
      const front = document.querySelector('[data-testid="automation-config-message"]')?.getBoundingClientRect();
      const back = document.querySelector('[data-testid="automation-config-message-mirror"]')?.getBoundingClientRect();
      if (!front || !back) return null;
      return {
        x: Math.abs(front.x - back.x),
        y: Math.abs(front.y - back.y),
        width: Math.abs(front.width - back.width),
      };
    });

    // A tolerance, not equality: sub-pixel layout rounding differs between
    // Windows and headless Linux and is not a defect. A real drift is whole
    // pixels, and the computed-style test above is what catches its causes.
    const worstDelta = async (): Promise<number | null> => {
      const measured = await deltas();
      return measured === null ? null : Math.max(measured.x, measured.y, measured.width);
    };
    await expect.poll(worstDelta).toBeLessThan(2);
  });

  // ── What the highlight says ────────────────────────────────────────────────

  test('paints a known variable as known and an unknown one as unknown, and names the unknown', async () => {
    await openMessageField('/review {{baseBranch}} and {{nope}}');

    await expect.poll(paintedVariables).toEqual([
      { name: 'baseBranch', known: 'true', text: '{{baseBranch}}' },
      { name: 'nope', known: 'false', text: '{{nope}}' },
    ]);

    const notice = page.locator('[data-testid="automation-config-message-unknown"]');
    await expect(notice).toBeVisible();
    // Named, and worded as a fact: an unknown name is passed through literally
    // by every interpolator, so nothing breaks.
    await expect(notice).toHaveText('Unknown variable: nope. It will be sent as written.');
  });

  // The pill's breathing room is painted OUTWARD (padding cancelled by a
  // negative margin) so it cannot move a glyph and desync the caret. The cost
  // is that it would paint over a character sitting directly against it, which
  // is what typing one character after a variable produces. So each side is
  // padded only when the neighbour is a space or the end of the value.
  //
  // 1px is pinned rather than left loose: it is the whole of what a 3.8px space
  // can give up and still read as a space. This was 4px, which covered the
  // space outright and left the pill touching the words on both sides.
  test('a pill pads only into whitespace, never over the character beside it', async () => {
    const padding = () => page.evaluate(() => Array.from(
      document.querySelectorAll('[data-template-variable]'),
    ).map((pill) => {
      const style = getComputedStyle(pill);
      return { name: (pill as HTMLElement).dataset.templateVariable, left: style.paddingLeft, right: style.paddingRight };
    }));

    // Opened once and refilled: the helper opens the Column Manager, so calling
    // it again lands on its own backdrop.
    await openMessageField('go {{title}} now');
    const field = page.locator('[data-testid="automation-config-message"]');

    // Spaces on both sides: room to paint into on both sides.
    await expect.poll(padding).toEqual([{ name: 'title', left: '1px', right: '1px' }]);

    // A character typed straight after the variable. The right side must give
    // up its padding or the glyph lands on the pill's background.
    await field.fill('{{description}}s');
    await expect.poll(padding).toEqual([{ name: 'description', left: '1px', right: '0px' }]);

    // Touching pills borrow from each other on neither side.
    await field.fill('{{title}}{{toColumn}}');
    await expect.poll(padding).toEqual([
      { name: 'title', left: '1px', right: '0px' },
      { name: 'toColumn', left: '0px', right: '1px' },
    ]);
  });

  test('says nothing when every variable is known', async () => {
    await openMessageField('/review {{title}} on {{toColumn}}');

    await expect.poll(paintedVariables).toEqual([
      { name: 'title', known: 'true', text: '{{title}}' },
      { name: 'toColumn', known: 'true', text: '{{toColumn}}' },
    ]);
    await expect(page.locator('[data-testid="automation-config-message-unknown"]')).toHaveCount(0);
  });

  // A field's context decides the catalog, and an automation is a move, so both
  // halves of the pair resolve. The spawn context is the one that would not.
  test('recognises the move variables, which only an automation has', async () => {
    await openMessageField('{{fromColumn}} -> {{toColumn}} ({{trigger}})');

    const painted = await paintedVariables();
    expect(painted.map((entry) => entry.known)).toEqual(['true', 'true', 'true']);
  });

  test('repaints as the value is typed, and fill() still drives the control', async () => {
    await openMessageField('');

    // `fill()` is the whole reason this stayed a <textarea>. If the control
    // ever becomes contenteditable this line is what fails first.
    await field().fill('start {{taskNumber}}');
    await expect.poll(paintedVariables).toEqual([
      { name: 'taskNumber', known: 'true', text: '{{taskNumber}}' },
    ]);

    // Typed rather than filled, so the paint has to survive per-keystroke
    // re-renders rather than one atomic set.
    await field().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' {{labels}}');
    await expect.poll(paintedVariables).toEqual([
      { name: 'taskNumber', known: 'true', text: '{{taskNumber}}' },
      { name: 'labels', known: 'true', text: '{{labels}}' },
    ]);
  });

  test('keeps the mirror on the text when a long value scrolls', async () => {
    await openMessageField('');
    await field().fill(`${'line\n'.repeat(40)}{{title}}`);

    await field().evaluate((node: HTMLTextAreaElement) => { node.scrollTop = node.scrollHeight; });

    await expect.poll(() => page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="automation-config-message"]') as HTMLTextAreaElement | null;
      const mirrorNode = document.querySelector('[data-testid="automation-config-message-mirror"]');
      if (!textarea || !mirrorNode) return null;
      return { scrolled: textarea.scrollTop > 0, delta: Math.abs(textarea.scrollTop - mirrorNode.scrollTop) };
    })).toEqual({ scrolled: true, delta: 0 });
  });

  // ── The inline picker ──────────────────────────────────────────────────────

  test('typing {{ opens the picker, filters it, and Enter inserts at the caret', async () => {
    await openMessageField('');
    await field().click();
    await page.keyboard.type('/review {{');

    await expect(inlinePicker()).toBeVisible();
    await page.keyboard.type('base');

    const options = inlinePicker().locator('[data-testid="automation-config-message-inline-option"]');
    await expect.poll(() => options.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-name'))))
      .toEqual(['baseBranch']);

    await page.keyboard.press('Enter');
    // The braces typed so far are REPLACED, not appended to, so the value is a
    // single well-formed variable rather than `{{base{{baseBranch}}`. The
    // trailing space comes with it: accepting a variable leaves the caret ready
    // for the rest of the sentence rather than butted against `}}`.
    await expect(field()).toHaveValue('/review {{baseBranch}} ');
    await expect(inlinePicker()).toHaveCount(0);
  });

  test('arrow keys move the inline selection and the caret lands after the insert', async () => {
    await openMessageField('');
    await field().click();
    await page.keyboard.type('{{');
    await expect(inlinePicker()).toBeVisible();

    const options = inlinePicker().locator('[data-testid="automation-config-message-inline-option"]');
    const first = await options.first().getAttribute('data-name');
    await page.keyboard.press('ArrowDown');
    const active = inlinePicker().locator('[data-testid="automation-config-message-inline-option"][data-active="true"]');
    await expect(active).not.toHaveAttribute('data-name', first ?? '');

    const picked = await active.getAttribute('data-name');
    await page.keyboard.press('Enter');
    await expect(field()).toHaveValue(`{{${picked}}} `);

    // Typing immediately afterwards must land AFTER the inserted variable and
    // its space, which is what the rAF caret restore exists for.
    await page.keyboard.type('!');
    await expect(field()).toHaveValue(`{{${picked}}} !`);
  });

  // The space is what the writer would have typed next, so accepting a variable
  // leaves the caret ready for the rest of the sentence. It is skipped where the
  // text already continues with whitespace, or re-picking mid-line would widen
  // the gap every time.
  test('accepting a variable adds the space after it, unless one is already there', async () => {
    await openMessageField('');
    await field().click();
    await page.keyboard.type('{{base');
    await expect(inlinePicker()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(field()).toHaveValue('{{baseBranch}} ');

    // Accepting where the text already continues with a space must not add a
    // second one. Typed rather than driven through `setSelectionRange`, whose
    // synthetic `select` event never reaches the React handler that opens the
    // picker.
    await field().fill('');
    await field().click();
    await page.keyboard.type(' and more');
    await page.keyboard.press('Home');
    await page.keyboard.type('{{base');
    await expect(inlinePicker()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(field()).toHaveValue('{{baseBranch}} and more');
  });

  test('Escape closes the inline picker without closing the dialog it sits in', async () => {
    await openMessageField('');
    await field().click();
    await page.keyboard.type('{{');
    await expect(inlinePicker()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(inlinePicker()).toHaveCount(0);
    // The nested dialog has its own Escape handler. Losing the whole editor
    // because someone dismissed an autocomplete is the wrong outcome.
    await expect(editDialog()).toBeVisible();
  });

  test('a completed variable does not re-open the picker', async () => {
    await openMessageField('');
    await field().click();
    await page.keyboard.type('{{title}}');
    await expect(inlinePicker()).toHaveCount(0);
  });

  // ── The button and the inline picker agree ─────────────────────────────────

  test('the Template variable button inserts at the caret of the highlighted field', async () => {
    await openMessageField('Run  now');

    // Caret between the two spaces, which is where the insert must land.
    await field().click();
    await field().evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 4));

    await editDialog().locator('[data-testid="template-variable-trigger"]').click();
    await page.locator('[data-testid="template-variable-menu"]')
      .locator('button', { hasText: '{{title}}' }).first().click();

    await expect(field()).toHaveValue('Run {{title}} now');
    await expect.poll(paintedVariables).toEqual([
      { name: 'title', known: 'true', text: '{{title}}' },
    ]);
  });

  test('an edit made through the field persists on save', async () => {
    await openMessageField('/code-review');
    await field().fill('/code-review {{baseBranch}}');
    await editDialog().locator('[data-testid="edit-automation-done"]').click();
    await expect(editDialog()).toHaveCount(0);

    await dialog().locator('[data-testid="board-manager-save"]').click();
    await dialog().waitFor({ state: 'detached', timeout: 10000 });

    const saved = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      const lane = lanes.find((swimlane) => swimlane.name === 'Code Review');
      const rows = await window.electronAPI.automations.list();
      return rows.filter((row) => row.swimlane_id === lane?.id).map((row) => row.config.message);
    });
    expect(saved).toEqual(['/code-review {{baseBranch}}']);
  });
});
