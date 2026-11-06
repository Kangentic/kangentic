/**
 * E2E: a folder and the databases around it, across real launches.
 *
 * Real wiring only this tier has: two real app launches over one project folder,
 * a real worktree deleted between them, and the cold open's own order of passes.
 * The rule is `.claude/rules/project-folder-ownership.md`, and its logic is pinned
 * in `project-ownership.test.ts` and `project-folder-sweep.test.ts`. Here only
 * that the open paths reach it.
 *
 *   1. A worktree folder goes while the app is closed. The card stays, its
 *      branch stays on the row, no agent starts, and Resume recreates the folder.
 *   2. A second instance starts on a copy of `index.db` with no per-project
 *      database, which is what deleted real data on 2026-11-05. It sweeps nothing.
 *      The owner, opening afterwards, still sweeps, into `set-aside`.
 *
 * Every path here is under a temp folder. No test may put a real project path in
 * an instance's database: startup opens every registered project.
 *
 * Red-green: restore the delete in the cold open and (1) fails on the task row;
 * drop the gate in `runColdOpenPasses` and (2) fails on the orphans.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  dismissOnboardingChecklist,
  mockAgentPath,
  moveTaskIpc,
  waitForTaskSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  closeAppAndWaitForExit,
} from './helpers';

const TEST_NAME = 'project-folder-ownership';
const SECOND_INSTANCE = `${TEST_NAME}-second-instance`;

function writeTestConfig(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    hasCompletedFirstRun: true,
    agent: { cliPaths: { claude: mockAgentPath('claude') }, permissionMode: 'default', maxConcurrentSessions: 5 },
    git: { worktreesEnabled: true },
  }));
}

/** Open the project as a launch does, with the board on screen. */
async function openProject(page: Page, projectPath: string): Promise<void> {
  await page.evaluate((folder) => window.electronAPI.projects.openByPath(folder), projectPath);
  await page.reload();
  await dismissOnboardingChecklist(page);
  await waitForBoard(page);
}

/**
 * The persisted logs, for a pass that leaves nothing else to see. Warnings always
 * reach one of them: the current project's, or the data directory's while no project
 * is current, which depends on how the cold open lands against boot. Not the app's
 * stdout: the copied index makes startup open the project before `launchApp` returns,
 * so a listener attached after it misses the line.
 */
function persistedLogs(...logsFolders: string[]): string {
  return logsFolders
    .filter((logsFolder) => fs.existsSync(logsFolder))
    .flatMap((logsFolder) => fs.readdirSync(logsFolder).map((name) => fs.readFileSync(path.join(logsFolder, name), 'utf-8')))
    .join('\n');
}

/** A folder past the sweep's 10 minute grace, holding a file. */
function oldFolder(folder: string, fileName: string): string {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, fileName), 'real data');
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(folder, past, past);
  return folder;
}

