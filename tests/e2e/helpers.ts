import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import type { Session, Swimlane, Task } from '../../src/shared/types';

export type AgentName = 'claude' | 'codex' | 'gemini' | 'cursor' | 'warp' | 'opencode' | 'kimi' | 'qwen' | 'droid';

// --- Test data isolation ---
// Each test run uses its own data directory so E2E tests never pollute
// the real user data at %APPDATA%/kangentic (or ~/.config/kangentic).
//
// Both the project temp dir and the data dir are keyed on process.pid so that
// concurrent Playwright workers (workers=4 on CI) never share a filesystem
// path. This mirrors the ensureGitTemplate() isolation pattern: each worker
// owns its own subtree under the parent, wipes only its own subtree, and never
// races with a sibling. Stale subdirs from prior runs (different PIDs)
// accumulate but are small and are cleaned by global teardown on Linux.
const TEST_DATA_ROOT = path.join(__dirname, '..', '.test-data', `worker-${process.pid}`);

/**
 * Get an isolated data directory for a specific test suite.
 * Keyed on process.pid so concurrent workers never share a path.
 * Removes stale data from previous runs, then recreates the directory.
 */
/**
 * Resolve a mock agent CLI path for the CURRENT platform.
 *
 * Always use this instead of joining a fixture path by hand. On Windows a bare
 * `.js` file is not executable: when node-pty spawns it, the shell has no
 * association for `.js` and Windows pops the "Select an app to open this .js file"
 * dialog instead of running anything. The agent then never starts, so the session
 * has no PTY and produces no output - and a spec asserting on "no output" can pass
 * for entirely the wrong reason while the developer's screen fills with modal
 * dialogs, one per run.
 *
 * Every mock in `tests/fixtures` ships a `.cmd` sibling that shells out to node for
 * exactly this reason. `tests/unit/e2e-mock-cli-platform.test.ts` fails any spec
 * that hand-rolls the path without the win32 branch.
 *
 * @param mockName Fixture basename with no extension, e.g. `mock-claude`.
 */
export function resolveMockAgentPath(mockName: string): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, `${mockName}.cmd`);
  }
  const jsPath = path.join(fixturesDir, `${mockName}.js`);
  // POSIX needs the executable bit for the shebang to be honoured; harmless to
  // re-apply on every run.
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

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

// Per-worker root for temp project directories. Keyed on process.pid so that
// concurrent Playwright workers (workers=4 on CI) never share a path and
// cannot race on rmSync/cpSync. Mirrors the TEMPLATE_DIR / TEST_DATA_ROOT
// isolation pattern.
const TMP_PROJECT_ROOT = path.join(__dirname, '..', '.tmp', `worker-${process.pid}`);
let templateInitialized = false;

