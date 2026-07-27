import { expect, test } from '@playwright/test';
import { createProject, createTask, launchPage } from './helpers';
import type { Browser, Locator, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Description Mention Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

/**
 * Wait for all dialog backdrops (fixed inset-0 overlays) to fully unmount.
 * BaseDialog animates close over 150ms and only unmounts on `animationend`.
 * Without this wait, a backdrop from the prior test intercepts clicks on "Add
 * task" in the next test, causing deterministic timeouts in a shared-page suite.
 */
async function waitForNoBackdrop(): Promise<void> {
  await expect(page.locator('.fixed.inset-0')).toHaveCount(0, { timeout: 2000 });
}

async function openNewTaskDialog() {
  // Ensure any dialog/backdrop from a prior test is fully gone before clicking.
  await waitForNoBackdrop();
  await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

/**
 * Dispatch a real `paste` ClipboardEvent carrying both `text/html` and
 * `text/plain` flavors on the given element, mirroring how a browser hands a
 * paste to the page (unlike the file-DataTransfer paste tests elsewhere in
 * this file, `onPaste` never calls `event.preventDefault()` for a text-only
 * paste, so this reaches DescriptionEditor's own HTML-conversion gate).
 * Returns the event's own `defaultPrevented` flag, read synchronously right
 * after dispatch - `handlePaste` calls `event.preventDefault()` (or doesn't)
 * entirely synchronously before it ever awaits the async conversion, so this
 * is a precise, immediate signal of which branch the gate took.
 */
async function dispatchHtmlPaste(target: Locator, html: string, plainText: string): Promise<boolean> {
  return target.evaluate((node, args) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/html', args.html);
    dataTransfer.setData('text/plain', args.plainText);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, { html, plainText });
}

/**
 * Dispatch a synthetic (untrusted) `keydown` for Mod+Shift+V on the given
 * element, to arm DescriptionEditor's `pastePlainRef` without going through
 * `page.keyboard.press`. A REAL, trusted Ctrl+Shift+V keypress is bound to
 * Chromium's own "paste and match style" edit command, which fires its own
 * native `paste` event (confirmed empirically: `isTrusted: true`, empty
 * `clipboardData.types` under headless Chromium with no clipboard
 * permission) - that event reaches `handlePaste` first and consumes
 * (resets) the ref before a test's own synthetic paste dispatch ever runs,
 * making the real key press unusable for testing this arm/consume pairing
 * deterministically. A JS-constructed `KeyboardEvent` is untrusted and
 * carries no such native side effect, while still reaching React's
 * `onKeyDown` (delegated `addEventListener`, which does not filter on
 * `isTrusted`) exactly like the file's own `dispatchHtmlPaste` above already
 * relies on for `paste`.
 */
async function armPastePlainViaSyntheticKeydown(target: Locator): Promise<void> {
  await target.evaluate((node) => {
    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    node.dispatchEvent(event);
  });
}

/**
 * Monkey-patches `HTMLTextAreaElement.prototype.setSelectionRange` on the
 * page to count calls, so a test can prove an async paste-conversion
 * callback actually ran before asserting on its result. `applyTextareaEdit`
 * calls `setSelectionRange` on every path it can take - including the
 * empty-insert/collapsed-caret early return - so a call landing is a
 * reliable "the promise settled" signal regardless of which branch fired.
 * Without this, a test asserting "the value is unchanged" after an async
 * paste would pass just as happily before the promise resolves as after,
 * proving nothing.
 */
async function armSetSelectionRangeProbe(): Promise<void> {
  await page.evaluate(() => {
    const proto = HTMLTextAreaElement.prototype;
    const globalWindow = window as unknown as {
      __originalSetSelectionRange?: typeof proto.setSelectionRange;
      __setSelectionRangeCallCount?: number;
    };
    if (!globalWindow.__originalSetSelectionRange) {
      globalWindow.__originalSetSelectionRange = proto.setSelectionRange;
    }
    globalWindow.__setSelectionRangeCallCount = 0;
    proto.setSelectionRange = function patchedSetSelectionRange(
      this: HTMLTextAreaElement,
      ...args: Parameters<typeof proto.setSelectionRange>
    ) {
      globalWindow.__setSelectionRangeCallCount = (globalWindow.__setSelectionRangeCallCount ?? 0) + 1;
      return globalWindow.__originalSetSelectionRange!.apply(this, args);
    };
  });
}

/** Waits until the armed probe above records at least one call. */
async function waitForSetSelectionRangeCall(): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __setSelectionRangeCallCount?: number }).__setSelectionRangeCallCount ?? 0,
        ),
      // Dynamic import('turndown') may be cold (this file's describe blocks
      // can land on separate workers), so this budget covers a cold import
      // through the Vite dev server, not just a warm re-conversion.
      { timeout: 5000, intervals: [50, 50, 100, 200, 300, 500] },
    )
    .toBeGreaterThan(0);
}

