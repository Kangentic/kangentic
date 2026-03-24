/**
 * E2E test for the session recovery re-entrancy guard.
 *
 * Verifies that:
 *  1. A brand-new task moved to Planning gets a fresh session (--session-id),
 *     NOT a --resume attempt
 *  2. Re-opening the same project (simulating a Vite hot-reload) does NOT
 *     orphan or try to resume active sessions
 *  3. After a duplicate PROJECT_OPEN, the original session is still running
 *
 * Bug context: Vite hot-reload triggers did-finish-load, which re-opens the
 * project and runs session recovery. markAllRunningAsOrphaned() was corrupting
 * records for sessions that were JUST created, causing --resume on sessions
 * with no JSONL file → "No conversation found" error.
 *
 * Uses mock-claude so tests work without a real Claude installation.
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
  cleanupTestDataDir,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-no-false-resume';
const runId = Date.now();
const PROJECT_NAME = `NoFalseResume ${runId}`;

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

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

test.describe('Claude Agent -- No False Resume on New Tasks', () => {
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
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('new task moved to Planning gets fresh session, not resume', async () => {
    // Create a task in To Do and move it to Planning via IPC
    const title = `Fresh Session ${runId}`;
    await createTask(page, title, 'Should use --session-id, not --resume');

    const { taskId, planningSwimlaneId } = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      return { taskId: task?.id, planningSwimlaneId: planning?.id };
    }, title);
    expect(taskId).toBeTruthy();
    expect(planningSwimlaneId).toBeTruthy();

    // Move to Planning → should spawn a fresh session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });

    // Wait for a running session
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!, { timeout: 15000 });

    // Wait for mock Claude to output a marker
    const start = Date.now();
    let scrollback = '';
    while (Date.now() - start < 15000) {
      scrollback = await page.evaluate(async (tid) => {
        const sessions = await window.electronAPI.sessions.list();
        const s = sessions.find((s: any) => s.taskId === tid);
        if (!s) return '';
        return window.electronAPI.sessions.getScrollback(s.id);
      }, taskId!);
      if (scrollback.includes('MOCK_CLAUDE_SESSION:') || scrollback.includes('MOCK_CLAUDE_RESUMED:')) {
        break;
      }
      await page.waitForTimeout(500);
    }

    // Must be a fresh SESSION, NOT a RESUMED marker
    expect(scrollback).toContain('MOCK_CLAUDE_SESSION:');
    expect(scrollback).not.toContain('MOCK_CLAUDE_RESUMED:');
  });

  test('duplicate PROJECT_OPEN does not orphan active sessions', async () => {
    const title = `Reopen Guard ${runId}`;
    await createTask(page, title, 'Session should survive re-open');

    const { taskId, planningSwimlaneId } = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      return { taskId: task?.id, planningSwimlaneId: planning?.id };
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });

    // Wait for a running session
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!, { timeout: 15000 });

    // Record the current session ID
    const sessionBefore = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      return s?.id ?? null;
    }, taskId!);
    expect(sessionBefore).toBeTruthy();

    // Simulate what Vite hot-reload does: call PROJECT_OPEN again for the
    // same project. This should be a no-op for recovery.
    await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      if (project) {
        await window.electronAPI.projects.open(project.id);
      }
    });

    // Brief pause for any recovery to settle
    await page.waitForTimeout(1000);

    // The session should STILL be running with the same ID
    const sessionAfter = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      return s?.id ?? null;
    }, taskId!);

    expect(sessionAfter).toBe(sessionBefore);

    // Verify the session is actually alive (mock Claude is still producing output)
    const scrollback = await page.evaluate(async (sid) => {
      return window.electronAPI.sessions.getScrollback(sid);
    }, sessionBefore!);
    expect(scrollback.length).toBeGreaterThan(0);
  });
});
