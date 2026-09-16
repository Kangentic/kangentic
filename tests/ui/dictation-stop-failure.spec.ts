/**
 * Coverage for the `dictation.stop()` rejection path in
 * `useDictation.ts`'s `finalizeOnRelease` (around lines 447-461).
 *
 * The dictation engine runs in its own utilityProcess worker (DESKTOP-X, see
 * .claude/rules/dictation-out-of-process.md), so a native fault there no
 * longer takes the whole app down - but the in-flight utterance is still
 * lost. A rejected `stop()` used to be swallowed by a bare `catch {}`, which
 * left `finalText` empty and showed the user nothing: the mic light simply
 * went out with no explanation and no way to tell whether the words had
 * landed anywhere. The fix cleans up, calls `setError(...)`, and returns
 * EARLY - it deliberately does not fall through to the code that would
 * otherwise clear the target and commit an empty transcript, and does not
 * reset the store, so the error stays visible instead of flashing back to
 * idle.
 *
 * This drives the REAL push-to-talk flow (press, real mic capture against a
 * fake media device, release) rather than poking the dictation store
 * directly, because the store poke used by dictation-live-chip.spec.ts can
 * only render states the hook already reached - it cannot exercise
 * `finalizeOnRelease`'s own try/catch around `dictation.stop()`, which is
 * exactly the code under test. See dictation-note-input.spec.ts for the
 * precedent this borrows its harness from.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, createProject } from './helpers';

// Each test launches its own browser/context: the dictation store is a
// Fast-Refresh-pinned singleton (module scope) and each test drives a full
// press/release cycle, so a shared page would carry `status` across tests.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** The streaming engine emits uppercase, unpunctuated tokens; `toPreviewCase`
 *  lowercases and capitalizes the first letter for the live preview. */
const PARTIAL_RAW = 'FIX THE SPACING';
const PARTIAL_SHOWN = 'Fix the spacing';

/** A fresh browser with a fake mic, dictation enabled, and push-to-talk bound
 *  to a keyboard combo Playwright can actually press (the default is
 *  `Mouse:Back`). */
async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, {
    dictation: { enabled: true, autoSubmit: false, releaseBufferMs: 0 },
    hotkeyOverrides: { 'dictation.pushToTalk': 'Alt+Shift+Q' },
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await createProject(page, `Dictation Stop Failure Test ${Date.now()}`);
  return { browser, page };
}

interface DictationStoreHandle {
  getState: () => { status: string; error: string | null; finalText: string };
}

function dictationState(page: Page): Promise<{ status: string; error: string | null; finalText: string } | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: { dictation: DictationStoreHandle } }).__zustandStores;
    const state = stores?.dictation?.getState();
    return state ? { status: state.status, error: state.error, finalText: state.finalText } : null;
  });
}

async function pressAndHold(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Q');
  await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');
}

async function release(page: Page): Promise<void> {
  await page.keyboard.up('Q');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
}

function emitPartial(page: Page, text: string): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __emitDictationPartial: (id: string, text: string) => void })
      .__emitDictationPartial('mock-dictation-1', value);
  }, text);
}

test.describe('useDictation: a rejected dictation.stop() surfaces an error and commits nothing', () => {
  test('shows the failure in the live chip and leaves the pre-release preview untouched', async () => {
    // The ui project's default 15s budget is tight for this one: launching a
    // fresh Chromium with fake-media-device flags, a cold Vite dev-server
    // compile of the whole renderer graph, mic capture, and a real project
    // creation flow all land in a single test (no shared beforeAll to
    // amortize them across a file, unlike dictation-note-input.spec.ts).
    test.setTimeout(45000);
    const { browser, page } = await launch();
    try {
      await page.evaluate(() => {
        (window as unknown as { __mockDictationStopError: string }).__mockDictationStopError = 'engine crashed';
      });

      const search = page.locator('[data-testid="board-search"]');
      await search.click();

      await pressAndHold(page);
      // A live partial lands before release, so there is something visible to
      // check was NOT overwritten by a (nonexistent) committed transcript.
      await emitPartial(page, PARTIAL_RAW);
      await expect(search).toHaveValue(PARTIAL_SHOWN);

      await release(page);

      // The chip surfaces the failure. Reverting to a bare `catch {}` resets
      // the store to idle instead, so the chip renders nothing at all here.
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip.getByText('Dictation failed: engine crashed', { exact: true })).toBeVisible();

      const state = await dictationState(page);
      expect(state?.status).toBe('error');
      // No transcript was ever produced (the decode itself failed), and the
      // early return never reaches the line that would assign one.
      expect(state?.finalText).toBe('');

      // The live preview stays exactly as the last partial left it: the early
      // return means `sinkRef.current?.submit(...)` is never called, so
      // nothing erases or replaces what was already typed. A bare `catch {}`
      // instead falls through to that submit with an empty final transcript,
      // which erases the preview back to the field's pre-press value (here,
      // empty) - so this assertion is the one that goes red on that revert.
      await expect(search).toHaveValue(PARTIAL_SHOWN);
    } finally {
      await browser.close();
    }
  });
});
