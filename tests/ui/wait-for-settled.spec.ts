/**
 * `waitForSettled` (tests/captures/helpers/scene-page.ts) holds a scene's `settle` elements to a
 * poster-worthy standard: at least one shown (opacity above zero), and no rect or opacity among
 * them changing for 500 ms AND 10 animation frames, or it throws after `timeoutMs`, naming the
 * no-GPU card when the page shows it. Only its success path runs in tests/demo/static-demo.spec.ts,
 * where a scene that never settles would fail the whole smoke run, so the failure path is pinned
 * here.
 *
 * It needs a real page (layout, `requestAnimationFrame`, computed style) and nothing else, so this
 * is a UI-tier spec over `page.setContent`: no app, no bridge, no built demo. Every failure case
 * passes a short `timeoutMs` so it rejects in a second rather than waiting out the helper's 15 s.
 * The success cases pass a generous one instead: this tier starves under CI load, and a settle that
 * needs a 500 ms quiet window should not be racing a one-second budget.
 */
import { test, expect, type Page } from '@playwright/test';
import { NO_GPU_FALLBACKS, waitForSettled } from '../captures/helpers/scene-page';

const SUBJECT = '#subject';
const SHORT_TIMEOUT_MS = 1000;
const SHORT_TIMEOUT_TEXT = '1s';
const GENEROUS_TIMEOUT_MS = 10_000;
const NO_GPU_TESTID_SELECTOR = '[data-testid="knowledge-graph-webgl-unavailable"]';

/** One absolutely placed box, `#subject`, with `subjectStyle` appended to its inline style. */
function documentWith(subjectStyle: string, extraBody = ''): string {
  return '<!doctype html><html><body style="margin:0">'
    + `<div id="subject" style="position:absolute;left:10px;top:10px;width:100px;height:40px;background:#888;${subjectStyle}"></div>`
    + `${extraBody}</body></html>`;
}

