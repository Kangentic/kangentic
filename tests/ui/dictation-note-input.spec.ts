/**
 * Dictation into the Browser pane's note input, driven through the REAL
 * push-to-talk flow.
 *
 * The reported bug is that dictation always went to a terminal: the note input
 * ("What should the agent do with this?") is the natural place to describe what
 * the agent should do with a capture, and it was the one place in that workflow
 * where speaking was most useful and least available.
 *
 * Why this drives the whole hook rather than poking the store the way
 * `dictation-live-chip.spec.ts` does: the two things that can break here are
 * both invisible to a store write. The target is resolved inside the
 * capture-phase press handler from `document.activeElement`, and the transcript
 * is written with the native value setter plus a dispatched `input` event -
 * assigning `.value` directly would update the DOM and leave React's state
 * stale, which looks correct for exactly one frame and then reverts. Only a real
 * press against a real controlled input tests either.
 *
 * That needs a microphone, which is why this file launches its own browser with
 * Chromium's fake media device rather than using the tier's usual one. Probed
 * before it was written: `getUserMedia`,
 * an `AudioContext` at 16 kHz, and an `AudioWorklet` registered from a Blob URL
 * all work headless, and `mediaDevices` exists because the Vite dev server is on
 * localhost (a secure context). No assertion depends on the audio CONTENT - the
 * mock's `dictation.stop()` returns a fixed transcript - only on the capture
 * starting without throwing, which is what the real hook awaits.
 *
 * The hotkey is rebound to `Alt+Shift+Q`, an unused combo. The default is
 * `Mouse:Back`, which Playwright cannot press, and `Mod+Shift+D` (the obvious
 * keyboard stand-in) is the dev-only activity debug overlay.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// ONE browser for the file, a fresh CONTEXT and page per test. The isolation
// that matters is the page: the dictation store is a module singleton, so a
// shared page would carry `status` and `targetKind` across tests, while a fresh
// page gets a fresh JS context. The browser itself carries nothing.
//
// Note the deliberate ABSENCE of `test.describe.configure({ mode: 'parallel' })`,
// which most UI specs opt into. Playwright's default already runs a file's tests
// sequentially in one worker, and here that is a correctness choice rather than
// a speed one: every page in this file holds a fake capture device and a real
// AudioContext + AudioWorklet, and fanning those out across workers crashed one
// outright (Windows 0xC0000409) on one run out of a handful. The whole file is
// under ten seconds, so there is nothing to buy by racing it. `mode: 'serial'`
// would also be wrong - it skips the remaining tests after a failure, which
// hides everything behind the first thing to break.

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-dictate-note';
const PROJECT_PATH = '/mock/dictate-note-test';
const TASK_ID = 'task-dictate-note';
const SESSION_ID = 'sess-dictate-note';
const SEEDED_URL = 'http://localhost:5173/';

/** What the mock's `dictation.stop()` resolves with. */
const FINAL_TRANSCRIPT = 'This is a test of dictation.';
/** The streaming engine emits uppercase, unpunctuated tokens; `toPreviewCase`
 *  lowercases and capitalizes the first letter so the preview already reads like
 *  the final text. */
