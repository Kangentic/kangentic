/**
 * E2E tests for terminal rendering.
 *
 * NOT migrated to shared-app fixture: the "bottom terminal panel shows xterm"
 * test asserts on a session tab appearing in the bottom panel using the
 * "/term-panel/" text pattern. In the shared Electron instance, sessions from
 * prior tests' projects can still appear as tabs in the bottom panel, making
 * the tab locator match a stale tab or miss the expected one (2/10 failures).
 * With its own Electron boot, the bottom panel starts empty and the first
 * session tab is deterministically the one this test created. Keeping own boot.
 *
 * Deleted tests (not reproduced):
 *  - "panel resize preserves scrollback" - deleted because design was
 *    fundamentally racy: snapshotted PTY scrollback for equality while
 *    mock-claude kept streaming. Fixed waits couldn't reliably distinguish
 *    "stream paused" from "stream finished". Coverage of PTY ring-buffer
 *    logic lives in unit tests; coverage of resize debouncing lives in the
 *    PTY debouncer unit tests.
 *  - Two other terminal snapshot tests - same racy PTY equality comparison
 *    design.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'terminal-rendering';
const runId = Date.now();
const PROJECT_NAME = `Term Test ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

/** Resolve the platform-appropriate mock Claude path */
function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  // Pre-write config with mock Claude CLI so sessions stay alive
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
});

async function ensureBoard() {
  // Dispatch Escape directly on document to bypass xterm's key capture.
  // xterm intercepts Escape (used for ANSI sequences) so
  // page.keyboard.press('Escape') doesn't reach the dialog's document listener.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(300);
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Drag a task card to a target column using mouse events.
 * Same approach as drag-and-drop.spec.ts.
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((targetCol) => {
    const targetEl = document.querySelector(`[data-swimlane-name="${targetCol}"]`);
    if (targetEl) targetEl.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
  // Confirm landing instead of a fixed 500ms post-drop wait.
  await expect(target.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 5000 });
}

/**
 * Wait for terminal scrollback to contain the expected text.
 */
async function waitForTerminalOutput(marker: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      const texts: string[] = [];
      for (const s of sessions) {
        const sb = await window.electronAPI.sessions.getScrollback(s.id);
        texts.push(sb);
      }
      return texts.join('\n');
    });

    if (scrollback.includes(marker)) {
      return scrollback;
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for terminal output containing: ${marker}`);
}

test.describe('Terminal Rendering', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('bottom terminal panel shows xterm after session spawn', async () => {
    const taskName = `Term Panel ${runId}`;
    await createTask(page, taskName, 'Test terminal in bottom panel');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // The bottom terminal panel should now have a session tab (not Activity)
    const sessionTab = page.locator('.resize-handle ~ div button', { hasText: /term-panel/i }).first();
    await expect(sessionTab).toBeVisible({ timeout: 5000 });

    // Click the session tab to ensure it's active
    await sessionTab.click();

    // xterm should have rendered in the terminal panel
    const terminalPanel = page.locator('.resize-handle ~ div');
    const xtermElement = terminalPanel.locator('.xterm');
    await expect(xtermElement.first()).toBeVisible({ timeout: 5000 });

    // xterm screen canvas should exist and have real dimensions
    const xtermScreen = terminalPanel.locator('.xterm-screen');
    await expect(xtermScreen.first()).toBeVisible({ timeout: 3000 });
    const screenBox = await xtermScreen.first().boundingBox();
    expect(screenBox).toBeTruthy();
    expect(screenBox!.width).toBeGreaterThan(50);
    expect(screenBox!.height).toBeGreaterThan(20);
  });

});
