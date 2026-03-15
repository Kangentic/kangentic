import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

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

// Temp project directory for tests -- always starts fresh
export function createTempProject(testName: string): string {
  const tmpDir = path.join(__dirname, '..', '.tmp', testName);
  // Remove stale data from previous runs to avoid session saturation
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(tmpDir, { recursive: true });
  // Initialize a git repo so worktrees can work
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'ignore' });
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

  // Ensure hasCompletedFirstRun is true so the WelcomeOverlay doesn't block tests.
  // Tests may pre-write their own config.json (e.g. with mock Claude CLI paths),
  // so merge into existing config rather than overwriting.
  const configPath = path.join(dataDir, 'config.json');
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!existing.hasCompletedFirstRun) {
      existing.hasCompletedFirstRun = true;
      fs.writeFileSync(configPath, JSON.stringify(existing));
    }
  } catch {
    fs.writeFileSync(configPath, JSON.stringify({ hasCompletedFirstRun: true }));
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
  await page.locator('[data-swimlane-name="Backlog"]').waitFor({ state: 'visible', timeout: 15000 });
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

// Create a task via the UI
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
  columnName: string = 'Backlog',
): Promise<void> {
  // Find the correct column's Add task button (use data-swimlane-name for precision)
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
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