/** The message a rejected `waitForSettled` carries; fails the test when it resolved instead. */
async function rejectionMessage(page: Page, selector: string, timeoutMs: number): Promise<string> {
  try {
    await waitForSettled(page, selector, timeoutMs);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${selector} settled, and the test expected it not to`);
}

type AnimatedProperty = 'transform' | 'left' | 'opacity';

/** Change `#subject`'s `property` on every animation frame, so its signature never repeats. */
async function animateEveryFrame(page: Page, property: AnimatedProperty): Promise<void> {
  await page.evaluate((animated) => {
    const subject = document.querySelector<HTMLElement>('#subject');
    if (!subject) throw new Error('no #subject to animate');
    let frame = 0;
    const step = (): void => {
      frame += 1;
      if (animated === 'transform') subject.style.transform = `translateX(${frame * 2}px)`;
      else if (animated === 'left') subject.style.left = `${10 + frame * 2}px`;
      else subject.style.opacity = frame % 2 === 0 ? '0.4' : '0.9';
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, property);
}

test.describe('waitForSettled', () => {
  test('resolves for a shown element that holds still, after the quiet window rather than on first sight', async ({ page }) => {
    await page.setContent(documentWith(''));
    const startedAt = Date.now();
    await waitForSettled(page, SUBJECT, GENEROUS_TIMEOUT_MS);
    // 450 rather than 500: the clock here is Node's, the helper's is the page's.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  });

  test('resolves when only one of several elements is shown', async ({ page }) => {
    await page.setContent(documentWith(
      'opacity:0;',
      '<div id="second" style="position:absolute;left:200px;top:10px;width:100px;height:40px;background:#444"></div>',
    ));
    await waitForSettled(page, `${SUBJECT}, #second`, GENEROUS_TIMEOUT_MS);
  });

  for (const property of ['transform', 'left', 'opacity'] as const) {
    test(`rejects while ${property} changes on every frame`, async ({ page }) => {
      await page.setContent(documentWith(''));
      await animateEveryFrame(page, property);

      const message = await rejectionMessage(page, SUBJECT, SHORT_TIMEOUT_MS);

      // Shown the whole time (opacity never reaches zero), so it is the motion that refused it.
      expect(message).toContain(`${SUBJECT} did not settle in ${SHORT_TIMEOUT_TEXT} (1 element(s), 1 shown)`);
    });
  }

  test('resolves once the motion stops, and not before half a second of stillness', async ({ page }) => {
    await page.setContent(documentWith(''));
    await page.evaluate(() => {
      const subject = document.querySelector<HTMLElement>('#subject');
      if (!subject) throw new Error('no #subject to animate');
      const motion = window as unknown as { lastMovedAt: number };
      const startedAt = performance.now();
      motion.lastMovedAt = startedAt;
      let frame = 0;
      const step = (): void => {
        const now = performance.now();
        if (now - startedAt > 400) return;
        frame += 1;
        subject.style.left = `${10 + frame * 2}px`;
        motion.lastMovedAt = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    await waitForSettled(page, SUBJECT, GENEROUS_TIMEOUT_MS);

    // The page's own clock, from the last frame that moved: the quiet window is measured from there.
    const stillForMs = await page.evaluate(() => performance.now() - (window as unknown as { lastMovedAt: number }).lastMovedAt);
    expect(stillForMs).toBeGreaterThanOrEqual(500);
  });

  test('needs ten frames as well as half a second, so a stalled frame loop is not read as still', async ({ page }) => {
    await page.setContent(documentWith(''));
    // One frame every 150 ms, as a loaded runner or software GL gives. The page clock reads half a
    // second of stillness after about four frames, so a refusal at one second can only be the
    // frame count: fewer than ten frames have run.
    await page.evaluate(() => {
      window.requestAnimationFrame = (callback: FrameRequestCallback): number => window.setTimeout(() => callback(performance.now()), 150);
    });

    const message = await rejectionMessage(page, SUBJECT, SHORT_TIMEOUT_MS);
    expect(message).toContain(`${SUBJECT} did not settle in ${SHORT_TIMEOUT_TEXT} (1 element(s), 1 shown)`);

    // Given room, the same loop does settle, once ten frames have gone by (ten more at 150 ms each).
    const startedAt = Date.now();
    await waitForSettled(page, SUBJECT, GENEROUS_TIMEOUT_MS);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
  });

  test('rejects an element that is never shown, saying how many were found and how many shown', async ({ page }) => {
    await page.setContent(documentWith('opacity:0;'));

    const message = await rejectionMessage(page, SUBJECT, SHORT_TIMEOUT_MS);

    expect(message).toBe(`${SUBJECT} did not settle in ${SHORT_TIMEOUT_TEXT} (1 element(s), 0 shown)`);
  });

  test('rejects a selector that matches nothing', async ({ page }) => {
    await page.setContent(documentWith(''));

    const message = await rejectionMessage(page, '#not-on-the-page', SHORT_TIMEOUT_MS);

    expect(message).toBe(`#not-on-the-page did not settle in ${SHORT_TIMEOUT_TEXT} (0 element(s), 0 shown)`);
  });

  test('names the no-GPU card in the rejection when the page shows it', async ({ page }) => {
    // The testid the helper checks for; the renderer stamps the same one on its WebGL fallback.
    expect(NO_GPU_FALLBACKS).toContain(NO_GPU_TESTID_SELECTOR);
    await page.setContent(documentWith('opacity:0;', '<div data-testid="knowledge-graph-webgl-unavailable">3D view unavailable</div>'));

    const message = await rejectionMessage(page, SUBJECT, SHORT_TIMEOUT_MS);

    expect(message).toContain(`${SUBJECT} did not settle in ${SHORT_TIMEOUT_TEXT} (1 element(s), 0 shown)`);
    expect(message).toContain(NO_GPU_TESTID_SELECTOR);
    expect(message).toContain('so it got no WebGL context');
  });

  test('says nothing about WebGL when the no-GPU card is not on the page', async ({ page }) => {
    await page.setContent(documentWith('opacity:0;'));

    const message = await rejectionMessage(page, SUBJECT, SHORT_TIMEOUT_MS);

    expect(message).not.toContain(NO_GPU_TESTID_SELECTOR);
    expect(message).not.toContain('WebGL');
  });
});
