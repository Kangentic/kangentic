/**
 * How a toast behaves, app-wide.
 *
 * - Every toast has a title over its body. A timed toast draws a 2px
 *   countdown line along its bottom edge; a persistent one draws none and is
 *   the only kind with a button.
 * - Hovering a timed toast holds its countdown until the pointer leaves, even
 *   a click-through card: the hold comes from the container tracking the
 *   pointer, never from the card taking it.
 * - A card about one thing (a task, a list, a workflow, a folder) opens it on
 *   a click and closes. A card that opens nothing stays click-through.
 * - While a dialog or the settings panel is open, no toast takes a click,
 *   including one opened by keyboard with the pointer resting on a toast.
 * - With Animations off the line steps once a second instead of moving.
 * - A pop-out window shows toasts too.
 *
 * Toasts are raised straight through the store (`__zustandStores.toast` in the
 * app, the module itself in a pop-out), so these cases pin the toast and not
 * any one call site.
 *
 * Tier: UI (headless Chromium). Every case owns its page.
 */
import { test, expect, chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, toastCountRightNow, waitForViteReady, gotoVite } from './helpers';
import type { ToastInput } from '../../src/renderer/stores/toast-store';

test.describe.configure({ mode: 'parallel' });

interface ToastStoreHandle {
  getState: () => {
    addToast: (input: ToastInput) => string;
    toasts: Array<{ id: string; runningSince: number | null }>;
  };
}

/** Raise a toast in the app. `opensFlag` gives it an onOpen that sets a window flag. */
async function raiseToast(page: Page, input: Omit<ToastInput, 'onOpen'>, opensFlag?: string): Promise<string> {
  return page.evaluate(({ toastInput, flag }) => {
    const store = (window as unknown as { __zustandStores: { toast: ToastStoreHandle } }).__zustandStores.toast;
    const onOpen = flag
      ? () => { (window as unknown as Record<string, boolean>)[flag] = true; }
      : undefined;
    return store.getState().addToast({ ...toastInput, onOpen } as ToastInput);
  }, { toastInput: input, flag: opensFlag });
}

async function readFlag(page: Page, flag: string): Promise<boolean> {
  return page.evaluate((name) => (window as unknown as Record<string, boolean | undefined>)[name] === true, flag);
}

async function heldStateOf(page: Page, id: string): Promise<boolean | null> {
  return page.evaluate((toastId) => {
    const store = (window as unknown as { __zustandStores: { toast: ToastStoreHandle } }).__zustandStores.toast;
    const toast = store.getState().toasts.find((candidate) => candidate.id === toastId);
    return toast ? toast.runningSince === null : null;
  }, id);
}

/** Whether a click at an element's centre lands on it (occlusion-aware, unlike boundingBox). */
async function hitTestable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
    return !!hit && element.contains(hit);
  }, selector);
}

async function cardCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('toast').first().boundingBox();
  if (!box) throw new Error('the toast has no bounding box');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