function ensureGitTemplate(): string {
  if (templateInitialized && fs.existsSync(TEMPLATE_DIR)) return TEMPLATE_DIR;
  // Only remove OUR own PID-specific subdirectory. Do NOT rmSync the entire
  // TEMPLATE_PARENT: with workers=4 on CI, multiple worker processes call
  // ensureGitTemplate concurrently and each owns a unique pid-keyed dir under
  // the parent. Wiping the parent races with sibling workers who have already
  // created their dirs and may be mid-way through `git init`, causing
  // `fs.cpSync(template, tmpDir)` in createTempProject to fail or copy an
  // empty tree - which is the root cause of the 0ms beforeAll failures seen
  // under workers=4. Stale dirs from prior runs (different PIDs) accumulate
  // but are small (~400KB each) and are cleaned up by the next run's
  // `npm run build` or global teardown on Linux.
  try { fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  // `-b main` pins the initial branch name. Without it, the branch comes from
  // the machine's `init.defaultBranch`: dev machines set `main` (so this was
  // green locally) but a fresh CI runner defaults to `master`, and the app then
  // fails to create a worktree off `main` ("invalid reference: main").
  execSync('git init -b main', { cwd: TEMPLATE_DIR, stdio: 'ignore' });
  // Pass identity inline with `-c` so the commit does not depend on a global
  // git user being configured. Dev machines have one (so this was green
  // locally), but a fresh CI runner does not, which made `git commit` fail and
  // every E2E test error at 0ms during setup.
  execSync('git -c user.email=ci@kangentic.test -c user.name=kangentic commit --allow-empty -m "init"', { cwd: TEMPLATE_DIR, stdio: 'ignore' });
  templateInitialized = true;
  return TEMPLATE_DIR;
}

// Temp project directory for tests -- always starts fresh.
// Path is keyed on process.pid (via TMP_PROJECT_ROOT) so concurrent workers
// never collide on rmSync/cpSync even when two describes use the same testName.
export function createTempProject(testName: string): string {
  const tmpDir = path.join(TMP_PROJECT_ROOT, testName);
  // Remove stale data from previous runs to avoid session saturation
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Copy from the cached git template instead of running git init + commit
  // every call. fs.cpSync recursively copies including the .git directory.
  const template = ensureGitTemplate();
  fs.cpSync(template, tmpDir, { recursive: true });
  return tmpDir;
}

export function cleanupTempProject(testName: string): void {
  const tmpDir = path.join(TMP_PROJECT_ROOT, testName);
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

  // hasCompletedFirstRun is now legacy (kept for schema/fixture compatibility;
  // no onboarding UI reads it). Written true regardless, cheap and harmless.
  //
  // onboardedProjectIds is deliberately NOT seeded, because it cannot be: E2E
  // creates its project through the app at runtime, so its id does not exist
  // when this config is written. The list therefore starts empty, and the
  // onboarding gate is install-scoped (it auto-opens only while the list is
  // empty), so exactly the FIRST project created in a worker's dataDir raises
  // the checklist - not every project, as this comment used to claim. That is
  // handled where it can be - createProject() calls dismissOnboardingChecklist()
  // after its reload - rather than here, since a config seed cannot reference an
  // id that does not exist yet.
  //
  // Also suppress all desktop notifications + toasts so killing mock sessions
  // during tests (e.g. archive flows, exit handling) doesn't fire spurious
  // "Session crashed" desktop notifications on the developer's machine. Tests
  // may pre-write their own config.json (e.g. with mock Claude CLI paths), so
  // merge rather than overwrite.
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
  // On a headless Linux CI runner (xvfb) Chromium's sandbox cannot initialize,
  // so Electron fails to launch without --no-sandbox. Windows, macOS, and local
  // Linux desktops are unaffected (the e2e suite historically ran only on
  // Windows). Guard it to linux so it never weakens the dev-machine runs.
  if (process.platform === 'linux') {
    args.push('--no-sandbox');
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

/**
 * Resilient app teardown for E2E afterAll hooks.
 *
 * Wraps `app.close()` in a 25-second race. If Electron's graceful shutdown
 * stalls (e.g. a hung PTY child blocks before-quit under CI load, or a worker
 * process crash leaves the app without its IPC pipe), this helper force-kills
 * the Electron process tree instead of letting the afterAll hook time out and
 * fail the entire worker (the CI failure mode this was written to fix).
 *
 * The 25s budget is chosen to be well within the project-level 45s test
 * timeout: a graceful shutdown rarely exceeds 5-8s, so 25s gives Electron
 * ample time for a clean exit while still leaving 20s margin for the timeout
 * budget and any subsequent afterAll cleanup (temp-dir removal, etc.).
 *
 * Normal path cost: zero. `Promise.race` resolves as soon as `app.close()`
 * settles, which is before the timeout promise even schedules its callback in
 * the normal case. The timeout promise is created unconditionally but never
 * resolves on the fast path.
 *
 * Force-kill is cross-platform:
 *   - Windows: `taskkill /PID <pid> /T /F` (walks the child tree, matches
 *     the existing janitor / zombie-reaper pattern in electron-janitor.ts and
 *     src/main/git/zombie-reaper.ts).
 *   - POSIX (Linux/macOS): `process.kill(pid, 'SIGKILL')`. Chromium GPU and
 *     network-utility children receive SIGTERM from the kernel when the main
 *     dies (they are not tree-killed explicitly on POSIX, but those children
 *     self-exit when their parent is gone). This is the same behavior as the
 *     global teardown janitor on Linux CI.
 *
 * This is a TEST-SIDE fix only. It does not touch any product shutdown code
 * in src/main/ (the synchronous before-quit path is intentionally synchronous
 * per .claude/rules/synchronous-shutdown.md).
 */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;

  // 25s is the force-kill deadline. Well under the 45s electron project timeout.
  const CLOSE_TIMEOUT_MS = 25_000;

  let didTimeout = false;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      didTimeout = true;
      resolve();
    }, CLOSE_TIMEOUT_MS);
  });

  await Promise.race([app.close(), timeoutPromise]);

  if (!didTimeout) {
    // Normal path: app.close() resolved before the timeout.
    return;
  }

  // Force-kill path: app.close() hung. Get the PID from the Electron process
  // handle and kill it cross-platform.
  console.warn(
    '[E2E closeApp] app.close() did not resolve within ' +
      `${CLOSE_TIMEOUT_MS}ms - force-killing Electron process`,
  );

  const electronProcess = app.process();
  const pid = electronProcess?.pid;

  if (!pid) {
    console.warn('[E2E closeApp] Could not obtain Electron PID - nothing to kill');
    return;
  }

  if (process.platform === 'win32') {
    // taskkill /T walks the child tree, /F is force-kill. Mirrors the pattern
    // in electron-janitor.ts and src/main/git/zombie-reaper.ts.
    await new Promise<void>((resolve) => {
      const taskkillProcess = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      taskkillProcess.on('close', () => resolve());
      taskkillProcess.on('error', (error) => {
        console.warn(`[E2E closeApp] taskkill failed for pid=${pid}:`, error);
        resolve();
      });
      // Taskkill is near-instantaneous; cap it at 3s to avoid a second hang.
      setTimeout(resolve, 3000);
    });
  } else {
    // POSIX: SIGKILL the main process. GPU/network-utility children
    // self-exit when the main dies (no explicit tree-kill needed).
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // Process may have already exited between the race and here.
      console.warn(`[E2E closeApp] SIGKILL failed for pid=${pid}:`, error);
    }
  }
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
  await dismissOnboardingChecklist(page);
  await waitForBoard(page);
}

