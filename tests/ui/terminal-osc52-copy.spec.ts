/**
 * UI tests for the OSC 52 clipboard copy path in enableTerminalClipboard.
 *
 * Claude Code's TUI copies a mouse selection by emitting an OSC 52 sequence
 * (ESC]52;c;<base64>BEL) into the terminal. useTerminal registers a write-only
 * OSC 52 handler that decodes the payload and routes it to the focus-independent
 * main-process clipboard write (window.electronAPI.clipboard.writeText).
 *
 * These tests drive a real mounted xterm (the command bar overlay) and push live
 * PTY data through window.__mockFireSessionData, proving end-to-end that:
 *   1. an OSC 52 write reaches clipboard.writeText with the decoded text,
 *   2. an OSC 52 READ request (Pd '?') is ignored (never writes the clipboard),
 *   3. an OSC 52 sequence embedded in replayed scrollback is stripped and does
 *      NOT clobber the live clipboard on restore.
 *
 * The pure decode/strip helpers and the handler registration are unit-tested in
 * tests/unit/terminal-clipboard-osc52.test.ts; these tests cover the live wiring.
 *
 * A mouse-drag selection + Ctrl+C copy path is intentionally NOT covered here:
 * xterm's selection lives in its own buffer and cannot be created deterministically
 * from outside under headless Linux. The unit registration test plus test 1 below
 * carry that branch's coverage.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own page/goto, so the file can fan out across UI workers.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-osc52-copy-test';
const TRANSIENT_SESSION_ID = 'sess-osc52-copy-1';

function basePreConfigScript(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'OSC 52 Copy Test Project',
        path: '/mock/osc52-copy-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-osc52-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** Deterministic transient session so onData fires route to a known id. */
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
        cwd: '/mock/osc52-copy-test',
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
  await page.addInitScript(basePreConfigScript());
  await page.addInitScript(extraScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function openCommandBarWithTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toBeVisible();

  await page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: { getState: () => { markFirstOutput: (id: string) => void } };
      };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(sessionId);
  }, TRANSIENT_SESSION_ID);

  await expect(
    page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first()
  ).toBeAttached({ timeout: 8000 });

  await page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').focus();
}

/** Build an OSC 52 write sequence (ESC]52;c;<base64(text)>BEL). */
function osc52Write(text: string): string {
  // btoa runs in the page; here we build the base64 in Node for the injected literal.
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${base64}\x07`;
}

test.describe('terminal OSC 52 copy', () => {
  test('an OSC 52 write reaches clipboard.writeText with the decoded text', async () => {
    const { browser, page } = await launchWithState(deterministicSpawnScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openCommandBarWithTerminal(page);

      await page.evaluate(() => {
        window.electronAPI.clipboard.__writeTextCalls.length = 0;
      });

      // Poll-fire the OSC write: any fire that lands during the brief scrollback
      // replay window is dropped, so re-fire each iteration until one lands after
      // the terminal is live. All landed fires carry the same value.
      const sequence = osc52Write('copied-via-osc52');
      await expect.poll(async () => {
        return page.evaluate(({ sessionId, seq }) => {
          window.__mockFireSessionData(sessionId, seq);
          return window.electronAPI.clipboard.__writeTextCalls.length;
        }, { sessionId: TRANSIENT_SESSION_ID, seq: sequence });
      }, { timeout: 5000 }).toBeGreaterThan(0);

      const calls = await page.evaluate(() => window.electronAPI.clipboard.__writeTextCalls as string[]);
      expect(calls.length).toBeGreaterThan(0);
      for (const value of calls) expect(value).toBe('copied-via-osc52');
    } finally {
      await browser.close();
    }
  });

  test('an OSC 52 read request is ignored (never writes the clipboard)', async () => {
    const { browser, page } = await launchWithState(deterministicSpawnScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openCommandBarWithTerminal(page);

      // Establish that live OSC data flows and the terminal is past its replay
      // window: poll-fire a real write until it lands.
      const writeSeq = osc52Write('readiness-probe');
      await expect.poll(async () => {
        return page.evaluate(({ sessionId, seq }) => {
          window.__mockFireSessionData(sessionId, seq);
          return window.electronAPI.clipboard.__writeTextCalls.length;
        }, { sessionId: TRANSIENT_SESSION_ID, seq: writeSeq });
      }, { timeout: 5000 }).toBeGreaterThan(0);

      // Now clear the log and fire a READ request; it must NOT write the clipboard.
      await page.evaluate(() => {
        window.electronAPI.clipboard.__writeTextCalls.length = 0;
      });
      await page.evaluate((sessionId) => {
        window.__mockFireSessionData(sessionId, '\x1b]52;c;?\x07');
      }, TRANSIENT_SESSION_ID);

      // Intentional fixed wait - cannot poll for non-occurrence.
      await page.waitForTimeout(800);

      const count = await page.evaluate(() => window.electronAPI.clipboard.__writeTextCalls.length);
      expect(count).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('an OSC 52 sequence in replayed scrollback does not clobber the clipboard', async () => {
    // getScrollback returns recorded output that CONTAINS an OSC 52 sequence, as it
    // would after a session that copied text. The replay path must strip it so the
    // user's live clipboard is untouched on restore.
    const replayScript = `
      ${deterministicSpawnScript}
      window.electronAPI.sessions.getScrollback = async function () {
        var raw = 'before-marker \\x1b]52;c;' + btoa('should-not-copy') + '\\x07 after-marker';
        return raw;
      };
    `;
    const { browser, page } = await launchWithState(replayScript);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        window.electronAPI.clipboard.__writeTextCalls.length = 0;
      });

      await openCommandBarWithTerminal(page);

      // Prove the OSC pipeline is live and replay has completed: poll-fire a real
      // OSC write and wait for it to land. If the strip had failed, the replayed
      // 'should-not-copy' would already be in the log by now.
      const writeSeq = osc52Write('live-after-replay');
      await expect.poll(async () => {
        return page.evaluate(({ sessionId, seq }) => {
          window.__mockFireSessionData(sessionId, seq);
          return window.electronAPI.clipboard.__writeTextCalls.length;
        }, { sessionId: TRANSIENT_SESSION_ID, seq: writeSeq });
      }, { timeout: 5000 }).toBeGreaterThan(0);

      const calls = await page.evaluate(() => window.electronAPI.clipboard.__writeTextCalls as string[]);
      // The live write landed, but the replayed OSC 52 was stripped.
      expect(calls).toContain('live-after-replay');
      expect(calls).not.toContain('should-not-copy');
    } finally {
      await browser.close();
    }
  });
});
