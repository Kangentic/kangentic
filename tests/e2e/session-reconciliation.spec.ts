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

const TEST_NAME = 'session-reconciliation';
const runId = Date.now();
let tmpDir: string;
// Shared data dir so the second launch sees the project from the first
const dataDir = getTestDataDir(TEST_NAME);

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
function writeTestConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'config.json'),
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

test.describe('Session Reconciliation', () => {
  test.beforeAll(() => {
    tmpDir = createTempProject(TEST_NAME);
    writeTestConfig(dataDir);
  });

  test.afterAll(() => {
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('sessions are reconciled after app restart for tasks in agent columns', async () => {
    const taskName = `Recon Task ${runId}`;

    // === Phase 1: Launch app, create project & task, drag to Planning ===
    let result = await launchApp({ dataDir });
    let app: ElectronApplication = result.app;
    let page: Page = result.page;

    await createProject(page, TEST_NAME, tmpDir);
    await createTask(page, taskName, 'Test session reconciliation');

    // Move task to Planning via IPC to spawn a session
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      return { planning: planning?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return task?.id;
    }, taskName);
    expect(taskId).toBeTruthy();

    await moveTask(page, taskId!, swimlaneIds.planning!);
    // Reload to sync renderer with DB after IPC-only move
    await page.reload();
    await waitForBoard(page);
    await waitForRunningSession(page);

    // Verify the task is in Planning and has a session
    const planningCol = page.locator('[data-swimlane-name="Planning"]');
    await expect(planningCol.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 15000 });

    // Wait for the agent count to become visible (session spawned)
    await expect(page.locator('text=/[1-9]\\d* agents?/')).toBeVisible({ timeout: 15000 });

    // The bottom terminal panel should have a session tab with xterm
    const sessionTab = page.locator('.resize-handle ~ div button').first();
    await expect(sessionTab).toBeVisible({ timeout: 5000 });

    // === Phase 2: Close the app ===
    await app.close();

    // Brief pause to ensure cleanup completes
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // === Phase 3: Relaunch the app and open the same project ===
    result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;

    // Re-open the project via IPC (same mechanism as createProject)
    await page.evaluate((p) => window.electronAPI.projects.openByPath(p), tmpDir);
    await page.reload();
    await waitForBoard(page);

    // Wait for the task to be loaded into the renderer (IPC → store → DOM)
    await page.waitForFunction(
      (name: string) => {
        const el = document.querySelector('[data-swimlane-name="Planning"]');
        return el?.textContent?.includes(name) ?? false;
      },
      taskName,
      { timeout: 20000 },
    );

    // === Key assertion: Session reconciliation should have spawned a new session ===
    // Wait for agent count (reconciliation runs during project open)
    await expect(page.locator('text=/[1-9]\\d* agents?/')).toBeVisible({ timeout: 20000 });

    // Verify session is running via IPC (more reliable than xterm visibility after relaunch)
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 20000 });

    // Cleanup
    await app.close();
  });
});
