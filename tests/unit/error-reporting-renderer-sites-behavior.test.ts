/**
 * What a user loses if these reports go quiet: a board that fails to load, a card click
 * that opens nothing, a terminal whose replay fails and a terminal stuck on the slow DOM
 * renderer all look like "the app is a bit off" with nothing on screen to say why, so a
 * regression in any of them reaches us only as a vague complaint.
 *
 * These run the real code and drive each catch with a throwing dependency, then assert
 * the call to `reportRendererFailure` (mocked here, so its area, op and error are what
 * is checked). They replace source-text pins in error-reporting-feature-gaps.test.ts.
 *
 * useTerminal is the one site kept as a source read. Both replay catches live inside a
 * very large hook whose refs, HMR rules and arrival-focus obligation (see
 * .claude/rules/terminal-arrival-focus.md) make an extraction risky, and the unit tier
 * has no DOM to render it. The read is scoped to the catch that follows each
 * 'replay-error' trace so a deleted report fails by trigger.
 *
 * The store report sites (the last describe) cover what a store's catch used to
 * swallow: a throw from the store's own work after main answered. Main's handler
 * wrap never sees that one, so a move that landed and then rolled back, a map
 * that stayed empty or a paused card over a running agent told us nothing. Each
 * case lets the IPC call succeed and makes the store's own work throw, or rejects
 * the call the way a channel with no handler does, and runs the real action. The
 * same describe pins the failure toasts added for changes that used to snap back
 * with no word.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

vi.mock('../../src/renderer/utils/renderer-failure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/utils/renderer-failure')>()),
  reportRendererFailure: vi.fn(() => true),
}));

import { reportRendererFailure } from '../../src/renderer/utils/renderer-failure';
import { PROJECT_NOT_FOUND_PREFIX, PROJECT_PATH_MISSING_PREFIX } from '../../src/shared/ipc-channels';
import { REPORTED_FAILURE_MARKER } from '../../src/shared/reported-failure-marker';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import { useAccountsStore } from '../../src/renderer/stores/accounts-store';
import { useBacklogStore } from '../../src/renderer/stores/backlog-store';
import { createBoardStore } from '../../src/renderer/stores/board-store';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { useKnowledgeGraphStore } from '../../src/renderer/stores/knowledge-graph-store';
import { useMonitorStore } from '../../src/renderer/stores/monitor-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { killTransientSessionForProject } from '../../src/renderer/stores/session-lifecycle-hooks';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import { useUpdaterStore } from '../../src/renderer/stores/updater-store';
import { useWorkflowStore } from '../../src/renderer/stores/workflow-store';
import { requestDetailOpenFromMain } from '../../src/renderer/window-manager/bridge/useTaskDetailWindowBridge';
import { attachWebglRenderer, setTerminalGraphicsSupport } from '../../src/renderer/utils/terminal-webgl';

const reportMock = vi.mocked(reportRendererFailure);

beforeEach(() => {
  reportMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('board load failure', () => {
  function stubElectronApi(tasksList: () => Promise<unknown[]>): void {
    vi.stubGlobal('window', {
      electronAPI: {
        tasks: {
          list: tasksList,
          listArchivedPreview: async () => ({ tasks: [], totalCount: 0 }),
        },
        swimlanes: { list: async () => [] },
        boardConfig: {
          getShortcuts: async () => [],
          getBoardProfiles: async () => [],
        },
        automations: { list: async () => [] },
      },
    });
  }

  it('reports a failed load as board/load and leaves the board hydrated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new TypeError('renderer-side defect');
    stubElectronApi(async () => { throw failure; });
    const store = createBoardStore();

    await store.getState().loadBoard();

    expect(reportMock).toHaveBeenCalledWith('board', 'load', failure);
    expect(store.getState().loading).toBe(false);
    expect(store.getState().hydrated).toBe(true);
  });

  it('reports nothing when the load succeeds', async () => {
    stubElectronApi(async () => []);
    const store = createBoardStore();

    await store.getState().loadBoard();

    expect(reportMock).not.toHaveBeenCalledWith('board', 'load', expect.anything());
  });
});

describe('card click that cannot resolve where to open', () => {
  it('reports a rejected requestOpen as task_detail/open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('main unreachable');

    await requestDetailOpenFromMain(async () => { throw failure; }, 'project-a', 'task-a');

    expect(reportMock).toHaveBeenCalledWith('task_detail', 'open', failure);
  });

  it('reports nothing when main answers', async () => {
    const requestOpen = vi.fn(async () => ({ kind: 'open-here' }));

    await requestDetailOpenFromMain(requestOpen, 'project-a', 'task-a');

    expect(requestOpen).toHaveBeenCalledWith('project-a', 'task-a', 'board');
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('terminal WebGL fallback', () => {
  // The graphics support is module state in terminal-webgl.ts, so a case that
  // sets it puts the default back for whatever runs after it.
  afterEach(() => {
    setTerminalGraphicsSupport({ softwareRendering: false, webglAvailable: true, webglFeatureStatus: 'unknown' });
  });

  it('reports the DOM fallback once, when the first retry pass is spent, with the WebGL feature status', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Main said WebGL was available and it still failed: the report carries
    // Chromium's word so a real defect can be told from an environment.
    setTerminalGraphicsSupport({ softwareRendering: false, webglAvailable: true, webglFeatureStatus: 'enabled' });
    const fakeTerminal = { loadAddon: vi.fn() } as unknown as Terminal;
    const dispose = attachWebglRenderer(fakeTerminal, 'session-webgl-report', {
      createAddon: () => { throw new Error('WebGL blocked'); },
      retryDelaysMs: [10, 20],
    });

    // Failures 1 and 2 are inside the schedule's first pass: nothing is reported yet.
    vi.advanceTimersByTime(10);
    expect(reportMock).not.toHaveBeenCalled();

    // The third failure is the first past the schedule.
    vi.advanceTimersByTime(20);
    expect(reportMock).toHaveBeenCalledTimes(1);
    const [area, operation, error, contexts] = reportMock.mock.calls[0];
    expect(area).toBe('terminal');
    expect(operation).toBe('webgl_fallback');
    expect((error as Error).name).toBe('WebglFallbackError');
    expect(contexts).toEqual({ webgl: { failure: 're-init-failed', contextLosses: 0, featureStatus: 'enabled' } });

    // Later failures stay quiet.
    vi.advanceTimersByTime(200);
    expect(reportMock).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe('terminal replay failure (source read, see header)', () => {
  const hookSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
    'utf-8',
  );

  function catchBodyFor(trigger: 'mount' | 'reload'): string {
    const marker = `traceReplay('replay-error', { trigger: '${trigger}'`;
    const start = hookSource.indexOf(marker);
    expect(start, `no replay-error trace for ${trigger}`).toBeGreaterThan(-1);
    const end = hookSource.indexOf("focusOnArrival('replay-error')", start);
    expect(end, `no arrival discharge after the ${trigger} catch`).toBeGreaterThan(start);
    // Comment lines dropped, so a commented-out call does not count.
    return hookSource
      .slice(start, end)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it.each(['mount', 'reload'] as const)('the %s replay catch reports terminal/replay with its trigger', (trigger) => {
    expect(catchBodyFor(trigger)).toContain(
      `reportRendererFailure('terminal', 'replay', error, { replay: { trigger: '${trigger}' } });`,
    );
  });
});

/** The recognisable user text each failure below is built around. No report key may hold it. */
const USER_TITLE = 'Fix Acme billing';
const STAMP = '2026-10-01T00:00:00.000Z';

