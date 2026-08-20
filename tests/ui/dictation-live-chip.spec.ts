/**
 * Coverage for `LiveDictationChip`'s autoSubmit-driven copy (Priority 2) and its
 * `noTarget` state (Priority 3). The chip is mounted unconditionally by
 * `<DictationSurface />` in `AppLayout`, with no project-open gate, so no project
 * or session needs to exist for these tests.
 *
 * Driving `recording` / `finalizing` through the real push-to-talk flow would need
 * a fake media device, granted mic permission, a loaded AudioWorklet, and a
 * combo-matched keydown/keyup - and `finalizing` is a single microtask in that path
 * (the mock's `dictation.stop()` resolves immediately), so it is not reliably
 * observable even with all of that in place. Instead this drives the dictation
 * store directly via the `__zustandStores` debug handle (`src/renderer/App.tsx`,
 * `import.meta.env.DEV`-only), the same pattern `spawn-stall-toast.spec.ts` uses
 * for the session store's `setSpawnProgress`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser: the dictation store is a Fast-Refresh-pinned
// singleton (module scope), so a shared page would carry `status` across tests.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

interface DictationStoreState {
  beginRecording: (
    dictationSessionId: string,
    target: {
      sessionId: string | null;
      kind: 'terminal' | 'input' | null;
      willSubmit?: boolean;
    },
  ) => void;
  setFinalizing: () => void;
}

interface DictationStoreHandle {
  getState: () => DictationStoreState;
}

/**
 * `dictation.enabled: true` matters beyond arming the (unused) keybinding:
 * `useDictation`'s teardown effect calls `cancelDictation()` (which resets the
 * store to idle) whenever `enabled` is false and status is not idle. Leaving it
 * false would race our direct store writes against that effect.
 */
async function launch(autoSubmit: boolean): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, { dictation: { enabled: true, autoSubmit } });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * `target` is the resolved dictation target, not a session id: a terminal target
 * carries a session, an INPUT target (the Browser pane's note field) carries
 * none, and "nothing focused" carries neither. The chip keys its no-target state
 * on the KIND for exactly that reason - a session-id test would report every
 * input target as having nowhere to type.
 */
async function beginRecording(
  page: Page,
  target: { sessionId: string | null; kind: 'terminal' | 'input' | null; willSubmit?: boolean },
): Promise<void> {
  await page.evaluate((resolved) => {
    const stores = (window as unknown as { __zustandStores?: { dictation: DictationStoreHandle } }).__zustandStores;
    if (!stores?.dictation) throw new Error('dictation store not exposed on __zustandStores');
    stores.dictation.getState().beginRecording('dict-session-1', resolved);
  }, target);
}

/**
 * `willSubmit` is what release will ACTUALLY do, resolved when the hook starts a
 * dictation - not the raw `autoSubmit` setting. The two differ for a field
 * inside a multi-field form, which never auto-submits however the setting is
 * configured, so the chip drives its "Release to send" / "Release to insert"
 * hint off this rather than off config.
 */
const TERMINAL_TARGET_SUBMITS = { sessionId: 'sess-target-1', kind: 'terminal' as const, willSubmit: true };
const TERMINAL_TARGET_INSERTS = { sessionId: 'sess-target-1', kind: 'terminal' as const, willSubmit: false };
const INPUT_TARGET_SUBMITS = { sessionId: null, kind: 'input' as const, willSubmit: true };
const NO_TARGET = { sessionId: null, kind: null, willSubmit: false };

async function setFinalizing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: { dictation: DictationStoreHandle } }).__zustandStores;
    if (!stores?.dictation) throw new Error('dictation store not exposed on __zustandStores');
    stores.dictation.getState().setFinalizing();
  });
}

test.describe('LiveDictationChip: autoSubmit-driven copy', () => {
  test('recording with a focused target: "Listening" + "Release to send" hint (autoSubmit on, the default)', async () => {
    const { browser, page } = await launch(true);
    try {
      await beginRecording(page, TERMINAL_TARGET_SUBMITS);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip.getByText('Listening', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('recording with a focused target: "Release to insert" hint when autoSubmit is off', async () => {
    const { browser, page } = await launch(false);
    try {
      await beginRecording(page, TERMINAL_TARGET_INSERTS);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Release to insert', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('finalizing with a focused target: "Sending..." label when autoSubmit is on', async () => {
    const { browser, page } = await launch(true);
    try {
      await beginRecording(page, TERMINAL_TARGET_SUBMITS);
      await setFinalizing(page);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Sending...', { exact: true })).toBeVisible();
      await expect(chip.getByText('Inserting...', { exact: true })).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('finalizing with a focused target: "Inserting..." label when autoSubmit is off', async () => {
    const { browser, page } = await launch(false);
    try {
      await beginRecording(page, TERMINAL_TARGET_INSERTS);
      await setFinalizing(page);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Inserting...', { exact: true })).toBeVisible();
      await expect(chip.getByText('Sending...', { exact: true })).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('LiveDictationChip: no focused target', () => {
  test('recording with no target: "No terminal or input focused" label, attention-toned dot, no hint', async () => {
    // The copy names inputs as well as terminals because either can be the
    // target now, and focusing the Browser pane's note input is a real fix for
    // this state. "No terminal focused" would send the user looking for the
    // wrong thing.
    const { browser, page } = await launch(true);
    try {
      await beginRecording(page, NO_TARGET);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('No terminal or input focused', { exact: true })).toBeVisible();
      await expect(chip.getByText('Listening', { exact: true })).toHaveCount(0);

      const dot = chip.locator('[data-testid="dictation-recording-dot"]');
      await expect(dot).toHaveAttribute('data-tone', 'attention');
      await expect(dot).toHaveClass(/bg-attention/);
      await expect(dot).not.toHaveClass(/bg-active/);

      // No "Release to..." hint while there is nowhere to release into.
      await expect(chip.getByText('Release to send', { exact: true })).toHaveCount(0);
      await expect(chip.getByText('Release to insert', { exact: true })).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('recording with a target: active-toned dot (the contrast case for the noTarget dot above)', async () => {
    const { browser, page } = await launch(true);
    try {
      await beginRecording(page, TERMINAL_TARGET_SUBMITS);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      const dot = chip.locator('[data-testid="dictation-recording-dot"]');
      await expect(dot).toHaveAttribute('data-tone', 'active');
      await expect(dot).toHaveClass(/bg-active/);
      await expect(dot).not.toHaveClass(/bg-attention/);
    } finally {
      await browser.close();
    }
  });

  test('an INPUT target reads as a live target, not as "no target"', async () => {
    // The regression this guards: `noTarget` used to be `!targetSessionId`, and
    // an input target has no session behind it (the renderer writes to the DOM
    // node directly). Under that test the chip would say "nothing focused" while
    // the user's words were visibly landing in the field.
    const { browser, page } = await launch(true);
    try {
      await beginRecording(page, INPUT_TARGET_SUBMITS);
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Listening', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toBeVisible();
      await expect(chip.getByText('No terminal or input focused', { exact: true })).toHaveCount(0);

      const dot = chip.locator('[data-testid="dictation-recording-dot"]');
      await expect(dot).toHaveAttribute('data-tone', 'active');
    } finally {
      await browser.close();
    }
  });
});