const PARTIAL_RAW = 'FIX THE SPACING';
const PARTIAL_SHOWN = 'Fix the spacing';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}', name: 'Dictate Note Test', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-dn-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}',
      pid: 9300, status: 'running', shell: 'bash',
      cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Dictate Note Task', description: 'Dictation target fixture',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude',
      session_id: '${SESSION_ID}', worktree_path: null, branch_name: null,
      pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({
    headless: true,
    args: [
      // A silent synthetic mic, so `startAudioCapture` resolves instead of
      // throwing and the hook reaches its recording state.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

interface LaunchOptions {
  autoSubmit: boolean;
  /** The push-to-talk binding. Defaults to a keyboard combo Playwright can
   *  actually press; the guest-button tests bind `Mouse:Back` instead, because
   *  those presses arrive over IPC rather than as key events. */
  hotkey?: string;
}

/** A fresh context and page on the shared browser. `autoSubmit` has to be
 *  per-context because it is seeded by an init script, which is why this returns
 *  a page rather than reusing one. */
async function launch({ autoSubmit, hotkey = 'Alt+Shift+Q' }: LaunchOptions): Promise<Page> {
  const context = await sharedBrowser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, {
    dictation: {
      enabled: true,
      autoSubmit,
      // The trailing-capture buffer keeps the mic open a beat past release so a
      // half-voiced last word is not clipped. There is no real speech here, so
      // it is only latency.
      releaseBufferMs: 0,
    },
    hotkeyOverrides: { 'dictation.pushToTalk': hotkey },
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((url) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-dictate-note', url);
  }, SEEDED_URL);
  return page;
}

/** A 1x1 transparent PNG, so `compositeCapture` has something real to decode. */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function openBrowserPane(page: Page): Promise<void> {
  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Dictate Note Task').first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });
  const pane = page.locator('[data-testid="browser-pane"]');
  if (!(await pane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await pane.waitFor({ state: 'visible', timeout: 10000 });

  // Give the `<webview>` stub the Electron-only surface `handleSend` and the
  // guest dictation path need, so both actually COMPLETE here instead of
  // throwing into the error strip or silently doing nothing.
  //
  // This is what makes the auto-submit assertion mean anything. Without it,
  // `compositeCapture` throws before `handleSend` ever reads `note`, so the error
  // strip appears identically whether the transcript reached the payload or an
  // empty string did - and the empty string is a live risk, because `submit()`
  // dispatches `input` (React schedules `setNote`) and then Enter synchronously,
  // and `handleSend` is a callback closed over `note`. Asserting on the recorded
  // capture payload is the only thing that separates those two outcomes.
  //
  // `executeJavaScript` DISPATCHES ON THE SCRIPT it receives rather than
  // returning one constant, so a test can choose what the guest reports.
  // `guest-text-target.ts` sends two distinct scripts: the write script is
  // matched FIRST, on its unmistakable parameter list (`value, caret,
  // previousLength`) - it has to be checked before the probe pattern below,
  // because the write script's own body also reads `document.activeElement`.
  // Everything else (Inspect mode, the selection read in `handleSend`, the
  // clear-pick script) falls through to the original '' default.
  //
  // `tabIndex = -1` makes the stub focusable in headless Chromium, where
  // `<webview>` is an unrecognized custom element and not natively
  // focusable - the same technique `browser-pane-agent-input-focus.spec.ts`
  // uses to stand in for a guest taking focus.
  await page.evaluate((pngDataUrl) => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      (HTMLElement & {
        __guestProbeResult: unknown;
        __executeJavaScriptCalls: string[];
        __canGoBack: boolean;
        __canGoForward: boolean;
        __navigationCalls: string[];
      }) | null;
    if (!webview) throw new Error('no webview stub');
    webview.__guestProbeResult = null;
    webview.__executeJavaScriptCalls = [];
    webview.__canGoBack = false;
    webview.__canGoForward = false;
    webview.__navigationCalls = [];
    Object.assign(webview, {
      capturePage: async () => ({
        toDataURL: () => pngDataUrl,
        getSize: () => ({ width: 1, height: 1 }),
      }),
      executeJavaScript: async (script: string) => {
        webview.__executeJavaScriptCalls.push(script);
        if (script.indexOf('value, caret, previousLength') !== -1) return true;
        if (script.indexOf('document.activeElement') !== -1) return webview.__guestProbeResult ?? '';
        return '';
      },
      getURL: () => 'http://localhost:5173/',
      canGoBack: () => webview.__canGoBack,
      canGoForward: () => webview.__canGoForward,
      goBack: () => { webview.__navigationCalls.push('goBack'); },
      goForward: () => { webview.__navigationCalls.push('goForward'); },
    });
    webview.tabIndex = -1;
  }, TINY_PNG);
}

/** The `BrowserCaptureInput` payloads Send would have shipped to the agent. */
function captureCalls(page: Page): Promise<{ note: string }[]> {
  return page.evaluate(() => (window.__mockBrowser?.getCaptureCalls() ?? []) as { note: string }[]);
}

/** Configure what the guest reports the next time its focused field is
 *  probed (`probeGuestField` in `guest-text-target.ts`). Matches the
 *  `GuestFieldProbe` discriminated union exactly - callers pass either an
 *  eligible or a refused shape. */
function setGuestProbeResult(page: Page, result: unknown): Promise<void> {
  return page.evaluate((value) => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      { __guestProbeResult: unknown } | null;
    if (!webview) throw new Error('no webview stub');
    webview.__guestProbeResult = value;
  }, result);
}

/** Move DOM focus onto the `<webview>` stub itself, which is what
 *  `resolveDictationTarget` reads to identify a guest target - from the
 *  host, `document.activeElement` is only ever the `<webview>` element,
 *  never a field inside it. */
function focusGuestWebview(page: Page): Promise<void> {
  return page.evaluate(() => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as HTMLElement | null;
    if (!webview) throw new Error('no webview stub');
    webview.focus();
  });
}

/** Every script the guest stub's `executeJavaScript` was called with, in
 *  call order - the probe (once, at press time) and every write. */
function guestExecuteJavaScriptCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      { __executeJavaScriptCalls?: string[] } | null;
    return webview?.__executeJavaScriptCalls ?? [];
  });
}

/** Just the WRITE calls, matched the same way the stub itself dispatches on
 *  them: by the write script's unmistakable parameter list. */
function guestWriteScripts(page: Page): Promise<string[]> {
  return guestExecuteJavaScriptCalls(page).then((calls) =>
    calls.filter((script) => script.indexOf('value, caret, previousLength') !== -1));
}

/** Configure the pane's stubbed navigation capability, read by
 *  `registerBrowserNavigationTarget`'s `canGoBack` / `canGoForward`. */
function setGuestNavigable(page: Page, canGoBack: boolean, canGoForward: boolean): Promise<void> {
  return page.evaluate((flags) => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      { __canGoBack: boolean; __canGoForward: boolean } | null;
    if (!webview) throw new Error('no webview stub');
    webview.__canGoBack = flags.canGoBack;
    webview.__canGoForward = flags.canGoForward;
  }, { canGoBack, canGoForward });
}

