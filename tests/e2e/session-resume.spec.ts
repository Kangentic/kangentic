/**
 * E2E tests for session suspend and resume.
 *
 * Verifies that:
 *  1. Moving a task out of an agent column suspends the session DB record
 *  2. Moving it back resumes with --resume (not --session-id)
 *  3. The original claude_session_id is preserved across the cycle
 *  4. Closing the app marks sessions as 'suspended' in the DB
 *  5. Relaunching resumes sessions with --resume (not fresh --session-id)
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) which outputs
 * distinct markers:
 *   MOCK_CLAUDE_SESSION:<id>   → new session via --session-id
 *   MOCK_CLAUDE_RESUMED:<id>   → resumed session via --resume
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

const TEST_NAME = 'session-resume';
const runId = Date.now();
const PROJECT_NAME = `Resume Test ${runId}`;

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
        permissionMode: 'project-settings',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

/**
 * Drag a task card to a target column using mouse events.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string) {
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

/**
 * Wait for the agent label to appear on a task card in a column.
 */
async function waitForMoveSettle(page: Page, column: string, taskTitle: string) {
  const col = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  try {
    await col.locator(`text=${taskTitle}`).first().locator('..').locator('text=claude').waitFor({ timeout: 10000 });
  } catch {
    await page.waitForTimeout(3000);
  }
}

/**
 * Poll all session scrollback for a marker string.
 * Returns the combined scrollback text if found, throws on timeout.
 */
async function waitForScrollback(page: Page, marker: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      const texts: string[] = [];
      for (const s of sessions) {
        const sb = await window.electronAPI.sessions.getScrollback(s.id);
        texts.push(sb);
      }
      return texts.join('\n---SESSION_BOUNDARY---\n');
    });

    if (scrollback.includes(marker)) {
      return scrollback;
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for scrollback containing: ${marker}`);
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

// =========================================================================
// Test: Column-move suspend & resume (Planning → Backlog → Planning)
// =========================================================================
test.describe('Claude Agent — Session Resume via Column Move', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(`${TEST_NAME}-move`);
    dataDir = getTestDataDir(`${TEST_NAME}-move`);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(`${TEST_NAME}-move`);
    cleanupTestDataDir(`${TEST_NAME}-move`);
  });

  test('moving Planning → Done → Unarchive to Planning resumes with --resume and same session ID', async () => {
    const title = `Move Resume ${runId}`;
    await createTask(page, title, 'Test suspend and resume via Done/unarchive');

    // --- Step 1: Move to Planning via IPC → spawns a NEW session ---
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      const done = swimlanes.find((s: any) => s.role === 'done');
      return { planning: planning?.id, done: done?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.done).toBeTruthy();

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
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for a running session to appear
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    // Wait for mock Claude to output its SESSION marker (task-specific)
    const scrollback1 = await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // --- Step 2: Move to Done via IPC → suspends session + archives task ---
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.done! });

    // Wait for no running sessions (session was suspended + PTY killed)
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return !sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    // Pause for DB update + onExit handler to settle
    await page.waitForTimeout(2000);

    // Verify task is now archived
    const archived = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.listArchived();
      return tasks.some((t: any) => t.id === tid);
    }, taskId!);
    expect(archived).toBe(true);

    // --- Step 3: Unarchive back to Planning → should RESUME ---
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for a running session to appear via IPC
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    // Wait for mock Claude to output its RESUMED marker
    const scrollback2 = await waitForScrollback(page, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // The resumed session ID must match the original
    expect(resumedSessionId).toBe(originalSessionId);
  });
});

// =========================================================================
// Test: Suspend & resume across app restart
// =========================================================================
test.describe('Claude Agent — Session Resume across App Restart', () => {
  let tmpDir: string;
  const dataDir = getTestDataDir(`${TEST_NAME}-restart`);

  test.beforeAll(() => {
    tmpDir = createTempProject(`${TEST_NAME}-restart`);
    writeTestConfig(dataDir);
  });

  test.afterAll(() => {
    cleanupTempProject(`${TEST_NAME}-restart`);
    cleanupTestDataDir(`${TEST_NAME}-restart`);
  });

  test('closing and relaunching the app resumes sessions with --resume', async () => {
    const title = `Restart Resume ${runId}`;

    // === Phase 1: Launch, create task, drag to Planning, verify session ===
    let result = await launchApp({ dataDir });
    let app: ElectronApplication = result.app;
    let page: Page = result.page;

    await createProject(page, `${PROJECT_NAME} Restart`, tmpDir);
    await createTask(page, title, 'Test resume across app restart');

    await dragTaskToColumn(page, title, 'Planning');
    await waitForMoveSettle(page, 'Planning', title);

    // Wait for a running session via IPC
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 15000 });

    // Wait for mock Claude to output its SESSION marker
    const scrollback1 = await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // === Phase 2: Close the app (triggers shutdownSessions) ===
    await app.close();

    // Brief pause for shutdown to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Re-write config in case shutdown cleared it
    writeTestConfig(dataDir);

    // === Phase 3: Relaunch and verify session is RESUMED ===
    result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;

    // Open the project
    const projectButton = page.locator(`button:has-text("${PROJECT_NAME} Restart")`).first();
    await expect(projectButton).toBeVisible({ timeout: 10000 });
    await projectButton.click();
    await waitForBoard(page);

    // Verify the task is still in Planning
    const planningCol = page.locator('[data-swimlane-name="Planning"]');
    await expect(planningCol.locator(`text=${title}`).first()).toBeVisible({ timeout: 10000 });

    // Wait for session recovery to spawn a running session via IPC
    await page.waitForFunction(async () => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.status === 'running');
    }, null, { timeout: 20000 });

    // Wait for the mock Claude to output a marker
    // It should be RESUMED (not SESSION) if the session was properly suspended
    let scrollback2: string;
    try {
      scrollback2 = await waitForScrollback(page, 'MOCK_CLAUDE_RESUMED:', 15000);
    } catch {
      // If RESUMED not found, check what DID happen
      const fallback = await page.evaluate(async () => {
        const sessions = await window.electronAPI.sessions.list();
        const texts: string[] = [];
        for (const s of sessions) {
          const sb = await window.electronAPI.sessions.getScrollback(s.id);
          texts.push(sb);
        }
        return texts.join('\n');
      });

      // Fail with diagnostic info
      const hasSession = fallback.includes('MOCK_CLAUDE_SESSION:');
      const hasResumed = fallback.includes('MOCK_CLAUDE_RESUMED:');
      throw new Error(
        `Expected MOCK_CLAUDE_RESUMED but not found. ` +
        `Has SESSION marker: ${hasSession}, Has RESUMED marker: ${hasResumed}. ` +
        `Scrollback (first 500 chars): ${fallback.slice(0, 500)}`,
      );
    }

    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();

    // The resumed session ID should match the original from Phase 1
    expect(resumedSessionId).toBe(originalSessionId);

    // Cleanup
    await app.close();
  });
});
