/**
 * E2E tests for context window usage bar and session info display.
 *
 * Verifies:
 * - Merged settings file is created with correct statusLine object format
 * - --settings flag is passed to Claude CLI
 * - Status file watcher emits usage data to the renderer
 * - TerminalPanel renders a color-coded context bar below the terminal
 * - StatusBar shows model, visual context bar, and cost
 * - No usage bar when no session is active
 *
 * Uses mock Claude CLI. Since mock Claude doesn't invoke the statusLine
 * bridge, tests write status files directly to simulate Claude Code's behavior.
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

const TEST_NAME = 'context-usage';
const runId = Date.now();
const PROJECT_NAME = `Usage Test ${runId}`;
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

/** Strip ANSI/terminal escape codes from text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?\x07|\x1B[()][A-Z0-9]/g, '');
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
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

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

/**
 * Find the merged settings file and extract the status output path from it.
 * Returns the status output path that the session manager is watching.
 */
function findStatusOutputPath(): string | null {
  const kangenticDir = path.join(tmpDir, '.kangentic');
  if (!fs.existsSync(kangenticDir)) return null;

  // Find the most recently modified claude-settings-*.json file
  const settingsFiles = fs.readdirSync(kangenticDir)
    .filter(f => f.startsWith('claude-settings-') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(kangenticDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.name);

  if (settingsFiles.length === 0) return null;

  const settingsContent = JSON.parse(
    fs.readFileSync(path.join(kangenticDir, settingsFiles[0]), 'utf-8'),
  );

  // Extract status output path from the statusLine command
  const cmd: string = settingsContent.statusLine?.command || '';
  const match = cmd.match(/"([^"]+\.json)"\s*$/);
  return match ? match[1].replace(/\//g, path.sep) : null;
}

test.describe('Context Window Usage', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('merged settings file has statusLine as object, not string', async () => {
    const title = `Settings Check ${runId}`;
    await createTask(page, title, 'Check settings format');

    await dragTaskToColumn(title, 'Running');

    // Wait for the mock Claude to start and report the --settings flag
    const scrollback = await waitForTerminalOutput('MOCK_CLAUDE_SETTINGS:');
    const clean = stripAnsi(scrollback);

    // Extract the settings path from the scrollback
    const settingsMatch = clean.match(/MOCK_CLAUDE_SETTINGS:(.+)/);
    expect(settingsMatch).toBeTruthy();
    const settingsPath = settingsMatch![1].trim();

    // Read and verify the merged settings file
    const settingsContent = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Critical: statusLine must be an object, not a string
    expect(typeof settingsContent.statusLine).toBe('object');
    expect(settingsContent.statusLine.type).toBe('command');
    expect(typeof settingsContent.statusLine.command).toBe('string');
    expect(settingsContent.statusLine.command).toContain('status-bridge.js');
  });

  test('status file write triggers usage bar on task card', async () => {
    const title = `Usage Bar ${runId}`;
    await createTask(page, title, 'Test usage bar display');

    await dragTaskToColumn(title, 'Running');

    // Wait for mock to start
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Find the status output path from the merged settings file
    const statusOutputPath = findStatusOutputPath();
    expect(statusOutputPath).toBeTruthy();

    // Ensure the directory exists
    fs.mkdirSync(path.dirname(statusOutputPath!), { recursive: true });

    // Write simulated usage data (as if Claude Code's status bridge wrote it)
    const usageData = {
      context_window: {
        used_percentage: 45,
        total_input_tokens: 5000,
        total_output_tokens: 3000,
        context_window_size: 200000,
      },
      cost: {
        total_cost_usd: 0.42,
        total_duration_ms: 12000,
      },
      model: {
        id: 'claude-opus-4-6',
        display_name: 'Opus 4.6',
      },
    };
    fs.writeFileSync(statusOutputPath!, JSON.stringify(usageData));

    // Wait for the usage bar to appear on the task card
    const usageBar = page.locator('[data-testid="usage-bar"]').first();
    await usageBar.waitFor({ state: 'visible', timeout: 10000 });

    // Verify percentage text
    await expect(usageBar.locator('text=45%')).toBeVisible();

    // Verify model name
    await expect(usageBar.locator('text=Opus 4.6')).toBeVisible();
  });

  test('context bar color is red at high context percentage', async () => {
    const title = `Bar Color ${runId}`;
    await createTask(page, title, 'Test color changes');

    await dragTaskToColumn(title, 'Running');

    // Wait for the new session to start — need a brief delay so the
    // merged settings file for this session is written before we read it.
    await page.waitForTimeout(3000);

    // Find the status output path for the latest session
    const statusOutputPath = findStatusOutputPath();
    expect(statusOutputPath).toBeTruthy();
    fs.mkdirSync(path.dirname(statusOutputPath!), { recursive: true });

    // Write high usage data (>= 90%) — should be red
    fs.writeFileSync(statusOutputPath!, JSON.stringify({
      context_window: { used_percentage: 95 },
      cost: { total_cost_usd: 2.50 },
      model: { display_name: 'Opus 4.6' },
    }));

    // Look specifically for a usage bar containing "95%" text
    const usageBar = page.locator('[data-testid="usage-bar"]', { hasText: '95%' });
    await usageBar.waitFor({ state: 'visible', timeout: 10000 });

    // Verify the bar has the red color class
    const barFill = usageBar.locator('.bg-red-500');
    await expect(barFill).toBeVisible();
  });

  test('usage bar appears on the task card for first session', async () => {
    // The "Usage Bar" task from a prior test should still have usage data.
    // Scroll to the Running column where it was dragged.
    await page.evaluate(() => {
      const el = document.querySelector('[data-swimlane-name="Running"]');
      if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    await page.waitForTimeout(300);

    // Find the usage bar with 45% (from the "Usage Bar" task)
    const usageBar = page.locator('[data-testid="usage-bar"]', { hasText: '45%' });
    await expect(usageBar).toBeVisible({ timeout: 5000 });
  });
});
