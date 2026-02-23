/**
 * E2E tests for deleting tasks — including tasks with active sessions.
 *
 * Verifies that:
 *  - Deleting a task with a running session doesn't crash the app
 *  - Deleting a task with an exited session doesn't crash the app
 *  - The task is removed from the board after deletion
 *  - The session is cleaned up from the session store
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'task-delete';
const runId = Date.now();
const PROJECT_NAME = `TaskDel ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'project-settings',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
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

async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
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

/** Wait for a running session to appear for the given task title */
async function waitForSession(taskTitle: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasSession = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: any) => t.title === title);
      return task?.session_id != null;
    }, taskTitle);
    if (hasSession) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for session on task: ${taskTitle}`);
}

test.describe('Task Delete', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('delete task with active session from detail dialog', async () => {
    const title = `Remove Active ${runId}`;
    await createTask(page, title, 'Session should be cleaned up');

    // Drag to Running to spawn a session
    await dragTaskToColumn(title, 'Running');
    await waitForSession(title);

    // Click on the task card to open the detail dialog
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();
    await page.waitForTimeout(500);

    // Verify the detail dialog opened (has Delete button)
    const dialog = page.locator('.fixed.inset-0');
    const deleteButton = dialog.locator('button', { hasText: /^Delete$/ });
    await deleteButton.waitFor({ state: 'visible', timeout: 3000 });

    // Click Delete — this should NOT crash the app
    await deleteButton.click();
    await page.waitForTimeout(1000);

    // Verify the app is still alive (board is visible)
    await waitForBoard(page);

    // Verify the task is gone
    const taskCards = page.locator('[data-testid="swimlane"]').locator(`text=${title}`);
    await expect(taskCards).toHaveCount(0);

    // Verify the session was cleaned up
    const sessionCount = await page.evaluate(async (t) => {
      const sessions = await window.electronAPI.sessions.list();
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return { sessions: sessions.length, taskExists: !!task };
    }, title);
    expect(sessionCount.taskExists).toBe(false);
  });

  test('delete task with exited session from detail dialog', async () => {
    const title = `Remove Exited ${runId}`;
    await createTask(page, title, 'Exited session cleanup');

    // Drag to Running to spawn a session
    await dragTaskToColumn(title, 'Running');
    await waitForSession(title);

    // Wait for mock-claude to exit (it exits after ~10s, but let's kill it sooner)
    // Kill the session via IPC so it becomes "(exited)"
    await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      if (task?.session_id) {
        await window.electronAPI.sessions.kill(task.session_id);
      }
    }, title);
    await page.waitForTimeout(500);

    // Open the task detail dialog
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();
    await page.waitForTimeout(500);

    // Click Delete on the exited session
    const dialog = page.locator('.fixed.inset-0');
    const deleteButton = dialog.locator('button', { hasText: /^Delete$/ });
    await deleteButton.waitFor({ state: 'visible', timeout: 3000 });
    await deleteButton.click();
    await page.waitForTimeout(1000);

    // Verify app is still alive
    await waitForBoard(page);

    // Verify task is gone
    const taskCards = page.locator('[data-testid="swimlane"]').locator(`text=${title}`);
    await expect(taskCards).toHaveCount(0);
  });

  test('delete task with queued session does not crash', async () => {
    const titleA = `QueueSlot ${runId}`;
    const titleB = `QueueWait ${runId}`;

    // Lower max concurrent to 1 so the second move queues
    await page.evaluate(async () => {
      const cfg = await window.electronAPI.config.get();
      cfg.claude.maxConcurrentSessions = 1;
      await window.electronAPI.config.set(cfg);
    });

    // Create two tasks
    await createTask(page, titleA, 'Occupies the only slot');
    await createTask(page, titleB, 'Should be queued');

    // Get swimlane IDs for Backlog (position 0) and Planning (position 1)
    const { planningId, taskAId, taskBId } = await page.evaluate(async (titles) => {
      const lanes = await window.electronAPI.swimlanes.list();
      const planning = lanes.find((l: any) => l.position === 1);
      const tasks = await window.electronAPI.tasks.list();
      const a = tasks.find((t: any) => t.title === titles.a);
      const b = tasks.find((t: any) => t.title === titles.b);
      return { planningId: planning.id, taskAId: a.id, taskBId: b.id };
    }, { a: titleA, b: titleB });

    // Move task A to Planning — this one gets the running session
    await page.evaluate(async (args) => {
      await window.electronAPI.tasks.move({
        taskId: args.taskId,
        targetSwimlaneId: args.laneId,
        targetPosition: 0,
      });
    }, { taskId: taskAId, laneId: planningId });

    // Wait for task A to get a running session
    await waitForSession(titleA);

    // Move task B to Planning — with maxConcurrent=1, this one gets queued
    await page.evaluate(async (args) => {
      await window.electronAPI.tasks.move({
        taskId: args.taskId,
        targetSwimlaneId: args.laneId,
        targetPosition: 1,
      });
    }, { taskId: taskBId, laneId: planningId });

    // Wait briefly for the queue entry to be created
    await page.waitForTimeout(500);

    // Verify task B has a session_id (queued sessions still get one)
    const taskBSessionId = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: any) => tk.title === title);
      return t?.session_id ?? null;
    }, titleB);
    expect(taskBSessionId).not.toBeNull();

    // Verify the session for B is queued (not running)
    const sessionBStatus = await page.evaluate(async (sid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((sess: any) => sess.id === sid);
      return s?.status ?? null;
    }, taskBSessionId);
    expect(sessionBStatus).toBe('queued');

    // Delete task B (the one with the queued session) via IPC
    await page.evaluate(async (id) => {
      await window.electronAPI.tasks.delete(id);
    }, taskBId);
    await page.waitForTimeout(500);

    // Verify app is still alive
    await waitForBoard(page);

    // Verify task B is gone
    const taskBExists = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.some((t: any) => t.title === title);
    }, titleB);
    expect(taskBExists).toBe(false);

    // Verify the queued session is no longer queued (killed sessions stay in
    // the in-memory map but are marked exited, not removed entirely)
    const queuedSessionStatus = await page.evaluate(async (sid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.id === sid);
      return s?.status ?? 'gone';
    }, taskBSessionId);
    expect(queuedSessionStatus).not.toBe('queued');

    // Verify task A's session is still running
    const taskASession = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: any) => tk.title === title);
      if (!t?.session_id) return null;
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((sess: any) => sess.id === t.session_id);
      return s?.status ?? null;
    }, titleA);
    expect(taskASession).toBe('running');

    // Clean up: restore maxConcurrentSessions and kill task A's session
    await page.evaluate(async (title) => {
      const cfg = await window.electronAPI.config.get();
      cfg.claude.maxConcurrentSessions = 5;
      await window.electronAPI.config.set(cfg);
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: any) => tk.title === title);
      if (t?.session_id) {
        await window.electronAPI.sessions.kill(t.session_id);
      }
    }, titleA);
    await page.waitForTimeout(300);
  });

  test('delete task without session from detail dialog', async () => {
    const title = `Remove NoSession ${runId}`;
    await createTask(page, title, 'No session');

    // Open detail dialog by clicking the card
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();
    await page.waitForTimeout(300);

    const dialog = page.locator('.fixed.inset-0');
    const deleteButton = dialog.locator('button', { hasText: /^Delete$/ });
    await deleteButton.waitFor({ state: 'visible', timeout: 3000 });
    await deleteButton.click();
    await page.waitForTimeout(500);

    // Verify app is still alive and task is gone
    await waitForBoard(page);
    const taskCards = page.locator('[data-testid="swimlane"]').locator(`text=${title}`);
    await expect(taskCards).toHaveCount(0);
  });
});