/** `goBack` / `goForward` calls the stub recorded, in order. */
function navigationCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const webview = document.querySelector('[data-testid="browser-webview"]') as unknown as
      { __navigationCalls?: string[] } | null;
    return webview?.__navigationCalls ?? [];
  });
}

/** Hold the push-to-talk combo and wait until the hook is actually recording.
 *  Everything downstream is gated on that status, so emitting a partial earlier
 *  would be silently dropped. */
async function pressAndHold(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Q');
  await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('recording');
}

/** Hold without waiting for `recording` - for the cases where the press is
 *  expected to be REFUSED, and polling for a status it will never reach would
 *  just time out. */
async function holdOnly(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Q');
}

/** Release in reverse order: the keyup that ends the hold is matched against the
 *  full combo, so the modifiers must still be down when Q comes up. */
async function release(page: Page): Promise<void> {
  await page.keyboard.up('Q');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
}

interface DictationStoreHandle {
  getState: () => { status: string; targetKind: string | null };
}

function dictationStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: { dictation: DictationStoreHandle } }).__zustandStores;
    return stores?.dictation?.getState().status ?? null;
  });
}

function dictationTargetKind(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: { dictation: DictationStoreHandle } }).__zustandStores;
    return stores?.dictation?.getState().targetKind ?? null;
  });
}

function emitPartial(page: Page, text: string): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __emitDictationPartial: (id: string, text: string) => void })
      .__emitDictationPartial('mock-dictation-1', value);
  }, text);
}

/** Every `dictation.liveWrite` payload sent to a PTY. Empty means nothing was
 *  routed to a terminal, which is the point of most of these tests. */
function liveWritePayloads(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.electronAPI.dictation as unknown as { __liveWriteCalls: { payload: string }[] })
      .__liveWriteCalls.map((entry) => entry.payload));
}

