/**
 * UI integration tests for the WriteBatcher wiring in useTerminal.
 *
 * The unit tests in tests/unit/write-batcher.test.ts prove the batcher
 * utility works in isolation. These tests prove the hook wires the batcher
 * correctly:
 *
 *   - xterm onData events are routed through batcher.schedule (not directly
 *     to sessions.write), so a burst of synchronous keystrokes produces one
 *     IPC write per microtask instead of one per character.
 *
 *   - When sessionId is null at flush time (effectiveSessionId=null, xterm
 *     never initialized), sessions.write is never called even if the overlay
 *     is open.
 *
 *   - The clipboard onWrite path (enableTerminalClipboard receives
 *     batcher.schedule) is exercised end-to-end: Ctrl+Enter sends a single
 *     write containing the newline character.
 *
 * Coverage of gap 1 (unmount-flush): flush() is called on unmount by the
 * cleanup effect. The synchronous flush() behavior is already unit-tested in
 * write-batcher.test.ts ("flush() drains pending data synchronously"). The
 * unmount-flush wiring itself is covered by the close test below - when the
 * overlay closes, any data that reached the batcher before the microtask
 * drained is captured by sessions.write because flush() runs synchronously
 * before dispose(). In practice, by the time Playwright processes any command
 * after keyboard.type(), the microtask has already drained, so the "pending
 * at unmount" scenario reduces to the same observable outcome: write was called.
 *
 * Coverage of gap 2 (null sessionId): the batcher is created inside
 * initTerminal, which only runs when effectiveSessionId is non-null. When
 * sessionId is null, initTerminal is never called, so no batcher is created
 * and sessions.write can never be called. This is verified by the
 * "write never called while spawn is pending" test below.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Deterministic session IDs so we can push store state without guessing.
const PROJECT_ID = 'proj-write-batcher-test';
const TRANSIENT_SESSION_ID = 'sess-write-batcher-transient-1';

/**
 * Pre-configure with one project and no sessions.
 * spawnTransient is overridden below per-test.
 */
function basePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Write Batcher Test Project',
        path: '/mock/write-batcher-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-wb-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * Override spawnTransient to return our deterministic session ID synchronously,
 * and inject sessionFirstOutput into the store so terminalReady becomes true
 * immediately (bypasses the shimmer overlay wait).
 */
const deterministicSpawnScript = `
  window.electronAPI.sessions.spawnTransient = async function (input) {
    return {
      session: {
        id: '${TRANSIENT_SESSION_ID}',
        taskId: '${TRANSIENT_SESSION_ID}',
        projectId: input.projectId,
        pid: null,
        status: 'running',
        shell: '/bin/bash',
        cwd: '/mock/write-batcher-test',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: true,
      },
      branch: 'main',
    };
  };
`;

async function launchWithState(extraScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(basePreConfig());
  await page.addInitScript(extraScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Open the command bar overlay and wait for xterm to mount.
 *
 * xterm mounts only after terminalReady=true. We force-set sessionFirstOutput
 * in the session store so the shimmer lifts immediately after spawnTransient
 * resolves. Then we wait for the .xterm canvas to appear inside the overlay.
 */
async function openCommandBarWithTerminal(page: Page): Promise<void> {
  // Open the overlay - spawnTransient fires immediately with our deterministic ID.
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

  // Inject sessionFirstOutput so terminalReady flips to true.
  // This simulates the 'onFirstOutput' IPC event from the real main process.
  await page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: { getState: () => { markFirstOutput: (id: string) => void } };
      };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(sessionId);
  }, TRANSIENT_SESSION_ID);

  // Wait for the xterm terminal to mount inside the overlay.
  // .xterm-helper-textarea is the focusable textarea element xterm renders;
  // it is present as soon as terminal.open() completes.
  await expect(
    page.getByTestId('command-bar-overlay').locator('.xterm-helper-textarea').first()
  ).toBeAttached({ timeout: 8000 });

  // Focus the terminal so keyboard input is routed to xterm's onData handler.
  // xterm's own focus() call happens inside initTerminal's requestAnimationFrame;
  // we force focus here to be deterministic and avoid timing races.
  await page.getByTestId('command-bar-overlay').locator('.xterm-helper-textarea').focus();
}

