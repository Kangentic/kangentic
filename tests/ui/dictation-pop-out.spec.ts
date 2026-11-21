/**
 * Push-to-talk in a pop-out window.
 *
 * A pop-out is its own renderer, and dictation used to mount only in the main
 * window's `AppLayout`: a hold in a popped-out Browser pane or Command Terminal
 * did nothing at all, no chip and no text. Each case here boots a page as a
 * pop-out (the descriptor set before the renderer mounts, as main boots one) and
 * drives the real hotkey, so it fails if the pop-out root stops mounting the
 * hook, or if the target is resolved from the main window's state.
 *
 * Mouse back and forward navigation used to live inside the dictation hook,
 * behind its `enabled` gate, so with dictation off they navigated nothing. The
 * last case drives a guest Back release with dictation off.
 *
 * Like `dictation-note-input.spec.ts`, this launches Chromium with a fake media
 * device so the real capture starts. The hotkey is rebound to `Alt+Shift+Q`,
 * since Playwright cannot press the default `Mouse:Back`. Each test launches its
 * own browser, because a pop-out is booted by a descriptor set before the
 * renderer mounts. The tests run in order in one worker: every page holds a
 * fake capture device and a real AudioContext.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-popout-dictation';
const PROJECT_NAME = 'Pop-out Dictation Test';
const PROJECT_PATH = '/mock/popout-dictation';
const TASK_ID = 'task-popout-dictation';
const TASK_SESSION_ID = 'sess-popout-dictation';
const TERMINAL_SESSION_ID = 'sess-popout-dictation-terminal';
const TASK_URL = 'http://localhost:5173/';

/** The streaming engine's raw partial, and what the hook types for it. */
const PARTIAL_RAW = 'FIX THE SPACING';
const PARTIAL_SHOWN = 'Fix the spacing';

/** One project with a task whose agent runs, and a Command Terminal in slot-1. */
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: '${PROJECT_NAME}', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var id = 'lane-popout-dictation-' + index;
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
    });
    state.sessions.push({
      id: '${TASK_SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9401,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.sessions.push({
      id: '${TERMINAL_SESSION_ID}', taskId: '${TERMINAL_SESSION_ID}', projectId: '${PROJECT_ID}', pid: 9402,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
      resuming: false, transient: true, commandTerminalSlot: 'slot-1',
      commandTerminalBranch: 'main', commandTerminalLabel: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', projectId: '${PROJECT_ID}', title: 'Pop-out Dictation Task', description: '',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${TASK_SESSION_ID}',
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

const BROWSER_DESCRIPTOR = { kind: 'browser', params: { taskId: TASK_ID, projectId: PROJECT_ID } };
const COMMAND_TERMINAL_DESCRIPTOR = { kind: 'command-terminal', params: { projectId: PROJECT_ID, projectName: PROJECT_NAME } };

interface LaunchOptions {
  /** Whether dictation is on. Defaults to true. */
  dictationEnabled?: boolean;
  /** The push-to-talk binding. Defaults to a keyboard combo Playwright can press;
   *  the Back cases bind `Mouse:Back`, the real default, whose presses arrive
   *  from the guest over IPC. */
  hotkey?: string;
  /** Page-side scripts that run after the mock and the seed, before the app boots. */
  initScripts?: string[];
}

/** `descriptor` null boots the MAIN window on the same seed, for the cases that
 *  contrast the two (prewarm) or need the settings panel (a rebind capture). */
async function launchPopOut(
  descriptor: { kind: string; params: Record<string, unknown> } | null,
  options: LaunchOptions = {},
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, {
    dictation: { enabled: options.dictationEnabled ?? true, autoSubmit: false, releaseBufferMs: 0 },
    hotkeyOverrides: { 'dictation.pushToTalk': options.hotkey ?? 'Alt+Shift+Q' },
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(`
    window.__mockBrowser.seedTaskUrl('${TASK_ID}', '${TASK_URL}');
    ${descriptor ? `window.electronAPI.popOut.descriptor = ${JSON.stringify(descriptor)};` : ''}
  `);
  for (const script of options.initScripts ?? []) await page.addInitScript(script);
  await gotoVite(page, VITE_URL);
  return { browser, page };
}

/** Wait for the popped-out pane and give its `<webview>` stub the guest surface
 *  the dictation and navigation paths call. */
async function waitForPane(page: Page): Promise<void> {
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate(() => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      (HTMLElement & { __navigationCalls: string[] }) | null;
    if (!webview) throw new Error('no webview stub');
    webview.__navigationCalls = [];
    Object.assign(webview, {
      executeJavaScript: async () => '',
      getURL: () => 'http://localhost:5173/',
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => { webview.__navigationCalls.push('goBack'); },
      goForward: () => { webview.__navigationCalls.push('goForward'); },
    });
    webview.tabIndex = -1;
  });
}

async function holdOnly(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Q');
}

async function release(page: Page): Promise<void> {
  await page.keyboard.up('Q');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
}

interface DictationState { status: string; targetKind: string | null; busyReason: string | null }

function dictationState(page: Page): Promise<DictationState | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { dictation: { getState: () => DictationState } };
    }).__zustandStores;
    const state = stores?.dictation.getState();
    return state ? { status: state.status, targetKind: state.targetKind, busyReason: state.busyReason } : null;
  });
}

