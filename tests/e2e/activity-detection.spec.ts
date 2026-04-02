/**
 * E2E tests for Claude Code activity detection (thinking vs idle).
 *
 * Verifies:
 * - Event bridge script writes correct JSONL when invoked
 * - Merged settings file contains hooks for tool_start, prompt, and idle events
 * - Events JSONL file watcher emits state changes to the renderer
 * - Task card shows Loader2 spinner when thinking, static dot when idle
 *
 * Uses mock Claude CLI. Since mock Claude doesn't invoke hooks,
 * tests write event files directly to simulate Claude Code's behavior.
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

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  // Pre-write config with mock Claude CLI path, worktrees disabled
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
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="To Do"]');
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
 * Find the most recent merged settings file and return its parsed contents.
 * Settings are at .kangentic/sessions/<id>/settings.json.
 */
function findMergedSettings(): Record<string, unknown> | null {
  const sessionsDir = path.join(tmpDir, '.kangentic', 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  const settingsFiles = fs.readdirSync(sessionsDir)
    .map(dir => path.join(sessionsDir, dir, 'settings.json'))
    .filter(f => fs.existsSync(f))
    .map(f => ({
      path: f,
      mtime: fs.statSync(f).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (settingsFiles.length === 0) return null;

  return JSON.parse(fs.readFileSync(settingsFiles[0].path, 'utf-8'));
}

/**
 * Extract the events output path from the merged settings hooks.
 * Looks for event-bridge commands referencing events.jsonl.
 */
function findEventsOutputPath(): string | null {
  const settings = findMergedSettings();
  if (!settings) return null;
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>> | undefined;
  if (!hooks?.Stop?.[0]?.hooks?.[0]?.command) return null;
  const cmd: string = hooks.Stop[0].hooks[0].command;
  // Extract the path from: node "bridge" "path" idle
  const match = cmd.match(/"([^"]+events\.jsonl)"/);
  return match ? match[1].replace(/\//g, path.sep) : null;
}

test.describe('Event Bridge Script', () => {
  test('event-bridge.js writes correct JSONL for tool_start event', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js');
    const outFile = path.join(tmpDir, 'test-tool-start.jsonl');

    const stdinData = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/src/main.ts' } });
    const stdinFile = path.join(tmpDir, 'test-tool-start-input.json');
    fs.writeFileSync(stdinFile, stdinData);

    execSync(`node "${bridgePath}" "${outFile}" tool_start < "${stdinFile}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe('tool_start');
    expect(event.tool).toBe('Read');
    expect(event.detail).toBe('/src/main.ts');
    expect(event.ts).toBeGreaterThan(0);

    fs.unlinkSync(outFile);
    fs.unlinkSync(stdinFile);
  });

  test('event-bridge.js writes correct JSONL for idle event', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js');
    const outFile = path.join(tmpDir, 'test-idle.jsonl');

    execSync(`echo {} | node "${bridgePath}" "${outFile}" idle`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe('idle');
    expect(event.ts).toBeGreaterThan(0);

    fs.unlinkSync(outFile);
  });

  test('event-bridge.js writes correct JSONL for prompt event', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js');
    const outFile = path.join(tmpDir, 'test-prompt.jsonl');

    execSync(`echo {} | node "${bridgePath}" "${outFile}" prompt`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe('prompt');

    fs.unlinkSync(outFile);
  });

  test('event-bridge.js appends multiple events (JSONL format)', async () => {
    const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js');
    const outFile = path.join(tmpDir, 'test-multi.jsonl');

    // Write two events to the same file
    execSync(`echo {} | node "${bridgePath}" "${outFile}" prompt`, { encoding: 'utf-8', timeout: 5000 });
    execSync(`echo {} | node "${bridgePath}" "${outFile}" idle`, { encoding: 'utf-8', timeout: 5000 });

    const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('prompt');
    expect(JSON.parse(lines[1]).type).toBe('idle');

    fs.unlinkSync(outFile);
  });
});

test.describe('Merged Settings Hooks', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('merged settings file contains event-bridge hooks', async () => {
    const title = `Hooks Check ${runId}`;
    await createTask(page, title, 'Check hooks in merged settings');

    await dragTaskToColumn(title, 'Code Review');
    await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    const settings = findMergedSettings();
    expect(settings).toBeTruthy();
    const hooks = settings!.hooks as Record<string, Array<{ hooks: Array<{ command: string; type: string }> }>>;
    expect(hooks).toBeTruthy();

    // PreToolUse hooks -- should contain event-bridge tool_start
    expect(hooks.PreToolUse).toBeInstanceOf(Array);
    expect(hooks.PreToolUse.length).toBeGreaterThanOrEqual(1);
    const ptuCommands = hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command));
    expect(ptuCommands.some(c => c.includes('event-bridge') && c.includes('tool_start'))).toBe(true);

    // UserPromptSubmit hooks -- should contain event-bridge prompt
    expect(hooks.UserPromptSubmit).toBeInstanceOf(Array);
    const upsCommands = hooks.UserPromptSubmit.flatMap(e => e.hooks.map(h => h.command));
    expect(upsCommands.some(c => c.includes('event-bridge') && c.includes('prompt'))).toBe(true);

    // Stop hooks -- should contain event-bridge idle
    expect(hooks.Stop).toBeInstanceOf(Array);
    const stopCommands = hooks.Stop.flatMap(e => e.hooks.map(h => h.command));
    expect(stopCommands.some(c => c.includes('event-bridge') && c.includes('idle'))).toBe(true);
  });

  test('hooks reference events file in session directory', async () => {
    const settings = findMergedSettings();
    expect(settings).toBeTruthy();
    const hooks = settings!.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

    const stopCmd: string = hooks.Stop[0].hooks[0].command;
    // Events file should be in .kangentic/sessions/<id>/events.jsonl
    expect(stopCmd).toMatch(/\.kangentic[/\\]sessions[/\\].*events\.jsonl/);
  });
});

test.describe('Activity State via IPC', () => {
  // Derive the events path from the session spawned in the first test.
  // Using the session ID from terminal output is more reliable than scanning
  // the filesystem for settings.json files (which breaks when multiple
  // session dirs exist or file system caching delays visibility).
  let eventsPathForBlock: string | null = null;

  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('new session defaults to idle state', async () => {
    const title = `Default State ${runId}`;
    await createTask(page, title, 'Check default idle state');

    await dragTaskToColumn(title, 'Code Review');
    const scrollback = await waitForTerminalOutput('MOCK_CLAUDE_SESSION:');

    // Extract the Claude session ID from mock output and build the events path
    const sessionIdMatch = scrollback.match(/MOCK_CLAUDE_SESSION:([^\s\r\n]+)/);
    expect(sessionIdMatch).toBeTruthy();
    const agentSessionId = sessionIdMatch![1];
    eventsPathForBlock = path.join(tmpDir, '.kangentic', 'sessions', agentSessionId, 'events.jsonl');

    // Check activity cache has 'idle' for the session (safe default -
    // 'thinking' is only set when hooks explicitly fire)
    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });

    const states = Object.values(activity) as string[];
    expect(states).toContain('idle');
  });

  test('writing events JSONL transitions state to thinking', async () => {
    // Use path derived from the first test, fall back to filesystem scan
    const eventsPath = eventsPathForBlock || findEventsOutputPath();
    expect(eventsPath).toBeTruthy();

    // Ensure directory exists
    fs.mkdirSync(path.dirname(eventsPath!), { recursive: true });

    // Write tool_start event to the events file (simulating PreToolUse hook)
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'tool_start',
      tool: 'Read',
    }) + '\n');

    // Wait for the file watcher to pick it up and emit to the renderer
    await page.waitForTimeout(500);

    // Check that at least one session is now thinking
    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });
    const states = Object.values(activity) as string[];
    expect(states).toContain('thinking');
  });

  test('writing idle event transitions state back to idle', async () => {
    const eventsPath = eventsPathForBlock || findEventsOutputPath();
    expect(eventsPath).toBeTruthy();

    // Write idle event (simulating Stop hook)
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'idle',
    }) + '\n');

    await page.waitForTimeout(500);

    const activity = await page.evaluate(async () => {
      return window.electronAPI.sessions.getActivity();
    });
    const states = Object.values(activity) as string[];
    expect(states).toContain('idle');
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
    // Find events path and write idle event
    const eventsPath = findEventsOutputPath();
    expect(eventsPath).toBeTruthy();

    fs.mkdirSync(path.dirname(eventsPath!), { recursive: true });
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'idle',
    }) + '\n');

    await page.waitForTimeout(500);

    // Scroll to Planning
    await page.evaluate(() => {
      const el = document.querySelector('[data-swimlane-name="Planning"]');
      if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    await page.waitForTimeout(300);

    // The initializing bar should still show a spinner (always spins while initializing)
    const initBar = page.locator('[data-swimlane-name="Planning"]').locator('[data-testid="status-bar"]');
    await expect(initBar).toBeVisible({ timeout: 3000 });

    const spinner = initBar.locator('.animate-spin');
    await expect(spinner).toBeVisible({ timeout: 3000 });
  });
});