test.describe('toast behavior', () => {
  test('a timed toast shows its title, its body and a countdown line, and no button', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Task moved', message: '"Fix login redirect" is now in Code Review.', durationMs: 30_000 });
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Task moved');
      await expect(toast.getByTestId('toast-body')).toHaveText('"Fix login redirect" is now in Code Review.');
      await expect(toast.getByTestId('toast-countdown')).toHaveCount(1);
      // toast-count-ok: a part of a toast still on screen (its countdown is 30s), not whether a toast appeared.
      await expect(toast.getByTestId('toast-action')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a persistent toast shows its button and its age, and draws no countdown', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => {
        const store = (window as unknown as { __zustandStores: { toast: ToastStoreHandle } }).__zustandStores.toast;
        store.getState().addToast({
          title: '2 idle agents paused',
          message: 'Kangentic paused them to free memory.',
          persistent: true,
          since: new Date().toISOString(),
          action: { label: 'Review', icon: 'review', onClick: () => { (window as unknown as Record<string, boolean>).__reviewed = true; } },
        });
      });
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveAttribute('data-persistent', 'true');
      // toast-count-ok: a part of a persistent toast, which never dismisses itself, not whether a toast appeared.
      await expect(toast.getByTestId('toast-countdown')).toHaveCount(0);
      await expect(toast.getByTestId('toast-age')).toBeVisible();
      await toast.getByTestId('toast-action').click();
      await expect.poll(() => readFlag(page, '__reviewed')).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('hovering a click-through toast holds its countdown until the pointer leaves', async () => {
    const { browser, page } = await launchPage();
    try {
      const id = await raiseToast(page, { title: 'Saved', message: 'Column order saved.', durationMs: 1500 });
      await expect(page.getByTestId('toast')).toHaveCount(1);
      const centre = await cardCentre(page);

      await page.mouse.move(centre.x - 5, centre.y);
      await page.mouse.move(centre.x, centre.y);
      await expect.poll(() => heldStateOf(page, id)).toBe(true);

      // Longer than the whole countdown: a toast whose hold did not take would
      // be gone by now. A fixed wait, because what is asserted is that nothing
      // happens.
      await page.waitForTimeout(2500);
      expect(await toastCountRightNow(page)).toBe(1);

      await page.mouse.move(5, 5);
      await expect.poll(() => toastCountRightNow(page), { timeout: 5000 }).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('a card that opens nothing lets a click through to what is under it', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Saved', message: 'Column order saved.', durationMs: 30_000 });
      await expect(page.getByTestId('toast')).toHaveCount(1);

      expect(await hitTestable(page, '[data-testid="toast-body"]'), 'the body ate the click').toBe(false);
      expect(await hitTestable(page, '[data-testid="toast-countdown"]'), 'the countdown line ate the click').toBe(false);
      expect(await hitTestable(page, '[data-testid="toast-dismiss"]'), 'the dismiss X is not clickable').toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a card that opens something opens it on a click, then closes', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Agent finished', message: '"Fix login redirect" is waiting on you.', durationMs: 30_000 }, '__opened');
      await expect(page.getByTestId('toast')).toHaveCount(1);
      expect(await hitTestable(page, '[data-testid="toast-body"]')).toBe(true);

      await page.getByTestId('toast-body').click();

      await expect.poll(() => readFlag(page, '__opened')).toBe(true);
      await expect.poll(() => toastCountRightNow(page), { timeout: 5000 }).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('the dismiss X on a card that opens something closes it without opening', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Agent finished', message: '"Fix login redirect" is waiting on you.', durationMs: 30_000 }, '__opened');
      await page.getByTestId('toast-dismiss').click();

      await expect.poll(() => toastCountRightNow(page), { timeout: 5000 }).toBe(0);
      expect(await readFlag(page, '__opened')).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('no toast takes a click while the settings panel is open, and they do again once it closes', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Agent finished', message: '"Fix login redirect" is waiting on you.', durationMs: 60_000 }, '__opened');
      await expect(page.getByTestId('toast')).toHaveCount(1);

      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });

      await expect(page.locator('[data-toast-gate]')).toHaveAttribute('data-toast-gate', 'closed');
      expect(await hitTestable(page, '[data-testid="toast-body"]'), 'the card took a click under the settings panel').toBe(false);
      expect(await hitTestable(page, '[data-testid="toast-dismiss"]'), 'the X took a click under the settings panel').toBe(false);

      await page.keyboard.press('Escape');
      await expect(page.locator('h2:has-text("Settings")')).toHaveCount(0);
      await expect(page.locator('[data-toast-gate]')).toHaveAttribute('data-toast-gate', 'open');
      expect(await hitTestable(page, '[data-testid="toast-dismiss"]')).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('the gate closes at once for a panel opened by keyboard with the pointer resting on a toast', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Agent finished', message: '"Fix login redirect" is waiting on you.', durationMs: 60_000 }, '__opened');
      const centre = await cardCentre(page);
      await page.mouse.move(centre.x, centre.y);

      // No pointer movement from here: the gate must not wait for one.
      await page.keyboard.press('Control+Shift+S');
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
      await page.mouse.click(centre.x, centre.y);

      expect(await readFlag(page, '__opened'), 'the click opened the toast through the settings panel').toBe(false);
      expect(await toastCountRightNow(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('with Animations off the countdown line steps once a second instead of moving', async () => {
    const { browser, page } = await launchPage();
    try {
      await raiseToast(page, { title: 'Moving', message: 'The line moves smoothly.', durationMs: 30_000 });
      const easingOf = (index: number) => page.evaluate((nth) => {
        const fill = document.querySelectorAll('[data-testid="toast-countdown"] > div')[nth];
        const animation = fill?.getAnimations()[0];
        return animation ? String(animation.effect?.getTiming().easing) : null;
      }, index);
      await expect.poll(() => easingOf(0)).toBe('linear');

      await page.evaluate(() => document.documentElement.classList.add('no-motion'));
      await raiseToast(page, { title: 'Stepping', message: 'The line steps.', durationMs: 30_000 });
      await expect.poll(() => easingOf(1)).toMatch(/^steps\(30/);
    } finally {
      await browser.close();
    }
  });
});

test.describe('toasts in a pop-out window', () => {
  test('a toast raised in the detached Agent Monitor shows there', async () => {
    await waitForViteReady();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript({ path: path.join(__dirname, 'mock-electron-api.js') });
      await page.addInitScript(`window.electronAPI.popOut.descriptor = { kind: 'monitor', params: {} };`);
      await gotoVite(page);
      await page.locator('[data-testid="popout-close"]').waitFor({ state: 'visible', timeout: 15000 });

      // A pop-out mounts no App.tsx, so it has no store handle on window; the
      // module the surface imported is the same one Vite serves here.
      await page.evaluate(async () => {
        const module = await import('/src/renderer/stores/toast-store.ts');
        module.useToastStore.getState().addToast({ title: 'Couldn\'t reset session', message: 'The task is in Done.', variant: 'error', durationMs: 30_000 });
      });

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast.getByTestId('toast-title')).toHaveText('Couldn\'t reset session');
    } finally {
      await browser.close();
    }
  });
});
