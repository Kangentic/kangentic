/**
 * E2E: the whole workspace comes back after a restart.
 *
 * Quit with a task's window open, two Command Terminals running and a third
 * Stopped, then relaunch through the REAL main process. The task and its window
 * come back through startup recovery and the saved layout. The two terminals come
 * back through `command-terminal-restore.ts`: `--resume <id>` in their own slots,
 * with no third terminal, and the panel reopens because it was showing.
 *
 * This is the one tier that runs the record end to end: the agent reporting its
 * id, input marking the row touched, the row kept open across a real quit, and a
 * real locator finding the transcript. A `sessions` resume needs none of those, so
 * mock-claude's conversation harness is opt-in here
 * (`MOCK_CLAUDE_TRANSCRIPT_FOLDER`). The transcripts go in a folder of this run's
 * own under `~/.claude/projects`, which `afterAll` deletes: a fake HOME crashes
 * Chromium on Windows.
 *
 * Red-green: without the restore, the second launch's panel starts one fresh
 * terminal with no MOCK_CLAUDE_RESUMED marker, and the conversations wait in Earlier.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  dismissOnboardingChecklist,
  isProcessAlive,
  mockAgentPath,
  moveTaskIpc,
  waitForRunningSession,
  waitForTaskSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  closeApp,
  closeAppAndWaitForExit,
} from './helpers';

const TEST_NAME = 'command-terminal-restart';
const runId = Date.now();

function writeTestConfig(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      hasCompletedFirstRun: true,
      agent: { cliPaths: { claude: mockAgentPath('claude') }, permissionMode: 'default', maxConcurrentSessions: 5 },
      git: { worktreesEnabled: false },
    }),
  );
}

interface TerminalRow {
  id: string;
  slot: string | null;
  agentSessionId: string | null;
  hasUserInput: boolean;
  label: string | null;
  tag: string;
}

/** Every Command Terminal main holds, in slot order, as main reports it. */
async function liveTerminals(page: Page): Promise<TerminalRow[]> {
  const rows = await page.evaluate(async () => {
    const sessions = await window.electronAPI.sessions.list();
    return sessions
      .filter((session) => session.transient && session.status === 'running')
      .map((session) => ({
        id: session.id,
        slot: session.commandTerminalSlot ?? null,
        agentSessionId: session.agentSessionId ?? null,
        hasUserInput: session.hasUserInput === true,
        label: session.commandTerminalLabel ?? null,
        tag: session.taskId,
      }));
  });
  return rows.sort((first, second) => (first.slot ?? '').localeCompare(second.slot ?? ''));
}

async function waitForTerminalCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => (await liveTerminals(page)).length, { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(count);
}

/** Type into a terminal the way a person does, which is what makes its conversation worth keeping. */
async function useTerminal(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => window.electronAPI.sessions.write(id, 'hello\r'), sessionId);
  await expect
    .poll(async () => (await liveTerminals(page)).find((row) => row.id === sessionId)?.hasUserInput, { timeout: 15_000 })
    .toBe(true);
}

