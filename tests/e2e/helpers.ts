import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Session, Swimlane, Task } from '../../src/shared/types';

export type AgentName = 'claude' | 'codex' | 'gemini' | 'cursor' | 'warp' | 'opencode' | 'kimi' | 'qwen' | 'droid';

// --- Test data isolation ---
// Each test run uses its own data directory so E2E tests never pollute
// the real user data at %APPDATA%/kangentic (or ~/.config/kangentic).
const TEST_DATA_ROOT = path.join(__dirname, '..', '.test-data');

/**
 * Get an isolated data directory for a specific test suite.
 * Removes stale data from previous runs, then recreates the directory.
 */
export function getTestDataDir(suiteName: string): string {
  const dir = path.join(TEST_DATA_ROOT, suiteName);
  // Remove stale data (global DB, configs) from previous runs
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove the test data directory for a specific suite.
 */
export function cleanupTestDataDir(suiteName: string): void {
  const dir = path.join(TEST_DATA_ROOT, suiteName);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}

// Cached git template - initialized once per worker process and copied
// per createTempProject() call. Replaces ~150-300ms of git init + git commit
// per call with a fast directory copy. The template lives outside the per-test
// .tmp tree so it's not wiped by individual test cleanup.
const TEMPLATE_PARENT = path.join(__dirname, '..', '.tmp-template');
const TEMPLATE_DIR = path.join(TEMPLATE_PARENT, `worker-${process.pid}`);
let templateInitialized = false;

function ensureGitTemplate(): string {
  if (templateInitialized && fs.existsSync(TEMPLATE_DIR)) return TEMPLATE_DIR;
  // Wipe the whole parent to also clean up stale directories from prior
  // runs whose PIDs are no longer live.
  try { fs.rmSync(TEMPLATE_PARENT, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  execSync('git init', { cwd: TEMPLATE_DIR, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: TEMPLATE_DIR, stdio: 'ignore' });
  templateInitialized = true;
  return TEMPLATE_DIR;
}

// Temp project directory for tests -- always starts fresh
export function createTempProject(testName: string): string {
  const tmpDir = path.join(__dirname, '..', '.tmp', testName);
  // Remove stale data from previous runs to avoid session saturation
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Copy from the cached git template instead of running git init + commit
  // every call. fs.cpSync recursively copies including the .git directory.
  const template = ensureGitTemplate();
  fs.cpSync(template, tmpDir, { recursive: true });
  return tmpDir;
}

export function cleanupTempProject(testName: string): void {
  const tmpDir = path.join(__dirname, '..', '.tmp', testName);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}

// App launcher
export async function launchApp(options?: {
  cwd?: string;
  dataDir?: string;
  extraEnv?: Record<string, string>;
}): Promise<{ app: ElectronApplication; page: Page }> {
  const mainEntry = path.join(__dirname, '../../.vite/build/index.js');

  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `Build not found at ${mainEntry}. Run "node scripts/build.js" first.`,
    );
  }

  // Always isolate test data. Use explicit dataDir if provided, otherwise
  // generate one from the Playwright worker index to avoid collisions.
  const dataDir = options?.dataDir || getTestDataDir(`worker-${process.pid}`);

  // Ensure hasCompletedFirstRun is true so the WelcomeOverlay doesn't block
  // tests, and suppress all desktop notifications + toasts so killing mock
  // sessions during tests (e.g. archive flows, exit handling) doesn't fire
  // spurious "Session crashed" desktop notifications on the developer's
  // machine. Tests may pre-write their own config.json (e.g. with mock Claude
  // CLI paths), so merge rather than overwrite.
  const configPath = path.join(dataDir, 'config.json');
  const notificationDefaults = {
    desktop: { onAgentIdle: false, onAgentCrash: false, onPlanComplete: false },
    toasts: { onAgentIdle: false, onAgentCrash: false, onPlanComplete: false, durationSeconds: 4, maxCount: 5 },
    cooldownSeconds: 60,
  };
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let changed = false;
    if (!existing.hasCompletedFirstRun) {
      existing.hasCompletedFirstRun = true;
      changed = true;
    }
    if (!existing.notifications) {
      existing.notifications = notificationDefaults;
      changed = true;
    }
    if (changed) fs.writeFileSync(configPath, JSON.stringify(existing));
  } catch {
    fs.writeFileSync(configPath, JSON.stringify({
      hasCompletedFirstRun: true,
      notifications: notificationDefaults,
    }));
  }

  const args = [mainEntry];
  if (options?.cwd) {
    args.push(`--cwd=${options.cwd}`);
  }

  // Retry electron.launch() with backoff -- Windows can transiently fail
  // to attach the debugger pipe under resource pressure or AV scans.
  const maxLaunchAttempts = 3;
  const baseRetryDelayMs = 2000;
  let app: ElectronApplication | undefined;
  let lastLaunchError: Error | undefined;

  for (let attempt = 1; attempt <= maxLaunchAttempts; attempt++) {
    try {
      app = await electron.launch({
        args,
        env: {
          ...process.env,
          ...(options?.extraEnv ?? {}),
          // Test-essential keys go LAST so callers cannot accidentally
          // override them via extraEnv.
          NODE_ENV: 'test',
          ELECTRON_DISABLE_GPU: '1',
          KANGENTIC_DATA_DIR: dataDir,
        },
        colorScheme: 'dark',
      });
      break;
    } catch (error) {
      lastLaunchError = error as Error;
      if (attempt < maxLaunchAttempts) {
        const retryDelayMs = baseRetryDelayMs * attempt;
        console.error(`electron.launch() attempt ${attempt} failed, retrying in ${retryDelayMs}ms: ${lastLaunchError.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  if (!app) {
    throw new Error(`electron.launch() failed after ${maxLaunchAttempts} attempts: ${lastLaunchError?.message}`);
  }

  const page = await app.firstWindow();

  // When HEADED=1 (user-invoked), maximize so the user can watch.
  // Otherwise (CI/automated), just let it run at default size.
  const isHeaded = process.env.HEADED === '1' || process.env.HEADED === 'true';
  await app.evaluate(({ BrowserWindow }, headed) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (headed) {
      win.maximize();
    } else {
      // Ensure window is large enough for DnD tests even when not headed.
      // Move off-screen so it doesn't steal focus or cover user's work.
      // Drag tests use adjacent-only drags to avoid coordinate issues.
      win.setSize(1920, 1080);
      win.setPosition(-2000, -2000);
    }
  }, isHeaded);

  // Wait for the full page to load (scripts, styles, etc.)
  await page.waitForLoadState('load');
  // Wait for React to actually render the app shell
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { app, page };
}

// Wait for the board to load (swimlanes visible)
export async function waitForBoard(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });
}

// Create a project via IPC (native dialog can't be automated in E2E)
export async function createProject(page: Page, _name: string, projectPath: string): Promise<void> {
  // Call openByPath directly -- creates the project if needed and opens it
  await page.evaluate((p: string) => window.electronAPI.projects.openByPath(p), projectPath);
  // Reload so the renderer picks up the new current project
  await page.reload();
  await waitForBoard(page);
}

// Create a task via the UI in the To Do column (the only column with an "Add task" button).
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
): Promise<void> {
  const column = page.locator('[data-swimlane-name="To Do"]');
  const addButton = column.locator('text=Add task');
  await addButton.click();

  const titleInput = page.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = page.locator('[data-testid="task-description"]');
    await descInput.fill(description);
  }

  const createButton = page.getByRole('button', { name: 'Create', exact: true });
  await createButton.click();
  await page.waitForTimeout(300);
}

/**
 * Resolve the platform-appropriate mock CLI fixture path for an agent.
 * Used by E2E specs that need to point an agent's cliPath at a mock binary
 * (e.g. mock-claude, mock-codex, mock-gemini).
 */
/**
 * Wipe the ~/.kimi/sessions/<hash>/ directory whose md5 matches the given
 * absolute work_dir. The mock-kimi fixture computes the hash the same way,
 * so this targets exactly the directories that mock spawned for this test.
 *
 * Mirrors the cleanup pattern used by mock-codex (which deletes its
 * rollout JSONL on exit), but factored into helpers because the mock
 * intentionally never cleans up itself - real Kimi persists wire.jsonl
 * across runs so resume can find it.
 */
export function cleanupKimiSessionsForCwd(cwd: string): void {
  const hash = createHash('md5').update(path.resolve(cwd)).digest('hex');
  const target = path.join(os.homedir(), '.kimi', 'sessions', hash);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function mockAgentPath(agent: AgentName): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, `mock-${agent}.cmd`);
  }
  const jsPath = path.join(fixturesDir, `mock-${agent}.js`);
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

/**
 * Set the current project's default agent via IPC, then reload so the
 * renderer picks up the change.
 */
export async function setProjectDefaultAgent(page: Page, agent: AgentName): Promise<void> {
  await page.evaluate(async (agentName) => {
    const current = await window.electronAPI.projects.getCurrent();
    if (current?.id) {
      await window.electronAPI.projects.setDefaultAgent(current.id, agentName);
    }
  }, agent);
  await page.reload();
  await waitForBoard(page);
}

/**
 * Poll all live session scrollback for a marker substring. Returns the
 * combined scrollback text once the marker appears, or throws on timeout.
 */
export async function waitForScrollback(page: Page, marker: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async () => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      const texts: string[] = [];
      for (const session of sessions) {
        texts.push(await window.electronAPI.sessions.getScrollback(session.id));
      }
      return texts.join('\n---SESSION_BOUNDARY---\n');
    });
    if (scrollback.includes(marker)) return scrollback;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for scrollback containing: ${marker}`);
}

/** Wait until at least one session reports status='running' via IPC. */
export async function waitForRunningSession(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(async () => {
    const sessions: Session[] = await window.electronAPI.sessions.list();
    return sessions.some((session) => session.status === 'running');
  }, null, { timeout: timeoutMs });
}

/** Wait until no session reports status='running' (suspend/exit completion). */
export async function waitForNoRunningSession(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(async () => {
    const sessions: Session[] = await window.electronAPI.sessions.list();
    return !sessions.some((session) => session.status === 'running');
  }, null, { timeout: timeoutMs });
}

/** Look up the task ID for a given title via IPC. */
export async function getTaskIdByTitle(page: Page, title: string): Promise<string> {
  const taskId = await page.evaluate(async (taskTitle) => {
    const tasks: Task[] = await window.electronAPI.tasks.list();
    return tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  if (!taskId) throw new Error(`No task found with title: ${title}`);
  return taskId;
}

/** Look up swimlane IDs by name and role. */
export async function getSwimlaneIds(page: Page): Promise<{ planning: string; done: string }> {
  const swimlaneIds = await page.evaluate(async () => {
    const swimlanes: Swimlane[] = await window.electronAPI.swimlanes.list();
    const planning = swimlanes.find((swimlane) => swimlane.name === 'Planning');
    const done = swimlanes.find((swimlane) => swimlane.role === 'done');
    return { planning: planning?.id ?? null, done: done?.id ?? null };
  });
  if (!swimlaneIds.planning || !swimlaneIds.done) {
    throw new Error('Could not find Planning and/or Done swimlanes');
  }
  return { planning: swimlaneIds.planning, done: swimlaneIds.done };
}

/** Move a task to a target swimlane via IPC (no UI drag). */
export async function moveTaskIpc(page: Page, taskId: string, targetSwimlaneId: string): Promise<void> {
  await page.evaluate(async ({ taskId: id, targetSwimlaneId: swimlaneId }) => {
    await window.electronAPI.tasks.move({
      taskId: id,
      targetSwimlaneId: swimlaneId,
      targetPosition: 0,
    });
  }, { taskId, targetSwimlaneId });
}
