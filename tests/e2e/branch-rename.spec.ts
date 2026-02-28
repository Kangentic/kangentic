/**
 * E2E tests for branch rename on task title edit and orphaned worktree pruning.
 *
 * Feature 1: When a task title is edited and the task has a worktree branch,
 *            the branch is renamed via `git branch -m` (worktree dir unchanged).
 *
 * Feature 2: On project open, tasks whose worktree directories have been
 *            deleted externally are pruned from the board.
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) so no real agent runs.
 * Worktrees are enabled so branches + directories are created on drag to Planning.
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
import { execSync } from 'node:child_process';

const TEST_NAME = 'branch-rename';
const runId = Date.now();
const PROJECT_NAME = `BranchRename ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

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

/** List git branches in a project directory */
function listBranches(cwd: string): string[] {
  const output = execSync('git branch --list --no-color', { cwd, encoding: 'utf-8' });
  return output
    .split('\n')
    .map(l => l.replace(/^[*+]?\s+/, '').trim())
    .filter(Boolean);
}

/**
 * Drag a task card to a target column using mouse events.
 */
async function dragTaskToColumn(p: Page, taskTitle: string, targetColumn: string) {
  const card = p.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = p.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await p.evaluate((targetCol) => {
    const targetEl = document.querySelector(`[data-swimlane-name="${targetCol}"]`);
    if (targetEl) targetEl.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await p.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await p.mouse.move(startX, startY);
  await p.mouse.down();
  await p.mouse.move(startX + 10, startY, { steps: 3 });
  await p.waitForTimeout(100);
  await p.mouse.move(endX, endY, { steps: 15 });
  await p.waitForTimeout(200);
  await p.mouse.up();
  await p.waitForTimeout(500);
}

/** Wait for the moveTask IPC to settle */
async function waitForMoveSettle(p: Page, column: string, taskTitle: string) {
  const col = p.locator(`[data-swimlane-name="${column}"]`);
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  try {
    await col.locator(`text=${taskTitle}`).first().locator('..').locator('text=claude').waitFor({ timeout: 10000 });
  } catch {
    await p.waitForTimeout(3000);
  }
}

/** Dismiss dialogs and ensure the board is visible */
async function ensureBoard(p: Page, projectName: string) {
  // Dispatch Escape directly on document to bypass xterm's key capture
  await p.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await p.waitForTimeout(300);
  const backlog = p.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await p.locator(`button:has-text("${projectName}")`).first().click();
  await waitForBoard(p);
}

/** Get task data via the electronAPI */
async function getTaskByTitle(p: Page, title: string) {
  return p.evaluate(async (t) => {
    const tasks = await window.electronAPI.tasks.list();
    return tasks.find((task: any) => task.title === t) || null;
  }, title);
}

/** Wait until a task has a non-null branch_name (polls the API) */
async function waitForBranch(p: Page, title: string, timeoutMs = 30000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await getTaskByTitle(p, title);
    if (task?.branch_name) return task.branch_name;
    await p.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for branch on task "${title}"`);
}

/** Open task detail dialog, edit the title, save, and close */
async function editTaskTitle(p: Page, oldTitle: string, newTitle: string) {
  const card = p.locator('[data-testid="swimlane"]').locator(`text=${oldTitle}`).first();
  await card.click();
  await p.waitForTimeout(500);

  // Edit is inside the kebab Actions menu dropdown
  const dialog = p.locator('.fixed.inset-0');
  const kebabButton = dialog.locator('button[title="Actions"]');
  await kebabButton.waitFor({ state: 'visible', timeout: 3000 });
  await kebabButton.click();
  await p.waitForTimeout(200);

  const editOption = dialog.locator('button', { hasText: /^Edit$/ });
  await editOption.waitFor({ state: 'visible', timeout: 3000 });
  await editOption.click();
  await p.waitForTimeout(200);

  const titleInput = dialog.locator('input[type="text"]');
  await titleInput.fill(newTitle);

  const saveBtn = dialog.locator('button:has-text("Save")');
  await saveBtn.click();
  await p.waitForTimeout(1000);

  // Dispatch Escape directly on document to bypass xterm's key capture
  await p.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await p.waitForTimeout(300);
}

test.describe('Branch Rename on Title Edit', () => {
  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);

    // Pre-write config with mock Claude CLI and worktrees ENABLED
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
          worktreesEnabled: true,
          autoCleanup: true,
          defaultBaseBranch: 'main',
          copyFiles: [],
        },
      }),
    );

    // Ensure the temp project has a 'main' branch
    try {
      execSync('git checkout -b main', { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // May already be on main
    }

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

  test.beforeEach(async () => {
    await ensureBoard(page, PROJECT_NAME);
  });

  test('renaming task title renames the git branch', async () => {
    test.setTimeout(90_000);
    const originalTitle = `Rename Test ${runId}`;
    const newTitle = `Renamed Task ${runId}`;

    // Create a task and drag to Planning (creates worktree + branch)
    await createTask(page, originalTitle, 'Test branch rename');
    await dragTaskToColumn(page, originalTitle, 'Planning');
    await waitForMoveSettle(page, 'Planning', originalTitle);

    // Wait for branch to be set on the task (worktree creation is async)
    const originalBranch = await waitForBranch(page, originalTitle);
    expect(originalBranch).toContain('kanban/rename-test-');

    // Verify worktree directory exists
    const task = await getTaskByTitle(page, originalTitle);
    expect(task?.worktree_path).toBeTruthy();
    expect(fs.existsSync(task!.worktree_path!)).toBe(true);
    const originalWorktreePath = task!.worktree_path!;

    // Verify the branch exists in git
    const branchesBefore = listBranches(tmpDir);
    expect(branchesBefore).toContain(originalBranch);

    // Edit the title
    await editTaskTitle(page, originalTitle, newTitle);

    // Verify the branch was renamed
    const updatedTask = await getTaskByTitle(page, newTitle);
    expect(updatedTask?.branch_name).toContain('kanban/renamed-task-');
    expect(updatedTask?.branch_name).not.toBe(originalBranch);

    // Verify via git that old branch is gone and new one exists
    const branchesAfter = listBranches(tmpDir);
    expect(branchesAfter).toContain(updatedTask!.branch_name);
    expect(branchesAfter).not.toContain(originalBranch);

    // Worktree directory should be UNCHANGED
    expect(updatedTask?.worktree_path).toBe(originalWorktreePath);
    expect(fs.existsSync(originalWorktreePath)).toBe(true);

    // Open task detail to verify branch name shows in UI
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${newTitle}`).first();
    await card.click();
    await page.waitForTimeout(500);
    await expect(page.locator(`text=${updatedTask!.branch_name}`)).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
  });

  test('rename is skipped when slug does not change', async () => {
    const originalTitle = `Slug Same ${runId}`;
    // Only change punctuation — slug stays the same
    const newTitle = `Slug Same! ${runId}`;

    await createTask(page, originalTitle, 'Test slug unchanged');
    await dragTaskToColumn(page, originalTitle, 'Planning');
    await waitForMoveSettle(page, 'Planning', originalTitle);

    const originalBranch = await waitForBranch(page, originalTitle);
    expect(originalBranch).toContain('kanban/slug-same-');

    await editTaskTitle(page, originalTitle, newTitle);

    // Branch should be unchanged (slug is identical after sanitization)
    const updatedTask = await getTaskByTitle(page, newTitle);
    expect(updatedTask?.branch_name).toBe(originalBranch);
  });
});