test.describe('Command Terminal restart', () => {
  // The crash starts from the workspace the first test leaves.
  test.describe.configure({ mode: 'serial' });
  const dataDir = getTestDataDir(TEST_NAME);
  let projectPath: string;
  // The folder Claude files a conversation under: the cwd with every other
  // character a dash (`claudeProjectSlug`). The locator's scan of every folder
  // answers from a listing kept for 30 s, too stale for a transcript written
  // after it, and a real session's file is here.
  let transcriptFolder: string;
  let launchEnv: Record<string, string>;
  // What a terminal's agent left running before the quit: a process with no live
  // parent, carrying the terminal's tag (detached-survivor-launcher.js).
  let survivorFile: string;
  let survivorPid: number | null = null;
  let projectId: string | null = null;
  let taskId: string;

  test.beforeAll(() => {
    cleanupTestDataDir(TEST_NAME);
    fs.mkdirSync(dataDir, { recursive: true });
    writeTestConfig(dataDir);
    projectPath = createTempProject(TEST_NAME);
    transcriptFolder = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    survivorFile = path.join(dataDir, 'survivor.json');
    launchEnv = {
      MOCK_CLAUDE_TRANSCRIPT_FOLDER: transcriptFolder,
      MOCK_CLAUDE_FAST_DETACH_RESULT_FILE: survivorFile,
      MOCK_CLAUDE_FAST_DETACH_COMMAND_TERMINAL: '1',
    };
  });

  test.afterAll(() => {
    if (survivorPid !== null && isProcessAlive(survivorPid)) process.kill(survivorPid);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
    fs.rmSync(path.join(os.homedir(), '.claude', 'projects', transcriptFolder), { recursive: true, force: true });
  });

  test('a relaunch brings back the task, its window, and the running terminals in their slots', async () => {
    // Two launches, three terminals and a task's agent each way.
    test.setTimeout(180_000);
    const title = `Restart Restore ${runId}`;

    // === Phase 1: the workspace at quit ===
    let launched = await launchApp({ dataDir, extraEnv: launchEnv });
    let { app, page } = launched;

    await createProject(page, 'Restart Restore', projectPath);
    await createTask(page, title, 'Comes back with the terminals');
    const { planning } = await getSwimlaneIds(page);
    taskId = await getTaskIdByTitle(page, title);
    await moveTaskIpc(page, taskId, planning);
    await page.reload();
    await dismissOnboardingChecklist(page);
    await waitForBoard(page);
    await waitForRunningSession(page);

    await page.locator('[data-swimlane-name="Planning"]').locator(`text=${title}`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10_000 });

    await page.keyboard.press('Control+Shift+P');
    await page.locator('[data-testid="command-terminal-window"]').first().waitFor({ state: 'visible', timeout: 20_000 });
    await waitForTerminalCount(page, 1);
    // Before the next terminal starts, or it starts a second one this spec never learns of.
    await expect.poll(() => fs.existsSync(survivorFile), { timeout: 20_000 }).toBe(true);
    const survivor = JSON.parse(fs.readFileSync(survivorFile, 'utf-8')) as { survivorPid: number; tag: string };
    survivorPid = survivor.survivorPid;
    await page.locator('[data-testid="command-terminal-new"]').click();
    await waitForTerminalCount(page, 2);
    await page.locator('[data-testid="command-terminal-new"]').click();
    await waitForTerminalCount(page, 3);

    await expect
      .poll(async () => (await liveTerminals(page)).every((row) => row.agentSessionId !== null), { timeout: 30_000, intervals: [250, 500, 1000] })
      .toBe(true);
    const terminals = await liveTerminals(page);
    expect(terminals.map((row) => row.slot)).toEqual(['slot-1', 'slot-2', 'slot-3']);
    for (const terminal of terminals) await useTerminal(page, terminal.id);

    // The Stopped one: Stop ends a terminal for good, and a restart must not undo it.
    const [firstTerminal, secondTerminal, stoppedTerminal] = terminals;
    expect(firstTerminal.tag).toBe(survivor.tag);
    await page.evaluate((id) => window.electronAPI.sessions.killTransient(id), stoppedTerminal.id);
    await waitForTerminalCount(page, 2);

    projectId = await page.evaluate(async () => (await window.electronAPI.projects.getCurrent())?.id ?? null);
    expect(projectId).toBeTruthy();

    await closeAppAndWaitForExit(app);

    // === Phase 2: the relaunch ===
    launched = await launchApp({ dataDir, extraEnv: launchEnv });
    ({ app, page } = launched);
    await page.evaluate((folder) => window.electronAPI.projects.openByPath(folder), projectPath);
    await page.reload();
    await dismissOnboardingChecklist(page);
    await waitForBoard(page);

    await waitForTaskSession(page, taskId, 30_000);
    await waitForTerminalCount(page, 2);

    // The same conversations, by `--resume <id>`, each in its own slot. The agent
    // reports its id a moment after it spawns.
    await expect
      .poll(
        async () => (await liveTerminals(page)).map((row) => ({ slot: row.slot, agentSessionId: row.agentSessionId })),
        { timeout: 20_000, intervals: [250, 500, 1000] },
      )
      .toEqual([
        { slot: 'slot-1', agentSessionId: firstTerminal.agentSessionId },
        { slot: 'slot-2', agentSessionId: secondTerminal.agentSessionId },
      ]);
    const restored = await liveTerminals(page);
    for (const terminal of restored) {
      await expect
        .poll(() => page.evaluate((id) => window.electronAPI.sessions.getScrollback(id), terminal.id), { timeout: 20_000, intervals: [250, 500, 1000] })
        .toContain(`MOCK_CLAUDE_RESUMED:${terminal.agentSessionId}`);
    }

    // The panel was showing at quit, so it is showing now, over those two and no third.
    await expect(page.locator('[data-testid="command-terminal-window"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible({ timeout: 15_000 });
    expect(await liveTerminals(page)).toHaveLength(2);

    // What was Stopped waits in Earlier; what came back does not.
    const earlier = await page.evaluate(
      (id) => window.electronAPI.sessions.listCommandTerminalHistory(id),
      projectId as string,
    );
    expect(earlier.map((entry) => entry.agentSessionId)).toEqual([stoppedTerminal.agentSessionId]);

    // A quit reaps nothing, so what the terminal started is still running, and the
    // terminal came back under its tag, so its Stop reaches that too.
    expect(isProcessAlive(survivor.survivorPid)).toBe(true);
    expect(restored[0].tag).toBe(survivor.tag);
    await page.evaluate((id) => window.electronAPI.sessions.killTransient(id), restored[0].id);
    await expect
      .poll(() => isProcessAlive(survivor.survivorPid), { timeout: 30_000, intervals: [500, 1000] })
      .toBe(false);

    await closeAppAndWaitForExit(app);
  });

  test('a real pty host crash brings the terminal back in its slot, under its tag', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ dataDir, extraEnv: launchEnv });
    await page.evaluate((folder) => window.electronAPI.projects.openByPath(folder), projectPath);
    await page.reload();
    await dismissOnboardingChecklist(page);
    await waitForBoard(page);
    await waitForTaskSession(page, taskId, 30_000);
    await waitForTerminalCount(page, 1);
    await expect
      .poll(async () => (await liveTerminals(page))[0]?.agentSessionId ?? null, { timeout: 20_000 })
      .not.toBeNull();
    const [before] = await liveTerminals(page);

    // This instance's own pty host, named by the app that forked it.
    const hostPids = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
      .filter((metric) => metric.type === 'Utility' && metric.name === 'kangentic-pty-host')
      .map((metric) => metric.pid));
    expect(hostPids).toHaveLength(1);
    process.kill(hostPids[0], 'SIGKILL');

    await expect
      .poll(
        async () => {
          const [terminal] = await liveTerminals(page);
          return terminal && terminal.id !== before.id ? terminal : null;
        },
        { timeout: 45_000, intervals: [500, 1000] },
      )
      .toMatchObject({ slot: before.slot, tag: before.tag });
    await waitForTerminalCount(page, 1);
    const [after] = await liveTerminals(page);
    await expect
      .poll(() => page.evaluate((id) => window.electronAPI.sessions.getScrollback(id), after.id), { timeout: 20_000, intervals: [250, 500, 1000] })
      .toContain(`MOCK_CLAUDE_RESUMED:${before.agentSessionId}`);

    // Its window went with the crash, so the panel hid, and the next open adopts it.
    await expect(page.locator('[data-testid="command-terminal-window"]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('[data-testid="command-terminal-window"]')).toHaveCount(1, { timeout: 15_000 });
    expect(await liveTerminals(page)).toHaveLength(1);

    // It came back, so it is not in Earlier, and the Stopped one still is.
    const earlier = await page.evaluate((id) => window.electronAPI.sessions.listCommandTerminalHistory(id), projectId as string);
    expect(earlier.map((entry) => entry.agentSessionId)).not.toContain(before.agentSessionId);

    await closeApp(app);
  });
});
