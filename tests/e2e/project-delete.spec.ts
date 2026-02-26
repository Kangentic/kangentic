/**
 * E2E tests for project deletion cleanup.
 *
 * Verifies that deleting a project:
 *  - Removes the `.kangentic/` directory
 *  - Removes the `.claude/` directory when it only contained our hooks
 *  - Preserves `.claude/` when the user has their own files (e.g. CLAUDE.md)
 *  - Strips the `.kangentic/` entry from `.gitignore`
 *  - Fully purges sessions from SessionManager (no cross-project bleed)
 *  - Leaves the rest of the project directory intact
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

const TEST_NAME = 'project-delete';
const runId = Date.now();
let app: ElectronApplication;
let page: Page;
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
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(`${TEST_NAME}-clean`);
  cleanupTempProject(`${TEST_NAME}-preserve`);
  cleanupTempProject(`${TEST_NAME}-bleed`);
});

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

test.describe('Project Delete Cleanup', () => {
  test('removes .kangentic/ and empty .claude/ on delete', async () => {
    const tmpDir = createTempProject(`${TEST_NAME}-clean`);
    const projectName = `CleanDel ${runId}`;
    await createProject(page, projectName, tmpDir);

    // Create a task and move to Running to spawn a session (which injects hooks)
    const taskTitle = `Cleanup Task ${runId}`;
    await createTask(page, taskTitle, 'Will be cleaned up');
    await dragTaskToColumn(taskTitle, 'Running');
    await waitForSession(taskTitle);

    // Verify .kangentic/ and .claude/settings.local.json were created
    expect(fs.existsSync(path.join(tmpDir, '.kangentic'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(true);

    // Verify .gitignore has our entry
    const gitignoreBefore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignoreBefore).toContain('.kangentic/');

    // Capture session ID before delete
    const sessionId = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: any) => tk.title === title);
      return t?.session_id ?? null;
    }, taskTitle);
    expect(sessionId).not.toBeNull();

    // Delete the project via IPC
    const projectId = await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      return project?.id;
    });
    await page.evaluate(async (id) => {
      await window.electronAPI.projects.delete(id);
    }, projectId);
    await page.waitForTimeout(500);

    // .kangentic/ should be gone
    expect(fs.existsSync(path.join(tmpDir, '.kangentic'))).toBe(false);

    // .claude/ should be gone (it only contained our settings.local.json)
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);

    // .gitignore should NOT contain .kangentic/ anymore
    if (fs.existsSync(path.join(tmpDir, '.gitignore'))) {
      const gitignoreAfter = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignoreAfter).not.toContain('.kangentic');
    }

    // Session should be fully purged from SessionManager (not just killed)
    const sessionStillExists = await page.evaluate(async (sid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.some((s: any) => s.id === sid);
    }, sessionId);
    expect(sessionStillExists).toBe(false);

    // Rest of project directory is untouched
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
  });

  test('preserves .claude/ when user has their own files', async () => {
    const tmpDir = createTempProject(`${TEST_NAME}-preserve`);
    const projectName = `PreserveDel ${runId}`;
    await createProject(page, projectName, tmpDir);

    // Create a task and move to Running to spawn a session (injects hooks)
    const taskTitle = `Preserve Task ${runId}`;
    await createTask(page, taskTitle, 'Claude dir has user files');
    await dragTaskToColumn(taskTitle, 'Running');
    await waitForSession(taskTitle);

    // Verify our hooks file was created
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(true);

    // Add a user file to .claude/ (simulating user's own Claude config)
    fs.writeFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), '# My project instructions\n');

    // Delete the project
    const projectId = await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      return project?.id;
    });
    await page.evaluate(async (id) => {
      await window.electronAPI.projects.delete(id);
    }, projectId);
    await page.waitForTimeout(500);

    // .kangentic/ should be gone
    expect(fs.existsSync(path.join(tmpDir, '.kangentic'))).toBe(false);

    // .claude/ should still exist (user's file is in there)
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true);

    // Our hooks file should be gone
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);

    // User's file should be preserved
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  test('new project after delete has no stale sessions', async () => {
    const tmpDir = createTempProject(`${TEST_NAME}-bleed`);
    const projectName = `NoBleeed ${runId}`;
    await createProject(page, projectName, tmpDir);

    // Sessions from previous project should not appear
    const sessions = await page.evaluate(async () => {
      return window.electronAPI.sessions.list();
    });
    expect(sessions).toEqual([]);

    // Board should have default swimlanes and no tasks
    await waitForBoard(page);
    const tasks = await page.evaluate(async () => {
      return window.electronAPI.tasks.list();
    });
    expect(tasks).toEqual([]);
  });
});
