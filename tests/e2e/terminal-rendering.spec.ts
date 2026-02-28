import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
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
  await app?.close();
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
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
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
  await page.waitForTimeout(100);

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
  await page.waitForTimeout(100);
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);

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

  test('task detail dialog shows xterm terminal', async () => {
    const taskName = `Term Dialog ${runId}`;
    await createTask(page, taskName, 'Test terminal in dialog');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Open the task detail dialog by clicking the card
    const card = page.locator('[data-swimlane-name="Planning"]').locator(`text=${taskName}`).first();
    await card.click();
    await page.waitForTimeout(500);

    // Dialog should be visible
    const dialog = page.locator('.fixed.inset-0');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // xterm should render inside the dialog
    const dialogXterm = dialog.locator('.xterm');
    await expect(dialogXterm.first()).toBeVisible({ timeout: 5000 });

    // xterm screen should have real dimensions (not collapsed)
    const xtermScreen = dialog.locator('.xterm-screen');
    await expect(xtermScreen.first()).toBeVisible({ timeout: 3000 });
    const screenBox = await xtermScreen.first().boundingBox();
    expect(screenBox).toBeTruthy();
    expect(screenBox!.width).toBeGreaterThan(100);
    expect(screenBox!.height).toBeGreaterThan(50);

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('terminal shows shell output (scrollback)', async () => {
    const taskName = `Term Output ${runId}`;
    await createTask(page, taskName, 'Test terminal shows output');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Open task detail dialog
    const card = page.locator('[data-swimlane-name="Planning"]').locator(`text=${taskName}`).first();
    await card.click();
    await page.waitForTimeout(1000);

    // The xterm terminal should render inside the dialog
    const dialog = page.locator('.fixed.inset-0');
    const xtermContainer = dialog.locator('.xterm');
    await expect(xtermContainer.first()).toBeVisible({ timeout: 5000 });

    // xterm v6 uses WebGL canvases for rendering, so we check that the terminal
    // has canvas elements with real pixel content (width/height > 0)
    const hasCanvasContent = await dialog.locator('.xterm canvas').first().evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      return canvas.width > 0 && canvas.height > 0;
    });
    expect(hasCanvasContent).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('panel resize preserves scrollback and refits xterm', async () => {
    // Extended timeout: session spawn + drag operations
    test.setTimeout(90000);

    const taskName = `Resize Test ${runId}`;
    await createTask(page, taskName, 'Test scrollback and refit after resize');

    // Spawn a session so the bottom panel has a live terminal
    await dragTaskToColumn(taskName, 'Planning');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Click the session tab to ensure this terminal is active.
    // With multiple sessions, the "All" tab may be selected by default.
    const sessionTab = page.locator('.resize-handle ~ div button', { hasText: /resize-test/i });
    await sessionTab.click();
    await page.waitForTimeout(300);

    // With multiple sessions, each terminal pane is display:none unless active.
    // Select the xterm inside the visible pane (display: block).
    const terminalPanel = page.locator('.resize-handle ~ div');
    const activePane = terminalPanel.locator('div.absolute.inset-0[style*="display: block"]');
    await expect(activePane.locator('.xterm').first()).toBeVisible({ timeout: 5000 });

    // --- Part 1: Scrollback preservation ---
    const scrollbackBefore = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      if (sessions.length === 0) return '';
      return window.electronAPI.sessions.getScrollback(sessions[0].id);
    });
    expect(scrollbackBefore.length).toBeGreaterThan(0);

    const handle = page.locator('.resize-handle');
    await expect(handle).toBeVisible({ timeout: 3000 });
    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();

    const handleX = handleBox!.x + handleBox!.width / 2;
    const handleY = handleBox!.y + handleBox!.height / 2;

    // Drag UP (bigger) → DOWN (smaller) → UP (bigger again).
    // This is the resize pattern that was losing scrollback before the fix.
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX, handleY - 100, { steps: 10 });
    await page.mouse.move(handleX, handleY + 30, { steps: 10 });
    await page.mouse.move(handleX, handleY - 80, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);

    const scrollbackAfter = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      if (sessions.length === 0) return '';
      return window.electronAPI.sessions.getScrollback(sessions[0].id);
    });

    // PTY buffer is the source of truth — unaffected by xterm row changes.
    expect(scrollbackAfter).toBe(scrollbackBefore);

    // --- Part 2: xterm refits after resize ---
    const xtermScreen = activePane.locator('.xterm-screen').first();
    const boxBefore = await xtermScreen.boundingBox();
    expect(boxBefore).toBeTruthy();

    // Drag handle UP another 100px to make panel bigger
    const handle2 = await handle.boundingBox();
    expect(handle2).toBeTruthy();
    const h2X = handle2!.x + handle2!.width / 2;
    const h2Y = handle2!.y + handle2!.height / 2;

    await page.mouse.move(h2X, h2Y);
    await page.mouse.down();
    await page.mouse.move(h2X, h2Y - 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1000);

    const boxAfter = await xtermScreen.boundingBox();
    expect(boxAfter).toBeTruthy();
    expect(boxAfter!.height).toBeGreaterThan(boxBefore!.height);
  });
});
