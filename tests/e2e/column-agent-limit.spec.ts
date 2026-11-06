/**
 * A column's agent limit through the real app and the mock agent CLI: the gate
 * is wired, the queue skips a full column, and the renderer hears the line.
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude), which stays alive long
 * enough to inspect state.
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

const TEST_NAME = 'column-agent-limit';
const runId = Date.now();

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') return path.join(fixturesDir, 'mock-claude.cmd');
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.describe('Column agent limit', () => {
  let app: ElectronApplication;
  let page: Page;

  const statusOf = (title: string) => page.evaluate(async (taskTitle) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidate) => candidate.title === taskTitle);
    const sessions = await window.electronAPI.sessions.list();
    // A queued resume sits beside the suspended row it resumes until it starts.
    const live = sessions.filter((session) => session.taskId === task?.id && session.status !== 'exited');
    return (live.find((session) => session.status !== 'suspended') ?? live[0])?.status ?? null;
  }, title);

  const moveTo = (title: string, column: string) => page.evaluate(async ({ taskTitle, columnName }) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidate) => candidate.title === taskTitle);
    const swimlanes = await window.electronAPI.swimlanes.list();
    const lane = swimlanes.find((candidate) => candidate.name === columnName);
    if (!task || !lane) throw new Error('Missing task or column');
    await window.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: lane.id, targetPosition: 0 });
  }, { taskTitle: title, columnName: column });

  test.beforeAll(async () => {
    const tmpDir = createTempProject(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      claude: { cliPath: mockClaudePath(), permissionMode: 'default', maxConcurrentSessions: 8 },
      git: { worktreesEnabled: false },
    }));
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Column Limit ${runId}`, tmpDir);
    await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const executing = swimlanes.find((lane) => lane.name === 'Executing');
      if (!executing) throw new Error('Missing Executing');
      await window.electronAPI.swimlanes.update({ id: executing.id, max_agents: 1 });
    });
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('runs one agent, queues the rest with global slots free, and starts the next when the first leaves', async () => {
    const first = `Limit first ${runId}`;
    const second = `Limit second ${runId}`;
    await createTask(page, first, 'One');
    await createTask(page, second, 'Two');

    await moveTo(first, 'Executing');
    await expect.poll(() => statusOf(first), { timeout: 15000 }).toBe('running');

    await moveTo(second, 'Executing');
    await expect.poll(() => statusOf(second), { timeout: 15000 }).toBe('queued');

    await expect(page.locator('[data-task-id]').filter({ hasText: second }).getByTestId('status-bar'))
      .toHaveText('Next in line...', { timeout: 10000 });

    // Leaving with its agent still running frees the column with no process
    // ending: only the move's own drain can start the next task.
    await moveTo(first, 'Planning');

    await expect.poll(() => statusOf(second), { timeout: 15000 }).toBe('running');
    expect(await statusOf(first)).toBe('running');
  });

  test('a task arriving with a running agent pauses, queues, and resumes on its turn', async () => {
    // `second` holds Executing from the test above. `first` is running in Planning.
    const first = `Limit first ${runId}`;
    const second = `Limit second ${runId}`;
    const agentSessionOf = (title: string) => page.evaluate(async (taskTitle) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((candidate) => candidate.title === taskTitle);
      const sessions = await window.electronAPI.sessions.list();
      const session = sessions.find((candidate) => candidate.taskId === task?.id && candidate.status !== 'exited' && candidate.status !== 'suspended');
      return { sessionId: session?.id ?? null, resuming: session?.resuming ?? null };
    }, title);
    const before = await agentSessionOf(first);

    await moveTo(first, 'Executing');

    await expect.poll(() => statusOf(first), { timeout: 15000 }).toBe('queued');
    expect((await agentSessionOf(first)).sessionId).not.toBe(before.sessionId);

    await moveTo(second, 'Planning');

    await expect.poll(() => statusOf(first), { timeout: 15000 }).toBe('running');
    expect((await agentSessionOf(first)).resuming).toBe(true);
  });

  test('turning the limit off starts what waits', async () => {
    const waiting = `Limit waiting ${runId}`;
    await createTask(page, waiting, 'Three');
    await moveTo(waiting, 'Executing');
    await expect.poll(() => statusOf(waiting), { timeout: 15000 }).toBe('queued');

    await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const executing = swimlanes.find((lane) => lane.name === 'Executing');
      if (!executing) throw new Error('Missing Executing');
      await window.electronAPI.swimlanes.update({ id: executing.id, max_agents: null });
    });

    await expect.poll(() => statusOf(waiting), { timeout: 15000 }).toBe('running');
  });
});
