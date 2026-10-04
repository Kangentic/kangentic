/**
 * E2E tests for session lifecycle across column moves.
 *
 * Covers scenarios introduced by the priority-ordered TASK_MOVE handler:
 *  1. To Do → non-agent column (Code Review) spawns a fresh session
 *  2. Active session survives moves between same-permission columns (Executing → Code Review → Testing)
 *  3. Done → unarchive to non-agent column (Code Review) resumes suspended session
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) which outputs
 * distinct markers:
 *   MOCK_CLAUDE_SESSION:<id>   → new session via --session-id
 *   MOCK_CLAUDE_RESUMED:<id>   → resumed session via --resume
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  waitForTaskSession,
  waitForTaskSessionNotRunning,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-move-lifecycle';
const runId = Date.now();

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

/** Pre-write config.json with mock Claude CLI and worktrees disabled */
function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: 10,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

/**
 * Poll a specific task's running session scrollback for a marker string.
 * Returns the scrollback text if found, throws on timeout.
 */
async function waitForTaskScrollback(page: Page, taskId: string, marker: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const runningSession = sessions.find(
        (session) => session.taskId === tid && session.status === 'running',
      );
      if (!runningSession) return '';
      return window.electronAPI.sessions.getScrollback(runningSession.id);
    }, taskId);

    if (scrollback.includes(marker)) {
      return scrollback;
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for task ${taskId.slice(0, 8)} scrollback containing: ${marker}`);
}

/**
 * Extract the session ID from a MOCK_CLAUDE_SESSION:<id> or
 * MOCK_CLAUDE_RESUMED:<id> marker in the scrollback text.
 */
function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_CLAUDE_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

/** Get swimlane IDs by name or role */
async function getSwimlaneIds(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const swimlanes = await window.electronAPI.swimlanes.list();
    const result: Record<string, string> = {};
    for (const s of swimlanes) {
      result[s.name] = s.id;
      if (s.role) result[`role:${s.role}`] = s.id;
    }
    return result;
  });
}

/** Get task ID by title */
async function getTaskId(page: Page, title: string): Promise<string> {
  const taskId = await page.evaluate(async (t) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidateTask) => candidateTask.title === t);
    return task?.id;
  }, title);
  if (!taskId) throw new Error(`Task "${title}" not found`);
  return taskId;
}

/** Move a task via IPC */
async function moveTask(page: Page, taskId: string, targetSwimlaneId: string): Promise<void> {
  await page.evaluate(async ({ taskId, swimlaneId }) => {
    await window.electronAPI.tasks.move({
      taskId,
      targetSwimlaneId: swimlaneId,
      targetPosition: 0,
    });
  }, { taskId, swimlaneId: targetSwimlaneId });
}

// =========================================================================
// Tests
// =========================================================================
test.describe('Claude Agent -- Session Move Lifecycle', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;
  let lanes: Record<string, string>;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Move Lifecycle ${runId}`, tmpDir);

    lanes = await getSwimlaneIds(page);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('To Do → Code Review spawns a fresh session (non-agent column)', async () => {
    const title = `To Do Review ${runId}`;
    await createTask(page, title, 'Test fresh spawn on non-agent column');

    const taskId = await getTaskId(page, title);

    // Move directly from To Do → Code Review (skipping agent columns)
    await moveTask(page, taskId, lanes['Code Review']);

    // Wait for THIS task's session to start. The Electron app is shared by every
    // test in this file, so a global "any session running" wait is already
    // satisfied by an earlier test's still-live session.
    await waitForTaskSession(page, taskId);

    // Wait for mock Claude to output its marker
    const scrollback = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');

    // Must be a FRESH session, not a resumed one
    expect(scrollback).toContain('MOCK_CLAUDE_SESSION:');
    const sessionId = extractSessionId(scrollback, 'SESSION');
    expect(sessionId).toBeTruthy();

    // Verify task now has a running session
    const taskSession = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find(
        (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
      );
    }, taskId);
    expect(taskSession).toBeTruthy();
  });

  test('active session survives move between same-permission columns (Executing → Code Review → Testing)', async () => {
    const title = `Survive Move ${runId}`;
    await createTask(page, title, 'Test session survives same-permission move');

    const taskId = await getTaskId(page, title);

    // Move to Executing → spawns session (default permission mode)
    await moveTask(page, taskId, lanes['Executing']);
    await waitForTaskSession(page, taskId);
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');

    // Record the session ID assigned to this task
    const sessionBefore = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find(
        (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
      );
    }, taskId);
    expect(sessionBefore).toBeTruthy();
    const sessionIdBefore = sessionBefore.id;

    // Move to Code Review → session should stay alive (same permission mode, no auto_command).
    // The move is fire-and-forget IPC; poll for the task to land in its new lane
    // before reading session state, instead of a fixed 1000ms wait.
    await moveTask(page, taskId, lanes['Code Review']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.list();
        return tasks.find((t: { id: string; swimlane_id: string }) => t.id === tid)?.swimlane_id;
      }, taskId);
    }, { timeout: 3000 }).toBe(lanes['Code Review']);

    // Verify the same PTY session is still running
    const sessionAfterReview = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find(
        (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
      );
    }, taskId);
    expect(sessionAfterReview).toBeTruthy();
    expect(sessionAfterReview.id).toBe(sessionIdBefore);

    // Move to Testing → session still alive
    await moveTask(page, taskId, lanes['Testing']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.list();
        return tasks.find((t: { id: string; swimlane_id: string }) => t.id === tid)?.swimlane_id;
      }, taskId);
    }, { timeout: 3000 }).toBe(lanes['Testing']);

    const sessionAfterRunning = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find(
        (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
      );
    }, taskId);
    expect(sessionAfterRunning).toBeTruthy();
    expect(sessionAfterRunning.id).toBe(sessionIdBefore);
  });

  test('Done suspends + archives, unarchive to Code Review resumes session', async () => {
    const title = `Done Unarchive ${runId}`;
    await createTask(page, title, 'Test Done/unarchive resume to non-agent column');

    const taskId = await getTaskId(page, title);

    // Move to Planning → spawns session
    await moveTask(page, taskId, lanes['Planning']);
    await waitForTaskSession(page, taskId);

    const scrollback1 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Move to Done → suspends session + archives task. Poll for both
    // conditions instead of the manual 20-iteration loop + buffer wait.
    await moveTask(page, taskId, lanes['role:done']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.some(
          (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
        );
      }, taskId);
    }, { timeout: 10000 }).toBe(false);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.listArchived();
        return tasks.some((t: { id: string }) => t.id === tid);
      }, taskId);
    }, { timeout: 5000 }).toBe(true);

    // Unarchive to Code Review (non-agent column) → should RESUME
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    // Wait for session to resume
    await waitForTaskSession(page, taskId);

    // Wait for the RESUMED marker
    const scrollback2 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // Same Claude session ID should be preserved
    expect(resumedSessionId).toBe(originalSessionId);
  });

  test('To Do → Done → Unarchive to Code Review spawns fresh agent (no prior session)', async () => {
    const title = `No Prior Session ${runId}`;
    await createTask(page, title, 'Test fresh spawn when no prior session exists');

    const taskId = await getTaskId(page, title);

    // Move directly to Done (no session was ever created) → archives.
    await moveTask(page, taskId, lanes['role:done']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.listArchived();
        return tasks.some((t: { id: string }) => t.id === tid);
      }, taskId);
    }, { timeout: 5000 }).toBe(true);

    // Unarchive to Code Review → should spawn a FRESH session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    await waitForTaskSession(page, taskId);

    const scrollback = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    expect(scrollback).toContain('MOCK_CLAUDE_SESSION:');
    const sessionId = extractSessionId(scrollback, 'SESSION');
    expect(sessionId).toBeTruthy();
  });

  test('Exited session preserved for resume through Done → Unarchive cycle', async () => {
    const title = `Exited Resume ${runId}`;
    await createTask(page, title, 'Test exited session gets preserved and resumed');

    const taskId = await getTaskId(page, title);

    // Move to Planning → spawns session
    await moveTask(page, taskId, lanes['Planning']);
    await waitForTaskSession(page, taskId);

    const scrollback1 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    const runningSessionId = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const runningSession = sessions.find(
        (session: { taskId: string; status: string }) => session.taskId === tid && session.status === 'running',
      );
      return runningSession?.id ?? null;
    }, taskId);
    expect(runningSessionId).toBeTruthy();

    // The session has to end on its own terms, with an 'exited' record, not a
    // suspend. Typing /exit does not do it: it ends the AGENT, but the agent runs
    // inside an interactive shell that survives it, so the PTY stays up and the
    // row stays 'running' until the agent-absence sweep retires it, 60 to 120 s
    // later on an idle machine (AGENT_ABSENCE_SWEEP_INTERVAL_MS in
    // background-shell/watcher.ts).
    //
    // So end the PTY the way the sweep itself does, with a kill through the
    // session manager, then wait on THIS task's rows only: earlier tests in this
    // file leave sessions alive in the shared app, so a global "no running
    // sessions" wait would never be true.
    await page.evaluate((sessionId) => window.electronAPI.sessions.kill(sessionId), runningSessionId!);
    await waitForTaskSessionNotRunning(page, taskId);
    const taskStatusesAfterKill = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions
        .filter((session: { taskId: string }) => session.taskId === tid)
        .map((session: { status: string }) => session.status);
    }, taskId);
    // The row is either kept as 'exited' or already evicted; never 'suspended'
    // or 'running' at this point. An evicted row leaves no status at all, which
    // is allowed here: the resume after Unarchive below is what proves the
    // record survived.
    expect(taskStatusesAfterKill.filter((status: string) => status !== 'exited')).toEqual([]);

    // Move to Done → should mark 'exited' record as 'suspended' + archive.
    await moveTask(page, taskId, lanes['role:done']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.listArchived();
        return tasks.some((t: { id: string }) => t.id === tid);
      }, taskId);
    }, { timeout: 5000 }).toBe(true);

    // Unarchive to Code Review → should RESUME the previous session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    await waitForTaskSession(page, taskId);

    const scrollback2 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // Same Claude session ID should be preserved
    expect(resumedSessionId).toBe(originalSessionId);
  });

  test('To Do → Planning → To Do → Done: no false resume from exited session', async () => {
    const title = `No False Resume ${runId}`;
    await createTask(page, title, 'Test that To Do exited sessions are not resumed by Done');

    const taskId = await getTaskId(page, title);

    // Move to Planning → spawns session
    await moveTask(page, taskId, lanes['Planning']);
    await waitForTaskSession(page, taskId);
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:', 30000);

    // Move to To Do → kills session, marks 'exited'. Wait on THIS task's
    // session only (see the note in the "Exited session preserved" test).
    await moveTask(page, taskId, lanes['role:todo']);
    await waitForTaskSessionNotRunning(page, taskId);

    // Move to Done → archives. Since session is 'exited' (not 'suspended'),
    // Done should NOT spawn or resume -- just archive silently.
    await moveTask(page, taskId, lanes['role:done']);
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const tasks = await window.electronAPI.tasks.listArchived();
        return tasks.some((t: { id: string }) => t.id === tid);
      }, taskId);
    }, { timeout: 5000 }).toBe(true);

    // Give any latent spawn 1s to surface before asserting non-occurrence.
    // This is intentionally a fixed wait - we can't poll for "nothing happens"
    // without adding a budget for the negative case.
    await page.waitForTimeout(1000);

    // Verify no running sessions for this task (Done should not spawn)
    const hasRunning = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.some(
        (s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running',
      );
    }, taskId);
    expect(hasRunning).toBe(false);
  });
});