/**
 * Dismiss the onboarding checklist the first project on a fresh dataDir auto-opens.
 *
 * Required at this tier, not merely tidy: E2E creates its projects through the app at
 * runtime, so their ids cannot be pre-seeded into `onboardedProjectIds` when the config
 * file is written. The list starts empty, and the checklist is a focus-trapping modal whose
 * backdrop swallows pointer events over the board. Skipping it persists, so it cannot come
 * back mid-test.
 *
 * Onboarding is install-scoped (`AppLayout` gates the auto-open on the list being EMPTY, not
 * on per-project membership), so only the first project in a worker's shared dataDir raises
 * it. Every later call here is a not-coming path that pays the wait below for nothing. The UI
 * tier avoids that by asking the config store first (`tests/ui/helpers.ts`); porting that here
 * needs care, because `__zustandStores` is not reliably present in the E2E context - see the
 * defensive skip in `session-rapid-moves.spec.ts`.
 */
export async function dismissOnboardingChecklist(page: Page): Promise<void> {
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  // Deliberately short. The checklist opens from an effect that runs as soon as the
  // project and config have hydrated, so if it is coming it is here well inside a second.
  // The wait is also the NOT-coming path (a project already marked onboarded, which the
  // shared Electron instance produces on a repeat open), and a 5s timeout there would be
  // paid silently on every such test across all E2E shards.
  await checklist.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  if (await checklist.isVisible().catch(() => false)) {
    await page.locator('[data-testid="onboarding-skip"]').click();
    await checklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
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
  // Wait for the dialog to fully unmount before returning. BaseDialog plays
  // a 100ms exit animation, then onAnimationEnd unmounts. Under full-suite
  // load this can exceed the old 300ms fixed sleep, leaving the backdrop
  // intercepting the next "Add task" click in back-to-back createTask calls.
  // Scope the wait to NewTaskDialog's "New Task" header so it does not
  // accidentally match other dialogs that share the title-input placeholder.
  await page.getByRole('heading', { name: 'New Task', exact: true }).waitFor({ state: 'detached', timeout: 3000 });
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

/**
 * Wait until this task's session is no longer running (suspended/exited).
 * Scoped to one task so a shared-Electron suite is not coupled to other
 * tasks' still-alive mocks (e.g. a previous case's resumed keep-alive PTY).
 * Treats "no session for the task" as not-running.
 */
export async function waitForTaskSessionNotRunning(page: Page, taskId: string, timeoutMs = 15000): Promise<void> {
  // Manual poll via page.evaluate (which reliably awaits its async body),
  // mirroring waitForScrollback. page.waitForFunction with an async predicate
  // can treat the returned Promise as truthy and resolve on the first tick.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = await page.evaluate(async (taskId) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      const session = sessions.find((candidate) => candidate.taskId === taskId);
      return !!session && session.status === 'running';
    }, taskId);
    if (!running) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for task ${taskId} session to stop running`);
}

/**
 * Poll until this task's session reports the expected captured agent session
 * ID. This is the conditional wait that replaces fixed post-plant sleeps: it
 * asserts the capture pipeline actually round-tripped the ID onto the live
 * session before the test suspends and resumes.
 *
 * Implemented as a manual poll via page.evaluate (which reliably awaits its
 * async body). page.waitForFunction with an async predicate can treat the
 * returned Promise as a truthy value and resolve on the first tick without
 * ever observing a false condition - which silently no-ops this wait.
 */
export async function waitForAgentSessionId(
  page: Page,
  taskId: string,
  expectedId: string,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  let lastSeen: string | null = null;
  while (Date.now() - start < timeoutMs) {
    lastSeen = await page.evaluate(async (taskId) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      return sessions.find((candidate) => candidate.taskId === taskId)?.agentSessionId ?? null;
    }, taskId);
    if (lastSeen === expectedId) return;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `Timed out waiting for agentSessionId=${expectedId} on task ${taskId} (last seen: ${lastSeen})`,
  );
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
