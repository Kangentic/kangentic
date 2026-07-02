/**
 * UI tests for copying special terminal blocks (quote / code) without CLI
 * decoration. Drives a real mounted xterm in the command-bar terminal:
 *
 *   1. The renderer hit-test global (`window.__kangenticTerminalBlockHitTest`)
 *      reports the correct block kind under a point (used by the main-process
 *      context-menu probe).
 *   2. Dispatching the `terminal-copy-block` CustomEvent (as the native "Copy
 *      Block" menu item does) copies the block's clean content to the clipboard.
 *   3. The hover copy button appears over a block and copies clean content.
 *
 * The block content is written into xterm via the scrollback-replay path
 * (getScrollback override), the same mechanism used when a background session's
 * terminal is rebuilt. navigator.clipboard.writeText is stubbed into a recorder.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';
import { TERMINAL_BLOCK_FIXTURE, QUOTE_LINES, BOX_LINES } from './fixtures/terminal-block-fixture';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-block-copy-test';
const TRANSIENT_SESSION_ID = 'sess-block-copy-1';

function basePreConfigScript(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Block Copy Test Project',
        path: '/mock/block-copy-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-bc-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

// Deterministic transient spawn + getScrollback returning the block fixture +
// a clipboard recorder. The fixture is painted into xterm by useTerminal's
// scrollback replay once the command terminal resolves its session id.
const setupScript = `
  window.__clipboardWrites = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: function (text) { window.__clipboardWrites.push(String(text)); return Promise.resolve(); },
        readText: function () { return Promise.resolve(''); },
      },
    });
  } catch (err) { /* clipboard already locked; test will surface it */ }

  // The context-menu copy-block path writes via the focus-independent main-process
  // clipboard (Menu.popup steals document focus, so navigator.clipboard rejects).
  // Record both into the same recorder.
  window.electronAPI.clipboard.writeText = function (text) { window.__clipboardWrites.push(String(text)); return Promise.resolve(); };

  window.electronAPI.sessions.spawnTransient = async function (input) {
    return {
      session: {
        id: '${TRANSIENT_SESSION_ID}',
        taskId: '${TRANSIENT_SESSION_ID}',
        projectId: input.projectId,
        pid: null,
        status: 'running',
        shell: '/bin/bash',
        cwd: '/mock/block-copy-test',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: true,
      },
      branch: 'main',
    };
  };

  window.electronAPI.sessions.getScrollback = async function () {
    return ${JSON.stringify(TERMINAL_BLOCK_FIXTURE)};
  };
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(basePreConfigScript());
  await page.addInitScript(setupScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

async function openTerminalWithFixture(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toBeVisible();

  // Flip terminalReady so the command terminal resolves its session id and
  // useTerminal replays the (overridden) scrollback fixture into xterm.
  await page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(sessionId);
  }, TRANSIENT_SESSION_ID);

  await expect(
    page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first(),
  ).toBeAttached({ timeout: 8000 });
}

/**
 * Sweep vertical points down the terminal screen and return, for each block
 * kind, a client point that lands on it. Polls until the fixture has painted
 * (a quote point is found), proving both the replay and detection work.
 */
async function findBlockPoints(page: Page): Promise<{ quote: { x: number; y: number } | null; box: { x: number; y: number } | null }> {
  return await page.evaluate(() => {
    const screen = document.querySelector('[data-testid="command-terminal-window"] .xterm-screen');
    if (!screen) return { quote: null, box: null };
    const rect = screen.getBoundingClientRect();
    const hitTest = window.__kangenticTerminalBlockHitTest;
    if (!hitTest) return { quote: null, box: null };
    const x = Math.round(rect.left + rect.width * 0.3);
    let quote: { x: number; y: number } | null = null;
    let box: { x: number; y: number } | null = null;
    for (let i = 1; i < 60; i += 1) {
      const y = Math.round(rect.top + (rect.height * i) / 60);
      const result = hitTest(x, y);
      if (!quote && result.blockKind === 'quote') quote = { x, y };
      if (!box && result.blockKind === 'box') box = { x, y };
    }
    return { quote, box };
  });
}

