/**
 * E2E guard for the workflow engine (#732): a started workflow runs its tasks
 * through their routes by itself.
 *
 * What only this tier can prove is the chain across the real app: the engine
 * starting a task through the real move path, a worktree cut from a freshly
 * fetched base, the mock agent's turn reaching the activity engine, the turn-end
 * runner asking the Automation agent (the same mock, in print mode) whether the
 * step is done, the move along the route, and the next task starting when its
 * blocker reaches Done. Each hop has unit tests; this spec exists for the hop
 * that is never connected.
 *
 * The mock is `mock-claude-workflow`: a fresh session, a resume with a prompt,
 * and a typed line each play one finished turn, and its print mode answers the
 * step check yes unless the task's title contains "needs-you" (an agent that
 * ended its turn on a question). See the wrapper's header.
 *
 * The project has a bare remote, so "freshly fetched" is observable: a commit
 * pushed to the remote after the blocker started must be in the dependent's
 * worktree, which the 30-second fetch throttle alone would have skipped.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTempProject,
  cleanupTempProject,
  cleanupTestDataDir,
  getTestDataDir,
  closeApp,
  resolveMockAgentPath,
  waitForTaskSession,
  waitForTaskSessionNotRunning,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'workflow-engine';
const runId = Date.now();
const PROJECT_NAME = `Workflow Engine ${runId}`;
const GIT_IDENTITY = ['-c', 'user.email=ci@kangentic.test', '-c', 'user.name=kangentic'];

/**
 * How long a test watches something that must NOT happen. A non-event cannot be
 * polled for, so this is a fixed budget with a reason: it outlasts the mock's
 * turn (1.5 s plus 0.5 s), the runner's 1.5 s of PTY silence and a step check,
 * which together move a task well inside it when the move is going to happen.
 */
const NO_CHANGE_OBSERVATION_MS = 6000;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let remoteDir: string;
let scratchDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