/** A throw from the renderer's own work, worded around what the user wrote. */
function rendererDefect(): Error {
  return new TypeError(`Cannot read "${USER_TITLE}"`);
}

/**
 * A row the store's own work cannot take: reading `field` throws `failure`. It
 * stands in for any payload a store trips on after its IPC call succeeded, and
 * hands the case the exact error to look for.
 */
function unreadableRow<Row extends object>(row: Row, field: keyof Row & string, failure: Error): Row {
  return Object.defineProperty({ ...row }, field, {
    enumerable: true,
    get: () => { throw failure; },
  });
}

/** A rejected `ipcRenderer.invoke`, as Electron words it for the renderer. */
function ipcRejection(channel: string, reason: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${reason}`);
}

/** The rejection for a channel main never registered, which no handler wrap sees. */
function unregisteredChannel(channel: string): Error {
  return ipcRejection(channel, `No handler registered for '${channel}'`);
}

/** The error handed to the reporter under one area and operation. */
function reportedError(area: string, operation: string): unknown {
  const call = reportMock.mock.calls.find(
    ([reportedArea, reportedOperation]) => reportedArea === area && reportedOperation === operation,
  );
  expect(call, `no ${area}/${operation} report`).toBeDefined();
  return call?.[2];
}

/** No report is keyed on what a user wrote: every area and operation is a fixed word. */
function expectNoUserTextInReportKeys(): void {
  for (const [area, operation] of reportMock.mock.calls) {
    expect(JSON.stringify([area, operation])).not.toContain(USER_TITLE);
  }
}

/** The site handed the reporter exactly `failure`, under `area` and `operation`. */
function expectReported(area: string, operation: string, failure: Error): void {
  expect(reportedError(area, operation)).toBe(failure);
  expectNoUserTextInReportKeys();
}

describe('store report sites', () => {
  const PROJECT_A = { id: 'project-a', name: 'Alpha', path: '/mock/alpha' };
  const PROJECT_B = { id: 'project-b', name: USER_TITLE, path: `/mock/${USER_TITLE}` };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The stores are singletons, so each case starts from what it does not seed itself.
    useToastStore.setState({ toasts: [] });
    useProjectStore.setState({ projects: [], groups: [], currentProject: null, missingPathProject: null });
    useSessionStore.setState({ transientSessions: {} });
    useWorkflowStore.setState({ projectId: null, selectedWorkflowId: null, homeSummaries: {} });
    useConfigStore.setState({ workspaceSeeded: false });
    useUpdaterStore.setState({ pendingUpdate: null, isModalOpen: false });
  });

  describe('board store work that throws after main answered', () => {
    const BOARD_TASK = 'task-acme';
    const SECOND_TASK = 'task-second';
    const ARCHIVED_TASK = 'task-archived';
    const LANE_DOING = 'lane-doing';
    const LANE_REVIEW = 'lane-review';
    const LANE_DONE = 'lane-done';

    /** A task as main lists it, with the fields the board store reads. */
    function taskRow(id: string, position: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id,
        title: USER_TITLE,
        display_id: position + 1,
        swimlane_id: LANE_DOING,
        position,
        session_id: null,
        labels: [],
        archived_at: null,
        created_at: STAMP,
        updated_at: STAMP,
        ...overrides,
      };
    }

    function archivedRow(): Record<string, unknown> {
      return taskRow(ARCHIVED_TASK, 2, { archived_at: STAMP });
    }

    function laneRow(id: string, position: number, role: 'done' | null = null): Record<string, unknown> {
      return { id, name: id, role, position, icon: null, auto_spawn: false, auto_command: null };
    }

    /** Main, answering every board call. A case swaps one answer for a row the store cannot take. */
    function boardApi() {
      return {
        tasks: {
          list: vi.fn(async (): Promise<unknown[]> => [taskRow(BOARD_TASK, 0), taskRow(SECOND_TASK, 1)]),
          listArchived: vi.fn(async (): Promise<unknown[]> => [archivedRow()]),
          listArchivedPreview: vi.fn(async () => ({ tasks: [archivedRow()], totalCount: 1 })),
          move: vi.fn(async () => undefined),
          unarchive: vi.fn(async () => undefined),
          delete: vi.fn(async () => undefined),
          bulkDelete: vi.fn(async (): Promise<unknown> => ({ deleted: 1, failures: [] })),
          bulkUnarchive: vi.fn(async () => undefined),
          onBulkDeleteProgress: vi.fn(() => () => undefined),
        },
        swimlanes: {
          list: vi.fn(async () => [laneRow(LANE_DOING, 0), laneRow(LANE_REVIEW, 1), laneRow(LANE_DONE, 2, 'done')]),
        },
        boardConfig: {
          getShortcuts: vi.fn(async (): Promise<unknown[]> => []),
          getBoardProfiles: vi.fn(async () => []),
        },
        automations: { list: vi.fn(async () => []) },
      };
    }

    /** A board store that has loaded two tasks, three columns and one archived task from main. */
    async function loadedBoard(api = boardApi()) {
      vi.stubGlobal('window', { electronAPI: api });
      const store = createBoardStore();
      await store.getState().loadBoard();
      return { store, api };
    }

    it('reports a list apply that throws after the move landed as board/move', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.tasks.list.mockResolvedValueOnce([unreadableRow(taskRow(BOARD_TASK, 0), 'id', failure)]);

      const result = await store.getState().moveTask({ taskId: BOARD_TASK, targetSwimlaneId: LANE_REVIEW, targetPosition: 0 });

      expect(api.tasks.move).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false });
      expectReported('board', 'move', failure);
    });

    it('reports a list apply that throws after the reorder landed as board/reorder', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.tasks.list.mockResolvedValueOnce([unreadableRow(taskRow(BOARD_TASK, 0), 'id', failure)]);

      await store.getState().reorderTaskInColumn(BOARD_TASK, LANE_DOING, BOARD_TASK, SECOND_TASK);

      expect(api.tasks.move).toHaveBeenCalledTimes(1);
      expectReported('board', 'reorder', failure);
    });

    it('reports a throw from the completion itself, after the Done move landed, as board/complete', async () => {
      const { store, api } = await loadedBoard();
      const task = store.getState().tasks.find((candidate) => candidate.id === BOARD_TASK);
      if (!task) throw new Error('the board did not load its task');
      const failure = rendererDefect();
      // The "Task completed" toast is the completion's own work. Its first listener throws, once.
      const stopThrowing = useToastStore.subscribe(() => {
        stopThrowing();
        throw failure;
      });

      try {
        store.getState().setCompletingTask({
          taskId: BOARD_TASK,
          targetSwimlaneId: LANE_DONE,
          targetPosition: 0,
          originSwimlaneId: LANE_DOING,
          task,
          startRect: { left: 100, top: 100, width: 200, height: 80 },
          projectId: null,
        });
        await store.getState().finalizeCompletion();
      } finally {
        stopThrowing();
      }

      expect(api.tasks.move).toHaveBeenCalledTimes(1);
      expectReported('board', 'complete', failure);
      // The move's own catch saw nothing: the throw was the completion's.
      expect(reportMock).not.toHaveBeenCalledWith('board', 'move', expect.anything());
      expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain("Couldn't complete task");
    });

    it('reports a list apply that throws after the restore landed as board/unarchive', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.tasks.list.mockResolvedValueOnce([unreadableRow(taskRow(ARCHIVED_TASK, 2), 'id', failure)]);

      await store.getState().unarchiveTask({ id: ARCHIVED_TASK, targetSwimlaneId: LANE_DOING });

      expect(api.tasks.unarchive).toHaveBeenCalledTimes(1);
      expectReported('board', 'unarchive', failure);
    });

    it('reports a session scrub that throws after main deleted the task as board/archived_delete', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      // The scrub is a session store write, and a listener of that write throws.
      const stopThrowing = useSessionStore.subscribe(() => { throw failure; });

      try {
        await store.getState().deleteArchivedTask(ARCHIVED_TASK);
      } finally {
        stopThrowing();
      }

      expect(api.tasks.delete).toHaveBeenCalledTimes(1);
      expectReported('board', 'archived_delete', failure);
    });

    it('reports an answer it cannot read after main deleted the batch as board/archived_bulk_delete', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.tasks.bulkDelete.mockResolvedValueOnce(unreadableRow({ deleted: 1, failures: [] }, 'failures', failure));

      await store.getState().bulkDeleteArchivedTasks([ARCHIVED_TASK]);

      expect(api.tasks.bulkDelete).toHaveBeenCalledTimes(1);
      expectReported('board', 'archived_bulk_delete', failure);
    });

    it('reports a list apply that throws after the bulk restore landed as board/bulk_unarchive', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.tasks.list.mockResolvedValueOnce([unreadableRow(taskRow(ARCHIVED_TASK, 2), 'id', failure)]);

      await store.getState().bulkUnarchiveTasks([ARCHIVED_TASK], LANE_DOING);

      expect(api.tasks.bulkUnarchive).toHaveBeenCalledTimes(1);
      expectReported('board', 'bulk_unarchive', failure);
    });

    it('reports a full archive refresh that fails behind a board load as board/archived_refresh', async () => {
      const { store, api } = await loadedBoard();
      // A mounted viewer holds the full archive, so the next board load refreshes it out of band.
      store.getState().acquireArchiveView();
      await store.getState().loadArchivedTasks();
      const failure = rendererDefect();
      api.tasks.listArchived.mockResolvedValueOnce([unreadableRow(archivedRow(), 'id', failure)]);

      await store.getState().loadBoard();

      await vi.waitFor(() => expectReported('board', 'archived_refresh', failure));
    });

    it('reports a shortcut list it cannot read as board/shortcuts', async () => {
      const { store, api } = await loadedBoard();
      const failure = rendererDefect();
      api.boardConfig.getShortcuts.mockResolvedValueOnce([unreadableRow({ label: USER_TITLE, icon: 'play' }, 'icon', failure)]);

      await store.getState().loadShortcuts();

      expectReported('board', 'shortcuts', failure);
    });

    it('reports a saved detail view that will not parse as task_detail/view_state_parse', async () => {
      const api = boardApi();
      api.tasks.list.mockResolvedValue([taskRow('task-view-state', 0, { detail_view_state: USER_TITLE })]);
      const { store } = await loadedBoard(api);

      // App.tsx hands every board load's tasks to this action.
      useSessionStore.getState().hydrateDetailViewStateForTasks(store.getState().tasks);

      expect(reportedError('task_detail', 'view_state_parse')).toBeInstanceOf(SyntaxError);
      expectNoUserTextInReportKeys();
    });
  });

  describe('project open against a list that disagrees with main', () => {
    /** Main refuses the open with `rejection`, and each list read answers the next entry of `listed`. */
    function stubProjects(rejection: Error, listed: unknown[][]): void {
      const list = vi.fn<() => Promise<unknown[]>>();
      for (const rows of listed) list.mockResolvedValueOnce(rows);
      vi.stubGlobal('window', {
        electronAPI: {
          projects: {
            open: async () => { throw rejection; },
            list,
            getCurrent: async () => PROJECT_A,
          },
        },
      });
    }

    /** The reported error is the store's own: a new Error that carries nothing of the rejection. */
    function expectOwnError(reported: unknown, rejection: Error, fragments: string[]): void {
      expect(reported).toBeInstanceOf(Error);
      expect(reported).not.toBe(rejection);
      const error = reported as Error;
      expect(error.cause).toBeUndefined();
      for (const fragment of [rejection.message, 'Error invoking remote method', USER_TITLE, ...fragments]) {
        expect(error.message).not.toContain(fragment);
      }
    }

    it('reports a row still missing after the refetch as projects/open_missing_row, with an error of its own', async () => {
      const rejection = ipcRejection('project:open', `${PROJECT_PATH_MISSING_PREFIX}${PROJECT_B.path}`);
      stubProjects(rejection, [[PROJECT_A], [PROJECT_A]]);
      await useProjectStore.getState().loadProjects();

      const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

      expect(outcome).toBe('failed');
      expectOwnError(reportedError('projects', 'open_missing_row'), rejection, [PROJECT_PATH_MISSING_PREFIX, PROJECT_B.path, PROJECT_B.id]);
      expectNoUserTextInReportKeys();
    });

    it('reports a project main lists and cannot find as projects/open_not_found_listed, with an error of its own', async () => {
      const rejection = ipcRejection('project:open', `${PROJECT_NOT_FOUND_PREFIX}${PROJECT_B.id}`);
      stubProjects(rejection, [[PROJECT_A, PROJECT_B], [PROJECT_A, PROJECT_B]]);
      await useProjectStore.getState().loadProjects();

      const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

      expect(outcome).toBe('not-found');
      expectOwnError(reportedError('projects', 'open_not_found_listed'), rejection, [PROJECT_NOT_FOUND_PREFIX, PROJECT_B.id]);
      expectNoUserTextInReportKeys();
    });

    it('reports nothing when the refetch drops the row: the list was only behind', async () => {
      const rejection = ipcRejection('project:open', `${PROJECT_NOT_FOUND_PREFIX}${PROJECT_B.id}`);
      stubProjects(rejection, [[PROJECT_A, PROJECT_B], [PROJECT_A]]);
      await useProjectStore.getState().loadProjects();

      const outcome = await useProjectStore.getState().openProject(PROJECT_B.id);

      expect(outcome).toBe('not-found');
      expect(reportMock).not.toHaveBeenCalledWith('projects', 'open_not_found_listed', expect.anything());
    });
  });

  describe('workflow actions', () => {
    beforeEach(() => {
      useWorkflowStore.setState({ projectId: PROJECT_A.id, selectedWorkflowId: 'workflow-a' });
    });

    it('reports a change to the selected workflow that no handler took as workflows/action', async () => {
      const rejection = unregisteredChannel('workflow:rename');
      vi.stubGlobal('window', { electronAPI: { workflows: { rename: async () => { throw rejection; } } } });

      const renamed = await useWorkflowStore.getState().renameWorkflow(USER_TITLE);

      expect(renamed).toBe(false);
      expectReported('workflows', 'action', rejection);
    });

    it('reports a change to a workflow named by its home that no handler took as workflows/action', async () => {
      const rejection = unregisteredChannel('workflow:removeTask');
      vi.stubGlobal('window', { electronAPI: { workflows: { removeTask: async () => { throw rejection; } } } });

      const removed = await useWorkflowStore.getState().removeTaskIn(PROJECT_A.id, 'workflow-a', 'task-key');

      expect(removed).toBe(false);
      expectReported('workflows', 'action', rejection);
    });

    /** What main answers an open or a resume with, unreadable where the store applies it. */
    function unreadableAgentStatus(failure: Error): Record<string, unknown> {
      return unreadableRow({ session: null, unavailable: null, setupNeeded: false, startsOnRequest: false }, 'session', failure);
    }

    it('reports an agent status it cannot apply after the open as workflows/agent_open', async () => {
      const failure = rendererDefect();
      const agentOpen = vi.fn(async () => unreadableAgentStatus(failure));
      vi.stubGlobal('window', { electronAPI: { workflows: { agentOpen } } });

      await useWorkflowStore.getState().openAgent();

      expect(agentOpen).toHaveBeenCalledTimes(1);
      expectReported('workflows', 'agent_open', failure);
    });

    it('reports an agent status it cannot apply after the resume as workflows/agent_resume', async () => {
      const failure = rendererDefect();
      const agentResume = vi.fn(async () => unreadableAgentStatus(failure));
      vi.stubGlobal('window', { electronAPI: { workflows: { agentResume } } });

      await useWorkflowStore.getState().resumeAgent();

      expect(agentResume).toHaveBeenCalledTimes(1);
      expectReported('workflows', 'agent_resume', failure);
    });

    it('reports a pause that no handler took as workflows/agent_pause', async () => {
      const rejection = unregisteredChannel('workflow:agentPause');
      vi.stubGlobal('window', { electronAPI: { workflows: { agentPause: async () => { throw rejection; } } } });

      await useWorkflowStore.getState().pauseAgent();

      expectReported('workflows', 'agent_pause', rejection);
    });

    it('reports a created workflow it cannot select as workflows/create', async () => {
      const failure = rendererDefect();
      const create = vi.fn(async () => unreadableRow({ id: 'workflow-new', title: USER_TITLE }, 'id', failure));
      vi.stubGlobal('window', {
        electronAPI: { projects: { getCurrent: async () => PROJECT_A }, workflows: { create } },
      });
      await useProjectStore.getState().loadCurrent();

      const created = await useWorkflowStore.getState().createWorkflow(null);

      expect(create).toHaveBeenCalledTimes(1);
      expect(created).toBeNull();
      expectReported('workflows', 'create', failure);
    });

    it('reports a home list it cannot share with the one it holds as workflows/home_summaries', async () => {
      const failure = rendererDefect();
      const summary = { workflow: { id: 'workflow-a', title: USER_TITLE }, boardTasks: {} };
      const list = vi.fn<() => Promise<unknown[]>>();
      list.mockResolvedValueOnce([summary]).mockResolvedValueOnce([unreadableRow(summary, 'workflow', failure)]);
      vi.stubGlobal('window', { electronAPI: { workflows: { list } } });
      // The first read is what the second is shared against.
      await useWorkflowStore.getState().loadHomeSummaries(['project-home']);
      expect(reportMock).not.toHaveBeenCalled();

      await useWorkflowStore.getState().loadHomeSummaries(['project-home']);

      expectReported('workflows', 'home_summaries', failure);
    });
  });

  describe('incidental config writes whose refresh throws', () => {
    /** The write lands, and the config read back after it is one the store cannot merge. */
    function stubConfigWithUnreadableRefresh(failure: Error) {
      const set = vi.fn(async () => ({ persisted: true }));
      vi.stubGlobal('window', {
        electronAPI: {
          config: {
            set,
            get: async () => unreadableRow({ ...DEFAULT_CONFIG }, 'theme', failure),
            getGlobal: async () => DEFAULT_CONFIG,
          },
        },
      });
      // Seeded, as after the app's first config load: the refresh then merges what it read.
      useConfigStore.setState({ workspaceSeeded: true });
      return set;
    }

    it('reports a dismissed announcement whose refresh throws as config/dismiss_announcement', async () => {
      const failure = rendererDefect();
      const set = stubConfigWithUnreadableRefresh(failure);

      useConfigStore.getState().dismissAnnouncement('announcement-acme');

      await vi.waitFor(() => expectReported('config', 'dismiss_announcement', failure));
      expect(set).toHaveBeenCalledTimes(1);
    });

    it('reports seen release notes whose refresh throws as config/seen_release_notes', async () => {
      const failure = rendererDefect();
      const set = stubConfigWithUnreadableRefresh(failure);
      useUpdaterStore.setState({ pendingUpdate: { version: '9.9.9', releaseNotes: USER_TITLE }, isModalOpen: true });

      useUpdaterStore.getState().dismiss();

      await vi.waitFor(() => expectReported('config', 'seen_release_notes', failure));
      expect(set).toHaveBeenCalledTimes(1);
    });
  });

  describe('Agent Monitor snapshots it cannot apply', () => {
    function unreadableSnapshot(failure: Error): Record<string, unknown> {
      return unreadableRow({ rows: [], generatedAt: STAMP }, 'rows', failure);
    }

    it('reports the subscribe answer as monitor/subscribe', async () => {
      const failure = rendererDefect();
      const subscribe = vi.fn(async () => unreadableSnapshot(failure));
      vi.stubGlobal('window', { electronAPI: { monitor: { subscribe } } });

      await useMonitorStore.getState().attach();

      expect(subscribe).toHaveBeenCalledTimes(1);
      expectReported('monitor', 'subscribe', failure);
    });

    it('reports a snapshot read as monitor/snapshot', async () => {
      const failure = rendererDefect();
      const getSnapshot = vi.fn(async () => unreadableSnapshot(failure));
      vi.stubGlobal('window', { electronAPI: { monitor: { getSnapshot } } });

      await useMonitorStore.getState().loadSnapshot();

      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expectReported('monitor', 'snapshot', failure);
    });
  });

  describe('Knowledge Graph maps that will not parse', () => {
    /** Main answers with a map whose JSON is not JSON, which only the renderer parses. */
    function stubUnparsableMap() {
      const graphSnapshot = vi.fn(async () => ({ projectId: PROJECT_A.id, projectionKey: 'key-1', projectionJson: USER_TITLE }));
      vi.stubGlobal('window', { electronAPI: { knowledgeGraph: { graphSnapshot } } });
      return graphSnapshot;
    }

    it('reports the open project map as knowledge_graph/snapshot', async () => {
      const graphSnapshot = stubUnparsableMap();

      await useKnowledgeGraphStore.getState().loadSnapshot(PROJECT_A.id);

      expect(graphSnapshot).toHaveBeenCalledTimes(1);
      expect(reportedError('knowledge_graph', 'snapshot')).toBeInstanceOf(SyntaxError);
      expectNoUserTextInReportKeys();
    });

    it('reports a scoped project map as knowledge_graph/scope_snapshot', async () => {
      const graphSnapshot = stubUnparsableMap();

      await useKnowledgeGraphStore.getState().loadScopeSnapshot(PROJECT_A.id);

      expect(graphSnapshot).toHaveBeenCalledTimes(1);
      expect(reportedError('knowledge_graph', 'scope_snapshot')).toBeInstanceOf(SyntaxError);
      expectNoUserTextInReportKeys();
    });
  });

  it('reports a backlog load that no handler took as backlog/load, and still hydrates', async () => {
    const rejection = unregisteredChannel('backlog:list');
    vi.stubGlobal('window', { electronAPI: { backlog: { list: async () => { throw rejection; } } } });

    await useBacklogStore.getState().loadBacklog();

    expectReported('backlog', 'load', rejection);
    expect(useBacklogStore.getState().hydrated).toBe(true);
    expect(useBacklogStore.getState().loading).toBe(false);
  });

  it('reports a live session it cannot write after a refused suspend as session_sync/reconcile_after_refused_suspend', async () => {
    const refusal = ipcRejection('session:suspend', 'RefusalError: The agent is still starting.');
    const failure = rendererDefect();
    const reconcile = vi.fn(async () => unreadableRow({ id: 'session-acme', taskId: 'task-acme', status: 'running' }, 'taskId', failure));
    vi.stubGlobal('window', {
      electronAPI: { sessions: { suspend: async () => { throw refusal; }, reconcile } },
    });

    // The refusal still reaches the caller, which toasts it.
    await expect(useSessionStore.getState().suspendSession('task-acme', PROJECT_A.id)).rejects.toBe(refusal);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expectReported('session_sync', 'reconcile_after_refused_suspend', failure);
  });

  it('reports a store scrub that throws after a project\'s terminals were killed as command_terminal/project_cleanup', async () => {
    const killTransient = vi.fn(async () => undefined);
    vi.stubGlobal('window', { electronAPI: { sessions: { killTransient } } });
    useSessionStore.setState({
      transientSessions: {
        [`${PROJECT_A.id}::slot-1`]: { projectId: PROJECT_A.id, slot: 'slot-1', sessionId: 'session-terminal', branch: 'main' },
      },
    });
    const failure = rendererDefect();
    // The scrub is the action's one store write, and a listener of that write throws.
    const stopThrowing = useSessionStore.subscribe(() => { throw failure; });

    try {
      killTransientSessionForProject(PROJECT_A.id);
      await vi.waitFor(() => expectReported('command_terminal', 'project_cleanup', failure));
    } finally {
      stopThrowing();
    }

    expect(killTransient).toHaveBeenCalledWith('session-terminal');
  });

  describe('a change main refused, which used to snap back with no word', () => {
    interface RefusedChange {
      /** The toast's title. */
      title: string;
      channel: string;
      /** Stub main so the change is refused with `rejection`, then make the change. */
      refuse: (rejection: Error) => Promise<void>;
    }

    const refusedChanges: RefusedChange[] = [
      {
        title: "Couldn't reorder projects",
        channel: 'project:reorder',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: { projects: { reorder: async () => { throw rejection; }, list: async () => [] } },
          });
          await useProjectStore.getState().reorderProjects([PROJECT_A.id, PROJECT_B.id]);
        },
      },
      {
        title: "Couldn't rename project",
        channel: 'project:rename',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: { projects: { rename: async () => { throw rejection; }, list: async () => [] } },
          });
          await useProjectStore.getState().renameProject(PROJECT_A.id, USER_TITLE);
        },
      },
      {
        title: "Couldn't move project",
        channel: 'project:setGroup',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: { projects: { setGroup: async () => { throw rejection; }, list: async () => [] } },
          });
          await useProjectStore.getState().setProjectGroup(PROJECT_A.id, 'group-a');
        },
      },
      {
        title: "Couldn't reorder groups",
        channel: 'projectGroup:reorder',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: { projectGroups: { reorder: async () => { throw rejection; }, list: async () => [] } },
          });
          await useProjectStore.getState().reorderGroups(['group-a']);
        },
      },
      {
        title: "Couldn't update group",
        channel: 'projectGroup:setCollapsed',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: { projectGroups: { setCollapsed: async () => { throw rejection; }, list: async () => [] } },
          });
          useProjectStore.setState({ groups: [{ id: 'group-a', name: USER_TITLE, position: 0, is_collapsed: false }] });
          await useProjectStore.getState().toggleGroupCollapsed('group-a');
        },
      },
      {
        title: "Couldn't remove account",
        channel: 'accounts:remove',
        refuse: async (rejection) => {
          vi.stubGlobal('window', {
            electronAPI: {
              accounts: { remove: async () => { throw rejection; }, list: async () => ({ cards: [], checked: true }) },
            },
          });
          await useAccountsStore.getState().remove('account-a');
        },
      },
    ];

    for (const change of refusedChanges) {
      it.each([
        { reportedByMain: true, line: 'with the reported line when main reported the failure' },
        { reportedByMain: false, line: 'without the reported line when main did not' },
      ])(`toasts "${change.title}" $line`, async ({ reportedByMain }) => {
        const reason = `the database is locked${reportedByMain ? REPORTED_FAILURE_MARKER : ''}`;

        await change.refuse(ipcRejection(change.channel, reason));

        const toast = useToastStore.getState().toasts.find((candidate) => candidate.title === change.title);
        expect(toast, `no "${change.title}" toast`).toBeDefined();
        expect(toast?.variant).toBe('error');
        expect(toast?.message).toBe('The database is locked.');
        expect(toast?.reported).toBe(reportedByMain ? true : undefined);
      });
    }
  });
});
