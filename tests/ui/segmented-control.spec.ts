/**
 * UI tests for the shared `SegmentedControl`, exercised through its live adopter
 * (`ViewToggle`).
 *
 * Two properties are worth a test rather than a review pass:
 *
 *  - **Height parity with `Select`.** The control exists to sit in a row beside
 *    the app's other single-line inputs, and it derives its height from padding
 *    (`p-0.5` track + `py-1` + `text-sm`) rather than a fixed `h-[34px]`, exactly
 *    as `FIELD_CONTROL_CLASS` does. Nothing mechanical ties those two derivations
 *    together, so a change to either silently makes one control the ragged one in
 *    its row. This test is that tie.
 *  - **The radiogroup keyboard model.** `role="radiogroup"` promises a screen
 *    reader one tab stop with arrow-key selection. Rendering a row of buttons
 *    with that role but leaving every option tabbable is the easy regression, and
 *    it is invisible on screen.
 *
 * The thumb is asserted as "covers the selected option", not at a pixel offset:
 * it is measured from live layout, so pinning coordinates would encode this
 * machine's font metrics (see `.claude/rules/cross-platform-parity.md`).
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, computedColor } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Segmented Test ${Date.now()}`;
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

const group = () => page.locator('[data-testid="view-toggle-group"]');
const boardOption = () => page.locator('[data-testid="view-toggle-board"]');
const backlogOption = () => page.locator('[data-testid="view-toggle-backlog"]');
const workflowsOption = () => page.locator('[data-testid="view-toggle-workflows"]');

/** Adds backlog items through the bridge and reloads the store, as a create from the UI would. */
async function createBacklogItems(target: Page, titles: string[]): Promise<void> {
  await target.evaluate(async (itemTitles) => {
    for (const title of itemTitles) await window.electronAPI.backlog.create({ title });
    const stores = (window as unknown as {
      __zustandStores: { backlog: { getState: () => { loadBacklog: () => Promise<void> } } };
    }).__zustandStores;
    await stores.backlog.getState().loadBacklog();
  }, titles);
}

/** The thumb's box as the frame sampler records it. */
interface ThumbBox { left: number; width: number }

/** Lives on `window` between `startSampling` and `stopSampling`, so a trigger can run in between. */
interface ThumbSampler { before: ThumbBox; samples: ThumbBox[]; read: () => ThumbBox; sampling: boolean }

/** Leave the board view selected, whichever test ran last. */
test.afterEach(async () => {
  await boardOption().click();
  await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
});

