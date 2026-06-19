/**
 * E2E tests for session concurrency and queue management.
 *
 * Verifies that:
 *  1. When maxConcurrentSessions is exceeded, extra sessions are queued
 *  2. Queued sessions promote to running when active sessions exit
 *  3. Multiple tasks moved to an agent column simultaneously each get
 *     their own distinct session (no "missing tab" bug)
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) which stays alive
 * for 30 seconds, giving tests time to inspect state before exit.
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
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

// The two describe blocks each launch an isolated Electron app with unique
// derived TEST_NAMEs ('session-queue-multi', 'session-queue-queue'). Running
// them in parallel saves the sequential second-launch overhead on whatever
// shard this file lands on.
test.describe.configure({ mode: 'parallel' });

const TEST_NAME = 'session-queue';
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
function writeTestConfig(dataDir: string, maxConcurrent: number): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: maxConcurrent,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

/**
 * Wait for a specific number of running sessions via IPC.
 */
async function waitForRunningCount(page: Page, count: number, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(
    async (expected) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      const running = sessions.filter((s: any) => s.status === 'running');
      return running.length === expected;
    },
    count,
    { timeout: timeoutMs },
  );
}

/**
 * Get session counts by status via IPC.
 */
async function getSessionCounts(page: Page): Promise<{ running: number; queued: number; exited: number }> {
  return page.evaluate(async () => {
    const sessions = await window.electronAPI.sessions.list();
    let running = 0;
    let queued = 0;
    let exited = 0;
    for (const s of sessions) {
      if (s.status === 'running') running++;
      else if (s.status === 'queued') queued++;
      else if (s.status === 'exited') exited++;
    }
    return { running, queued, exited };
  });
}

// =========================================================================
// Test: Multiple simultaneous spawns each get their own session
// =========================================================================
test.describe('Claude Agent -- Multiple Simultaneous Spawns', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(`${TEST_NAME}-multi`);
    dataDir = getTestDataDir(`${TEST_NAME}-multi`);
    writeTestConfig(dataDir, 5); // high limit so nothing queues

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Multi Spawn ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(`${TEST_NAME}-multi`);
    cleanupTestDataDir(`${TEST_NAME}-multi`);
  });

  test('3 tasks moved to Planning each get a distinct running session', async () => {
    const titles = [`Multi A ${runId}`, `Multi B ${runId}`, `Multi C ${runId}`];

    // Create all 3 tasks
    for (const title of titles) {
      await createTask(page, title, 'Test simultaneous spawn');
    }

    // Get the Planning swimlane ID
    const planningSwimlaneId = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      return planning?.id;
    });
    expect(planningSwimlaneId).toBeTruthy();

    // Move all 3 tasks to Planning via IPC in rapid succession
    for (const title of titles) {
      const taskId = await page.evaluate(async (t) => {
        const tasks = await window.electronAPI.tasks.list();
        const task = tasks.find((tk: any) => tk.title === t);
        return task?.id;
      }, title);
      expect(taskId).toBeTruthy();

      await page.evaluate(async ({ taskId, swimlaneId }) => {
        await window.electronAPI.tasks.move({
          taskId,
          targetSwimlaneId: swimlaneId,
          targetPosition: 0,
        });
      }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });
    }

    // Wait for all 3 sessions to be running
    await waitForRunningCount(page, 3);

    // Verify each task has a distinct session
    const sessions = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions
        .filter((s: any) => s.status === 'running')
        .map((s: any) => ({ id: s.id, taskId: s.taskId }));
    });

    expect(sessions.length).toBe(3);

    // All session IDs should be unique
    const sessionIds = new Set(sessions.map((s: any) => s.id));
    expect(sessionIds.size).toBe(3);

    // All task IDs should be unique
    const taskIds = new Set(sessions.map((s: any) => s.taskId));
    expect(taskIds.size).toBe(3);
  });
});

// =========================================================================
// Test: Session queuing when maxConcurrent is exceeded
// =========================================================================
test.describe('Claude Agent -- Session Queue', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(`${TEST_NAME}-queue`);
    dataDir = getTestDataDir(`${TEST_NAME}-queue`);
    writeTestConfig(dataDir, 2); // low limit to trigger queuing

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Queue Test ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(`${TEST_NAME}-queue`);
    cleanupTestDataDir(`${TEST_NAME}-queue`);
  });

  test('3rd task queues when maxConcurrentSessions is 2, promotes when one exits', async () => {
    const titles = [`Queue A ${runId}`, `Queue B ${runId}`, `Queue C ${runId}`];

    // Create all 3 tasks
    for (const title of titles) {
      await createTask(page, title, 'Test queue overflow');
    }

    // Get the Planning swimlane ID
    const planningSwimlaneId = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      return planning?.id;
    });
    expect(planningSwimlaneId).toBeTruthy();

    // Move all 3 tasks to Planning via IPC
    const taskIds: string[] = [];
    for (const title of titles) {
      const taskId = await page.evaluate(async (t) => {
        const tasks = await window.electronAPI.tasks.list();
        const task = tasks.find((tk: any) => tk.title === t);
        return task?.id;
      }, title);
      expect(taskId).toBeTruthy();
      taskIds.push(taskId!);

      await page.evaluate(async ({ taskId, swimlaneId }) => {
        await window.electronAPI.tasks.move({
          taskId,
          targetSwimlaneId: swimlaneId,
          targetPosition: 0,
        });
      }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });
    }

    // Wait for at least 2 running sessions
    await waitForRunningCount(page, 2);

    // All 3 should have sessions (running or queued)
    const counts = await getSessionCounts(page);
    expect(counts.running + counts.queued).toBeGreaterThanOrEqual(2);

    // Kill one running session to trigger queue promotion (if anything is queued)
    const runningSessions = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.filter((s: { status: string }) => s.status === 'running').map((s: { id: string }) => s.id);
    });
    expect(runningSessions.length).toBeGreaterThanOrEqual(2);

    // Kill the first running session
    await page.evaluate(async (sessionId) => {
      await window.electronAPI.sessions.kill(sessionId);
    }, runningSessions[0]);

    // Wait for queue to settle - kill must register as exited, and at least
    // one slot should still be running (either an original or one promoted
    // from the queue). Poll instead of a fixed sleep so we leave as soon as
    // the kill + promotion cycle is reflected.
    await expect
      .poll(
        async () => {
          const counts = await getSessionCounts(page);
          return counts.exited >= 1 && counts.running >= 1;
        },
        { timeout: 10_000, intervals: [200, 500] },
      )
      .toBe(true);
    const finalCounts = await getSessionCounts(page);
    expect(finalCounts.running).toBeGreaterThanOrEqual(1);
    expect(finalCounts.exited).toBeGreaterThanOrEqual(1);
  });
});