test.describe('dictation into the Browser pane note input', () => {
  test('a streaming partial lands in the note input, and nothing reaches a PTY', async () => {
    // The red-green case. Before this change `resolveDictationTarget` could only
    // ever return a terminal session id, so the transcript went to the task's
    // shell (or nowhere) while the user watched an empty note field.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const noteInput = page.locator('[data-testid="browser-note-input"]');
      await noteInput.click();

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');

      await emitPartial(page, PARTIAL_RAW);

      await expect(noteInput).toHaveValue(PARTIAL_SHOWN);
      expect(await liveWritePayloads(page)).toEqual([]);

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  test('successive partials REPLACE rather than append, and keep surrounding text', async () => {
    // The anchor is captured once, at press time, and every partial rewrites
    // that one span. Appending instead would leave three copies of a revised
    // sentence in the field.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const noteInput = page.locator('[data-testid="browser-note-input"]');
      await noteInput.click();
      await noteInput.fill('note: ');

      await pressAndHold(page);
      await emitPartial(page, 'FIX');
      await expect(noteInput).toHaveValue('note: Fix');
      await emitPartial(page, 'FIX THE');
      await expect(noteInput).toHaveValue('note: Fix the');
      await emitPartial(page, PARTIAL_RAW);
      await expect(noteInput).toHaveValue(`note: ${PARTIAL_SHOWN}`);

      await release(page);
      await expect(noteInput).toHaveValue(`note: ${FINAL_TRANSCRIPT}`);
    } finally {
      await page.context().close();
    }
  });

  test('release with auto-submit OFF inserts the final transcript and does not send', async () => {
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const noteInput = page.locator('[data-testid="browser-note-input"]');
      await noteInput.click();

      await pressAndHold(page);
      await emitPartial(page, PARTIAL_RAW);
      await expect(noteInput).toHaveValue(PARTIAL_SHOWN);

      await release(page);

      await expect(noteInput).toHaveValue(FINAL_TRANSCRIPT);
      // A fixed budget, not a poll: this asserts a NON-occurrence, and a poll
      // returns on its first success. Send is fully wired in this file (see
      // `openBrowserPane`), so an accidental send would record a capture call
      // rather than fail into the error strip.
      await page.waitForTimeout(500);
      expect(await captureCalls(page)).toEqual([]);
      await expect(page.locator('[data-testid="browser-send-error"]')).not.toBeVisible();
      expect(await liveWritePayloads(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('release with auto-submit ON sends the transcript to the agent', async () => {
    // "The commit behavior works the same in both places": in a terminal,
    // release pastes and presses Enter. Here it writes the field and presses
    // Enter on it, which is what the note input already maps to Send.
    //
    // The assertion is the SEND PAYLOAD, not the field's value, and that is the
    // point. `submit()` dispatches `input` - which only SCHEDULES React's
    // `setNote` - and then dispatches Enter synchronously, while `handleSend` is
    // a callback closed over `note`. If React had not committed in between, Send
    // would fire carrying the PREVIOUS note, empty on a fresh field: the field
    // would still read correctly, the send would still happen, and the user's
    // words would silently never reach the agent. Only the payload separates
    // those.
    const page = await launch({ autoSubmit: true });
    try {
      await openBrowserPane(page);
      const noteInput = page.locator('[data-testid="browser-note-input"]');
      await noteInput.click();

      await pressAndHold(page);
      await emitPartial(page, PARTIAL_RAW);
      await release(page);

      await expect.poll(() => captureCalls(page), { timeout: 5000 }).toHaveLength(1);
      expect((await captureCalls(page))[0].note).toBe(FINAL_TRANSCRIPT);
      // A completed Send clears the field, exactly as it does when the user
      // presses Enter themselves.
      await expect(noteInput).toHaveValue('');
      await expect(page.locator('[data-testid="browser-send-error"]')).not.toBeVisible();
      expect(await liveWritePayloads(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('with focus in a TERMINAL the transcript still goes to the PTY, untouched', async () => {
    // The converse. A change that merely stopped routing to terminals would pass
    // every test above and break the feature for everyone else.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      // Click into the task's own terminal, which lives in the same window.
      const terminalTextarea = page.locator('[data-testid="task-detail-dialog"] .xterm-helper-textarea').first();
      await terminalTextarea.waitFor({ state: 'attached', timeout: 10000 });
      await terminalTextarea.focus();

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('terminal');

      await emitPartial(page, PARTIAL_RAW);

      await expect.poll(() => liveWritePayloads(page), { timeout: 5000 }).toContain(PARTIAL_SHOWN);
      await expect(page.locator('[data-testid="browser-note-input"]')).toHaveValue('');

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  /**
   * Where the chip SITS. The unit tier pins the placement arithmetic against
   * rects measured from a real window; what it cannot reach is the DOM half -
   * that `resolveDictationAnchor` finds the right elements at all (the input's
   * own node, and the terminal's container via the anchor registry). These are
   * that half.
   *
   * The bug they guard: the chip used to anchor to the focused WINDOW and centre
   * horizontally, and in a split task-detail window the window's centre IS the
   * split seam - so it straddled the divider whichever side was being dictated
   * into, and covered the Browser pane's own controls.
   */
  test('the chip sits against the NOTE INPUT, inside the Browser pane', async () => {
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const noteInput = page.locator('[data-testid="browser-note-input"]');
      await noteInput.click();
      await pressAndHold(page);

      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      // The note field is the last row of its pane, so below does not fit and
      // the chip flips above it.
      await expect(chip).toHaveAttribute('data-placement', 'above');

      const boxes = await page.evaluate(() => {
        const read = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        return {
          chip: read('[data-testid="dictation-live-chip"]'),
          note: read('[data-testid="browser-note-input"]'),
          pane: read('[data-testid="browser-pane"]'),
        };
      });
      if (!boxes.chip || !boxes.note || !boxes.pane) throw new Error('missing box');

      // Clear of the field, so it never covers what is being dictated.
      expect(boxes.chip.bottom).toBeLessThanOrEqual(boxes.note.top);
      // And inside the pane it belongs to, which is the seam bug in one line.
      expect(boxes.chip.left).toBeGreaterThanOrEqual(boxes.pane.left - 1);
      expect(boxes.chip.right).toBeLessThanOrEqual(boxes.pane.right + 1);

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  test('the chip sits inside the TERMINAL pane, never crossing into the Browser pane', async () => {
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const terminalTextarea = page.locator('[data-testid="task-detail-dialog"] .xterm-helper-textarea').first();
      await terminalTextarea.waitFor({ state: 'attached', timeout: 10000 });
      await terminalTextarea.focus();
      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('terminal');

      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();

      const boxes = await page.evaluate(() => {
        const read = (element: Element | null) => {
          if (!element) return null;
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const dialog = document.querySelector('[data-testid="task-detail-dialog"]');
        return {
          chip: read(document.querySelector('[data-testid="dictation-live-chip"]')),
          terminal: read(dialog?.querySelector('.xterm') ?? null),
          pane: read(document.querySelector('[data-testid="browser-pane"]')),
        };
      });
      if (!boxes.chip || !boxes.terminal || !boxes.pane) throw new Error('missing box');

      // Inside the terminal pane...
      expect(boxes.chip.left).toBeGreaterThanOrEqual(boxes.terminal.left - 1);
      expect(boxes.chip.right).toBeLessThanOrEqual(boxes.terminal.right + 1);
      // ...and therefore never over the Browser pane's controls, which is what
      // the window-centred version did on every single dictation.
      expect(boxes.chip.right).toBeLessThanOrEqual(boxes.pane.left + 1);

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  test('the terminal chip does NOT move when the xterm caret does', async () => {
    // The reported bug, in one assertion. The anchor used to be the caret, read
    // off `.xterm-helper-textarea` - which xterm keeps on the caret for IME
    // composition, but only while the cursor is SHOWN. An agent TUI hides it,
    // and with it hidden xterm parks that element elsewhere and then snaps it
    // onto the real caret the moment input arrives, so the chip slid across the
    // pane at the start of every utterance.
    //
    // Moving that element is therefore the sharpest available probe: it is the
    // exact input the old anchor consumed, and the chip must now ignore it.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      const terminalTextarea = page.locator('[data-testid="task-detail-dialog"] .xterm-helper-textarea').first();
      await terminalTextarea.waitFor({ state: 'attached', timeout: 10000 });
      await terminalTextarea.focus();
      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('terminal');

      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      const before = await chip.boundingBox();

      const moved = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="task-detail-dialog"]');
        const helper = dialog?.querySelector('.xterm-helper-textarea');
        if (!(helper instanceof HTMLElement)) return null;
        const was = helper.getBoundingClientRect();
        // Sized as well as moved: the old anchor ignored a zero-area caret and
        // fell through to the pane, so a move alone would prove nothing.
        helper.style.top = '4px';
        helper.style.left = '4px';
        helper.style.width = '7px';
        helper.style.height = '17px';
        const now = helper.getBoundingClientRect();
        return {
          was: { top: was.top, width: was.width, height: was.height },
          now: { top: now.top, width: now.width, height: now.height },
        };
      });
      if (!moved) throw new Error('no helper textarea');
      // The probe has to land a rect the old anchor would have USED, or it
      // proves nothing: a real position and a real area.
      expect(moved.now.top).not.toBe(moved.was.top);
      expect(moved.now.width).toBeGreaterThan(0);
      expect(moved.now.height).toBeGreaterThan(0);

      // Two animation frames, so the chip's rAF loop has had every chance to
      // react before we claim it did not.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      const after = await chip.boundingBox();
      expect(after).toEqual(before);

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  /**
   * The auto-submit paste window.
   *
   * A terminal auto-submit is not instant: `terminal-submit.ts` waits for the
   * TUI to settle rather than sleeping a fixed amount, so it is fast on an idle
   * machine and patient on a loaded one - measured at 2.1 SECONDS of in-flight
   * paste on a busy box. Dictation has to refuse a press during that window,
   * because fresh bytes would split the bracketed paste.
   *
   * The bug was the shape of that refusal: one global boolean, checked before
   * the target was even resolved, applied to every possible destination and said
   * nothing. Push-to-talk simply went dead for a couple of seconds after each
   * terminal dictation, which is how it was reported - "works sometimes, seems
   * to need a reset". Captured live: two consecutive presses logged
   * `startDictation {active:false, submitting:true}` and did nothing at all.
   */
  test('a terminal paste still landing does not block dictation ELSEWHERE', async () => {
    const page = await launch({ autoSubmit: true });
    try {
      await openBrowserPane(page);
      // Hold the paste open, so the in-flight window is observable at all. The
      // mock otherwise resolves instantly and this whole class of bug is
      // invisible to the test tier.
      await page.evaluate(() => window.electronAPI.dictation.__blockSubmit());

      const terminalTextarea = page.locator('[data-testid="task-detail-dialog"] .xterm-helper-textarea').first();
      await terminalTextarea.waitFor({ state: 'attached', timeout: 10000 });
      await terminalTextarea.focus();
      await pressAndHold(page);
      await release(page);
      await expect
        .poll(() => page.evaluate(() => window.electronAPI.dictation.__submits.length), { timeout: 10000 })
        .toBe(1);

      // THE REGRESSION. The note input cannot corrupt a PTY's bracketed paste,
      // so a paste into the terminal is none of its business.
      await page.locator('[data-testid="browser-note-input"]').click();
      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');
      await release(page);

      await page.evaluate(() => window.electronAPI.dictation.__releaseSubmit());
    } finally {
      await page.context().close();
    }
  });

  test('a press into the SAME terminal is refused in WORDS, not silently', async () => {
    // Where the guard is legitimate, it still has to say so. A button that does
    // nothing for two seconds reads as broken, not as busy.
    const page = await launch({ autoSubmit: true });
    try {
      await openBrowserPane(page);
      await page.evaluate(() => window.electronAPI.dictation.__blockSubmit());

      const terminalTextarea = page.locator('[data-testid="task-detail-dialog"] .xterm-helper-textarea').first();
      await terminalTextarea.waitFor({ state: 'attached', timeout: 10000 });
      await terminalTextarea.focus();
      await pressAndHold(page);
      await release(page);
      await expect
        .poll(() => page.evaluate(() => window.electronAPI.dictation.__submits.length), { timeout: 10000 })
        .toBe(1);

      await terminalTextarea.focus();
      await holdOnly(page);
      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('busy');
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('Still sending the last one');
      // No second capture was started, so nothing was recorded into the paste.
      expect(await page.evaluate(() => window.electronAPI.dictation.__startCalls.length)).toBe(1);
      await release(page);

      // And it clears itself, because no release will ever end a refusal.
      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('idle');
      await page.evaluate(() => window.electronAPI.dictation.__releaseSubmit());
    } finally {
      await page.context().close();
    }
  });

  test('works in an ORDINARY app field that nothing opted in - the board search box', async () => {
    // The whole point of allow-by-default. This field is nowhere near the
    // Browser pane, carries no marker, and nobody wired it up: dictation works
    // there because the user can type there. Under the original opt-in rule it
    // silently did nothing, which is the failure mode that made the marker the
    // wrong default.
    const page = await launch({ autoSubmit: false });
    try {
      const search = page.locator('input[placeholder="Search board..."]');
      await search.click();

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');

      await emitPartial(page, PARTIAL_RAW);
      await expect(search).toHaveValue(PARTIAL_SHOWN);

      await release(page);
      await expect(search).toHaveValue(FINAL_TRANSCRIPT);
      // Still nothing routed to a PTY, even with running sessions on the board.
      expect(await liveWritePayloads(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('a MULTI-FIELD form never auto-submits, even with the setting on', async () => {
    // Auto-submit means pressing Enter, and in a multi-field form Enter commits
    // EVERY field. Dictating a title into the New Task dialog would otherwise
    // create the task the instant the user let go of the key, with the rest of
    // the form still empty. The text still lands; only the commit is withheld.
    const page = await launch({ autoSubmit: true });
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="swimlane-add-task"]').first().click();
      const dialog = page.locator('[data-testid="new-task-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 10000 });

      const title = dialog.locator('input[type="text"]').first();
      await title.click();

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');
      // The chip must not promise a send it will refuse to perform.
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Release to insert', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toHaveCount(0);

      await emitPartial(page, PARTIAL_RAW);
      await expect(title).toHaveValue(PARTIAL_SHOWN);

      await release(page);

      // The transcript landed...
      await expect(title).toHaveValue(FINAL_TRANSCRIPT);
      // ...and the dialog is still open, because Enter was never pressed. A
      // fixed budget, not a poll: this is a non-occurrence.
      await page.waitForTimeout(600);
      await expect(dialog).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  /**
   * The guest mouse-button channel.
   *
   * A Browser pane's guest is an out-of-process frame and consumes the mouse
   * outright: measured on a live guest, one real back-button press produced 31
   * events inside the page and ZERO on the host window. So while the page has
   * focus there is NO DOM event to simulate - push-to-talk and back-navigation
   * both live on that button and both were simply dead there. Main forwards the
   * presses over `browser:guestMouseButton` instead, and these drive that push
   * directly because it is the only path that exists.
   *
   * `at` is supplied explicitly so a hold can be modelled without waiting: it is
   * MAIN's clock, and the renderer measures tap-vs-hold from it precisely
   * because its own clock is congested by the work a press starts.
   */
  test('a guest HOLD on the back button starts dictation and does not navigate', async () => {
    const page = await launch({ autoSubmit: false, hotkey: 'Mouse:Back' });
    try {
      await openBrowserPane(page);
      // Navigable in both directions, so a bug that mis-fired the tap path on
      // a hold would have somewhere real to go rather than silently no-op'ing
      // against a stub that always refuses.
      await setGuestNavigable(page, true, true);
      // The pane must be the active navigation target, or a tap would have
      // nowhere to go and the hold/tap distinction would be untestable.
      await page.locator('[data-testid="browser-note-input"]').click();

      const pressedAt = Date.now();
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', at);
      }, pressedAt);

      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('recording');

      // Release well past the tap threshold: a hold dictates, never navigates.
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', at);
      }, pressedAt + 1500);

      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('idle');
      // The EFFECT, not just the end status: `status === 'idle'` is also what
      // a plain `finalizeOnRelease()` lands on, so without this a hold and a
      // tap are indistinguishable from here - the whole point of the split.
      expect(await navigationCalls(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('a guest TAP on the back button never leaves dictation recording', async () => {
    // The tap is the navigation gesture. What matters here is the half that is
    // observable without a real guest history: the optimistically-started
    // dictation is cancelled rather than left holding the microphone open.
    const page = await launch({ autoSubmit: false, hotkey: 'Mouse:Back' });
    try {
      await openBrowserPane(page);
      await setGuestNavigable(page, true, true);
      await page.locator('[data-testid="browser-note-input"]').click();

      const pressedAt = Date.now();
      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', at);
      }, pressedAt);
      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('recording');

      await page.evaluate((at) => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', at);
      }, pressedAt + 40);

      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('idle');
      // The EFFECT of the tap: it actually navigated, exactly once. Before
      // the webview's navigation methods were stubbed, `canGoBack()` always
      // threw into the pane's try/catch and returned false, so this call
      // never fired and a deleted tap-navigates feature would have left this
      // test (and the HOLD test above) equally green.
      expect(await navigationCalls(page)).toEqual(['goBack']);
    } finally {
      await page.context().close();
    }
  });

  test('a guest release with no matching press cannot strand the microphone', async () => {
    // Main synthesises a release from `mouseLeave`, because a press whose
    // pointer left the webview reported its DOWN and never an UP - measured on a
    // live guest. Without that, dictation would record forever. An unmatched
    // release must therefore be harmless rather than throwing or hanging.
    const page = await launch({ autoSubmit: false, hotkey: 'Mouse:Back' });
    try {
      await openBrowserPane(page);
      await page.evaluate(() => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'up', Date.now());
      });
      await page.waitForTimeout(400);
      expect(await dictationStatus(page)).toBe('idle');
    } finally {
      await page.context().close();
    }
  });

  test('a guest back press is IGNORED when push-to-talk is bound to a key', async () => {
    // The gate that keeps the button honest: someone who rebound dictation to a
    // keyboard combo must not have the back button start recording at them. This
    // page uses the file's default keyboard binding, so the same push that
    // starts dictation above must do nothing here.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      await page.evaluate(() => {
        window.__mockBrowser?.emitGuestMouseButton(4242, 'back', 'down', Date.now());
      });
      // A fixed budget, not a poll: this asserts a non-occurrence.
      await page.waitForTimeout(600);
      expect(await dictationStatus(page)).toBe('idle');
    } finally {
      await page.context().close();
    }
  });

  test('rebinding push-to-talk to Mouse:Forward starts dictation without also navigating', async () => {
    // Pins a fix in useDictation.ts. `Mouse:Forward` is a first-class
    // rebindable token, and the window-level `onForward` pointerdown listener
    // and useKeybinding's press handler both sit on `window` in the capture
    // phase, where `stopPropagation` does not stop a sibling listener on the
    // SAME node - so before the `boundToMouseForward` gate was added, a user
    // who rebound push-to-talk to Forward got BOTH on every press: dictation
    // started AND the pane navigated forward out from under it.
    //
    // No release is dispatched here on purpose: the bug is a PRESS-time
    // double-fire, and a release would additionally exercise the legitimate
    // tap-navigate mechanism (covered by the guest HOLD/TAP tests above),
    // which calls `goForward` through a different, correct path and would
    // defeat this assertion.
    const page = await launch({ autoSubmit: false, hotkey: 'Mouse:Forward' });
    try {
      await openBrowserPane(page);
      await setGuestNavigable(page, false, true);
      // The pane must be the active navigation target, or the old bug's
      // `goForward` call would have had nowhere to land and this would pass
      // for the wrong reason.
      await page.locator('[data-testid="browser-note-input"]').click();

      // Dispatched on `document.body`, not `window`, so `event.target` is a
      // real Node - both window-level listeners see it either way, since the
      // CAPTURE phase always travels window-down-to-target regardless of
      // `bubbles`, but an event targeted at `window` itself makes an
      // unrelated capture-phase `when` predicate elsewhere in the app throw
      // on `.contains(window)`, which a real mouse press could never do.
      await page.evaluate(() => {
        document.body.dispatchEvent(new PointerEvent('pointerdown', {
          button: 4,
          buttons: 16,
          bubbles: true,
          cancelable: true,
        }));
      });

      // Positive control: the press was recognized as push-to-talk at all, so
      // a dispatch that was silently swallowed could not make this pass for
      // free.
      await expect.poll(() => dictationStatus(page), { timeout: 10000 }).toBe('recording');
      expect(await navigationCalls(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('dictates into a CONTENTEDITABLE, replacing revisions in place', async () => {
    // Rich-text hosts take a different write route entirely: no `.value`, so the
    // native-setter trick does nothing and the text goes in via Selection +
    // `execCommand('insertText')` - the route a real keystroke takes, which is
    // what makes it fire real input events and land in the undo stack. None of
    // that is unit-testable, so it is pinned here against a real one.
    //
    // Kangentic renders no contenteditable today (checked: every occurrence in
    // the renderer is a defensive selector list), so the surface that matters is
    // a rich-text editor inside someone's dev page. One is injected here rather
    // than pretending an app surface exists.
    const page = await launch({ autoSubmit: true });
    try {
      await page.evaluate(() => {
        const editor = document.createElement('div');
        editor.id = 'rich-text-probe';
        editor.contentEditable = 'true';
        editor.textContent = '';
        Object.assign(editor.style, {
          position: 'fixed', top: '200px', left: '200px',
          width: '400px', height: '80px', border: '1px solid #444',
        });
        document.body.appendChild(editor);
        editor.focus();
        // Put the caret inside it, which is what a real click would do.
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');

      const read = () => page.evaluate(
        () => document.getElementById('rich-text-probe')?.textContent ?? '',
      );

      await emitPartial(page, 'FIX');
      await expect.poll(read, { timeout: 5000 }).toBe('Fix');
      // The revision must REPLACE, not stack - the whole reason the sink tracks
      // how much it last inserted.
      await emitPartial(page, PARTIAL_RAW);
      await expect.poll(read, { timeout: 5000 }).toBe(PARTIAL_SHOWN);

      await release(page);
      await expect.poll(read, { timeout: 5000 }).toBe(FINAL_TRANSCRIPT);

      // Auto-submit is ON, but Enter in a rich-text editor is a NEWLINE rather
      // than a commit, so it is deliberately never pressed: the text must be
      // exactly the transcript, with no trailing break.
      expect(await read()).toBe(FINAL_TRANSCRIPT);
    } finally {
      await page.context().close();
    }
  });

  test('the chip reports an input target as a real target, not as "no target"', async () => {
    // `noTarget` used to be `!targetSessionId`, and an input target has no
    // session behind it - so without the kind, dictating into the note input
    // would have shown "no target" while the words were visibly landing.
    const page = await launch({ autoSubmit: true });
    try {
      await openBrowserPane(page);
      await page.locator('[data-testid="browser-note-input"]').click();
      await pressAndHold(page);
      // Assert the kind explicitly: a terminal target ALSO reads "Listening",
      // so without this the copy assertions below would pass even if the note
      // input had never won the resolve.
      expect(await dictationTargetKind(page)).toBe('input');

      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Listening', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toBeVisible();
      await expect(chip.locator('[data-testid="dictation-recording-dot"]'))
        .toHaveAttribute('data-tone', 'active');

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  /**
   * Dictating into a field INSIDE the guest page.
   *
   * Before the webview stub dispatched on the script it received (it always
   * returned '' for every call, including the probe), `probeGuestField`
   * resolved to `''`, so `guestProbe?.eligible` was always falsy and
   * `createDictationSink`'s guest branch was NEVER constructed - the whole
   * guest-field path, including the password refusal, was unreachable from
   * any test.
   */
  test('a guest field WRITES the transcript via executeJavaScript, and nothing reaches a PTY', async () => {
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      await setGuestProbeResult(page, {
        eligible: true,
        reason: 'ok',
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        richText: false,
        rect: { left: 40, top: 40, width: 200, height: 24 },
      });
      await focusGuestWebview(page);

      await pressAndHold(page);
      // Reports as 'input', same as the host-side case: the chip only asks
      // "is there somewhere to type", and a guest field answers yes. The sink
      // built underneath still holds the real (guest) target.
      expect(await dictationTargetKind(page)).toBe('input');

      await emitPartial(page, PARTIAL_RAW);
      await expect.poll(() => guestWriteScripts(page), { timeout: 5000 }).toHaveLength(1);
      expect((await guestWriteScripts(page))[0]).toContain(JSON.stringify(PARTIAL_SHOWN));
      expect(await liveWritePayloads(page)).toEqual([]);

      await release(page);
      await expect.poll(() => guestWriteScripts(page), { timeout: 5000 }).toHaveLength(2);
      expect((await guestWriteScripts(page))[1]).toContain(JSON.stringify(FINAL_TRANSCRIPT));
      expect(await liveWritePayloads(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('a guest PASSWORD field refuses in words, and nothing is written or sent to a PTY', async () => {
    // The security-relevant case: dictation's Cloud engine POSTs raw audio to
    // a configured endpoint, so a refusal regression here would route a
    // spoken password into a page - or, falling through silently, into a
    // terminal shell instead.
    const page = await launch({ autoSubmit: false });
    try {
      await openBrowserPane(page);
      await setGuestProbeResult(page, {
        eligible: false,
        reason: 'password',
        rect: { left: 40, top: 40, width: 200, height: 24 },
      });
      await focusGuestWebview(page);

      await pressAndHold(page);
      // No target: a refused guest field resolves to null, exactly like a
      // structural "nothing focused" - except the reason travels with it, so
      // the chip can say what actually happened.
      expect(await dictationTargetKind(page)).toBe(null);

      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip.getByText('Dictation is off in password fields', { exact: true })).toBeVisible();

      await emitPartial(page, PARTIAL_RAW);
      // A fixed budget, not a poll: a refusal has no target to write into, so
      // there is nothing that becomes true to poll for.
      await page.waitForTimeout(500);
      expect(await guestWriteScripts(page)).toEqual([]);
      expect(await liveWritePayloads(page)).toEqual([]);

      await release(page);
    } finally {
      await page.context().close();
    }
  });

  test('release with auto-submit ON only FILLS a guest field - it never submits', async () => {
    // DICTATION NEVER SUBMITS IN A GUEST (see the header of
    // guest-text-target.ts and decision 24 in docs/embedded-browser.md):
    // pressing Enter in someone else's page commits a form we know nothing
    // about. `createGuestSink`'s `submit` does not even read its `autoSubmit`
    // argument, so the call sequence [probe, write, write] must hold exactly
    // however release finalizes - a submit/Enter path would add a fourth
    // `executeJavaScript` call, which the exact-length assertions below would
    // catch regardless of what that call's script looked like.
    const page = await launch({ autoSubmit: true });
    try {
      await openBrowserPane(page);
      await setGuestProbeResult(page, {
        eligible: true,
        reason: 'ok',
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        richText: false,
        rect: { left: 40, top: 40, width: 200, height: 24 },
      });
      await focusGuestWebview(page);

      await pressAndHold(page);
      expect(await dictationTargetKind(page)).toBe('input');
      // The chip must not promise a send it will refuse to perform.
      const chip = page.locator('[data-testid="dictation-live-chip"]');
      await expect(chip.getByText('Release to insert', { exact: true })).toBeVisible();
      await expect(chip.getByText('Release to send', { exact: true })).toHaveCount(0);

      await emitPartial(page, PARTIAL_RAW);
      // probe (1) + the partial's write (1).
      await expect.poll(() => guestExecuteJavaScriptCalls(page), { timeout: 5000 }).toHaveLength(2);

      await release(page);
      // + the final write on release. No fourth call, whatever it would be.
      await expect.poll(() => guestExecuteJavaScriptCalls(page), { timeout: 5000 }).toHaveLength(3);
      const calls = await guestExecuteJavaScriptCalls(page);
      expect(calls[2]).toContain(JSON.stringify(FINAL_TRANSCRIPT));
      expect(await liveWritePayloads(page)).toEqual([]);
      expect(await captureCalls(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
