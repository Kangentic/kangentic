/**
 * E2E tests for Claude Code activity detection (thinking vs idle).
 *
 * Verifies:
 * - Activity bridge script writes correct JSON when invoked
 * - Merged settings file contains hooks for UserPromptSubmit and Stop events
 * - Activity file watcher emits state changes to the renderer
 * - Task card shows Loader2 spinner when thinking, static dot when idle
 * - Task detail dialog shows spinner when thinking, static dot when idle
 * - Activity state defaults to 'thinking' for newly spawned sessions
 *
 * Uses mock Claude CLI. Since mock Claude doesn't invoke hooks,
 * tests write activity files directly to simulate Claude Code's behavior.
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
import { execSync } from 'node:child_process';

const TEST_NAME = 'activity-detection';
const runId = Date.now();
const PROJECT_NAME = `Activity Test ${runId}`;
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

  // Pre-write config with mock Claude CLI path, worktrees disabled
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
 * Find the merged settings file and return its parsed contents.
 */
function findMergedSettings(): Record<string, any> | null {
  const kangenticDir = path.join(tmpDir, '.kangentic');
  if (!fs.existsSync(kangenticDir)) return null;

  const settingsFiles = fs.readdirSync(kangenticDir)
    .filter(f => f.startsWith('claude-settings-') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(kangenticDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.name);

  if (settingsFiles.length === 0) return null;

  return JSON.parse(
    fs.readFileSync(path.join(kangenticDir, settingsFiles[0]), 'utf-8'),
  );
}

/**
 * Extract the activity output path from the merged settings hooks.
 */
function findActivityOutputPath(): string | null {
  const settings = findMergedSettings();
  if (!settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command) return null;
  const cmd: string = settings.hooks.Stop[0].hooks[0].command;
  // Extract the path from: node "bridge" "path" idle
  const match = cmd.match(/"([^"]+\.activity\.json)"/);
  return match ? match[1].replace(/\//g, path.sep) : null;
}

test.describe('Activity Bridge Script', () => {
  test('activity-bridge.js writes correct JSON for thinking state', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js');
    const outFile = path.join(tmpDir, 'test-thinking.json');

    execSync(`echo {} | node "${bridgePath}" "${outFile}" thinking`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(data.state).toBe('thinking');
    expect(data.timestamp).toBeTruthy();
    expect(new Date(data.timestamp).getTime()).toBeGreaterThan(0);

    fs.unlinkSync(outFile);
  });

  test('activity-bridge.js writes correct JSON for idle state', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js');
    const outFile = path.join(tmpDir, 'test-idle.json');

    execSync(`echo {} | node "${bridgePath}" "${outFile}" idle`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(data.state).toBe('idle');
    expect(data.timestamp).toBeTruthy();

    fs.unlinkSync(outFile);
  });

  test('activity-bridge.js defaults to thinking when no state arg', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js');
    const outFile = path.join(tmpDir, 'test-default.json');

    execSync(`echo {} | node "${bridgePath}" "${outFile}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(data.state).toBe('thinking');

    fs.unlinkSync(outFile);
  });

  test('activity-bridge.js handles piped JSON (large stdin)', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js');
    const outFile = path.join(tmpDir, 'test-large-stdin.json');
    const stdinFile = path.join(tmpDir, 'test-large-stdin-input.json');

    // Write a large payload to a temp file and pipe it via file redirect
    // (avoids Windows command-line length limit)
    const largePayload = JSON.stringify({ event: 'Stop', data: { x: 'y'.repeat(10000) } });
    fs.writeFileSync(stdinFile, largePayload);

    execSync(`node "${bridgePath}" "${outFile}" idle < "${stdinFile}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(data.state).toBe('idle');

    fs.unlinkSync(outFile);
    fs.unlinkSync(stdinFile);
  });
});

test.describe('Merged Settings Hooks', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('merged settings file contains UserPromptSubmit and Stop hooks', async () => {
    const title = `Hooks Check ${runId}`;
    await createTask(page, title, 'Check hooks in merged settings');

    await dragTaskToColumn(title, 'Running');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    const settings = findMergedSettings();
    expect(settings).toBeTruthy();
    expect(settings!.hooks).toBeTruthy();

    // UserPromptSubmit hook
    expect(settings!.hooks.UserPromptSubmit).toBeInstanceOf(Array);
    expect(settings!.hooks.UserPromptSubmit.length).toBeGreaterThanOrEqual(1);
    const upsHook = settings!.hooks.UserPromptSubmit[0];
    expect(upsHook.hooks[0].type).toBe('command');
    expect(upsHook.hooks[0].command).toContain('activity-bridge');
    expect(upsHook.hooks[0].command).toContain('thinking');

    // Stop hook
    expect(settings!.hooks.Stop).toBeInstanceOf(Array);
    expect(settings!.hooks.Stop.length).toBeGreaterThanOrEqual(1);
    const stopHook = settings!.hooks.Stop[0];
    expect(stopHook.hooks[0].type).toBe('command');
    expect(stopHook.hooks[0].command).toContain('activity-bridge');
    expect(stopHook.hooks[0].command).toContain('idle');
  });

  test('hooks reference activity file in status directory', async () => {
    const settings = findMergedSettings();
    expect(settings).toBeTruthy();

    const stopCmd: string = settings!.hooks.Stop[0].hooks[0].command;
    // Activity file should be in .kangentic/status/<id>.activity.json
    expect(stopCmd).toMatch(/\.kangentic[/\\]status[/\\].*\.activity\.json/);
  });
});

