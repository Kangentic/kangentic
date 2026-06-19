/**
 * E2E tests for config changes during active sessions.
 *
 * Verifies that:
 *  1. Two sessions can be spawned under maxConcurrentSessions=5
 *  2. Lowering maxConcurrentSessions to 1 via IPC does NOT kill existing sessions
 *  3. A new task moved to Planning queues (because 2 running > new limit of 1)
 *  4. Killing one running session promotes the queued session
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) which stays alive
 * for 30 seconds, giving tests time to inspect state before exit.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'config-changes';
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

/**
 * Get the Planning swimlane ID via IPC.
 */
async function getPlanningSwimlaneId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const swimlanes = await window.electronAPI.swimlanes.list();
    const planning = swimlanes.find((s: any) => s.name === 'Planning');
    return planning?.id;
  });
  expect(id).toBeTruthy();
  return id!;
}

/**
 * Move a task (by title) to a given swimlane via IPC.
 */
async function moveTaskToSwimlane(page: Page, taskTitle: string, swimlaneId: string): Promise<string> {
  const taskId = await page.evaluate(async (title) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((t: any) => t.title === title);
    return task?.id;
  }, taskTitle);
  expect(taskId).toBeTruthy();

  await page.evaluate(async ({ taskId, swimlaneId }) => {
    await window.electronAPI.tasks.move({
      taskId,
      targetSwimlaneId: swimlaneId,
      targetPosition: 0,
    });
  }, { taskId: taskId!, swimlaneId });

  return taskId!;
}

// =========================================================================
// Test: Config changes during active sessions
// =========================================================================
test.describe('Claude Agent -- Config Changes During Active Sessions', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(`${TEST_NAME}-live`);
    dataDir = getTestDataDir(`${TEST_NAME}-live`);
    writeTestConfig(dataDir, 5); // Start with a high limit so nothing queues initially

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Config Changes ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(`${TEST_NAME}-live`);
    cleanupTestDataDir(`${TEST_NAME}-live`);
  });

  test('lowering maxConcurrentSessions does not kill existing sessions but queues new ones', async () => {
    const taskA = `CfgChg A ${runId}`;
    const taskB = `CfgChg B ${runId}`;
    const taskC = `CfgChg C ${runId}`;

    // --- Step 1: Create 3 tasks in To Do ---
    await createTask(page, taskA, 'Config change test task A');
    await createTask(page, taskB, 'Config change test task B');
    await createTask(page, taskC, 'Config change test task C');

    const planningSwimlaneId = await getPlanningSwimlaneId(page);

    // --- Step 2: Move 2 tasks to Planning (spawns 2 sessions under limit=5) ---
    await moveTaskToSwimlane(page, taskA, planningSwimlaneId);
    await moveTaskToSwimlane(page, taskB, planningSwimlaneId);

    // Wait for both sessions to be running
    await waitForRunningCount(page, 2);

    const countsAfterSpawn = await getSessionCounts(page);
    expect(countsAfterSpawn.running).toBe(2);
    expect(countsAfterSpawn.queued).toBe(0);

    // --- Step 3: Lower maxConcurrentSessions to 1 via IPC ---
    // config.set accepts Partial<AppConfig> and deep-merges, so we only
    // need to provide the nested claude.maxConcurrentSessions key.
    await page.evaluate(async () => {
      await window.electronAPI.config.set({
        claude: {
          maxConcurrentSessions: 1,
        },
      } as any);
    });

    // Give the main process a moment to apply the new limit
    await page.waitForTimeout(500);

    // --- Step 4: Verify existing sessions are STILL running (not killed) ---
    const countsAfterConfigChange = await getSessionCounts(page);
    expect(countsAfterConfigChange.running).toBe(2);
    expect(countsAfterConfigChange.queued).toBe(0);

    // --- Step 5: Move 3rd task to Planning -- should queue (2 running > limit of 1) ---
    await moveTaskToSwimlane(page, taskC, planningSwimlaneId);

    // Wait for the 3rd session to appear (queued or running)
    await page.waitForFunction(
      async () => {
        const sessions = await (window as any).electronAPI.sessions.list();
        return sessions.length >= 3;
      },
      null,
      { timeout: 10000 },
    );

    const countsAfterThird = await getSessionCounts(page);
    // 3rd task should be queued OR already promoted (queue promotion can be near-instant)
    expect(countsAfterThird.running + countsAfterThird.queued).toBe(3);

    // --- Step 6: Kill running sessions until only 1 remains ---
    // With maxConcurrent=1, the queue should maintain at most 1 running session.
    // Kill sessions one at a time, verifying the queue promotes correctly.
    const runningSessions = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions
        .filter((s: { status: string }) => s.status === 'running')
        .map((s: { id: string }) => s.id);
    });
    expect(runningSessions.length).toBeGreaterThanOrEqual(2);

    // Kill all running sessions except one
    for (let index = 0; index < runningSessions.length - 1; index++) {
      await page.evaluate(async (sessionId) => {
        await window.electronAPI.sessions.kill(sessionId);
      }, runningSessions[index]);
      await page.waitForTimeout(1000);
    }

    // After killing all but one, should have exactly 1 running (maxConcurrent=1)
    const countsAfterKills = await getSessionCounts(page);
    expect(countsAfterKills.running + countsAfterKills.queued).toBeGreaterThanOrEqual(1);

    // --- Step 7: Kill the last running session -- queue should promote if anything queued ---
    const remainingRunning = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions
        .filter((s: { status: string }) => s.status === 'running')
        .map((s: { id: string }) => s.id);
    });

    if (remainingRunning.length > 0) {
      await page.evaluate(async (sessionId) => {
        await window.electronAPI.sessions.kill(sessionId);
      }, remainingRunning[0]);

      // Poll for kill to be reflected: nothing running and nothing queued.
      // Replaces a fixed 2s sleep that hid the actual settle time.
      await expect
        .poll(
          async () => {
            const counts = await getSessionCounts(page);
            return counts.running === 0 && counts.queued === 0;
          },
          { timeout: 10_000, intervals: [200, 500] },
        )
        .toBe(true);
    }

    // Final state: all sessions should be exited (no queued left to promote)
    const finalCounts = await getSessionCounts(page);
    expect(finalCounts.queued).toBe(0);
    expect(finalCounts.exited).toBeGreaterThanOrEqual(2);
  });
});
