/**
 * The Stop script before a terminal transition's reap (src/main/stop-script/terminal-stop.ts),
 * called directly with a held `runStopScript`: its shared 30 s deadline, its cap of two
 * scripts at once, and the reasons it starts none. The wiring through the real
 * `reapTaskLeftovers` (script, then reap, once per folder) is in
 * session-leftover-reap-wiring.test.ts.
 *
 * `Date.now` is spied rather than faking timers, so a `vi.waitFor` poll never moves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { StopScriptOutcome } from '../../src/main/stop-script/run-stop-script';

const { mockRunStopScript, mockIsShuttingDown, mockReportFailure } = vi.hoisted(() => ({
  mockRunStopScript: vi.fn(),
  mockIsShuttingDown: vi.fn((): boolean => false),
  mockReportFailure: vi.fn(),
}));

vi.mock('../../src/main/stop-script/run-stop-script', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/stop-script/run-stop-script')>()),
  runStopScript: (input: unknown) => mockRunStopScript(input),
}));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: () => mockIsShuttingDown() }));
vi.mock('../../src/main/stop-script/stop-script-failure', () => ({
  reportStopScriptFailure: (...args: unknown[]) => mockReportFailure(...args),
}));

import { stopBeforeReap } from '../../src/main/stop-script/terminal-stop';

const PROJECT_PATH = path.join(os.tmpdir(), 'kng-terminal-stop-project');
const RUNNING = [{ pid: 501, startKey: 'k-501', label: 'node (vite)' }];
const BUDGET_MS = 30_000;

interface HeldRun {
  input: { taskId: string; script: string; cwd: string; timeoutMs: number; signal?: AbortSignal };
  settle: (outcome: StopScriptOutcome) => void;
}

let scratch: string;
let now: number;
let held: HeldRun[];

function makeFolders(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => {
    const folder = path.join(scratch, `worktree-${index}`);
    fs.mkdirSync(folder);
    return folder;
  });
}

function tasksIn(folders: readonly string[]): Array<{ id: string; worktree_path: string | null; title?: string }> {
  return folders.map((folder, index) => ({ id: `task-${index}`, worktree_path: folder }));
}

function makeContext(options: { projects?: Array<{ id: string; path: string }>; script?: string | null } = {}) {
  const sessionManager = {
    probeTaskProcesses: vi.fn(async (_projectPath: string, tasks: Array<{ id: string }>) => (
      tasks.map((task) => ({ taskId: task.id, processes: RUNNING, connected: false }))
    )),
  };
  const context = {
    boardConfigManager: { getStopScriptForPath: vi.fn(() => (options.script === undefined ? 'npm run stop' : options.script)) },
    configManager: { load: vi.fn(() => ({ stopLeftoverProcesses: true })) },
    projectRepo: { list: vi.fn(() => options.projects ?? [{ id: 'proj-1', path: PROJECT_PATH }]) },
    sessionManager,
  } as unknown as IpcContext;
  return { context, sessionManager };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-terminal-stop-'));
  now = 1_000_000;
  held = [];
  mockRunStopScript.mockReset();
  mockReportFailure.mockReset();
  mockIsShuttingDown.mockReset();
  mockIsShuttingDown.mockReturnValue(false);
  mockRunStopScript.mockImplementation((input: HeldRun['input']) => new Promise<StopScriptOutcome>((resolve) => {
    held.push({ input, settle: resolve });
  }));
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('stopBeforeReap', () => {
  it('runs the script in each task\'s own folder, once per folder', async () => {
    const folders = makeFolders(2);
    const { context } = makeContext();
    const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(folders));

    await vi.waitFor(() => expect(held).toHaveLength(2));
    held.forEach((run) => run.settle({ status: 'ok' }));
    await done;

    expect(held.map((run) => run.input.cwd).sort()).toEqual([...folders].sort());
    expect(held.every((run) => run.input.script === 'npm run stop')).toBe(true);
  });

  it('runs at most two scripts at once, and starts the next as one ends', async () => {
    const { context } = makeContext();
    const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(4)));

    await vi.waitFor(() => expect(held).toHaveLength(2));
    // Positive control: both slots are in use, and the other two folders are waiting for one.
    expect(mockRunStopScript).toHaveBeenCalledTimes(2);

    held[0].settle({ status: 'ok' });
    await vi.waitFor(() => expect(held).toHaveLength(3));
    expect(mockRunStopScript).toHaveBeenCalledTimes(3);

    held[1].settle({ status: 'ok' });
    await vi.waitFor(() => expect(held).toHaveLength(4));
    held[2].settle({ status: 'ok' });
    held[3].settle({ status: 'ok' });
    await done;
  });

  it('gives a script that starts later what is left of one shared 30 s, not 30 s of its own', async () => {
    const { context } = makeContext();
    const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(3)));

    await vi.waitFor(() => expect(held).toHaveLength(2));
    // Two start together, so they have the same, full budget.
    expect(held[0].input.timeoutMs).toBe(BUDGET_MS);
    expect(held[1].input.timeoutMs).toBe(BUDGET_MS);

    now += 10_000;
    held[0].settle({ status: 'ok' });
    await vi.waitFor(() => expect(held).toHaveLength(3));

    expect(held[2].input.timeoutMs).toBe(BUDGET_MS - 10_000);
    held[1].settle({ status: 'ok' });
    held[2].settle({ status: 'ok' });
    await done;
  });

  it('starts no script once the shared deadline has passed', async () => {
    const { context } = makeContext();
    const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(3)));

    await vi.waitFor(() => expect(held).toHaveLength(2));
    now += BUDGET_MS;
    held[0].settle({ status: 'ok' });
    held[1].settle({ status: 'ok' });
    await done;

    expect(mockRunStopScript).toHaveBeenCalledTimes(2);
  });

  it('starts no script when the superseding move\'s signal is already aborted, and hands a live one to each', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const { context } = makeContext();
    const tasks = tasksIn(makeFolders(1));

    await stopBeforeReap(context, PROJECT_PATH, tasks, aborted.signal);
    expect(mockRunStopScript).not.toHaveBeenCalled();

    const live = new AbortController();
    const done = stopBeforeReap(context, PROJECT_PATH, tasks, live.signal);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(held[0].input.signal).toBe(live.signal);
    held[0].settle({ status: 'ok' });
    await done;
  });

  it('starts no script, and asks the host nothing, during a quit', async () => {
    mockIsShuttingDown.mockReturnValue(true);
    const { context, sessionManager } = makeContext();

    await stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(1)));

    expect(sessionManager.probeTaskProcesses).not.toHaveBeenCalled();
    expect(mockRunStopScript).not.toHaveBeenCalled();
  });

  it('asks the host nothing for a project with no script', async () => {
    const { context, sessionManager } = makeContext({ script: null });

    await stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(1)));

    expect(sessionManager.probeTaskProcesses).not.toHaveBeenCalled();
  });

  describe('a failed script', () => {
    const FAILED: StopScriptOutcome = { status: 'failed', failure: { kind: 'exit-code', exitCode: 2, detail: 'boom' } };

    it('reports under the task\'s title when it has one, else the first 8 characters of its id', async () => {
      const folders = makeFolders(2);
      const tasks = [
        { id: '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7', worktree_path: folders[0], title: 'Fix login' },
        { id: '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b', worktree_path: folders[1] },
      ];
      const { context } = makeContext();
      const done = stopBeforeReap(context, PROJECT_PATH, tasks);

      await vi.waitFor(() => expect(held).toHaveLength(2));
      held.forEach((run) => run.settle(FAILED));
      await done;

      const reported = mockReportFailure.mock.calls.map((call) => call[1] as { taskId: string; taskTitle: string; projectId: string });
      expect(reported.find((event) => event.taskId.startsWith('7a1f'))).toMatchObject({ projectId: 'proj-1', taskTitle: 'Fix login' });
      expect(reported.find((event) => event.taskId.startsWith('0b9e'))).toMatchObject({ projectId: 'proj-1', taskTitle: '0b9e8d7c' });
    });

    it('reports nothing for a task whose project path matches no project', async () => {
      const { context } = makeContext({ projects: [{ id: 'proj-other', path: path.join(scratch, 'elsewhere') }] });
      const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(1)));

      await vi.waitFor(() => expect(held).toHaveLength(1));
      held[0].settle(FAILED);
      await done;

      expect(mockReportFailure).not.toHaveBeenCalled();
    });

    it('reports nothing for a run that was cancelled', async () => {
      const { context } = makeContext();
      const done = stopBeforeReap(context, PROJECT_PATH, tasksIn(makeFolders(1)));

      await vi.waitFor(() => expect(held).toHaveLength(1));
      held[0].settle({ status: 'aborted' });
      await done;

      expect(mockReportFailure).not.toHaveBeenCalled();
    });
  });
});
