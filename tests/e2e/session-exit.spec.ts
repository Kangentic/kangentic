/**
 * E2E tests for session exit handling.
 *
 * Verifies that:
 *  1. When a session is killed, its status updates to 'exited'
 *  2. The session count decrements after exit
 *  3. Moving a task back to an agent column after exit spawns a new PTY
 *     (session ID is reused by design, but a fresh PTY is created)
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) and triggers exit
 * via the sessions.kill() IPC, which fires the PTY onExit handler.
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

const TEST_NAME = 'session-exit';
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

/** Pre-write config.json with mock Claude CLI */
function writeTestConfig(dataDir: string): void {
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
}

test.describe('Claude Agent -- Session Exit Handling', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Exit Test ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('moving to non-agent column kills session and clears running state', async () => {
    const title = `Exit Task ${runId}`;
    await createTask(page, title, 'Test session exit handling');

    // Get swimlane IDs
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      const backlog = swimlanes.find((s: any) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.backlog).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for session to be running
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    // Verify we have exactly 1 running session
    const runningBefore = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.filter((s: any) => s.status === 'running').length;
    });
    expect(runningBefore).toBe(1);

    // Move to To Do → suspends and kills the session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.backlog! });

    // Wait for the session to no longer be running.
    // Poll with manual delays to avoid timing races.
    let runningAfter = 1;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      const sessions = await page.evaluate(async () => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.map((s: any) => ({ id: s.id, taskId: s.taskId, status: s.status }));
      });
      runningAfter = sessions.filter((s: any) => s.status === 'running').length;
      if (runningAfter === 0) break;
    }
    expect(runningAfter).toBe(0);
  });

  test('moving task back to agent column after exit creates a new PTY', async () => {
    const title = `Re-spawn ${runId}`;
    await createTask(page, title, 'Test re-spawn after exit');

    // Get swimlane IDs
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      const backlog = swimlanes.find((s: any) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.backlog).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for running
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!, { timeout: 15000 });

    // Wait for scrollback to have content (session fully started)
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (!s) return false;
      const sb = await (window as any).electronAPI.sessions.getScrollback(s.id);
      return sb && sb.length > 10;
    }, taskId!, { timeout: 15000 });

    // Record the first scrollback content
    const firstScrollback = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid);
      if (!s) return '';
      return window.electronAPI.sessions.getScrollback(s.id);
    }, taskId!);

    // Move to To Do (suspends session, kills PTY)
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.backlog! });

    // Wait for no running sessions
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return !sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    await page.waitForTimeout(1000);

    // Move back to Planning → spawns new PTY
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for a new running session
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!, { timeout: 15000 });

    // Wait for the new session to produce scrollback
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (!s) return false;
      const sb = await (window as any).electronAPI.sessions.getScrollback(s.id);
      return sb && sb.includes('MOCK_CLAUDE_');
    }, taskId!, { timeout: 15000 });

    // Verify a running session exists for this task
    const newSession = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!);

    expect(newSession).toBeTruthy();
    expect(newSession.status).toBe('running');

    // To Do marks sessions as 'exited' (not 'suspended'), so re-entry
    // must spawn a FRESH session (MOCK_CLAUDE_SESSION), never a resumed one.
    // Poll until the marker appears in this task's scrollback.
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (!s) return false;
      const sb = await (window as any).electronAPI.sessions.getScrollback(s.id);
      return sb && sb.includes('MOCK_CLAUDE_SESSION:');
    }, taskId!, { timeout: 15000 });
  });
});
