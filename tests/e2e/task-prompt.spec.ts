/**
 * E2E tests for task prompt delivery to agents.
 *
 * Verifies that the task title/description reaches the agent on first load
 * and that resumed sessions receive no extra prompt.
 *
 * Uses a mock Claude CLI (tests/fixtures/mock-claude) so these tests work
 * without a real Claude installation. The mock echoes its arguments to
 * stdout with markers the tests can match against.
 *
 * Encapsulated under "Claude Agent" — future agent types (e.g. Codex, Aider)
 * should get their own describe blocks.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'task-prompt';
const runId = Date.now();
const PROJECT_NAME = `Prompt Test ${runId}`;
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
  // Unix: use the .js file directly (has shebang)
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  // Pre-write config with mock Claude CLI path
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'project-settings',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false, // Avoid worktree overhead in prompt tests
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

/** Dismiss dialogs and ensure the board is visible */
async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Drag a task card to a target column.
 * Duplicated from drag-and-drop.spec.ts — extracted here to keep tests
 * self-contained. A shared helper can be refactored later.
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col) => {
    const el = document.querySelector(`[data-swimlane-name="${col}"]`);
    if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

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
 * Polls via the renderer's electronAPI (preload bridge).
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

test.describe('Claude Agent — Task Prompt', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('fresh session receives task title and description as prompt', async () => {
    const title = `Prompt Fresh ${runId}`;
    const description = 'Implement the login feature with OAuth support';
    await createTask(page, title, description);

    // Drag to Running (Backlog → Running triggers spawn_agent)
    await dragTaskToColumn(title, 'Running');

    // The shell echoes the full command including the quoted prompt.
    // Wait for the title to appear in terminal scrollback.
    const scrollback = await waitForTerminalOutput(title);

    // Verify both title and description are in the prompt
    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
    // Verify it uses the "Task:" template format
    expect(scrollback).toContain('Task:');
  });

  test('fresh session to Planning receives prompt in plan mode', async () => {
    const title = `Prompt Plan ${runId}`;
    const description = 'Design the authentication architecture';
    await createTask(page, title, description);

    await dragTaskToColumn(title, 'Planning');

    const scrollback = await waitForTerminalOutput(title);

    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
    // Planning column uses --permission-mode plan
    expect(scrollback).toContain('permission-mode');
  });

  test('prompt includes full description text, not just title', async () => {
    const title = `Prompt Desc ${runId}`;
    const description = 'Build a REST API with pagination and filtering';
    await createTask(page, title, description);

    await dragTaskToColumn(title, 'Running');

    const scrollback = await waitForTerminalOutput(title);

    // The full description should be in the prompt
    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
  });
});