/** Push one commit to the remote's main from a separate clone; returns its sha. */
function pushCommitToRemote(message: string): string {
  const clone = fs.mkdtempSync(path.join(scratchDir, 'push-'));
  execFileSync('git', ['clone', '--quiet', remoteDir, clone]);
  git(clone, ...GIT_IDENTITY, 'commit', '--allow-empty', '-m', message);
  git(clone, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(clone, 'rev-parse', 'HEAD');
}

interface WorkflowTaskSpec {
  title: string;
  /** Column names, in board order. */
  route: string[];
}

interface StartedWorkflow {
  projectId: string;
  workflowId: string;
}

interface TaskState {
  title: string;
  taskId: string | null;
  column: string | null;
  worktreePath: string | null;
}

test.describe('Workflow engine', () => {
  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-e2e-'));
    remoteDir = path.join(scratchDir, 'remote.git');
    execFileSync('git', ['clone', '--quiet', '--bare', tmpDir, remoteDir]);
    git(tmpDir, 'remote', 'add', 'origin', remoteDir);
    git(tmpDir, 'fetch', '--quiet', 'origin');

    const dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: resolveMockAgentPath('mock-claude-workflow'),
          permissionMode: 'default',
          maxConcurrentSessions: 6,
        },
        git: { worktreesEnabled: true },
        // The Automation agent judges each step; without one every column is
        // a human gate and nothing advances by itself.
        automation: { agent: 'claude', model: 'haiku', effort: null },
      }),
    );
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);

    // Code Review gives its agent something to do, as a real board's does, so
    // a task arriving there starts a turn (typed into a running session, or as
    // the prompt of a resumed one). A column's message is its first Send
    // message row on task enter.
    await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      if (!project) throw new Error('No project is open');
      const columns = await window.electronAPI.swimlanes.list();
      const review = columns.find((column) => column.name === 'Code Review');
      if (!review) throw new Error('No Code Review column');
      await window.electronAPI.automations.replaceForColumn(
        review.id,
        [{
          name: 'Review',
          type: 'send_message',
          trigger: 'enter',
          enabled: true,
          config: { message: 'Review the change' },
          condition: null,
          max_runs: null,
        }],
        project.id,
      );
    });
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  /** Plan and start a workflow; `links` are [blocker, blocked] indexes into `tasks`. */
  async function startWorkflow(tasks: WorkflowTaskSpec[], links: Array<[number, number]>): Promise<StartedWorkflow> {
    return page.evaluate(async ({ taskSpecs, linkSpecs, title }) => {
      const project = await window.electronAPI.projects.getCurrent();
      if (!project) throw new Error('No project is open');
      const columns = await window.electronAPI.swimlanes.list();
      const columnId = (name: string): string => {
        const column = columns.find((candidate) => candidate.name === name);
        if (!column) throw new Error(`No column named ${name}`);
        return column.id;
      };
      const workflow = await window.electronAPI.workflows.create(project.id, null);
      await window.electronAPI.workflows.rename(project.id, workflow.id, title);
      const keys: string[] = [];
      for (const spec of taskSpecs) {
        const key = await window.electronAPI.workflows.addTask(project.id, workflow.id, { title: spec.title });
        await window.electronAPI.workflows.setRoute(project.id, workflow.id, key, spec.route.map(columnId));
        keys.push(key);
      }
      for (const [blocker, blocked] of linkSpecs) {
        await window.electronAPI.workflows.setLink(project.id, workflow.id, keys[blocker], keys[blocked], true);
      }
      await window.electronAPI.workflows.start(project.id, workflow.id);
      return { projectId: project.id, workflowId: workflow.id };
    }, { taskSpecs: tasks, linkSpecs: links, title: `Engine ${runId} ${tasks[0].title}` });
  }

  /** Each task of the workflow with the column it is in (Done included, though archived). */
  async function workflowTasks(workflow: StartedWorkflow): Promise<TaskState[]> {
    return page.evaluate(async ({ projectId, workflowId }) => {
      const detail = await window.electronAPI.workflows.get(projectId, workflowId);
      const columns = await window.electronAPI.swimlanes.list();
      return detail.tasks.map((task) => ({
        title: task.title,
        taskId: task.task?.id ?? null,
        column: columns.find((column) => column.id === task.swimlaneId)?.name ?? null,
        worktreePath: task.task?.worktree_path ?? null,
      }));
    }, workflow);
  }

  async function taskState(workflow: StartedWorkflow, title: string): Promise<TaskState> {
    const state = (await workflowTasks(workflow)).find((task) => task.title === title);
    if (!state) throw new Error(`No workflow task titled ${title}`);
    return state;
  }

  async function columnOf(workflow: StartedWorkflow, title: string): Promise<string | null> {
    return (await taskState(workflow, title)).column;
  }

  async function workflowState(workflow: StartedWorkflow): Promise<string> {
    return page.evaluate(async ({ projectId, workflowId }) => {
      const detail = await window.electronAPI.workflows.get(projectId, workflowId);
      return detail.workflow.state;
    }, workflow);
  }

  /** The step check's answers for a task, as the run log records them. */
  async function stepRuns(taskId: string): Promise<string[]> {
    return page.evaluate(async (id) => {
      const runs = await window.electronAPI.automations.runsForTask(id);
      return runs
        .filter((run) => run.type === 'workflow_step')
        .map((run) => `${run.status}:${run.condition_met ? 'yes' : 'no'}`);
    }, taskId);
  }

  /**
   * Everything worth reading when a task did not move, so a failure names its
   * hop: the run log, each of the task's sessions with its activity, the
   * events the mock wrote, and the end of its terminal.
   */
  async function describe(workflow: StartedWorkflow): Promise<string> {
    const tasks = await workflowTasks(workflow);
    const lines = [`workflow state: ${await workflowState(workflow)}`];
    for (const task of tasks) {
      if (!task.taskId) {
        lines.push(`${task.title}: not created`);
        continue;
      }
      const facts = await page.evaluate(async (id) => {
        const runs = await window.electronAPI.automations.runsForTask(id);
        const sessions = (await window.electronAPI.sessions.list()).filter((session) => session.taskId === id);
        const activity = await window.electronAPI.sessions.getActivity();
        const terminals: string[] = [];
        for (const session of sessions) {
          const scrollback = await window.electronAPI.sessions.getScrollback(session.id).catch(() => '');
          terminals.push(`${session.id} ${session.status} ${activity[session.id] ?? '-'}: ${scrollback.slice(-400).replace(/\s+/g, ' ')}`);
        }
        return {
          runs: runs.map((run) => `${run.automation_name}:${run.status}:${run.detail ?? ''}`),
          sessionIds: sessions.map((session) => session.id),
          terminals,
        };
      }, task.taskId);
      lines.push(`${task.title}: ${task.column} runs=${JSON.stringify(facts.runs)}`);
      lines.push(...facts.terminals.map((terminal) => `  session ${terminal}`));
      for (const sessionId of facts.sessionIds) {
        for (const root of [tmpDir, task.worktreePath].filter((candidate): candidate is string => !!candidate)) {
          const events = path.join(root, '.kangentic', 'sessions', sessionId, 'events.jsonl');
          if (fs.existsSync(events)) lines.push(`  events ${sessionId}: ${fs.readFileSync(events, 'utf-8').trim().replace(/\n/g, ' | ')}`);
        }
      }
    }
    return lines.join('\n');
  }

  async function expectColumn(workflow: StartedWorkflow, title: string, column: string, timeout = 40_000): Promise<void> {
    try {
      await expect.poll(() => columnOf(workflow, title), { timeout, intervals: [250, 500, 1000] }).toBe(column);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${await describe(workflow)}`, { cause: error });
    }
  }

  test('tasks advance along their routes on clean turn ends, and a dependent starts at its blocker\'s Done', async () => {
    test.setTimeout(150_000);
    const blocker = `Route blocker ${runId}`;
    const dependent = `Route dependent ${runId}`;
    const workflow = await startWorkflow(
      [
        { title: blocker, route: ['Executing', 'Code Review'] },
        { title: dependent, route: ['Executing'] },
      ],
      [[0, 1]],
    );

    // The blocker starts at once; the dependent waits in To Do.
    await expectColumn(workflow, blocker, 'Executing', 20_000);
    expect(await columnOf(workflow, dependent)).toBe('To Do');

    // Executing's turn ends, the check says done: on to Code Review, the last
    // column of its route, whose turn ends too: on to Done.
    await expectColumn(workflow, blocker, 'Code Review');
    await expectColumn(workflow, blocker, 'Done');
    const blockerId = (await taskState(workflow, blocker)).taskId!;
    // Polled, not read: the step records its run once the move returns, and a
    // move to Done commits the column, then suspends, reaps and removes the
    // worktree before it returns, so Done is visible before the run is.
    await expect.poll(() => stepRuns(blockerId), { timeout: 20_000 }).toEqual(['succeeded:yes', 'succeeded:yes']);

    // Its Done is the dependent's gate.
    await expectColumn(workflow, dependent, 'Executing');
    await expectColumn(workflow, dependent, 'Done');
    await expect.poll(() => workflowState(workflow), { timeout: 15_000 }).toBe('done');
  });

  test('a task whose agent ends its turn on a question stays in its column', async () => {
    test.setTimeout(90_000);
    const title = `needs-you question ${runId}`;
    const workflow = await startWorkflow([{ title, route: ['Executing', 'Code Review'] }], []);
    await expectColumn(workflow, title, 'Executing', 20_000);
    const taskId = (await taskState(workflow, title)).taskId!;

    // The check ran and answered no, with its reason in the log.
    await expect.poll(() => stepRuns(taskId), { timeout: 30_000 }).toContain('skipped:no');
    // Intentional fixed wait: see NO_CHANGE_OBSERVATION_MS.
    await page.waitForTimeout(NO_CHANGE_OBSERVATION_MS);
    expect(await columnOf(workflow, title), await describe(workflow)).toBe('Executing');
    expect(await workflowState(workflow)).toBe('running');
  });

  test('main refuses a move of a locked task, and the task stays where it is', async () => {
    test.setTimeout(90_000);
    const running = `needs-you locked running ${runId}`;
    const waiting = `Locked waiting ${runId}`;
    const workflow = await startWorkflow(
      [
        { title: running, route: ['Executing'] },
        { title: waiting, route: ['Executing'] },
      ],
      [[0, 1]],
    );
    await expectColumn(workflow, running, 'Executing', 20_000);

    const attempt = async (title: string, column: string): Promise<string | null> => {
      const { taskId } = await taskState(workflow, title);
      return page.evaluate(async ({ id, target }) => {
        const columns = await window.electronAPI.swimlanes.list();
        const targetId = columns.find((candidate) => candidate.name === target)!.id;
        try {
          await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: targetId, targetPosition: 0 });
          return null;
        } catch (error) {
          return (error as Error).message;
        }
      }, { id: taskId!, target: column });
    };

    // A task waiting on another, and a running one whose column an agent
    // judges: neither moves by hand while the workflow runs.
    expect(await attempt(waiting, 'Executing')).toMatch(/is locked while Engine .* runs\./);
    expect(await attempt(running, 'Code Review')).toMatch(/is locked while Engine .* runs\./);
    expect(await columnOf(workflow, waiting)).toBe('To Do');
    expect(await columnOf(workflow, running)).toBe('Executing');
  });

  test('Pause stops every task, a paused card moves by hand, and Resume starts its dependent from fresh code', async () => {
    test.setTimeout(150_000);
    const blocker = `needs-you paused blocker ${runId}`;
    const dependent = `Paused dependent ${runId}`;
    const workflow = await startWorkflow(
      [
        { title: blocker, route: ['Executing'] },
        { title: dependent, route: ['Executing'] },
      ],
      [[0, 1]],
    );
    await expectColumn(workflow, blocker, 'Executing', 20_000);
    const blockerId = (await taskState(workflow, blocker)).taskId!;
    await waitForTaskSession(page, blockerId, 30_000);

    // The blocker's code lands on the remote's main after the blocker started,
    // inside the fetch throttle's 30 seconds.
    const landed = pushCommitToRemote(`landed while ${blocker} ran`);

    await page.evaluate(({ projectId, workflowId }) => window.electronAPI.workflows.pause(projectId, workflowId), workflow);
    await waitForTaskSessionNotRunning(page, blockerId, 20_000);
    await expect.poll(() => workflowState(workflow), { timeout: 10_000 }).toBe('paused');

    // Paused, a card moves by hand; Done is its blocker's gate, but a paused
    // workflow starts nothing.
    await page.evaluate(async (id) => {
      const columns = await window.electronAPI.swimlanes.list();
      const done = columns.find((column) => column.role === 'done')!;
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: done.id, targetPosition: 0 });
    }, blockerId);
    await expectColumn(workflow, blocker, 'Done', 20_000);
    // Intentional fixed wait: see NO_CHANGE_OBSERVATION_MS.
    await page.waitForTimeout(NO_CHANGE_OBSERVATION_MS);
    expect(await columnOf(workflow, dependent), await describe(workflow)).toBe('To Do');

    await page.evaluate(({ projectId, workflowId }) => window.electronAPI.workflows.resume(projectId, workflowId), workflow);
    await expectColumn(workflow, dependent, 'Executing');
    await waitForTaskSession(page, (await taskState(workflow, dependent)).taskId!, 30_000);
    // Read after the spawn, which is what creates the worktree.
    const dependentState = await taskState(workflow, dependent);

    // Cut from the base as fetched at the start, not as fetched 30 seconds ago.
    expect(dependentState.worktreePath, 'the dependent started without a worktree').toBeTruthy();
    let containsLanded = true;
    try {
      execFileSync('git', ['-C', dependentState.worktreePath!, 'merge-base', '--is-ancestor', landed, 'HEAD']);
    } catch {
      containsLanded = false;
    }
    expect(containsLanded, `the dependent's worktree does not contain ${landed}`).toBe(true);
  });
});
