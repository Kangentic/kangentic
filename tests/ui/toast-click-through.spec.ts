/**
 * A toast must never absorb a click meant for the UI underneath it.
 *
 * ToastContainer is `fixed right-3`, `bottom: 40px`, `z-[60]` - above
 * BaseDialog's `z-50`, and in the corner where a centred dialog puts its footer.
 * ToastItem used to carry `pointer-events-auto` on the whole CARD, so a toast
 * stacked there covered Save and Cancel and ate every click aimed at them. The
 * card body has no onClick, so the click did nothing at all: not even dismiss
 * the toast. That shipped as "Save in the Column Manager does nothing", with
 * Ctrl+S as the workaround, and it bit hardest while agents were running because
 * "Task updated by agent" toasts stack three deep in exactly that corner.
 *
 * The fix moves `pointer-events-auto` off the card and onto its two interactive
 * children (the dismiss X and the optional action button). Test 1 pins that
 * boundary directly; tests 2 and 3 drive the reported case end to end.
 *
 * Every test launches its own page. Test 2 renames a real seeded column, and
 * sharing a page would leak that into the others (cross-platform-parity.md).
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

/**
 * Long enough to wrap. The card caps at `max-w-[min(34rem,...)]` (544px), so
 * this reaches about four lines and ~98px of height. That matters: at 1920x1080
 * the Column Manager is `min(1120px, 88vh)` = 950px centred, putting Save around
 * y 974-1002 while a single UNWRAPPED toast spans 1002-1040 and merely touches
 * its bottom edge. The tests still measure rather than trust this.
 */
const TALL_MESSAGE =
  'Kangentic could not write to its data folder, so the column layout, the board '
  + 'profiles and the per-project settings you just changed apply to this session '
  + 'but will not persist across a restart. Check the folder permissions and try again.';

const SHORT_MESSAGE = 'Kangentic could not write to its data folder.';

interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * `__mockFireConfigWriteFailed` is installed lazily inside the mock's
 * `config.onWriteFailed`, so it does not exist until App.tsx has subscribed.
 * `launchPage` only waits for the shell to render, which can be a tick earlier.
 */
async function waitForToastHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireConfigWriteFailed === 'function'), {
      timeout: 5000,
    })
    .toBe(true);
}

/** App.tsx toasts this push verbatim at variant 'error', duration 12000. */
async function pushToast(page: Page, message: string): Promise<void> {
  const before = await page.locator('[data-testid="toast"]').count();
  await page.evaluate((text) => window.__mockFireConfigWriteFailed?.(text), message);
  await expect(page.locator('[data-testid="toast"]')).toHaveCount(before + 1, { timeout: 5000 });
}

/** The union of every visible toast card's rect, or null when none are up. */
async function toastStackRect(page: Page): Promise<Rect | null> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="toast"]'));
    if (cards.length === 0) return null;
    const boxes = cards.map((card) => card.getBoundingClientRect());
    return {
      left: Math.min(...boxes.map((box) => box.left)),
      top: Math.min(...boxes.map((box) => box.top)),
      right: Math.max(...boxes.map((box) => box.right)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
  });
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Push toasts until the stack genuinely covers `target`, then hand back its
 * centre to click.
 *
 * The overlap is a MEASURED precondition, not an assumption. Without it the
 * whole spec passes vacuously the day a CI runner lays the dialog out a few
 * pixels differently and the toast stops covering the button. It compares two
 * measured rects rather than asserting absolute pixels, which is what
 * cross-platform-parity.md asks for. `maxCount` defaults to 5, so the loop is
 * bounded by the store as well as by the counter.
 */
async function coverWithToasts(
  page: Page,
  target: Rect,
  label: string,
): Promise<{ x: number; y: number }> {
  let stack: Rect | null = null;
  for (let pushes = 0; pushes < 5; pushes += 1) {
    await pushToast(page, TALL_MESSAGE);
    stack = await toastStackRect(page);
    if (stack && intersects(stack, target)) {
      return {
        x: Math.round((target.left + target.right) / 2),
        y: Math.round((target.top + target.bottom) / 2),
      };
    }
  }
  throw new Error(
    `No toast stack covered ${label}, so this test would prove nothing. `
    + `${label}: ${JSON.stringify(target)}. Toast stack: ${JSON.stringify(stack)}.`,
  );
}

/**
 * Every toast's text, snapshotted the first time one of them matches `marker`.
 * Returning the whole stack from a single DOM read is what lets a caller assert
 * that some OTHER toast was absent at that same instant, without racing the
 * auto-dismiss timer.
 */