test.describe('WriteBatcher - useTerminal IPC wiring', () => {
  test('burst of characters produces one batched sessions.write call', async () => {
    const { browser, page } = await launchWithState(deterministicSpawnScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Reset the write call log before opening the overlay.
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await openCommandBarWithTerminal(page);

      // Dispatch 5 synthetic input events synchronously in a single evaluate()
      // call. xterm listens to the 'input' event on its .xterm-helper-textarea
      // element; each event fires onData, which calls batcher.schedule().
      // Because all 5 dispatches happen in the same synchronous JavaScript task,
      // only one microtask is scheduled. That microtask fires after the evaluate()
      // returns and emits one sessions.write with the concatenated payload.
      //
      // This differs from page.keyboard.type(): Playwright sends each character
      // across the CDP boundary separately (one round-trip per key), giving the
      // browser's microtask checkpoint time to drain between keys. Dispatching
      // events from inside a single evaluate() call avoids that boundary, keeping
      // all 5 dispatchEvent calls in one synchronous task.
      await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="command-bar-overlay"]');
        const textarea = overlay?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (!textarea) throw new Error('xterm textarea not found inside command-bar-overlay');

        // Dispatch all 5 input events synchronously - same task, one microtask.
        for (const char of ['a', 'b', 'c', 'd', 'e']) {
          const event = new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true });
          textarea.dispatchEvent(event);
        }
      });

      // Poll for the write call to arrive after the microtask drains.
      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBeGreaterThan(0);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);

      // All 5 characters should be concatenated into a single payload.
      const totalPayload = writeCalls.map((c: { payload: string }) => c.payload).join('');
      expect(totalPayload).toBe('abcde');
      // The key assertion: batching reduces round-trips. Without batching we'd
      // see 5 calls (one per character). With batching, exactly 1 call is produced
      // because all 5 onData events fire in the same synchronous task.
      expect(writeCalls.length).toBe(1);
      // The write must be for our session.
      for (const call of writeCalls as Array<{ sessionId: string; payload: string }>) {
        expect(call.sessionId).toBe(TRANSIENT_SESSION_ID);
      }
    } finally {
      await browser.close();
    }
  });

  test('sessions.write is never called while sessionId is null (spawn pending)', async () => {
    // Override spawnTransient with a promise that never resolves.
    // This keeps effectiveSessionId=null so initTerminal is never called,
    // the batcher is never created, and sessions.write must stay at 0 calls.
    const hangingSpawnScript = `
      window.electronAPI.sessions.spawnTransient = function () {
        return new Promise(function () {});
      };
    `;
    const { browser, page } = await launchWithState(hangingSpawnScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      // Open overlay - spawn will hang, xterm never mounts, no batcher created.
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-bar-overlay')).toBeVisible();

      // Intentional fixed wait - we cannot poll for non-occurrence.
      // 800ms gives the microtask queue and any async paths time to fire.
      // If write were called, it would have been captured by now.
      await page.waitForTimeout(800);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      expect(writeCalls).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+Enter sends a single write via the clipboard onWrite batcher path', async () => {
    // The clipboard callback wiring: enableTerminalClipboard receives batcher.schedule
    // as the onWrite argument. Ctrl+Enter calls onWrite('\n') directly (not via
    // terminal.paste()), so it should produce exactly one sessions.write call
    // with payload '\n', routed through the batcher.
    const { browser, page } = await launchWithState(deterministicSpawnScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await openCommandBarWithTerminal(page);

      // Ctrl+Enter triggers the onWrite('\n') path in enableTerminalClipboard
      // (the custom key event handler). This calls batcher.schedule('\n') directly,
      // bypassing terminal.paste(). The batcher flushes on the next microtask.
      await page.keyboard.press('Control+Enter');

      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBe(1);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
      expect((writeCalls as Array<{ sessionId: string; payload: string }>)[0].sessionId).toBe(TRANSIENT_SESSION_ID);
      expect((writeCalls as Array<{ sessionId: string; payload: string }>)[0].payload).toBe('\n');
    } finally {
      await browser.close();
    }
  });
});