test.describe('SegmentedControl', () => {
  test('matches the shared Select control height', async () => {
    const segmentedBox = await group().boundingBox();
    expect(segmentedBox).not.toBeNull();

    // Open the board manager purely to get a real `Select` on screen. Any
    // column works; the Agent section always renders selects.
    await page.locator('[data-swimlane-name="To Do"]').locator('text=To Do').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const select = dialog.locator('select').first();
    await expect(select).toBeVisible();
    const selectBox = await select.boundingBox();
    expect(selectBox).not.toBeNull();

    // Both are padding-derived from the same type scale, so they should agree
    // exactly. The tolerance absorbs sub-pixel font-metric differences between
    // Windows and CI's headless Linux, not a design drift: a real mismatch (a
    // dropped `py-1`, a fixed height) moves this by 4px or more.
    expect(Math.abs(segmentedBox!.height - selectBox!.height)).toBeLessThanOrEqual(1.5);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  test('exposes one tab stop and moves selection with arrow keys', async () => {
    await expect(group()).toHaveAttribute('role', 'radiogroup');
    await expect(boardOption()).toHaveAttribute('role', 'radio');

    // Roving tabindex: the selected option is the only reachable one.
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
    await expect(boardOption()).toHaveAttribute('tabindex', '0');
    await expect(backlogOption()).toHaveAttribute('tabindex', '-1');

    await boardOption().focus();
    await page.keyboard.press('ArrowRight');
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await expect(backlogOption()).toHaveAttribute('tabindex', '0');
    await expect(boardOption()).toHaveAttribute('tabindex', '-1');
    // Selection is the view, not just a highlight.
    await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

    // On to the third option, then wraps back to the first.
    await page.keyboard.press('ArrowRight');
    await expect(workflowsOption()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('End');
    await expect(workflowsOption()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
  });

  test('a control mounted inside an animating dialog still measures itself', async () => {
    // The ViewToggle above never animates, so every other thumb assertion here
    // is blind to the defect this covers. A dialog enters at scale(0.96)
    // (`dialog-content-in`), `getBoundingClientRect` reports TRANSFORMED
    // geometry, and the component's only correction is a ResizeObserver, which
    // reports the LAYOUT box and therefore never fires when a transform ends.
    // A thumb measured mid-entrance stayed 2.84px narrow for the life of the
    // dialog. It looked intermittent because what varies is whether the layout
    // effect lands before or during the animation's first frame.
    // Planning, not To Do: To Do collapses its Conversation card to an
    // explanation, so it has no Session control to measure.
    await page.locator('[data-swimlane-name="Planning"]').locator('text=Planning').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const control = dialog.locator('[data-testid="column-session-target"]');
    await expect(control).toBeVisible();

    // Polled, because the entrance takes ~150ms and the correction runs across
    // it. The defect does not settle at all, so a poll cannot paper over it.
    await expect.poll(async () => {
      const drift = await control.evaluate((node) => {
        const row = node.firstElementChild;
        const thumb = row?.querySelector('.kng-segmented-thumb');
        const active = row?.querySelector('[data-selected="true"]');
        if (!thumb || !active) return null;
        const thumbBox = thumb.getBoundingClientRect();
        const activeBox = active.getBoundingClientRect();
        return Math.max(
          Math.abs(thumbBox.width - activeBox.width),
          Math.abs(thumbBox.left - activeBox.left),
        );
      });
      // Half a pixel: the scale correction reads an unrounded computed width, so
      // what is left is float noise, not a rounding budget. The defect is 2.84.
      return drift === null ? 99 : drift < 0.5;
    }, { timeout: 5000 }).toBe(true);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  test('an option with no ariaLabel exposes its label text as its accessible name', async () => {
    // Board passes no `ariaLabel`, so this is the plain
    // `aria-label={option.ariaLabel ?? option.label}` fallback every option gets -
    // the Backlog option's own override is covered separately below.
    await expect(boardOption()).toHaveAttribute('aria-label', 'Board');
  });

  test("the Backlog option's accessible name spells out its item count", async () => {
    // A fresh project seeds no backlog items, so the option's name starts as the
    // bare label. The `CountBadge` in `trailing` contributes nothing to the
    // accessible name once it comes from `ariaLabel` instead of the rendered
    // text, so both branches of ViewToggle's ternary need their own assertion.
    await expect(backlogOption()).toHaveAttribute('aria-label', 'Backlog');

    await createBacklogItems(page, ['Alpha backlog item']);
    await expect(backlogOption()).toHaveAttribute('aria-label', 'Backlog, 1 item');

    await createBacklogItems(page, ['Beta backlog item', 'Gamma backlog item']);
    await expect(backlogOption()).toHaveAttribute('aria-label', 'Backlog, 3 items');
  });

  test('slides the thumb onto the selected option', async () => {
    const thumb = group().locator('.kng-segmented-thumb');
    await expect(thumb).toBeAttached();

    // The thumb is measured from live layout, so assert containment rather than
    // coordinates: it should sit over whichever option is selected. Polled
    // because the thumb slides over ~150ms, so a single read after a click can
    // land mid-transition.
    const covers = async (option: ReturnType<typeof boardOption>) => {
      await expect.poll(async () => {
        const thumbBox = await thumb.boundingBox();
        const optionBox = await option.boundingBox();
        if (!thumbBox || !optionBox || thumbBox.width === 0) return false;
        // Same span as the option it marks, within sub-pixel rounding.
        return Math.abs(thumbBox.x - optionBox.x) <= 1.5
          && Math.abs(thumbBox.width - optionBox.width) <= 1.5;
      }, { timeout: 3000 }).toBe(true);
    };

    await covers(boardOption());
    await backlogOption().click();
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await covers(backlogOption());
  });

  test('the Animations setting stops the thumb slide', async () => {
    // The desktop app never matches prefers-reduced-motion (main forces
    // Chromium's no-preference switch), so `.no-motion`, which the Animations
    // setting puts on <html>, is the only thing that can stop this transition
    // there. `.no-motion *` zeroes animations, not transitions, so the thumb
    // needs its own rule in index.css.
    const thumb = group().locator('.kng-segmented-thumb');
    await expect(thumb).toBeAttached();
    const transitionProperty = () => thumb.evaluate((node) => getComputedStyle(node).transitionProperty);
    // The slide's transition is on only once a selection has moved the thumb, and
    // without it the property reads its default `all`, which says nothing. So move
    // the thumb and wait for the slide's own properties before turning motion off.
    await backlogOption().click();
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await expect.poll(transitionProperty).toContain('transform');

    await page.evaluate(() => document.documentElement.classList.add('no-motion'));
    try {
      await expect.poll(transitionProperty).toBe('none');
    } finally {
      await page.evaluate(() => document.documentElement.classList.remove('no-motion'));
    }
  });
});

/**
 * Each of these adds backlog items, so each owns a fresh project rather than
 * leaving them on the shared page, where the accessible-name test above expects
 * an empty backlog.
 */
test.describe('SegmentedControl on a fresh project', () => {
  async function freshPage(): Promise<{ browser: Browser; page: Page }> {
    const result = await launchPage();
    await createProject(result.page, `Segmented Fresh ${Date.now()}`);
    await waitForBoard(result.page);
    return result;
  }

  test("the Backlog count centers its digits' ink, which only an inner span can do", async () => {
    // `line-height: 1` centers the em box, and the system UI font's tall ascent left
    // the digits 0.5 to 1px low. `text-box` trims the line to the digits' cap height,
    // but it does nothing on the pill itself: the digits there are a bare text node
    // in a flex container, in an anonymous item the property never reaches. So the
    // trim has to be on the inner span, and this pins it there.
    const fresh = await freshPage();
    try {
      await createBacklogItems(fresh.page, ['Alpha backlog item']);
      const digits = fresh.page.locator('[data-testid="view-toggle-backlog-count"] > span');
      await expect(digits).toHaveText('1');
      const trim = await digits.evaluate((node) => {
        const style = getComputedStyle(node);
        return { trim: style.getPropertyValue('text-box-trim'), edge: style.getPropertyValue('text-box-edge') };
      });
      expect(trim).toEqual({ trim: 'trim-both', edge: 'cap alphabetic' });
    } finally {
      await fresh.browser.close();
    }
  });

  test("the Backlog count takes its option's text tone and wears a 1px edge, idle and selected", async () => {
    // The tinted pill sets no text color of its own: it inherits its option's, so it
    // follows the tab from muted to bright. The variants it replaced (`muted`, and
    // `accent` while selected) each fixed a tone of their own and drew no edge. The
    // selected read is the one that tells them apart: `accent`'s fixed muted tone
    // equals the idle tab's, so an idle-only check passes either way.
    const fresh = await freshPage();
    const target = fresh.page;
    try {
      await createBacklogItems(target, ['Alpha backlog item']);
      const pill = target.locator('[data-testid="view-toggle-backlog-count"]');
      await expect(pill).toHaveText('1');
      // Off every option, so no hover tone leaks into the idle read.
      await target.mouse.move(0, 0);
      await expect(target.locator('[data-testid="view-toggle-board"]')).toHaveAttribute('aria-checked', 'true');

      // Both colors in one read, so the option's 150ms color transition cannot
      // move one between the two reads.
      const readTones = () => target.evaluate(() => {
        const option = document.querySelector('[data-testid="view-toggle-backlog"]');
        const countPill = document.querySelector('[data-testid="view-toggle-backlog-count"]');
        if (!option || !countPill) return null;
        return {
          optionColor: getComputedStyle(option).color,
          pillColor: getComputedStyle(countPill).color,
          pillBorderTopWidth: getComputedStyle(countPill).borderTopWidth,
        };
      });

      // Idle: Board is selected, so Backlog wears the muted tone.
      const mutedTone = await computedColor(target, 'var(--color-fg-muted)');
      await expect.poll(async () => (await readTones())?.optionColor).toBe(mutedTone);
      const idle = await readTones();
      expect(idle?.pillColor, 'the idle count did not follow its option').toBe(idle?.optionColor);
      expect(idle?.pillBorderTopWidth).toBe('1px');

      // Selected: the option goes bright, and the count goes with it.
      await target.locator('[data-testid="view-toggle-backlog"]').click();
      await expect(target.locator('[data-testid="view-toggle-backlog"]')).toHaveAttribute('aria-checked', 'true');
      const selectedTone = await computedColor(target, 'var(--color-fg)');
      expect(selectedTone, 'the selected and idle tones must differ, or this test cannot tell them apart').not.toBe(mutedTone);
      await expect.poll(async () => (await readTones())?.optionColor).toBe(selectedTone);
      await expect.poll(async () => {
        const tones = await readTones();
        return tones ? tones.pillColor === tones.optionColor : null;
      }, { message: 'the selected count did not follow its option' }).toBe(true);
      expect((await readTones())?.pillBorderTopWidth).toBe('1px');
    } finally {
      await fresh.browser.close();
    }
  });

  test('a count changing width under the selected option moves the thumb at once, while a selection still slides', async () => {
    // A count is not the user choosing anything, and a project switch re-populates
    // every count at once, so the thumb takes the new width without animating
    // (restore-no-animation-replay.md). Frames are sampled rather than the settled
    // state read, because the slide ends on the same box: only the frames between
    // show it.
    const fresh = await freshPage();
    const target = fresh.page;
    try {
      const backlog = target.locator('[data-testid="view-toggle-backlog"]');
      await backlog.click();
      await expect(backlog).toHaveAttribute('aria-checked', 'true');

      /** Records the thumb's left and width on every frame until `stopSampling` reads them back. */
      const startSampling = () => target.evaluate(() => {
        const thumb = document.querySelector('[data-testid="view-toggle-group"] .kng-segmented-thumb');
        if (!thumb) throw new Error('thumb not found');
        const read = (): ThumbBox => {
          const rect = thumb.getBoundingClientRect();
          return { left: rect.left, width: rect.width };
        };
        const sampler: ThumbSampler = { before: read(), samples: [], read, sampling: true };
        const tick = () => {
          if (!sampler.sampling) return;
          sampler.samples.push(read());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        (window as unknown as { __thumbSampler: ThumbSampler }).__thumbSampler = sampler;
      });
      /** Lets 400ms of frames land after the trigger, then stops the sampler and returns them. */
      const stopSampling = () => target.evaluate(async () => {
        const sampler = (window as unknown as { __thumbSampler: ThumbSampler }).__thumbSampler;
        await new Promise((resolve) => setTimeout(resolve, 400));
        sampler.sampling = false;
        return { before: sampler.before, after: sampler.read(), samples: sampler.samples };
      });

      // Let the slide onto Backlog finish before sampling the width-only change.
      await expect.poll(() => target.evaluate(() => {
        const thumb = document.querySelector('[data-testid="view-toggle-group"] .kng-segmented-thumb');
        const option = document.querySelector('[data-testid="view-toggle-backlog"]');
        if (!thumb || !option) return false;
        const thumbRect = thumb.getBoundingClientRect();
        const optionRect = option.getBoundingClientRect();
        return Math.abs(thumbRect.left - optionRect.left) < 0.5 && Math.abs(thumbRect.width - optionRect.width) < 0.5;
      })).toBe(true);
      await startSampling();
      await createBacklogItems(target, ['Widens the count']);
      const widthChange = await stopSampling();
      expect(widthChange.after.width - widthChange.before.width, 'the count did not widen the option').toBeGreaterThan(8);
      const between = widthChange.samples.filter((sample) => (
        sample.width > widthChange.before.width + 0.5 && sample.width < widthChange.after.width - 0.5
      ));
      expect(between, 'the thumb animated to a width it only changed because a count did').toEqual([]);

      // The same sampler does see a slide, so the check above is not vacuous.
      await startSampling();
      await target.locator('[data-testid="view-toggle-board"]').click();
      const selection = await stopSampling();
      const low = Math.min(selection.before.left, selection.after.left);
      const high = Math.max(selection.before.left, selection.after.left);
      expect(selection.samples.some((sample) => sample.left > low + 0.5 && sample.left < high - 0.5)).toBe(true);
    } finally {
      await fresh.browser.close();
    }
  });
});