async function toastTextsWhen(page: Page, marker: RegExp): Promise<string[]> {
  let snapshot: string[] = [];
  await expect
    .poll(async () => {
      snapshot = await page.locator('[data-testid="toast"]').allTextContents();
      return snapshot.some((text) => marker.test(text));
    }, { timeout: 5000 })
    .toBe(true);
  return snapshot;
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

async function openColumnManager(page: Page, columnName: string): Promise<void> {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
}

test.describe('a toast does not eat clicks on what is under it', () => {
  // ── 1. The invariant, independent of any dialog's geometry ───────────────
  //
  // elementFromPoint is the right instrument here. Playwright's boundingBox()
  // and toBeVisible() both ignore occlusion, so a geometry-only check passes
  // against a toast that is swallowing everything (the same point
  // popover-escapes-clipping.md makes about clipped menus).
  test('the card falls through while the dismiss button stays hit-testable', async () => {
    const { browser, page }: { browser: Browser; page: Page } = await launchPage();
    try {
      await waitForToastHook(page);
      await pushToast(page, SHORT_MESSAGE);

      const probe = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="toast"]')!;
        const message = card.querySelector('span')!;
        const dismiss = card.querySelector('[data-testid="toast-dismiss"]')!;
        const stripe = card.firstElementChild!;
        const at = (element: Element) => {
          const box = element.getBoundingClientRect();
          return document.elementFromPoint(
            Math.round(box.left + box.width / 2),
            Math.round(box.top + box.height / 2),
          );
        };
        const overMessage = at(message);
        const overStripe = at(stripe);
        const overDismiss = at(dismiss);
        return {
          messageFallsThrough: !!overMessage && !card.contains(overMessage),
          stripeFallsThrough: !!overStripe && !card.contains(overStripe),
          dismissIsHitTestable: !!overDismiss && dismiss.contains(overDismiss),
          // Named so a failure says WHAT was on top, not just that it was wrong.
          overMessageTag: overMessage?.tagName ?? null,
        };
      });

      expect(probe.messageFallsThrough, `the message span ate the click (${probe.overMessageTag} on top)`).toBe(true);
      expect(probe.stripeFallsThrough, 'the accent stripe ate the click').toBe(true);
      expect(probe.dismissIsHitTestable, 'the dismiss X is no longer clickable').toBe(true);
    } finally {
      await browser.close();
    }
  });

  // The dismiss X must still WORK, not merely hit-test: it is the one control
  // that opts back in, and a `pointer-events-auto` that landed on the wrong
  // element would pass the probe above and still leave the toast undismissable.
  test('the dismiss button still dismisses through a real click', async () => {
    const { browser, page } = await launchPage();
    try {
      await waitForToastHook(page);
      await pushToast(page, SHORT_MESSAGE);

      await page.locator('[data-testid="toast-dismiss"]').click();
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(0, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // Removal used to be gated on `transitionend` alone. A page that produces no
  // frames never fires it, so the toast stayed in the store forever - measured
  // in a real occluded window on BOTH a hand-dismissed and an auto-dismissed
  // toast. Suppressing the event here is the closest a live page gets to that.
  test('a toast still leaves the store when transitionend never fires', async () => {
    const { browser, page } = await launchPage();
    try {
      await waitForToastHook(page);
      await pushToast(page, SHORT_MESSAGE);

      // Swallow transitionend before it reaches React's listener, so only the
      // fallback timer can remove the toast.
      await page.evaluate(() => {
        document.addEventListener('transitionend', (event) => event.stopPropagation(), true);
      });

      await page.locator('[data-testid="toast-dismiss"]').click();
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(0, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // The message is not selectable any more (the card is inert), so an error a
  // user needs to paste into an issue has to be reachable some other way.
  test('an error toast copies its message, and other variants carry no copy button', async () => {
    const { browser, page } = await launchPage();
    try {
      await browser.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write']);
      await waitForToastHook(page);
      await pushToast(page, SHORT_MESSAGE);

      await expect(page.locator('[data-testid="toast-copy"]')).toHaveCount(1);
      await page.locator('[data-testid="toast-copy"]').click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
        .toBe(SHORT_MESSAGE);
      // The icon says it landed rather than leaving the user guessing.
      await expect(page.locator('[data-testid="toast-copy"]')).toHaveAttribute('aria-label', 'Message copied');

      // An info toast is not something anyone copies, so it carries no button.
      await page.evaluate(async () => {
        const store = (window as unknown as {
          __zustandStores: { toast: { getState: () => { addToast: (input: { message: string; variant: string }) => void } } };
        }).__zustandStores.toast;
        store.getState().addToast({ message: 'Saved 1 column', variant: 'info' });
      });
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(2, { timeout: 5000 });
      await expect(page.locator('[data-testid="toast-copy"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  // pushToast only ever raises a plain error toast, so no test above has
  // exercised toast.action. Seed one directly through the same dev-only
  // escape hatch the info toast above uses. __zustandStores is installed at
  // App.tsx module eval, well before launchPage's `text=Kangentic` wait, so
  // no readiness wait is needed here.
  test('the action button opts back in to pointer events and its onClick still fires', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => {
        const store = (window as unknown as {
          __zustandStores: {
            toast: {
              getState: () => {
                addToast: (input: {
                  message: string;
                  variant: string;
                  action: { label: string; onClick: () => void };
                }) => void;
              };
            };
          };
        }).__zustandStores.toast;
        store.getState().addToast({
          message: 'A background task needs your attention',
          variant: 'info',
          action: {
            label: 'Retry',
            onClick: () => {
              (window as unknown as { __toastActionClicked?: boolean }).__toastActionClicked = true;
            },
          },
        });
      });
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(1, { timeout: 5000 });

      // Same elementFromPoint instrument as the invariant test above:
      // boundingBox and toBeVisible both ignore occlusion.
      const probe = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="toast"]')!;
        const action = Array.from(card.querySelectorAll('button')).find(
          (button) => button.textContent === 'Retry',
        )!;
        const box = action.getBoundingClientRect();
        const overAction = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        );
        return { actionIsHitTestable: !!overAction && action.contains(overAction) };
      });
      expect(probe.actionIsHitTestable, 'the action button is not clickable through the inert card').toBe(true);

      await page.locator('[data-testid="toast"] button', { hasText: 'Retry' }).click();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { __toastActionClicked?: boolean }).__toastActionClicked ?? false,
            ),
          { timeout: 2000 },
        )
        .toBe(true);
    } finally {
      await browser.close();
    }
  });

  // handleCopyClick's rejection branch deliberately leaves the icon
  // un-flipped (an honest signal beats a fake one). Every other clipboard
  // test in this file exercises the success path only.
  test('a rejected clipboard write leaves the copy button unflipped', async () => {
    const { browser, page } = await launchPage();
    try {
      await waitForToastHook(page);
      await pushToast(page, SHORT_MESSAGE);

      // Count the override's own calls, so a missed click or a selector miss
      // cannot pass this test by looking identical to a correct un-flip.
      await page.evaluate(() => {
        const clipboardProbeWindow = window as unknown as { __clipboardRejectCalls: number };
        clipboardProbeWindow.__clipboardRejectCalls = 0;
        navigator.clipboard.writeText = () => {
          clipboardProbeWindow.__clipboardRejectCalls += 1;
          return Promise.reject(new Error('clipboard write denied'));
        };
      });

      await page.locator('[data-testid="toast-copy"]').click();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { __clipboardRejectCalls: number }).__clipboardRejectCalls,
            ),
          { timeout: 2000 },
        )
        .toBe(1);

      // Negative assertion: a correct implementation never flips the icon
      // here, so there is nothing to poll for. A rejected promise settles on
      // the next microtask, so 500ms is a wide margin, not a tuned one. This
      // is the documented fixed wait a non-occurrence needs, not a
      // substitute for the conditional wait above.
      //
      // A snapshot read, not `toHaveAttribute`: that matcher auto-retries for
      // up to its own timeout, so a buggy flip-then-revert (COPY_FEEDBACK_MS
      // still fires even when the reject branch wrongly flips the icon) would
      // pass the moment the untouched reset timer reverted it, long after the
      // bug already ran.
      await page.waitForTimeout(500);
      const ariaLabel = await page.locator('[data-testid="toast-copy"]').getAttribute('aria-label');
      expect(ariaLabel, 'the copy button flipped to "copied" after a rejected write').toBe('Copy message');
    } finally {
      await browser.close();
    }
  });

  // COPY_FEEDBACK_MS drives the reset back to "Copy message". No test above
  // waits past it, so a deleted reset effect would leave the icon stuck at
  // "Message copied" with nothing catching it. A long explicit duration
  // keeps the toast's own auto-dismiss exit transition well clear of the
  // revert window (the default is about 4 seconds, which would otherwise
  // race the assertion below on a loaded runner).
  test('the copy button reverts to Copy message after COPY_FEEDBACK_MS', async () => {
    const { browser, page } = await launchPage();
    try {
      await browser.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate((message) => {
        const store = (window as unknown as {
          __zustandStores: {
            toast: { getState: () => { addToast: (input: { message: string; variant: string; duration: number }) => void } };
          };
        }).__zustandStores.toast;
        store.getState().addToast({ message, variant: 'error', duration: 60000 });
      }, SHORT_MESSAGE);
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(1, { timeout: 5000 });

      const copyButton = page.locator('[data-testid="toast-copy"]');
      await copyButton.click();
      await expect(copyButton).toHaveAttribute('aria-label', 'Message copied', { timeout: 5000 });

      // toHaveAttribute polls the condition, so this waits for the revert
      // rather than sleeping for it. The timeout stays comfortably above
      // COPY_FEEDBACK_MS (1500ms).
      await expect(copyButton).toHaveAttribute('aria-label', 'Copy message', { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // ── 2. The reported case, driven by coordinate ───────────────────────────
  //
  // Dirtying the draft first is load-bearing, and the test is theatre without
  // it: Save is `confirmDisabled={saving || !hasDirty}`, so on a clean draft a
  // coordinate click is a no-op that passes identically with the bug present.
  test('Save lands when a toast covers it', async () => {
    test.slow();
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Toast Save ${Date.now()}`);
      await waitForBoard(page);
      await waitForToastHook(page);
      await openColumnManager(page, 'Planning');

      const renamed = 'Planning Through A Toast';
      await page.locator('[data-testid="board-manager-name"]').fill(renamed);
      const save = page.locator('[data-testid="board-manager-save"]');
      await expect(save).toBeEnabled({ timeout: 5000 });

      const point = await coverWithToasts(page, await rectOf(page, '[data-testid="board-manager-save"]'), 'Save');
      await page.mouse.click(point.x, point.y);

      await expect(page.locator('[data-testid="board-manager-dialog"]')).toHaveCount(0, { timeout: 10000 });
      // The dialog closing is the weaker half: assert the write actually landed.
      const names = await page.evaluate(async () =>
        (await window.electronAPI.swimlanes.list()).map((lane) => lane.name));
      expect(names).toContain(renamed);
    } finally {
      await browser.close();
    }
  });

  test('Cancel lands when a toast covers it', async () => {
    test.slow();
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Toast Cancel ${Date.now()}`);
      await waitForBoard(page);
      await waitForToastHook(page);
      await openColumnManager(page, 'Planning');

      // Dirty for the same reason as above, and for a second one: requestCancel
      // only raises the discard confirm when `hasDirty`, so a clean draft would
      // just close and the test would go red-red.
      await page.locator('[data-testid="board-manager-name"]').fill('Planning Renamed');
      await expect(page.locator('[data-testid="board-manager-save"]')).toBeEnabled({ timeout: 5000 });

      const point = await coverWithToasts(page, await rectOf(page, '[data-testid="board-manager-cancel"]'), 'Cancel');
      await page.mouse.click(point.x, point.y);

      await expect(page.locator('text=Discard unsaved changes?')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ── 3. A failed profile save must not report success ─────────────────────
  //
  // saveBoardProfiles catches the IPC failure itself (it reloads and raises its
  // own toast), so it never rejected. handleSave read that as success and
  // printed "saved profiles" next to the store's "Failed to save profiles",
  // then closed - taking the edit with it. It now reports `false`, which folds
  // into the same firstError path as a failed column write.
  test('a failed profile save keeps the dialog open and prints no success', async () => {
    test.slow();
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => {
        window.__mockBoardProfilesSaveError = 'kangentic.json is read-only';
      });
      await createProject(page, `Toast Profiles ${Date.now()}`);
      await waitForBoard(page);
      await openColumnManager(page, 'Planning');

      // Dirty the PROFILES specifically: create one, which is the shortest path
      // to `profilesDirty` without depending on a seeded fixture.
      await page.locator('[data-testid="board-manager-profile-new"]').click();
      await page.locator('[data-testid="profile-name-input"]').fill('Review Heavy');
      await page.locator('[data-testid="profile-name-confirm"]').click();
      await expect(page.locator('[data-testid="profile-name-input"]')).toHaveCount(0, { timeout: 5000 });

      const save = page.locator('[data-testid="board-manager-save"]');
      await expect(save).toBeEnabled({ timeout: 5000 });
      await save.click();

      // ONE atomic read of the whole stack, not two sequential assertions.
      // Toasts auto-dismiss after `durationSeconds` (4 by default), so a second
      // assertion that waits on its own timeout can watch the success toast
      // expire and then pass on its absence, which is the vacuous version of
      // exactly the thing under test. Both toasts are added in the same tick
      // (nothing awaits between them), so the snapshot that holds one holds
      // both.
      const toasts = await toastTextsWhen(page, /failed to save profiles/i);
      expect(
        toasts.some((text) => /saved profiles/i.test(text)),
        `a success toast printed alongside the failure: ${toasts.join(' | ')}`,
      ).toBe(false);
      await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible();
      await expect(save).toBeEnabled({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