test.describe('a project folder across launches', () => {
  test.describe.configure({ mode: 'serial' });
  const dataDir = getTestDataDir(TEST_NAME);
  const secondDataDir = getTestDataDir(SECOND_INSTANCE);
  let projectPath: string;

  test.beforeAll(() => {
    cleanupTestDataDir(TEST_NAME);
    cleanupTestDataDir(SECOND_INSTANCE);
    writeTestConfig(dataDir);
    projectPath = createTempProject(TEST_NAME);
  });

  test.afterAll(() => {
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
    cleanupTestDataDir(SECOND_INSTANCE);
  });

  test('a worktree that went while the app was closed keeps its card, and Resume makes it again', async () => {
    test.setTimeout(150_000);
    const title = `Folder gone ${Date.now()}`;

    let { app, page } = await launchApp({ dataDir });
    await createProject(page, 'Folder gone', projectPath);
    await createTask(page, title, 'Survives losing its worktree');
    const { planning } = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);
    await moveTaskIpc(page, taskId, planning);
    await waitForTaskSession(page, taskId, 30_000);
    const before = await page.evaluate(async (id) => {
      const task = (await window.electronAPI.tasks.list()).find((candidate) => candidate.id === id);
      return { worktreePath: task?.worktree_path ?? null, branchName: task?.branch_name ?? null };
    }, taskId);
    expect(before.worktreePath).toBeTruthy();
    expect(before.branchName).toBeTruthy();
    await closeAppAndWaitForExit(app);

    const worktreePath = before.worktreePath as string;
    fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

    ({ app, page } = await launchApp({ dataDir }));
    await openProject(page, projectPath);

    // Not running, and saying why, with Resume there to press.
    await expect
      .poll(async () => page.evaluate(async (id) => {
        const row = (await window.electronAPI.sessions.list()).find((session) => session.taskId === id);
        return { status: row?.status, reason: row?.startBlockedReason };
      }, taskId), { timeout: 30_000, intervals: [250, 500, 1000] })
      .toEqual({ status: 'suspended', reason: 'worktree-missing' });

    // What a person reads: the card itself, in the real renderer over the real main.
    await expect(page.locator(`[data-task-id="${taskId}"]`).locator('[data-testid="status-bar"]')).toHaveText('Worktree missing', { timeout: 15_000 });

    const after = await page.evaluate(async (id) => {
      const task = (await window.electronAPI.tasks.list()).find((candidate) => candidate.id === id);
      return { worktreePath: task?.worktree_path ?? null, branchName: task?.branch_name ?? null };
    }, taskId);
    expect(after).toEqual(before);
    expect(fs.existsSync(worktreePath)).toBe(false);

    await page.evaluate(({ id, project }) => window.electronAPI.sessions.resume(id, undefined, project), {
      id: taskId,
      project: await page.evaluate(async () => (await window.electronAPI.projects.getCurrent())?.id ?? undefined),
    });
    await waitForTaskSession(page, taskId, 30_000);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);

    await closeAppAndWaitForExit(app);
  });

  test('a second instance on a copy of the index sweeps nothing, and the owner still does', async () => {
    test.setTimeout(150_000);
    const kangentic = path.join(projectPath, '.kangentic');
    const orphanTask = oldFolder(path.join(kangentic, 'tasks', 'orphan-task'), 'attachment.png');
    const orphanWorktree = oldFolder(path.join(kangentic, 'worktrees', 'orphan-worktree'), 'uncommitted.ts');
    const markerPath = path.join(kangentic, 'project-owner.json');
    const markerBefore = fs.readFileSync(markerPath, 'utf-8');
    const sessionFolders = fs.readdirSync(path.join(kangentic, 'sessions'));

    // The incident: the real ids at the real paths, and no per-project database.
    writeTestConfig(secondDataDir);
    fs.copyFileSync(path.join(dataDir, 'index.db'), path.join(secondDataDir, 'index.db'));

    const second = await launchApp({ dataDir: secondDataDir });
    await openProject(second.page, projectPath);
    await expect
      .poll(() => persistedLogs(path.join(kangentic, 'logs'), path.join(secondDataDir, 'logs')), { timeout: 30_000 })
      .toContain('belongs to another database');
    await closeAppAndWaitForExit(second.app);

    expect(fs.existsSync(path.join(orphanTask, 'attachment.png'))).toBe(true);
    expect(fs.existsSync(path.join(orphanWorktree, 'uncommitted.ts'))).toBe(true);
    expect(fs.readdirSync(path.join(kangentic, 'sessions'))).toEqual(sessionFolders);
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(markerBefore);

    const owner = await launchApp({ dataDir });
    await openProject(owner.page, projectPath);

    await expect.poll(() => fs.existsSync(orphanTask), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => fs.existsSync(orphanWorktree), { timeout: 30_000 }).toBe(false);
    const setAsideTasks = fs.readdirSync(path.join(kangentic, 'set-aside', 'tasks'));
    expect(setAsideTasks).toHaveLength(1);
    expect(fs.existsSync(path.join(kangentic, 'set-aside', 'tasks', setAsideTasks[0], 'attachment.png'))).toBe(true);

    await closeAppAndWaitForExit(owner.app);
  });
});