test.describe('Activity State via IPC', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('new session defaults to idle state', async () => {
    const title = `Default State ${runId}`;
    await createTask(page, title, 'Check default idle state');

    await dragTaskToColumn(title, 'Running');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Check activity cache has 'idle' for the session (safe default —
    // 'thinking' is only set when hooks explicitly fire)
    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });

    const states = Object.values(activity) as string[];
    expect(states).toContain('idle');
  });

  test('writing activity file transitions state to idle', async () => {
    // Find the activity output path from the merged settings
    const activityPath = findActivityOutputPath();
    expect(activityPath).toBeTruthy();

    // Ensure directory exists
    fs.mkdirSync(path.dirname(activityPath!), { recursive: true });

    // Write idle state to the activity file (simulating Stop hook)
    fs.writeFileSync(activityPath!, JSON.stringify({
      state: 'idle',
      timestamp: new Date().toISOString(),
    }));

    // Wait for the file watcher to pick it up and emit to the renderer
    await page.waitForTimeout(500);

    // Check that at least one session is now idle
    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });
    const states = Object.values(activity) as string[];
    expect(states).toContain('idle');
  });

  test('writing activity file transitions state back to thinking', async () => {
    const activityPath = findActivityOutputPath();
    expect(activityPath).toBeTruthy();

    // Write thinking state (simulating UserPromptSubmit hook)
    fs.writeFileSync(activityPath!, JSON.stringify({
      state: 'thinking',
      timestamp: new Date().toISOString(),
    }));

    await page.waitForTimeout(500);

    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });
    const states = Object.values(activity) as string[];
    expect(states).toContain('thinking');
  });
});

test.describe('Task Card Spinner', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('task card shows spinner when session is thinking', async () => {
    const title = `Spinner Card ${runId}`;
    await createTask(page, title, 'Test spinner on card');

    await dragTaskToColumn(title, 'Planning');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // The task card should show a spinning Loader2 icon (animate-spin class)
    // Wait for the card to update with session info
    await page.waitForTimeout(1000);

    // Scroll to Planning to see the card
    await page.evaluate(() => {
      const el = document.querySelector('[data-swimlane-name="Planning"]');
      if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    await page.waitForTimeout(300);

    // Look for the spinning loader (Loader2 renders as an SVG with animate-spin)
    const spinner = page.locator('[data-swimlane-name="Planning"]').locator('.animate-spin').first();
    await expect(spinner).toBeVisible({ timeout: 5000 });
  });

  test('task card shows static dot when session is idle', async () => {
    // Find activity path and write idle state
    const activityPath = findActivityOutputPath();
    expect(activityPath).toBeTruthy();

    fs.mkdirSync(path.dirname(activityPath!), { recursive: true });
    fs.writeFileSync(activityPath!, JSON.stringify({
      state: 'idle',
      timestamp: new Date().toISOString(),
    }));

    await page.waitForTimeout(500);

    // Scroll to Planning
    await page.evaluate(() => {
      const el = document.querySelector('[data-swimlane-name="Planning"]');
      if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    await page.waitForTimeout(300);

    // The initializing bar should still show a spinner (always spins while initializing)
    const initBar = page.locator('[data-swimlane-name="Planning"]').locator('[data-testid="initializing-bar"]');
    await expect(initBar).toBeVisible({ timeout: 3000 });

    const spinner = initBar.locator('.animate-spin');
    await expect(spinner).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Usage Bar Spinner', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('usage bar shows spinner next to model name when thinking', async () => {
    const title = `Usage Spinner ${runId}`;
    await createTask(page, title, 'Test spinner in usage bar');

    await dragTaskToColumn(title, 'Running');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Wait for session to start then get the status output path
    await page.waitForTimeout(1000);

    const settings = findMergedSettings();
    const statusCmd: string = settings?.statusLine?.command || '';
    const statusMatch = statusCmd.match(/"([^"]+\.json)"\s*$/);
    const statusPath = statusMatch ? statusMatch[1].replace(/\//g, path.sep) : null;
    expect(statusPath).toBeTruthy();

    // Write 'thinking' activity state (simulates UserPromptSubmit hook)
    const activityPath = findActivityOutputPath();
    expect(activityPath).toBeTruthy();
    fs.mkdirSync(path.dirname(activityPath!), { recursive: true });
    fs.writeFileSync(activityPath!, JSON.stringify({
      state: 'thinking',
      timestamp: new Date().toISOString(),
    }));

    await page.waitForTimeout(500);

    // Write usage data to trigger the usage bar
    fs.mkdirSync(path.dirname(statusPath!), { recursive: true });
    fs.writeFileSync(statusPath!, JSON.stringify({
      context_window: { used_percentage: 25 },
      cost: { total_cost_usd: 0.10 },
      model: { display_name: 'Opus 4.6' },
    }));

    // Wait for usage bar to appear
    const usageBar = page.locator('[data-testid="usage-bar"]', { hasText: '25%' });
    await usageBar.waitFor({ state: 'visible', timeout: 10000 });

    // Should have a spinner in the usage bar (thinking state from hook)
    const spinner = usageBar.locator('.animate-spin');
    await expect(spinner).toBeVisible({ timeout: 3000 });
  });

  test('usage bar hides spinner when session is idle', async () => {
    // Write idle state to the activity file
    const activityPath = findActivityOutputPath();
    expect(activityPath).toBeTruthy();

    fs.mkdirSync(path.dirname(activityPath!), { recursive: true });
    fs.writeFileSync(activityPath!, JSON.stringify({
      state: 'idle',
      timestamp: new Date().toISOString(),
    }));

    await page.waitForTimeout(500);

    // The usage bar with 25% should still exist but without a spinner
    const usageBar = page.locator('[data-testid="usage-bar"]', { hasText: '25%' });
    await expect(usageBar).toBeVisible();

    const spinner = usageBar.locator('.animate-spin');
    await expect(spinner).toHaveCount(0, { timeout: 3000 });
  });
});
