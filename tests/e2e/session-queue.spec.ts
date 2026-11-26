/**
 * E2E tests for session concurrency and queue management.
 *
 * Verifies that:
 *  1. When maxConcurrentSessions is exceeded, extra sessions are queued
 *  2. Queued sessions promote to running when active sessions exit. The
 *     wiring this needs a real PTY for: a killed session keeps its slot
 *     until the pty host reports the PTY's exit, and that exit is what
 *     marks the row exited and promotes the queue.
 *  3. Multiple tasks moved to an agent column simultaneously each get
 *     their own distinct session (no "missing tab" bug)
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
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

/**
 * Wait for a specific number of running sessions via IPC.
 *
 * expect.poll, not page.waitForFunction: an async predicate handed to
 * waitForFunction resolves on its first evaluation whatever the promise
 * resolves to, so that version never waited.
 */
async function waitForRunningCount(page: Page, count: number, timeoutMs = 15000): Promise<void> {
  await expect
    .poll(
      async () => page.evaluate(async () => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.filter((session) => session.status === 'running').length;
      }),
      {
        timeout: timeoutMs,
        intervals: [100, 250, 500],
        message: `Expected ${count} running sessions`,
      },
    )
    .toBe(count);
}

/** One row of main's session registry, as `sessions.list()` reports it. */
interface SessionRow {
  id: string;
  taskId: string;
  status: string;
}

/** Main's session registry (`listSessions`), not the renderer's replica. */
async function listSessionRows(page: Page): Promise<SessionRow[]> {
  return page.evaluate(async () => {
    const sessions = await window.electronAPI.sessions.list();
    return sessions.map((session) => ({ id: session.id, taskId: session.taskId, status: session.status }));
  });
}

/**
 * The status of one session by id, or 'missing' when its row is gone. Polled
 * as a value, so a timeout prints what the row actually read.
 */
async function sessionStatus(page: Page, sessionId: string): Promise<string> {
  const rows = await listSessionRows(page);
  return rows.find((row) => row.id === sessionId)?.status ?? 'missing';
}

/** Count of rows per status, as one comparable value. */
function countByStatus(rows: SessionRow[]): { running: number; queued: number } {
  return {
    running: rows.filter((row) => row.status === 'running').length,
    queued: rows.filter((row) => row.status === 'queued').length,
  };
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
      const planning = swimlanes.find((swimlane) => swimlane.name === 'Planning');
      return planning?.id;
    });
    expect(planningSwimlaneId).toBeTruthy();

    // Move all 3 tasks to Planning via IPC in rapid succession
    for (const title of titles) {
      const taskId = await page.evaluate(async (t) => {
        const tasks = await window.electronAPI.tasks.list();
        const task = tasks.find((candidateTask) => candidateTask.title === t);
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
        .filter((session) => session.status === 'running')
        .map((session) => ({ id: session.id, taskId: session.taskId }));
    });

    expect(sessions.length).toBe(3);

    // All session IDs should be unique
    const sessionIds = new Set(sessions.map((runningSession) => runningSession.id));
    expect(sessionIds.size).toBe(3);

    // All task IDs should be unique
    const taskIds = new Set(sessions.map((runningSession) => runningSession.taskId));
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
      const planning = swimlanes.find((swimlane) => swimlane.name === 'Planning');
      return planning?.id;
    });
    expect(planningSwimlaneId).toBeTruthy();

    // Move all 3 tasks to Planning via IPC
    const taskIds: string[] = [];
    for (const title of titles) {
      const taskId = await page.evaluate(async (t) => {
        const tasks = await window.electronAPI.tasks.list();
        const task = tasks.find((candidateTask) => candidateTask.title === t);
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

    // At cap 2, two of the three tasks run and the third waits in the queue.
    // Polled as one value so a timeout prints the counts it last saw.
    await expect
      .poll(async () => countByStatus(await listSessionRows(page)), {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'Expected 2 running sessions and 1 queued at maxConcurrentSessions 2',
      })
      .toEqual({ running: 2, queued: 1 });

    const rowsAtCap = await listSessionRows(page);
    // Each task has its own row: the queued one is the third task, not a
    // second session of a task already running.
    expect(new Set(rowsAtCap.map((row) => row.taskId))).toEqual(new Set(taskIds));
    const queuedSessionId = rowsAtCap.find((row) => row.status === 'queued')!.id;
    const killedSessionId = rowsAtCap.find((row) => row.status === 'running')!.id;
    const survivingSessionId = rowsAtCap.find((row) => row.status === 'running' && row.id !== killedSessionId)!.id;

    // Resolves once main has run kill() under the task lock.
    await page.evaluate(async (sessionId) => {
      await window.electronAPI.sessions.kill(sessionId);
    }, killedSessionId);

    // kill() only closes the PTY. The row reads 'running' and still holds its
    // slot until the PTY's exit lands (onPtyExit), so wait on that row by id.
    await expect
      .poll(async () => sessionStatus(page, killedSessionId), {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'Expected the killed session to read exited once its PTY exits',
      })
      .toBe('exited');

    // The freed slot promotes the queued session. A promotion keeps its id.
    await expect
      .poll(async () => sessionStatus(page, queuedSessionId), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'Expected the queued session to be promoted to running',
      })
      .toBe('running');

    // The cap held: the survivor and the promoted session, nothing more.
    expect(await sessionStatus(page, survivingSessionId)).toBe('running');
    expect(countByStatus(await listSessionRows(page))).toEqual({ running: 2, queued: 0 });
  });
});