/** Restores the original `setSelectionRange`, leaving no trace for later tests. */
async function disarmSetSelectionRangeProbe(): Promise<void> {
  await page.evaluate(() => {
    const proto = HTMLTextAreaElement.prototype;
    const globalWindow = window as unknown as { __originalSetSelectionRange?: typeof proto.setSelectionRange };
    if (globalWindow.__originalSetSelectionRange) {
      proto.setSelectionRange = globalWindow.__originalSetSelectionRange;
    }
  });
}

test.describe('DescriptionEditor file mentions', () => {
  test('supports keyboard selection in New Task', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@src');

    const menu = page.locator('[data-testid="description-mention-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('src');

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="description-mention-item"]').nth(1)).toHaveClass(/bg-surface-hover/);

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const selectedValue = await textarea.inputValue();
    await expect(selectedValue.startsWith('@src')).toBeTruthy();
    await expect(menu).not.toBeVisible();

    // Form is dirty (description filled) - Cancel shows "Discard unsaved
    // changes?" confirm. Dismiss via Discard so the dialog fully closes before
    // the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('a mention menu with many results stays inside the editor body instead of clipping off the top', async () => {
    await openNewTaskDialog();

    // "@r" matches every entry in the mock file list (see mock-electron-api.js's
    // MOCK_PROJECT_ENTRIES), so the menu renders enough rows to exceed the
    // editor's fixed 160px body - the scenario DescriptionMentionMenu's
    // `max-h-[min(20rem,calc(100%-1.5rem))]` cap exists for. The menu is
    // bottom-anchored and grows upward, so without that cap its top edge runs
    // above the editor body's top edge and gets sliced by the body's own
    // `overflow-hidden`.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@r');

    const menu = page.locator('[data-testid="description-mention-menu"]');
    await expect(menu).toBeVisible();
    // A floor, not an exact count: the point is only that enough rows render
    // to overflow the 160px body (six rows at ~40px each already clears it
    // with room to spare - the pre-fix overshoot measured 93px), not the
    // precise size of MOCK_PROJECT_ENTRIES, which other mention tests are
    // free to grow.
    await expect
      .poll(() => page.locator('[data-testid="description-mention-item"]').count())
      .toBeGreaterThanOrEqual(6);

    const geometry = await page.evaluate(() => {
      const editorBody = document.querySelector('[data-testid="description-editor-body"]') as HTMLElement;
      const mentionMenu = document.querySelector('[data-testid="description-mention-menu"]') as HTMLElement;
      return {
        editorTop: editorBody.getBoundingClientRect().top,
        menuTop: mentionMenu.getBoundingClientRect().top,
      };
    });

    // A tolerance, not a pixel-exact comparison (cross-platform-parity): the
    // clipping bug this guards overshoots by several tens of pixels, not
    // sub-pixel rounding noise, so a 1px floor is generous rather than fragile.
    expect(geometry.menuTop).toBeGreaterThanOrEqual(geometry.editorTop - 1);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('tab selects the highlighted item and escape closes only the menu', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@desc');

    const menu = page.locator('[data-testid="description-mention-menu"]');
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    await textarea.fill('');
    await textarea.fill('@desc');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('DescriptionEditor.tsx');
    await page.keyboard.press('Tab');
    await expect(textarea).toHaveValue('@src/renderer/components/DescriptionEditor.tsx ');

    // Form is dirty (description filled) - Cancel shows "Discard unsaved
    // changes?" confirm. Dismiss via Discard so the dialog fully closes before
    // the next test runs.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('is available in backlog editing and preview preserves plain text', async () => {
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();

    const backlogTextarea = page.locator('[data-testid="backlog-task-description"]');
    await backlogTextarea.fill('@read');
    await expect(page.locator('[data-testid="description-mention-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="description-mention-menu"]')).toContainText('README.md');
    await page.keyboard.press('Enter');
    await expect(backlogTextarea).toHaveValue('@README.md ');

    await page.locator('[data-testid="description-preview-toggle"]').click();
    await expect(page.locator('[data-testid="description-preview"]')).toContainText('@README.md');
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="view-toggle-board"]').click();
  });

  test('uses worktree or project editor wiring in task detail', async () => {
    await createTask(page, 'Mention Detail Task');
    await page.locator('[data-testid="swimlane"]').locator('text=Mention Detail Task').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.fill('@workt');
    await expect(page.locator('[data-testid="description-mention-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="description-mention-menu"]')).toContainText('worktree-strategy.md');

    await page.keyboard.press('Enter');
    await expect(textarea).toHaveValue('@docs/worktree-strategy.md ');

    // Close via Cancel (description-only edits via Playwright fill() do not
    // trigger the dirty guard, so Cancel closes directly without a confirm).
    // Using Cancel rather than Escape avoids the bubble-phase interception risk
    // on CI Linux where focus is in the textarea after Enter.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 5000 });
  });

  test('continues an unordered list on Enter and clears an empty marker instead of nesting', async () => {
    await openNewTaskDialog();

    // pressSequentially dispatches real keystrokes (unlike fill()), so this
    // exercises DescriptionEditor's own keydown handling, not just its value.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('- item one');
    await textarea.press('Enter');
    await textarea.pressSequentially('item two');
    await expect(textarea).toHaveValue('- item one\n- item two');

    // Enter on a non-empty item continues the list; Enter again on the now-
    // empty marker clears it instead of nesting an empty item.
    await textarea.press('Enter');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('- item one\n- item two\n');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('list continuation on Enter is a native undo step, not a wholesale value replacement', async () => {
    await openNewTaskDialog();

    // Enter is applied via execCommand('insertText', ...) specifically so it
    // becomes one step in the native undo stack rather than replacing the
    // field's contents wholesale. This is the discriminator between
    // execCommand actually running and the value/onChange fallback silently
    // taking over: if the fallback were live, undo would fight the controlled
    // textarea's value and could wipe the field instead of stepping back one edit.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('- item one');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('- item one\n- ');

    await textarea.press('ControlOrMeta+z');
    await expect(textarea).toHaveValue(/item one/);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Mod+B wraps the selection in bold markdown', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello world');
    await textarea.press('ControlOrMeta+a');
    await textarea.press('ControlOrMeta+b');
    await expect(textarea).toHaveValue('**hello world**');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Mod+I wraps the selection in italic markdown', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello world');
    await textarea.press('ControlOrMeta+a');
    await textarea.press('ControlOrMeta+i');
    await expect(textarea).toHaveValue('_hello world_');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Mod+K wraps the selection in a markdown link with the caret ready for the URL', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello world');
    await textarea.press('ControlOrMeta+a');
    await textarea.press('ControlOrMeta+k');
    await expect(textarea).toHaveValue('[hello world]()');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Mod+Shift+V arms paste-as-plain, so the following paste skips HTML-to-markdown conversion', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello ');

    // See armPastePlainViaSyntheticKeydown's doc comment: a real trusted
    // Ctrl+Shift+V press fires Chromium's own native "paste and match style"
    // paste event first, which would consume pastePlainRef before this
    // test's own synthetic paste ever dispatches.
    await armPastePlainViaSyntheticKeydown(textarea);
    const defaultPrevented = await dispatchHtmlPaste(
      textarea,
      '<ul><li>one</li><li>two</li></ul>',
      'one\ntwo',
    );

    // handlePaste reads and clears pastePlainRef before it ever inspects the
    // clipboard, so the pastePlain branch returns before reaching
    // shouldConvertPastedHtml - it never calls preventDefault, leaving the
    // browser's native plain-text paste to run instead of turndown's
    // conversion. (A synthetic, untrusted dispatchEvent cannot actually
    // trigger that native paste - see "text/html with no structural tag..."
    // above - so this asserts the gate itself, not the resulting value.)
    expect(defaultPrevented).toBe(false);
    await expect(textarea).toHaveValue('hello ');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('an ordinary keystroke after Mod+Shift+V drops the arm, so a later paste converts normally', async () => {
    await openNewTaskDialog();

    // Guards the disarm at handleTextareaKeyDown's "any other keystroke means
    // the paste never arrived" branch: if a Mod+Shift+V arm were never
    // dropped by an intervening keystroke, the NEXT ordinary paste (Mod+V or
    // otherwise) would silently skip HTML conversion too. A bare letter key
    // carries no Chromium accelerator (unlike Ctrl+Shift+V, see
    // armPastePlainViaSyntheticKeydown's doc comment), so a real keystroke is
    // safe to use here and also leaves the form dirty for the Discard teardown.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello ');

    await armPastePlainViaSyntheticKeydown(textarea);
    await textarea.press('x');

    const defaultPrevented = await dispatchHtmlPaste(
      textarea,
      '<ul><li>one</li><li>two</li></ul>',
      'one\ntwo',
    );

    // The arm was dropped by the intervening 'x' keystroke, so this paste
    // takes the normal conversion path and DOES preventDefault.
    expect(defaultPrevented).toBe(true);
    await expect.poll(() => textarea.inputValue(), { timeout: 5000 }).toMatch(/[*-]\s+one/);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Tab indents a list line by two spaces and Shift+Tab outdents it back', async () => {
    await openNewTaskDialog();

    // pressSequentially + press('Tab') dispatches real keystrokes, so this
    // exercises handleTextareaKeyDown's own Tab routing (indentListSelection +
    // applyTextareaEdit), not just the pure helper in isolation.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('- item one');
    await textarea.press('Tab');
    await expect(textarea).toHaveValue('  - item one');

    await textarea.press('Shift+Tab');
    await expect(textarea).toHaveValue('- item one');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('Tab on a non-list line leaves native focus movement alone', async () => {
    await openNewTaskDialog();

    // indentListSelection returns null when the line under the caret is not a
    // list item, so handleTextareaKeyDown must never call preventDefault here -
    // the browser's native Tab-to-next-focusable behavior has to still fire.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('plain text, not a list');
    await textarea.press('Tab');

    await expect(textarea).not.toBeFocused();
    await expect(textarea).toHaveValue('plain text, not a list');

    // Focus moved off the textarea via Tab (not a click), so Escape (rather
    // than the Cancel button, which the textarea's own click helpers assume
    // is reachable the same way) closes this one; the description is
    // non-empty, so this is the dirty-form discard path.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
  });

  test('a long description scrolls inside a fixed-height editor rather than displacing the fields below it', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    const editorHeight = () =>
      page.locator('[data-testid="description-editor-body"]').evaluate((node) => node.getBoundingClientRect().height);

    // Heights are font- and platform-dependent, so this asserts relationships
    // (unchanged / still reachable), never a pixel literal. Both readings are
    // taken after the dialog's entrance animation has settled - measuring an
    // empty editor the instant the dialog opens catches it mid-scale-transform,
    // and getBoundingClientRect reports the transformed size.
    await textarea.fill(Array.from({ length: 400 }, (_, index) => `Line ${index + 1}`).join('\n'));
    const filledHeight = await editorHeight();

    await textarea.fill('');

    // The editor deliberately does NOT grow to fit. Content-driven growth was
    // tried and reverted: it pushed the run-mode controls under the fold and the
    // footer off-screen, because a windowed dialog neither scrolls nor caps its
    // own height. Maximizing is the affordance for wanting more room.
    await expect.poll(editorHeight).toBeCloseTo(filledHeight, 0);

    await textarea.fill(Array.from({ length: 400 }, (_, index) => `Line ${index + 1}`).join('\n'));

    // The overflow goes into the textarea's own scrollbar instead.
    await expect
      .poll(async () =>
        textarea.evaluate((node) => {
          const field = node as HTMLTextAreaElement;
          return field.scrollHeight > field.clientHeight;
        }),
      )
      .toBeTruthy();

    // Everything below the editor stays where it was, including the run-mode
    // controls that sit furthest down and the dialog footer. Addressed by
    // testid, not text: "Column Settings" also appears inside the Agent
    // Override blurb ("...ignoring column settings").
    await expect(page.locator('[data-testid="task-run-mode-profile"]')).toBeInViewport();
    await expect(page.locator('[data-testid="task-advanced-toggle"]')).toBeInViewport();
    await expect(page.locator('button:has-text("Create")')).toBeInViewport();

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('the preview toggle keeps a gutter clear of the textarea scrollbar', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    // Enough content to force the scrollbar the toggle must not collide with.
    await textarea.fill(Array.from({ length: 400 }, (_, index) => `Line ${index + 1}`).join('\n'));

    const geometry = await page.evaluate(() => {
      const field = document.querySelector('[data-testid="task-description"]') as HTMLTextAreaElement;
      const toggle = document.querySelector('[data-testid="description-preview-toggle"]') as HTMLElement;
      return {
        // Read at runtime, never assumed: classic scrollbars take layout width
        // on Windows, while headless Linux uses zero-width overlay scrollbars.
        scrollbarWidth: field.offsetWidth - field.clientWidth,
        toggleGapFromRightEdge: field.getBoundingClientRect().right - toggle.getBoundingClientRect().right,
      };
    });

    // The toggle sat directly on top of the scrollbar track before this gutter
    // existed. Requiring a floor as well as clearing the measured scrollbar
    // keeps the test meaningful where scrollbars are zero-width overlays.
    expect(geometry.toggleGapFromRightEdge).toBeGreaterThanOrEqual(Math.max(geometry.scrollbarWidth, 8));

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('the preview toggle renders markdown and preserves the source on return', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('**bold** text');

    const toggle = page.locator('[data-testid="description-preview-toggle"]');
    // Write/Preview is the vocabulary every git forge uses for this control.
    await expect(toggle).toHaveText('Preview');
    await toggle.click();

    const preview = page.locator('[data-testid="description-preview"]');
    await expect(preview).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(toggle).toHaveText('Write');

    // Toggling back off must not have lost anything typed while previewing was on.
    await toggle.click();
    await expect(preview).not.toBeVisible();
    await expect(textarea).toHaveValue('**bold** text');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('a structural HTML paste is converted to markdown via the async turndown path', async () => {
    await openNewTaskDialog();

    // Every other paste test in this file dispatches a FILE DataTransfer,
    // which handleAttachmentPaste's onPaste consumes and preventDefaults
    // before DescriptionEditor's own paste handling ever runs. This one
    // carries no file, so it reaches shouldConvertPastedHtml.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    const defaultPrevented = await dispatchHtmlPaste(
      textarea,
      '<ul><li>one</li><li>two</li></ul>',
      'one\ntwo',
    );
    // shouldConvertPastedHtml sees the <ul>/<li> tags and takes the convert
    // branch synchronously, before the async conversion even starts.
    expect(defaultPrevented).toBe(true);

    // The conversion is async (a dynamic import('turndown') the first time
    // it runs), so poll for the value rather than asserting on the next tick.
    // A bullet marker preceding the item text is the discriminator between
    // "turndown actually converted this" and a plain-text fallback (which
    // would show "one\ntwo" with no marker) - not the exact leading
    // whitespace, which is turndown's own formatting choice and already
    // pinned by tests/unit/markdown-paste-html.test.ts.
    await expect.poll(() => textarea.inputValue(), { timeout: 5000 }).toMatch(/[*-]\s+one/);
    const value = await textarea.inputValue();
    expect(value).toMatch(/[*-]\s+two/);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });

  test('text/html with no structural tag is left for the plain-text flavor, not converted', async () => {
    await openNewTaskDialog();

    // Many apps set text/html on content that is really just styled plain
    // text - no link, heading, list, code, table, blockquote, or bold/italic
    // run. shouldConvertPastedHtml must reject this so the plain-text flavor
    // is what lands, not a turndown-mangled version of the styling wrapper.
    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    const defaultPrevented = await dispatchHtmlPaste(
      textarea,
      '<div><span style="color:red">plain</span></div>',
      'plain',
    );

    // The gate rejects this synchronously - handlePaste never reaches the
    // convert branch, so it never calls preventDefault, and the browser's own
    // native plain-text paste is left to run (which a synthetic, untrusted
    // dispatchEvent cannot actually trigger - see the value assertion below).
    expect(defaultPrevented).toBe(false);
    // No conversion ran and nothing else touched the field.
    await expect(textarea).toHaveValue('');

    await page.keyboard.press('Escape');
  });

  test('an HTML paste that converts to an empty string does not eat the character before a collapsed caret', async () => {
    await openNewTaskDialog();

    const textarea = page.locator('[data-testid="task-description"]');
    await textarea.click();
    await textarea.pressSequentially('hello');
    await expect(textarea).toHaveValue('hello');

    // Arm the probe right before the paste (after typing), so pressSequentially's
    // own focus/selection handling never counts toward it.
    await armSetSelectionRangeProbe();

    // <strong></strong> passes shouldConvertPastedHtml (a structural tag), but
    // turndown converts it to an empty string - the regression this guards
    // against fed that empty insert into a collapsed caret (start === end,
    // the ordinary no-selection case), which fell through to
    // execCommand('delete') - a backspace on a collapsed range - and silently
    // ate the character before the caret.
    const defaultPrevented = await dispatchHtmlPaste(textarea, '<strong></strong>', '');
    expect(defaultPrevented).toBe(true);

    // Wait for applyTextareaEdit to actually run (see armSetSelectionRangeProbe's
    // doc comment) before asserting nothing changed - otherwise this would pass
    // just as happily before the promise resolves as after.
    await waitForSetSelectionRangeCall();
    await disarmSetSelectionRangeProbe();

    await expect(textarea).toHaveValue('hello');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
  });
});
