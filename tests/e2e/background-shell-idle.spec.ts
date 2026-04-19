/**
 * E2E regression guard for the background-shell false-idle bug (fixed).
 *
 * Historical bug: when a Claude Code agent launched a backgrounded Bash
 * (Bash tool with run_in_background: true) and yielded its turn, the
 * activity engine flipped the session to 'idle' even though the
 * detached child was still doing real work. User-visible effects:
 *
 *   1. Task card showed the idle/yellow-mail icon instead of the
 *      active/thinking indicator.
 *   2. ContextBar treated the session as done.
 *   3. Auto-suspend could fire after idleTimeoutMinutes and kill the
 *      session while background tests were still running.
 *   4. Nothing stopped a user or an auto-transition from moving the
 *      task to Done even though the agent hadn't actually finished.
 *
 * Confirmed in the wild on task #503 (session e426341b-1725-4f5c-b411-
 * 50ead5da728a): events.jsonl contained idle at ts=17617675411 while
 * the user's screenshot at ts=17617702595 (27s later) showed the task
 * card stuck on the idle icon despite `npx playwright test --project=ui`
 * still running in a backgrounded bash. The next event in events.jsonl
 * was a user prompt 5 minutes later, confirming no automatic
 * reactivation on background-child completion.
 *
 * Mechanism (confirmed empirically from task #503's events.jsonl):
 *   run_in_background: true returns the Bash handle in ~300ms, so
 *   PostToolUse fires right away -> event-bridge emits a well-formed
 *   tool_end that balances the tool_start. The agent narrates ("tests
 *   are running, I'll wait") and yields. Stop fires -> event-bridge
 *   emits idle. Pre-fix: state machine transitioned thinking -> idle
 *   because nothing knew about the detached child.
 *
 * Fix: the event-bridge's PreToolUse handler now remaps
 * `tool_name === 'Bash' && tool_input.run_in_background === true` to
 * a new `background_shell_start` event type, and `tool_name ===
 * 'KillBash'` to `background_shell_end`. The ActivityStateMachine
 * tracks `activeBackgroundShells`, and Guard 3
 * (`deferStopUntilBackgroundShellsFinish`) suppresses any Stop-driven
 * idle while that counter is > 0. Interrupts and permission idle
 * bypass the guard so they reach the user immediately.
 *
 * ------------------------------------------------------------------
 * Harness design
 * ------------------------------------------------------------------
 *
 * Two describe blocks, each with its own isolated Electron launch.
 *
 * POSITIVE CONTROL (mock-claude-bgbash wrapper, two tests):
 *   - Sets MOCK_CLAUDE_BACKGROUND_BASH=1 via the Node wrapper.
 *   - Mock writes background_shell_start + tool_end + idle into the
 *     session's events.jsonl (the exact shape the real event-bridge
 *     would emit after remapping) AND spawns a detached node child
 *     bounded by MOCK_CLAUDE_BG_SHELL_LIFETIME_MS (default 10s).
 *   - Mock publishes the child's PID to bg-shell.pid so the spec
 *     proves the child is alive at the moment activity is observed.
 *
 *   (a) `activity stays thinking (not idle) while detached bg shell
 *       is alive` -- asserts Guard 3 holds. Polls for thinking, waits
 *       a 5s observation window to catch any late idle flip, then
 *       asserts the PID is still alive.
 *   (b) `deferred idle emits after background_shell_end drops the
 *       counter to zero` -- appends a KillBash-equivalent event to
 *       events.jsonl and asserts activity flips to idle within 5s.
 *       Exercises the deferred-idle release path.
 *
 * NEGATIVE CONTROL (standard mock, one test):
 *   - Appends a well-formed tool_start + tool_end + idle cycle with
 *     NO surviving child, and asserts activity reaches idle within
 *     5s. Catches a fix that over-suppresses idle.
 *
 * Artifacts: each test copies its session's events.jsonl to
 * test-results/background-shell-idle/ and attaches via
 * test.info().attachments for post-mortem A/B diffing against real
 * task #503 captures.
 *
 * Event-bridge directive tests (remap-nested for run_in_background,
 * remap for KillBash) live in tests/e2e/claude-activity-detection.spec.ts
 * so the remap itself is covered by a real-shape fixture without
 * needing to spin up Electron.
 *
 * ------------------------------------------------------------------
 * Running locally
 * ------------------------------------------------------------------
 *
 *   npm run build
 *   npx playwright test tests/e2e/background-shell-idle.spec.ts
 *
 * Manual ground-truth reproduction against the real Claude CLI:
 *
 *   1. Launch Kangentic dev build. Create a task.
 *   2. Prompt real Claude: "Run `npx playwright test --project=ui`
 *      backgrounded, then tell me when it's done."
 *   3. Observe: task card stays on the thinking indicator, does not
 *      flip to idle while tests run.
 *   4. Copy `.kangentic/sessions/<id>/events.jsonl`. Verify it
 *      contains a `background_shell_start` entry for the Bash call.
 *   5. Diff against the synthetic
 *      test-results/background-shell-idle/positive-control-events.jsonl.
 *      Differences should only be timestamps and tool details. If
 *      anything else differs (e.g. a notification event between
 *      tool_end and idle), update the mock's bg-bash branch so the
 *      harness stays faithful to real-world behavior.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const runId = Date.now();

function standardMockPath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

function bgBashMockPath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude-bgbash.cmd');
  }
  const shPath = path.join(fixturesDir, 'mock-claude-bgbash.sh');
  fs.chmodSync(shPath, 0o755);
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return shPath;
}

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-results', 'background-shell-idle');

function copyArtifact(src: string, name: string): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const dst = path.join(ARTIFACT_DIR, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, `(events.jsonl did not exist at ${src})\n`);
  }
  return dst;
}

/**
 * signal 0 is the standard "does this PID exist" probe on POSIX and is
 * supported by Node on Windows too. Returns true iff the process is
 * alive (or we lack permission to signal it, which implies it exists).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
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

async function waitForScrollbackMarker(page: Page, marker: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      const texts: string[] = [];
      for (const session of sessions) {
        texts.push(await window.electronAPI.sessions.getScrollback(session.id));
      }
      return texts.join('\n');
    });
    if (scrollback.includes(marker)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for scrollback containing: ${marker}`);
}

async function sessionDirForTask(
  page: Page,
  tmpDir: string,
  taskTitle: string,
  timeoutMs = 10000,
): Promise<string> {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t) => t.title === title);
      if (!task) return { error: 'task missing' };
      const sessions = await window.electronAPI.sessions.list();
      const taskSessions = sessions.filter((s) => s.taskId === task.id);
      if (taskSessions.length === 0) {
        return { error: `0 sessions for task ${task.id} (total ${sessions.length})` };
      }
      return { sessionId: taskSessions[taskSessions.length - 1].id };
    }, taskTitle);
    if ('sessionId' in result && result.sessionId) {
      return path.join(tmpDir, '.kangentic', 'sessions', result.sessionId);
    }
    lastError = (result as { error: string }).error;
    await page.waitForTimeout(200);
  }
  throw new Error(`No session for task "${taskTitle}" after ${timeoutMs}ms (${lastError})`);
}

async function readBgShellPid(sessionDir: string, timeoutMs = 10000): Promise<number> {
  const pidFile = path.join(sessionDir, 'bg-shell.pid');
  const diagFile = path.join(sessionDir, 'bg-shell.diag');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(pidFile)) {
      const contents = fs.readFileSync(pidFile, 'utf-8').trim();
      const parsed = parseInt(contents, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      if (parsed === -1) {
        const diag = fs.existsSync(diagFile) ? fs.readFileSync(diagFile, 'utf-8') : '(no diag)';
        throw new Error(`Mock's bg-bash spawn failed (pid=-1). Diagnostic:\n${diag}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagContent = fs.existsSync(diagFile)
    ? fs.readFileSync(diagFile, 'utf-8')
    : '(bg-shell.diag NOT written -- mock bg-bash branch never executed, ' +
      'most likely MOCK_CLAUDE_BACKGROUND_BASH env did not propagate via the wrapper)';
  if (fs.existsSync(diagFile)) {
    copyArtifact(diagFile, 'positive-control-bg-shell.diag');
  }
  throw new Error(
    `bg-shell.pid not written at ${pidFile} after ${timeoutMs}ms.\n` +
      `Mock diagnostic:\n${diagContent}`,
  );
}

test.describe('Background-shell idle bug -- positive control (bg Bash + live detached child)', () => {
  const TEST_NAME = 'bg-shell-idle-positive';
  const PROJECT_NAME = `BG Shell Positive ${runId}`;
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);

    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: bgBashMockPath(),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
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

  test('activity stays thinking (not idle) while detached bg shell is alive', async () => {
    const title = `BG Shell Fixed ${runId}`;
    await createTask(page, title, 'Backgrounded Bash with detached child');

    await dragTaskToColumn(page, title, 'Planning');
    await waitForScrollbackMarker(page, 'MOCK_CLAUDE_SESSION:');

    const sessionDir = await sessionDirForTask(page, tmpDir, title);
    const pid = await readBgShellPid(sessionDir);

    // Wait for the engine to ingest the mock's event cycle
    // (background_shell_start, tool_end, idle). Guard 3 in the
    // ActivityStateMachine must defer the Stop-driven idle while
    // activeBackgroundShells > 0, so the session should settle on
    // 'thinking' -- not 'idle' as it did pre-fix. Poll with a healthy
    // timeout so fs.watch debounce + IPC round-trip have time.
    await expect
      .poll(
        async () => {
          const activity = await page.evaluate(() =>
            window.electronAPI.sessions.getActivity(),
          );
          return Object.values(activity as Record<string, string>);
        },
        {
          timeout: 10_000,
          message: 'Expected activity to settle on thinking while bg shell is alive',
        },
      )
      .toContain('thinking');

    // Stay on thinking for an observation window so any latent
    // stale-thinking / watchdog path that might re-flip to idle has
    // time to do so. 5s is comfortably longer than any debounce.
    await page.waitForTimeout(5000);
    const latent = await page.evaluate(() => window.electronAPI.sessions.getActivity());
    const latentStates = Object.values(latent as Record<string, string>);
    expect(latentStates).toContain('thinking');
    expect(latentStates).not.toContain('idle');

    // Prove the child is ACTUALLY alive at the moment we observe the
    // activity state. Without this, a green test could be a false
    // positive (child died early -> legit idle got suppressed by
    // chance). If this ever fails, the mock's lifetime bound is too
    // short -- fix the mock, not the fix.
    expect(isProcessAlive(pid)).toBe(true);

    // Capture the events.jsonl artifact for A/B diffing against the
    // negative control and against real task #503 captures.
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const artifact = copyArtifact(eventsPath, 'positive-control-events.jsonl');
    test.info().attachments.push({
      name: 'positive-control-events.jsonl',
      path: artifact,
      contentType: 'application/jsonl',
    });

    const lines = fs
      .readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(
      lines.filter((entry) => entry.type === 'background_shell_start').length,
    ).toBeGreaterThanOrEqual(1);
    expect(lines.filter((entry) => entry.type === 'tool_end').length).toBeGreaterThanOrEqual(1);
    expect(lines.filter((entry) => entry.type === 'idle').length).toBeGreaterThanOrEqual(1);
  });

  test('deferred idle emits after a background_shell_end drops the counter to zero', async () => {
    const title = `BG Shell Release ${runId}`;
    await createTask(page, title, 'Backgrounded Bash followed by KillBash');

    await dragTaskToColumn(page, title, 'Planning');
    await waitForScrollbackMarker(page, 'MOCK_CLAUDE_SESSION:');

    const sessionDir = await sessionDirForTask(page, tmpDir, title);
    const eventsPath = path.join(sessionDir, 'events.jsonl');

    // First poll: while the mock's bg_shell_start is live, activity
    // should be thinking.
    await expect
      .poll(
        async () => {
          const activity = await page.evaluate(() =>
            window.electronAPI.sessions.getActivity(),
          );
          return Object.values(activity as Record<string, string>);
        },
        { timeout: 10_000, message: 'Expected activity to settle on thinking pre-kill' },
      )
      .toContain('thinking');

    // Append a background_shell_end (as if the agent called KillBash)
    // directly to events.jsonl -- the file watcher will pick it up
    // and the state machine should emit the deferred idle.
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({ ts: Date.now(), type: 'background_shell_end', tool: 'KillBash' }) + '\n',
    );

    await expect
      .poll(
        async () => {
          const activity = await page.evaluate(() =>
            window.electronAPI.sessions.getActivity(),
          );
          return Object.values(activity as Record<string, string>);
        },
        {
          timeout: 5000,
          message: 'Expected deferred idle to emit after background_shell_end',
        },
      )
      .toContain('idle');
  });
});

test.describe('Background-shell idle bug -- negative control (no detached child)', () => {
  const TEST_NAME = 'bg-shell-idle-negative';
  const PROJECT_NAME = `BG Shell Negative ${runId}`;
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);

    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: standardMockPath(),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
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

  test('well-formed cycle with no detached child reaches idle (must pass both before and after fix)', async () => {
    const title = `Well-formed Cycle ${runId}`;
    await createTask(page, title, 'Standard tool cycle ends in idle');

    await dragTaskToColumn(page, title, 'Planning');
    await waitForScrollbackMarker(page, 'MOCK_CLAUDE_SESSION:');

    const sessionDir = await sessionDirForTask(page, tmpDir, title);
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

    fs.appendFileSync(
      eventsPath,
      JSON.stringify({ ts: Date.now(), type: 'tool_start', tool: 'Bash' }) + '\n',
    );
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({ ts: Date.now(), type: 'tool_end', tool: 'Bash' }) + '\n',
    );
    fs.appendFileSync(eventsPath, JSON.stringify({ ts: Date.now(), type: 'idle' }) + '\n');

    // No detached child was spawned, so the session is legitimately
    // idle. The fix should not regress this -- activity must still
    // reach 'idle' for a well-formed cycle with no surviving child.
    await expect
      .poll(
        async () => {
          const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
          return Object.values(activity as Record<string, string>);
        },
        { timeout: 5000, message: 'Expected session to reach idle within 5 seconds' },
      )
      .toContain('idle');

    const artifact = copyArtifact(eventsPath, 'negative-control-events.jsonl');
    test.info().attachments.push({
      name: 'negative-control-events.jsonl',
      path: artifact,
      contentType: 'application/jsonl',
    });

    const lines = fs
      .readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.filter((entry) => entry.type === 'tool_start').length).toBeGreaterThanOrEqual(1);
    expect(lines.filter((entry) => entry.type === 'tool_end').length).toBeGreaterThanOrEqual(1);
    expect(lines.filter((entry) => entry.type === 'idle').length).toBeGreaterThanOrEqual(1);
  });
});