function emitPartial(page: Page, text: string): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __emitDictationPartial: (id: string, text: string) => void })
      .__emitDictationPartial('mock-dictation-1', value);
  }, text);
}

function emitPartialFor(page: Page, dictationSessionId: string, text: string): Promise<void> {
  return page.evaluate(([id, value]) => {
    (window as unknown as { __emitDictationPartial: (id: string, text: string) => void })
      .__emitDictationPartial(id, value);
  }, [dictationSessionId, text]);
}

function emitFinalFor(page: Page, dictationSessionId: string, text: string): Promise<void> {
  return page.evaluate(([id, value]) => {
    (window as unknown as { __emitDictationFinal: (id: string, text: string) => void })
      .__emitDictationFinal(id, value);
  }, [dictationSessionId, text]);
}

function dictationTexts(page: Page): Promise<{ partialText: string; finalText: string }> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { dictation: { getState: () => { partialText: string; finalText: string } } };
    }).__zustandStores;
    const { partialText, finalText } = stores.dictation.getState();
    return { partialText, finalText };
  });
}

function navigationCalls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(document.querySelector('[data-testid="browser-webview"]') as unknown as { __navigationCalls: string[] }).__navigationCalls]);
}

/** A mouse Back (3) or Forward (4) press on the window, as the OS delivers it. */
function mouseNavigationPress(page: Page, button: 3 | 4): Promise<void> {
  return page.evaluate((pressed) => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', {
      button: pressed, buttons: pressed === 3 ? 8 : 16, pointerType: 'mouse', bubbles: true, cancelable: true,
    }));
  }, button);
}

function liveWrites(page: Page): Promise<{ sessionId: string; payload: string }[]> {
  return page.evaluate(() =>
    (window.electronAPI.dictation as unknown as { __liveWriteCalls: { sessionId: string; payload: string }[] }).__liveWriteCalls);
}