test.describe('Prune Orphaned Worktree Tasks', () => {
  let pruneTmpDir: string;
  let pruneDataDir: string;
  const PRUNE_TEST_NAME = 'branch-rename-prune';
  const PRUNE_PROJECT_NAME = `Prune ${runId}`;

  test.beforeAll(() => {
    pruneTmpDir = createTempProject(PRUNE_TEST_NAME);
    pruneDataDir = getTestDataDir(PRUNE_TEST_NAME);

    fs.writeFileSync(
      path.join(pruneDataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: mockClaudePath(),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: {
          worktreesEnabled: true,
          autoCleanup: true,
          defaultBaseBranch: 'main',
          copyFiles: [],
        },
      }),
    );

    try {
      execSync('git checkout -b main', { cwd: pruneTmpDir, stdio: 'ignore' });
    } catch { /* already on main */ }
  });

  test.afterAll(async () => {
    cleanupTempProject(PRUNE_TEST_NAME);
    cleanupTestDataDir(PRUNE_TEST_NAME);
  });

  test('orphaned worktree tasks are pruned on project open', async () => {
    test.setTimeout(120000);

    const orphanTask = `Orphan ${runId}`;
    const keepTask = `Keep ${runId}`;

    // Phase 1: Launch, create project, create two tasks in Planning
    let result = await launchApp({ dataDir: pruneDataDir });
    let pruneApp = result.app;
    let prunePage = result.page;
    await createProject(prunePage, PRUNE_PROJECT_NAME, pruneTmpDir);

    // Create and drag first task
    await createTask(prunePage, orphanTask, 'Will be orphaned');
    await dragTaskToColumn(prunePage, orphanTask, 'Planning');
    await waitForMoveSettle(prunePage, 'Planning', orphanTask);
    await waitForBranch(prunePage, orphanTask);

    // Create and drag second task
    await createTask(prunePage, keepTask, 'Will be kept');
    await dragTaskToColumn(prunePage, keepTask, 'Planning');
    await waitForMoveSettle(prunePage, 'Planning', keepTask);
    await waitForBranch(prunePage, keepTask);

    // Get worktree paths from the API
    const orphanTaskData = await getTaskByTitle(prunePage, orphanTask);
    const keepTaskData = await getTaskByTitle(prunePage, keepTask);
    expect(orphanTaskData?.worktree_path).toBeTruthy();
    expect(keepTaskData?.worktree_path).toBeTruthy();
    expect(fs.existsSync(orphanTaskData!.worktree_path!)).toBe(true);
    expect(fs.existsSync(keepTaskData!.worktree_path!)).toBe(true);

    // Phase 2: Close the app
    await pruneApp.close();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Manually delete the orphan worktree directory
    fs.rmSync(orphanTaskData!.worktree_path!, { recursive: true, force: true });
    execSync('git worktree prune', { cwd: pruneTmpDir, stdio: 'ignore' });

    // Phase 3: Relaunch — prune should fire on project open
    result = await launchApp({ dataDir: pruneDataDir });
    pruneApp = result.app;
    prunePage = result.page;

    // Re-open project via IPC (sidebar button uses dir basename, not project name)
    await prunePage.evaluate((p) => window.electronAPI.projects.openByPath(p), pruneTmpDir);
    await prunePage.reload();
    await waitForBoard(prunePage);

    // Wait for reconciliation to complete
    await prunePage.waitForTimeout(5000);

    // The orphaned task should be gone from the board
    await expect(prunePage.locator(`text=${orphanTask}`)).not.toBeVisible({ timeout: 5000 });

    // The kept task should still be there
    const planningCol = prunePage.locator('[data-swimlane-name="Planning"]');
    await expect(planningCol.locator(`text=${keepTask}`).first()).toBeVisible({ timeout: 10000 });

    await pruneApp.close();
  });
});