test.describe('terminal block copy', () => {
  test('hit-test reports quote and box block kinds, and dispatch copies clean content', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminalWithFixture(page);

      // Poll until the fixture has painted and both blocks are detectable.
      let points: Awaited<ReturnType<typeof findBlockPoints>> = { quote: null, box: null };
      await expect.poll(async () => {
        points = await findBlockPoints(page);
        return Boolean(points.quote && points.box);
      }, { timeout: 8000 }).toBe(true);

      // The intro line is plain prose - now a copyable 'text' block.
      const introResult = await page.evaluate(() => {
        const screen = document.querySelector('[data-testid="command-terminal-window"] .xterm-screen');
        const rect = screen!.getBoundingClientRect();
        return window.__kangenticTerminalBlockHitTest!(Math.round(rect.left + rect.width * 0.3), Math.round(rect.top + 2));
      });
      expect(introResult.isTerminal).toBe(true);
      expect(introResult.blockKind).toBe('text');

      // Copying the intro text block yields its prose.
      const introPoint = await page.evaluate(() => {
        const screen = document.querySelector('[data-testid="command-terminal-window"] .xterm-screen');
        const rect = screen!.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width * 0.3), y: Math.round(rect.top + 2) };
      });
      await page.evaluate((pt) => {
        window.dispatchEvent(new CustomEvent('terminal-copy-block', { detail: pt }));
      }, introPoint);
      await expect.poll(async () => {
        return page.evaluate(() => window.__clipboardWrites as string[]);
      }, { timeout: 3000 }).toContain('Normal intro line');

      // Dispatch the copy-block action at the quote point (as the menu item does).
      await page.evaluate((pt) => {
        window.dispatchEvent(new CustomEvent('terminal-copy-block', { detail: pt }));
      }, points.quote!);

      await expect.poll(async () => {
        return page.evaluate(() => window.__clipboardWrites as string[]);
      }, { timeout: 3000 }).toContain(QUOTE_LINES.join('\n'));

      // And at the box point.
      await page.evaluate((pt) => {
        window.dispatchEvent(new CustomEvent('terminal-copy-block', { detail: pt }));
      }, points.box!);

      await expect.poll(async () => {
        return page.evaluate(() => window.__clipboardWrites as string[]);
      }, { timeout: 3000 }).toContain(BOX_LINES.join('\n'));

      // The copied text carries no CLI decoration.
      const writes = await page.evaluate(() => window.__clipboardWrites as string[]);
      expect(writes.some((w) => w.includes('▎'))).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('hover shows the copy button and clicking it copies clean block content', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminalWithFixture(page);

      let points: Awaited<ReturnType<typeof findBlockPoints>> = { quote: null, box: null };
      await expect.poll(async () => {
        points = await findBlockPoints(page);
        return Boolean(points.quote);
      }, { timeout: 8000 }).toBe(true);

      // Move the pointer over the quote block; the highlight and copy button appear.
      await page.mouse.move(points.quote!.x, points.quote!.y, { steps: 5 });
      const button = page.getByTestId('terminal-block-copy-button');
      const highlight = page.getByTestId('terminal-block-copy-highlight');
      await expect(button).toBeVisible({ timeout: 3000 });
      await expect(highlight).toBeVisible({ timeout: 3000 });

      await page.evaluate(() => { window.__clipboardWrites = []; });
      await button.click();

      await expect.poll(async () => {
        return page.evaluate(() => window.__clipboardWrites as string[]);
      }, { timeout: 3000 }).toContain(QUOTE_LINES.join('\n'));

      // Moving the pointer to a blank row (below the fixture content) hides the
      // button and highlight. The move stays INSIDE the terminal, so mousemove
      // fires reliably on every platform (exiting the element does not on the CI
      // Linux runner); a blank row has no block, so handleMove hides it.
      const blankPoint = await page.evaluate(() => {
        const screen = document.querySelector('[data-testid="command-terminal-window"] .xterm-screen');
        const rect = screen!.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width * 0.3);
        for (let i = 59; i >= 1; i -= 1) {
          const y = Math.round(rect.top + (rect.height * i) / 60);
          const result = window.__kangenticTerminalBlockHitTest!(x, y);
          if (result.isTerminal && result.blockKind === null) return { x, y };
        }
        return null;
      });
      expect(blankPoint).not.toBeNull();
      await page.mouse.move(blankPoint!.x, blankPoint!.y, { steps: 10 });
      await expect(button).toBeHidden({ timeout: 3000 });
      await expect(highlight).toBeHidden({ timeout: 3000 });

      // Clicking the block body (not the button) also copies it.
      await page.evaluate(() => { window.__clipboardWrites = []; });
      await page.mouse.click(points.quote!.x, points.quote!.y);
      await expect.poll(async () => {
        return page.evaluate(() => window.__clipboardWrites as string[]);
      }, { timeout: 3000 }).toContain(QUOTE_LINES.join('\n'));
    } finally {
      await browser.close();
    }
  });

  test('the terminalBlockCopy setting gates the whole affordance', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminalWithFixture(page);

      let points: Awaited<ReturnType<typeof findBlockPoints>> = { quote: null, box: null };
      await expect.poll(async () => {
        points = await findBlockPoints(page);
        return Boolean(points.quote);
      }, { timeout: 8000 }).toBe(true);

      // Feature on: the button appears on hover.
      await page.mouse.move(points.quote!.x, points.quote!.y, { steps: 5 });
      const button = page.getByTestId('terminal-block-copy-button');
      await expect(button).toBeVisible({ timeout: 3000 });

      // Turn the setting off via the config store.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { config?: { setState: (fn: (s: { config: Record<string, unknown> }) => object) => void } };
        }).__zustandStores;
        stores?.config?.setState((s) => ({ config: { ...s.config, terminalBlockCopy: false } }));
      });

      // The hit-test global now stands down (no "Copy Block" menu item), and the
      // hover button / highlight are gone.
      await expect.poll(async () => {
        return page.evaluate((pt) => window.__kangenticTerminalBlockHitTest!(pt!.x, pt!.y).blockKind, points.quote);
      }, { timeout: 3000 }).toBeNull();
      await expect(button).toBeHidden({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });
});

declare global {
  interface Window {
    __clipboardWrites: string[];
  }
}
