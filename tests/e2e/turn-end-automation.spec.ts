/**
 * E2E guard for column automations that run when an agent finishes a turn
 * (#732, "On agent turn end").
 *
 * What only this tier can prove is the wiring across four layers that no unit
 * test spans: the session's `events.jsonl` (written by a real hook in
 * production, by the mock here) -> the file watcher -> the activity engine's
 * `turn-ended` -> the turn-end runner's wait for PTY silence -> the transition
 * engine running a `move_to_column` row -> a real `tasks.move` that lands the
 * task in another column. Each hop has its own unit tests; the failure this
 * spec exists for is a hop that is never connected (a listener not registered,
 * a payload the runner discards), which every one of those tests passes.
 *
 * The mock plays one finished turn (`prompt`, then `idle`) when the wrapper
 * `mock-claude-turnend` starts a fresh session. See MOCK_CLAUDE_TURN_END in
 * `tests/fixtures/mock-claude.js`. It prints nothing afterwards, so the 1.5 s
 * of PTY silence the runner waits for is genuine rather than faked.
 *
 * Source column is Executing and the destination is Code Review: neither has a
 * plan-exit target or a message, so nothing else can move the task.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  cleanupTestDataDir,
  getTestDataDir,
  closeApp,
  getTaskIdByTitle,
  moveTaskIpc,
  resolveMockAgentPath,
  waitForTaskSession,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'turn-end-automation';
const runId = Date.now();
const PROJECT_NAME = `Turn End ${runId}`;
const SOURCE_COLUMN = 'Executing';
const TARGET_COLUMN = 'Code Review';

/**
 * How long the negative test watches a task that must NOT move. A non-event
 * cannot be polled for, so this is a fixed budget with a reason: it has to
 * outlast the runner's 1.5 s PTY-silence wait plus the pass itself, and the
 * positive test finishes a whole move inside well under this once the turn has
 * ended, so a row that was going to run would have run.
 */
const NO_MOVE_OBSERVATION_MS = 5000;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;

test.describe('Turn-end automations', () => {
  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: resolveMockAgentPath('mock-claude-turnend'),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  /** A column's id by name. */
  async function columnId(name: string): Promise<string> {
    const id = await page.evaluate(async (columnName) => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      return swimlanes.find((swimlane) => swimlane.name === columnName)?.id ?? null;
    }, name);
    if (!id) throw new Error(`No column named ${name}`);
    return id;
  }

  /**
   * Give the source column exactly one turn-end row: a Move to column row to
   * the target, with no Condition (so no Automation agent is needed) and no
   * Frequency limit. The project id is passed explicitly, as the renderer does.
   */
  async function seedMoveRow(enabled: boolean): Promise<void> {
    const sourceId = await columnId(SOURCE_COLUMN);
    await page.evaluate(async ({ swimlaneId, targetColumn, rowEnabled }) => {
      const project = await window.electronAPI.projects.getCurrent();
      if (!project) throw new Error('No project is open');
      await window.electronAPI.automations.replaceForColumn(
        swimlaneId,
        [{
          name: 'Hand off',
          type: 'move_to_column',
          trigger: 'turn_end',
          enabled: rowEnabled,
          config: { targetColumn },
          condition: null,
          max_runs: null,
        }],
        project.id,
      );
    }, { swimlaneId: sourceId, targetColumn: TARGET_COLUMN, rowEnabled: enabled });
  }

  async function taskColumnId(taskId: string): Promise<string | null> {
    return page.evaluate(async (id) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((task) => task.id === id)?.swimlane_id ?? null;
    }, taskId);
  }

  /** Everything worth reading when the task did not move, so a failure names its hop. */
  async function describeTurnEndState(taskId: string, sessionId: string): Promise<string> {
    const sessionDir = path.join(tmpDir, '.kangentic', 'sessions', sessionId);
    const read = (name: string): string => {
      const file = path.join(sessionDir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '(missing)';
    };
    const state = await page.evaluate(async ({ id, session }) => {
      const tasks = await window.electronAPI.tasks.list();
      const columns = await window.electronAPI.swimlanes.list();
      const task = tasks.find((candidate) => candidate.id === id);
      const activity = await window.electronAPI.sessions.getActivity();
      const runs = await window.electronAPI.automations.runsForTask(id);
      return {
        column: columns.find((column) => column.id === task?.swimlane_id)?.name ?? null,
        activity: activity[session] ?? null,
        runs: runs.map((run) => `${run.automation_name}:${run.trigger}:${run.status}:${run.detail ?? ''}`),
      };
    }, { id: taskId, session: sessionId });
    return [
      `task column: ${state.column}`,
      `session activity: ${state.activity}`,
      `automation runs: ${JSON.stringify(state.runs)}`,
      `turn-end.emitted: ${read('turn-end.emitted')}`,
      `events.jsonl:\n${read('events.jsonl')}`,
    ].join('\n');
  }

  /** Start a task in the source column and wait until its agent has played its turn. */
  async function startTaskAndWaitForTurn(title: string): Promise<{ taskId: string; sessionId: string }> {
    await createTask(page, title, 'Plays one finished turn');
    const taskId = await getTaskIdByTitle(page, title);
    await moveTaskIpc(page, taskId, await columnId(SOURCE_COLUMN));
    const { sessionId } = await waitForTaskSession(page, taskId);
    const emitted = path.join(tmpDir, '.kangentic', 'sessions', sessionId, 'turn-end.emitted');
    await expect
      .poll(() => fs.existsSync(emitted), {
        timeout: 20_000,
        message: 'the mock agent never wrote its finished turn (is the mock-claude-turnend wrapper being used?)',
      })
      .toBe(true);
    return { taskId, sessionId };
  }

  test('a Move to column row at a turn end moves the task to the target column', async () => {
    await seedMoveRow(true);
    const { taskId, sessionId } = await startTaskAndWaitForTurn(`Turn End Move ${runId}`);
    const targetId = await columnId(TARGET_COLUMN);

    try {
      await expect
        .poll(() => taskColumnId(taskId), { timeout: 20_000, intervals: [250, 500, 1000] })
        .toBe(targetId);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${await describeTurnEndState(taskId, sessionId)}`, { cause: error });
    }

    // The move is recorded as the row's run, so "did it run" has an answer
    // that does not depend on where the task happens to be now.
    await expect
      .poll(async () => page.evaluate(async (id) => {
        const runs = await window.electronAPI.automations.runsForTask(id);
        return runs.map((run) => `${run.automation_name}:${run.type}:${run.trigger}:${run.status}`);
      }, taskId), { timeout: 10_000 })
      .toContain('Hand off:move_to_column:turn_end:succeeded');
  });

  test('a switched-off row does not move the task when its turn ends', async () => {
    await seedMoveRow(false);
    const { taskId, sessionId } = await startTaskAndWaitForTurn(`Turn End Off ${runId}`);
    const sourceId = await columnId(SOURCE_COLUMN);

    // The turn really ended: the engine reports the session idle. Without this
    // the assertion below would also pass if the turn never finished at all.
    await expect
      .poll(async () => page.evaluate(async (session) => {
        const activity = await window.electronAPI.sessions.getActivity();
        return activity[session] ?? null;
      }, sessionId), { timeout: 20_000, message: 'the engine never reported the turn as ended' })
      .toBe('idle');

    // Intentional fixed wait: see NO_MOVE_OBSERVATION_MS.
    await page.waitForTimeout(NO_MOVE_OBSERVATION_MS);
    expect(await taskColumnId(taskId), await describeTurnEndState(taskId, sessionId)).toBe(sourceId);
  });
});