test.describe('Dictation in a pop-out window', () => {
  // The default binding is Mouse:Back, which is also the browser Back button. A
  // popped-out pane gets the same tap-versus-hold split as the main window: a pop-out
  // used to hold no button at all, so Back navigated on the press and never dictated.
  test('with push-to-talk on Mouse:Back, a guest HOLD in a popped-out pane dictates and does not navigate', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, { hotkey: 'Mouse:Back' });
    try {
      await waitForPane(page);
      await page.locator('[data-testid="browser-note-input"]').click();

      const pressedAt = Date.now();
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', at);
      }, pressedAt);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');

      // Released well past the tap threshold: a hold dictates, never navigates.
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', at);
      }, pressedAt + 1500);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
      expect(await navigationCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('with push-to-talk on Mouse:Back, a guest TAP in a popped-out pane navigates once and leaves nothing recording', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, { hotkey: 'Mouse:Back' });
    try {
      await waitForPane(page);
      await page.locator('[data-testid="browser-note-input"]').click();

      const pressedAt = Date.now();
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', at);
      }, pressedAt);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', at);
      }, pressedAt + 40);

      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
      expect(await navigationCalls(page)).toEqual(['goBack']);
    } finally {
      await browser.close();
    }
  });

  test('a hold in a popped-out Browser pane types into its note input and shows the chip there', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR);
    try {
      await waitForPane(page);
      const note = page.locator('[data-testid="browser-note-input"]');
      await note.click();

      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');
      expect((await dictationState(page))?.targetKind).toBe('input');
      await expect(page.getByTestId('dictation-live-chip')).toBeVisible();

      await emitPartial(page, PARTIAL_RAW);
      await expect(note).toHaveValue(PARTIAL_SHOWN);
      expect(await liveWrites(page)).toEqual([]);

      await release(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('with nothing focused, a hold in a Browser pop-out types into no terminal', async () => {
    // The main window falls back to its bottom panel's terminal. A pop-out has
    // no bottom panel, so that fallback would type into a terminal nobody in
    // this window can see.
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR);
    try {
      await waitForPane(page);
      // The premise: this window knows the project and its running task agent,
      // which is everything the bottom-panel fallback would resolve.
      await expect.poll(() => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { project: { getState: () => { currentProject: { id: string } | null } } };
        }).__zustandStores;
        return stores?.project.getState().currentProject?.id ?? null;
      }), { timeout: 10000 }).toBe(PROJECT_ID);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');
      expect((await dictationState(page))?.targetKind).toBeNull();
      await expect(page.getByTestId('dictation-live-chip').getByText('No terminal or input focused')).toBeVisible();

      await emitPartial(page, PARTIAL_RAW);
      await release(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
      expect(await liveWrites(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a hold in the Command Terminal pop-out types into its focused terminal', async () => {
    // It boots its own browser and waits for a Command Terminal and its xterm
    // before the hold starts, which ran past the default budget about one run
    // in six.
    test.slow();
    const { browser, page } = await launchPopOut(COMMAND_TERMINAL_DESCRIPTOR);
    try {
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 15000 });
      const terminalInput = page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first();
      await terminalInput.waitFor({ state: 'attached', timeout: 15000 });
      await terminalInput.focus();

      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');
      expect((await dictationState(page))?.targetKind).toBe('terminal');

      await emitPartial(page, PARTIAL_RAW);
      await expect.poll(() => liveWrites(page), { timeout: 5000 }).toEqual([
        { sessionId: TERMINAL_SESSION_ID, payload: PARTIAL_SHOWN },
      ]);

      await release(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('a press while another window is still dictating says so and records nothing', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, {
      initScripts: ['window.__mockDictationStartRefused = true;'],
    });
    try {
      await waitForPane(page);
      await page.locator('[data-testid="browser-note-input"]').click();

      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.busyReason, { timeout: 10000 }).toBe('other-window');
      await expect(page.getByTestId('dictation-live-chip').getByText('Finishing in another window')).toBeVisible();
      await release(page);
      // The refusal clears itself once read.
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
      await expect(page.locator('[data-testid="browser-note-input"]')).toHaveValue('');
    } finally {
      await browser.close();
    }
  });

  test('with dictation off, a mouse Back release in the guest navigates the popped-out pane', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, { dictationEnabled: false });
    try {
      await waitForPane(page);
      // Focus inside the pane makes it the one a Back gesture belongs to.
      await page.evaluate(() => (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus());

      await page.evaluate(() => {
        const at = Date.now();
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', at);
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', at + 40);
      });

      await expect.poll(() => page.evaluate(() =>
        (document.querySelector('[data-testid="browser-webview"]') as unknown as { __navigationCalls: string[] }).__navigationCalls),
      { timeout: 5000 }).toEqual(['goBack']);
      expect((await dictationState(page))?.status).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('a partial and a final for another dictation session leave the target and store untouched', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR);
    try {
      await waitForPane(page);
      const note = page.locator('[data-testid="browser-note-input"]');
      await note.click();
      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('recording');

      // Main sends a session's text only to its own window, and the hook matches
      // the id as well: a routing slip for another session types nothing here.
      await emitPartialFor(page, 'mock-dictation-other', 'SOMEONE ELSES WORDS');
      await emitFinalFor(page, 'mock-dictation-other', 'Someone else final');
      await expect(note).toHaveValue('');
      expect(await dictationTexts(page)).toEqual({ partialText: '', finalText: '' });

      await emitPartialFor(page, 'mock-dictation-1', PARTIAL_RAW);
      await emitFinalFor(page, 'mock-dictation-1', 'Fix the spacing now');
      await expect(note).toHaveValue(PARTIAL_SHOWN);
      expect(await dictationTexts(page)).toEqual({ partialText: PARTIAL_SHOWN, finalText: 'Fix the spacing now' });

      await release(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('a refused press can be followed by another press that records', async () => {
    // Two holds in one page, and the first leaves the 1.6s refusal notice to run
    // out before the second: more than the 15s UI default on a loaded worker.
    test.slow();
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, {
      initScripts: ['window.__mockDictationStartRefused = true;'],
    });
    try {
      await waitForPane(page);
      const note = page.locator('[data-testid="browser-note-input"]');
      await note.click();

      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.busyReason, { timeout: 10000 }).toBe('other-window');
      await release(page);
      // The refusal released the press latch, so the lift is nothing to finish:
      // it must not run the release path, whose reset would wipe the notice the
      // user is still reading. A latch left set sent the lift down that path.
      expect((await dictationState(page))?.busyReason).toBe('other-window');
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');

      // The other window finished. A refusal that left the press latched would
      // treat this press as a second press of a hold that never began.
      await page.evaluate(() => { (window as unknown as { __mockDictationStartRefused: boolean }).__mockDictationStartRefused = false; });
      await note.click();
      await holdOnly(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 6000 }).toBe('recording');
      expect((await dictationState(page))?.busyReason).toBeNull();

      await release(page);
      await expect.poll(async () => (await dictationState(page))?.status, { timeout: 10000 }).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('with dictation off, a window mouse Forward press and a guest Forward release both navigate forward', async () => {
    const { browser, page } = await launchPopOut(BROWSER_DESCRIPTOR, { dictationEnabled: false });
    try {
      await waitForPane(page);
      await page.evaluate(() => {
        const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
          HTMLElement & { canGoForward: () => boolean };
        webview.canGoForward = () => true;
        webview.focus();
      });

      await test.step('a window pointerdown with button 4 navigates on press', async () => {
        await mouseNavigationPress(page, 4);
        await expect.poll(() => navigationCalls(page), { timeout: 5000 }).toEqual(['goForward']);
      });

      await test.step('a guest Forward up event navigates', async () => {
        await page.evaluate(() => {
          const at = Date.now();
          window.__mockBrowser?.emitGuestMouseButton(4242, 'forward', 'down', at);
          window.__mockBrowser?.emitGuestMouseButton(4242, 'forward', 'up', at + 40);
        });
        await expect.poll(() => navigationCalls(page), { timeout: 5000 }).toEqual(['goForward', 'goForward']);
      });
      expect((await dictationState(page))?.status).toBe('idle');
    } finally {
      await browser.close();
    }
  });

  test('a mouse Back press does not navigate while a hotkey rebind capture is open', async () => {
    // The capture widget lives in the main window's Settings panel, so this case
    // boots the main window, opens the task's Browser pane, then arms a capture
    // over it (the settings panel is an overlay sibling, the pane stays mounted).
    const { browser, page } = await launchPopOut(null, { dictationEnabled: false });
    try {
      await page.getByText('Pop-out Dictation Task').first().click();
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });
      const pane = page.locator('[data-testid="browser-pane"]');
      if (!(await pane.isVisible().catch(() => false))) {
        await page.locator('[data-testid="browser-toggle"]').click();
      }
      await waitForPane(page);

      await page.locator('[data-testid="settings-button"]').click();
      await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
      await page.getByTestId('hotkey-row-view.toggleSidebar').getByTestId('key-capture-input').click();
      const captureBox = page.getByTestId('key-capture-box');
      await captureBox.waitFor({ state: 'visible', timeout: 5000 });
      await expect(pane).toHaveCount(1);

      const focusPane = (): Promise<void> => page.evaluate(() =>
        (document.querySelector('[data-testid="browser-webview"]') as HTMLElement).focus());
      await focusPane();

      await mouseNavigationPress(page, 3);
      // The press has been handled by now (dispatch is synchronous); the capture
      // owns it, so the pane stays put and the capture is still open.
      expect(await navigationCalls(page)).toEqual([]);
      await expect(captureBox).toBeVisible();

      // Control: with the capture closed the same press navigates, so the empty
      // list above is the capture's doing and not a pane that cannot go back.
      await captureBox.focus();
      await page.keyboard.press('Escape');
      await expect(captureBox).toHaveCount(0);
      await focusPane();
      await mouseNavigationPress(page, 3);
      await expect.poll(() => navigationCalls(page), { timeout: 5000 }).toEqual(['goBack']);
    } finally {
      await browser.close();
    }
  });

  test('only the main window prewarms the dictation engine', async () => {
    // With dictation off the main window sends `prewarm(null)` as soon as the
    // config has loaded, with no debounce, so it is the signal that the effect
    // ran. The pop-out reaches the same point and must send nothing.
    const prewarmCalls = (page: Page): Promise<unknown[]> => page.evaluate(() =>
      [...(window.electronAPI.dictation as unknown as { __prewarmCalls: unknown[] }).__prewarmCalls]);
    const configLoaded = (page: Page): Promise<boolean> => page.evaluate(() =>
      (window as unknown as { __zustandStores: { config: { getState: () => { configLoaded: boolean } } } })
        .__zustandStores.config.getState().configLoaded);

    const main = await launchPopOut(null, { dictationEnabled: false });
    try {
      await expect.poll(() => prewarmCalls(main.page), { timeout: 10000 }).toEqual([null]);
    } finally {
      await main.browser.close();
    }

    const popOut = await launchPopOut(BROWSER_DESCRIPTOR, { dictationEnabled: false });
    try {
      await waitForPane(popOut.page);
      await expect.poll(() => configLoaded(popOut.page), { timeout: 10000 }).toBe(true);
      // One more round trip, so the effect that follows the config load has run.
      await popOut.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(await prewarmCalls(popOut.page)).toEqual([]);
    } finally {
      await popOut.browser.close();
    }
  });
});
