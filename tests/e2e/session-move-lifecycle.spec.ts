/**
 * E2E tests for session lifecycle across column moves.
 *
 * Covers scenarios introduced by the priority-ordered TASK_MOVE handler:
 *  1. Backlog → non-agent column (Code Review) spawns a fresh session
 *  2. Active session survives moves between non-kill columns (Code Review → Tests)
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
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (!s) return '';
      return window.electronAPI.sessions.getScrollback(s.id);
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
    const task = tasks.find((tk: any) => tk.title === t);
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

/** Wait for at least one running session */
async function waitForRunningSession(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(async () => {
    const sessions = await (window as any).electronAPI.sessions.list();
    return sessions.some((s: any) => s.status === 'running');
  }, null, { timeout: timeoutMs });
}

/** Wait for zero running sessions */
async function waitForNoRunningSessions(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(async () => {
    const sessions = await (window as any).electronAPI.sessions.list();
    return !sessions.some((s: any) => s.status === 'running');
  }, null, { timeout: timeoutMs });
}

// =========================================================================
// Tests
// =========================================================================
test.describe('Claude Agent — Session Move Lifecycle', () => {
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
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('Backlog → Code Review spawns a fresh session (non-agent column)', async () => {
    const title = `Backlog Review ${runId}`;
    await createTask(page, title, 'Test fresh spawn on non-agent column');

    const taskId = await getTaskId(page, title);

    // Move directly from Backlog → Code Review (skipping agent columns)
    await moveTask(page, taskId, lanes['Code Review']);

    // Wait for a session to start
    await waitForRunningSession(page);

    // Wait for mock Claude to output its marker
    const scrollback = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');

    // Must be a FRESH session, not a resumed one
    expect(scrollback).toContain('MOCK_CLAUDE_SESSION:');
    const sessionId = extractSessionId(scrollback, 'SESSION');
    expect(sessionId).toBeTruthy();

    // Verify task now has a running session
    const taskSession = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId);
    expect(taskSession).toBeTruthy();
  });

  test('active session survives move between non-kill columns (Planning → Code Review → Tests)', async () => {
    const title = `Survive Move ${runId}`;
    await createTask(page, title, 'Test session survives non-kill move');

    const taskId = await getTaskId(page, title);

    // Move to Planning → spawns session
    await moveTask(page, taskId, lanes['Planning']);
    await waitForRunningSession(page);
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');

    // Record the session ID assigned to this task
    const sessionBefore = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId);
    expect(sessionBefore).toBeTruthy();
    const sessionIdBefore = sessionBefore.id;

    // Move to Code Review → session should stay alive (Priority 3: keep alive)
    await moveTask(page, taskId, lanes['Code Review']);
    await page.waitForTimeout(1000);

    // Verify the same PTY session is still running
    const sessionAfterReview = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId);
    expect(sessionAfterReview).toBeTruthy();
    expect(sessionAfterReview.id).toBe(sessionIdBefore);

    // Move to Tests → session still alive
    await moveTask(page, taskId, lanes['Tests']);
    await page.waitForTimeout(1000);

    const sessionAfterRunning = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
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
    await waitForRunningSession(page);

    const scrollback1 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Move to Done → suspends session + archives task
    await moveTask(page, taskId, lanes['role:done']);

    // Wait for session to stop running
    // Poll manually to handle timing
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      const running = await page.evaluate(async (tid) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
      }, taskId);
      if (!running) break;
    }

    await page.waitForTimeout(1000);

    // Verify task is archived
    const isArchived = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.listArchived();
      return tasks.some((t: any) => t.id === tid);
    }, taskId);
    expect(isArchived).toBe(true);

    // Unarchive to Code Review (non-agent column) → should RESUME
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    // Wait for session to resume
    await waitForRunningSession(page);

    // Wait for the RESUMED marker
    const scrollback2 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // Same Claude session ID should be preserved
    expect(resumedSessionId).toBe(originalSessionId);
  });

  test('Backlog → Done → Unarchive to Code Review spawns fresh agent (no prior session)', async () => {
    const title = `No Prior Session ${runId}`;
    await createTask(page, title, 'Test fresh spawn when no prior session exists');

    const taskId = await getTaskId(page, title);

    // Move directly to Done (no session was ever created) → archives
    await moveTask(page, taskId, lanes['role:done']);
    await page.waitForTimeout(1000);

    // Verify task is archived
    const isArchived = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.listArchived();
      return tasks.some((t: any) => t.id === tid);
    }, taskId);
    expect(isArchived).toBe(true);

    // Unarchive to Code Review → should spawn a FRESH session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    await waitForRunningSession(page);

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
    await waitForRunningSession(page);

    const scrollback1 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Send /exit to make mock Claude exit naturally
    await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (s) await window.electronAPI.sessions.write(s.id, '/exit\r');
    }, taskId);

    // Wait for the session to exit
    await waitForNoRunningSessions(page);
    await page.waitForTimeout(1000);

    // Move to Done → should mark 'exited' record as 'suspended' + archive
    await moveTask(page, taskId, lanes['role:done']);
    await page.waitForTimeout(1000);

    // Verify task is archived
    const isArchived = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.listArchived();
      return tasks.some((t: any) => t.id === tid);
    }, taskId);
    expect(isArchived).toBe(true);

    // Unarchive to Code Review → should RESUME the previous session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: lanes['Code Review'] });

    await waitForRunningSession(page);

    const scrollback2 = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // Same Claude session ID should be preserved
    expect(resumedSessionId).toBe(originalSessionId);
  });

  test('Backlog → Planning → Backlog → Done: no false resume from exited session', async () => {
    const title = `No False Resume ${runId}`;
    await createTask(page, title, 'Test that Backlog exited sessions are not resumed by Done');

    const taskId = await getTaskId(page, title);

    // Move to Planning → spawns session
    await moveTask(page, taskId, lanes['Planning']);
    await waitForRunningSession(page);
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:', 30000);

    // Move to Backlog → kills session, marks 'exited'
    await moveTask(page, taskId, lanes['role:backlog']);
    await waitForNoRunningSessions(page);
    await page.waitForTimeout(1000);

    // Move to Done → archives. Since session is 'exited' (not 'suspended'),
    // Done should NOT spawn or resume — just archive silently.
    await moveTask(page, taskId, lanes['role:done']);
    await page.waitForTimeout(2000);

    // Verify task is archived
    const isArchived = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.listArchived();
      return tasks.some((t: any) => t.id === tid);
    }, taskId);
    expect(isArchived).toBe(true);

    // Verify no running sessions for this task (Done should not spawn)
    const hasRunning = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId);
    expect(hasRunning).toBe(false);
  });
});
