/**
 * The workflow operations on real, migrated SQLite: a plan is validated whole
 * before anything is written, Start creates the tasks on their boards with
 * their routes and links, and the started workflow's guards (links, routes,
 * removal) hold.
 *
 * Two projects, so a task on another board is covered. The move path and the
 * session handlers are mocked: Start moves only the source task, and most
 * workflows here have none. The ones that do pin that a source task that cannot
 * move to Done never fails a Start that has already run.
 *
 * Start is several writes (one transaction per board, then the home database),
 * so a write that throws after an earlier board committed undoes what those
 * boards hold. The cases below make each of those writes throw, on real SQLite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
// A spy, so the Resume tests can say which tasks it was asked to bring back. The
// module's one runtime export; a plain factory, not `importOriginal`, since the
// original sits in an import cycle with the workflow service and a spread of it
// would leave the service holding the real function.
vi.mock('../../src/main/ipc/handlers/session-resume', () => ({ resumeTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/session-reconcile')>()),
  reconcileTaskSessionRef: vi.fn(),
}));
// A plain factory: the module sits in an import cycle with this service, and a
// partial mock built through importOriginal hands the service the real export.
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({ autoSpawnForTask: vi.fn() }));
// The notice a failed Resume shows: only the call is pinned, not the toast it sends.
vi.mock('../../src/main/ipc/helpers/task-git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/task-git')>()),
  notifySpawnBlocked: vi.fn(),
}));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/automations/turn-end/turn-end-passes')>()),
  supersedeTurnEndWork: vi.fn(),
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
// A workflow delete takes its tasks that never started through the board's own
// task delete. Its cleanup needs sessions and git; the cases below give it a
// double that asks the in-lock check and drops the row, as the real one does.
vi.mock('../../src/main/ipc/helpers/task-delete', () => ({ deleteTaskWithCleanup: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));

const { handleTaskMove } = await import('../../src/main/ipc/handlers/task-move');
const { pauseTaskSession } = await import('../../src/main/ipc/handlers/session-pause');
const { resumeTaskSession } = await import('../../src/main/ipc/handlers/session-resume');
const { reconcileTaskSessionRef } = await import('../../src/main/ipc/handlers/session-reconcile');
const { autoSpawnForTask } = await import('../../src/main/ipc/helpers/agent-spawn');
const { notifySpawnBlocked } = await import('../../src/main/ipc/helpers/task-git');
const { supersedeTurnEndWork } = await import('../../src/main/automations/turn-end/turn-end-passes');
const { notifyWorkflowChanged } = await import('../../src/main/workflows/workflow-changed');
const { deleteTaskWithCleanup } = await import('../../src/main/ipc/helpers/task-delete');
const { SessionRepository } = await import('../../src/main/db/repositories/session-repository');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { TaskLinkRepository } = await import('../../src/main/db/repositories/task-link-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { isSessionInOwnCall } = await import('../../src/main/ipc/handlers/own-call-turn-wait');
const { setWorkflowWake } = await import('../../src/main/workflows/workflow-wake');
const { setWorkflowCatchUp } = await import('../../src/main/workflows/workflow-catch-up');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards, taskTitled } from './helpers/workflow-plans';
import {
  getRecoveryEntry,
  isUnderWorkflowRecovery,
  resetWorkflowRecoveryForTests,
  setRecoveryEntry,
} from '../../src/main/workflows/workflow-recovery-state';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('workflow operations', () => {
  let context: IpcContext;

  function database(projectId: string): Database.Database {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
    return db;
  }

  beforeEach(() => {
    harness.dbs.clear();
    database('home');
    database('mobile');
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
    vi.restoreAllMocks();
  });

  const lanesOf = (projectId: string) => new SwimlaneRepository(harness.dbs.get(projectId) as Database.Database).list();
  const tasksOf = (projectId: string) => new TaskRepository(harness.dbs.get(projectId) as Database.Database);

  function plan(extra: Partial<service.PlanInput> = {}): service.PlanInput {
    return {
      title: 'Usage budgets',
      tasks: [
        { key: 'api', title: 'Budgets API', description: 'Add the API.', skip: ['Planning'] },
        { key: 'ui', title: 'Budgets UI', description: 'Show budgets.' },
        { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile', routeLast: 'Code Review' },
      ],
      links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'api', blocked: 'phone' }],
      ...extra,
    };
  }

  it('saves a plan by key, resolving columns and projects by name', () => {
    const workflow = service.createWorkflow('home', {});
    const saved = service.savePlan(context, 'home', workflow.id, plan());
    expect(saved.title).toBe('Usage budgets');
    expect(saved.draft?.tasks.map((task) => task.key)).toEqual(['api', 'ui', 'phone']);
    const planning = lanesOf('home').find((lane) => lane.name === 'Planning')!;
    expect(saved.draft?.tasks[0].skipped_swimlane_ids).toEqual([planning.id]);
    expect(saved.draft?.tasks[2].project_id).toBe('mobile');
  });

  it('refuses a plan with a loop, an unknown key, a bad column or a duplicate key, writing nothing', () => {
    const workflow = service.createWorkflow('home', {});
    const attempts: Array<[Partial<service.PlanInput>, RegExp]> = [
      [{ links: [{ blocker: 'api', blocked: 'ui' }, { blocker: 'ui', blocked: 'api' }] }, /loop/],
      [{ links: [{ blocker: 'nope', blocked: 'ui' }] }, /not a task key/],
      [{ tasks: [{ key: 'api', title: 'A', skip: ['Nowhere'] }] }, /not a column a route can use/],
      [{ tasks: [{ key: 'api', title: 'A' }, { key: 'api', title: 'B' }], links: [] }, /share the key/],
    ];
    for (const [change, message] of attempts) {
      expect(() => service.savePlan(context, 'home', workflow.id, plan(change))).toThrow(message);
    }
    expect(service.readWorkflow(context, 'home', workflow.id).tasks).toEqual([]);
  });

  it('saves a planned task\'s own plan approval with the plan, and Start carries it onto the task it creates', async () => {
    // The seeded Planning column is Manual, so Automatic is an override worth storing.
    const created = service.createWorkflowWithPlan(context, 'home', {}, {
      tasks: [{ key: 'api', title: 'Budgets API', planApproval: 'automatic' }, { key: 'ui', title: 'Budgets UI' }],
      links: [],
    });
    expect(created.draft?.tasks.map((task) => task.plan_approval)).toEqual(['automatic', null]);

    await service.startWorkflow(context, 'home', created.id);

    const started = service.readWorkflow(context, 'home', created.id);
    const byTitle = new Map(started.tasks.map((task) => [task.title, task]));
    expect(byTitle.get('Budgets API')?.planApproval).toMatchObject({ set: 'automatic', value: 'automatic' });
    expect(byTitle.get('Budgets UI')?.planApproval).toMatchObject({ set: null, value: 'manual' });
  });

  it('refuses a save over a newer revision', () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan({ revision: workflow.revision }));
    expect(() => service.savePlan(context, 'home', workflow.id, plan({ revision: workflow.revision })))
      .toThrow(/changed since you read it/);
  });

  it('announces a pause, a resume and a rename on every board holding its tasks, though no task row changed', async () => {
    // Every card carries its workflow's state and name, and a paired phone
    // redraws them only on a board event.
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const emit = vi.mocked(context.boardEvents.emitBoardChanged);
    const boardsAnnounced = (): string[] => [...new Set(emit.mock.calls.map(([event]) => event.projectId))].sort();

    emit.mockClear();
    await service.pauseWorkflow(context, 'home', workflow.id, 'a test');
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);

    emit.mockClear();
    await service.resumeWorkflow(context, 'home', workflow.id, 'a test');
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);

    emit.mockClear();
    service.renameWorkflow(context, 'home', workflow.id, 'Spend limits');
    expect(boardsAnnounced()).toEqual(['home', 'mobile']);
  });

  it('wakes the engine with the workflow\'s id on a resume only, so Resume retries its failed starts at once', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const wake = vi.fn();
    setWorkflowWake(wake);
    try {
      await service.pauseWorkflow(context, 'home', workflow.id, 'a test');
      expect(wake.mock.calls.every(([retryWorkflowId]) => retryWorkflowId === undefined)).toBe(true);

      wake.mockClear();
      await service.resumeWorkflow(context, 'home', workflow.id, 'a test');
      expect(wake).toHaveBeenCalledWith(workflow.id);
    } finally {
      setWorkflowWake(null);
    }
  });

  describe('Pause stops every agent and Resume brings every one back', () => {
    beforeEach(() => {
      for (const mock of [pauseTaskSession, resumeTaskSession, reconcileTaskSessionRef, autoSpawnForTask, supersedeTurnEndWork, notifySpawnBlocked]) {
        vi.mocked(mock).mockReset();
      }
    });

    const homeDb = (): Database.Database => harness.dbs.get('home') as Database.Database;
    const laneNamed = (name: string) => lanesOf('home').find((lane) => lane.name === name)!;
    function place(taskId: string, laneName: string): void {
      homeDb().prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(laneNamed(laneName).id, taskId);
    }

    /** A started workflow of the named tasks, all on the home board and in To Do. */
    async function startedWith(titles: string[]): Promise<{ workflowId: string; taskIdOf: (title: string) => string }> {
      const created = service.createWorkflowWithPlan(context, 'home', {}, {
        tasks: titles.map((title) => ({ key: title, title })),
        links: [],
      });
      await service.startWorkflow(context, 'home', created.id);
      const tasks = tasksOf('home').listByWorkflow(created.id);
      return { workflowId: created.id, taskIdOf: (title) => tasks.find((task) => task.title === title)!.id };
    }

    /** The session registry as Resume reads it: paused rows, and the tasks with a live agent. */
    function withSessions(pausedTaskIds: string[], liveTaskIds: Set<string>): IpcContext {
      return {
        ...context,
        // One Board Profile, which turns Testing's agent off for a task that rides it.
        boardConfigManager: {
          getBoardProfiles: () => [{ id: 'quiet', name: 'Quiet', columns: { [laneNamed('Testing').id]: { autoSpawn: false } } }],
        },
        sessionManager: {
          listSessions: () => pausedTaskIds.map((taskId) => ({ taskId, status: 'suspended', transient: false })),
          findLiveSessionByTaskId: (taskId: string) => (liveTaskIds.has(taskId) ? { id: `live-${taskId}` } : undefined),
          currentWorkSerial: () => 7,
          getActivityCache: () => Object.fromEntries([...liveTaskIds].map((taskId) => [`live-${taskId}`, 'idle'])),
        },
      } as unknown as IpcContext;
    }

    it('asks every task, a task with no session pointer included, and reports what each did', async () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, plan());
      await service.startWorkflow(context, 'home', workflow.id);
      const members = [...tasksOf('home').listByWorkflow(workflow.id), ...tasksOf('mobile').listByWorkflow(workflow.id)];
      // None of them has a session pointer: the pause's own reconcile is what
      // finds a live agent whose pointer was lost, so it is asked for each.
      expect(members.every((task) => task.session_id === null)).toBe(true);
      const api = members.find((task) => task.title === 'Budgets API')!;
      const phone = members.find((task) => task.title === 'Budgets on the phone')!;
      vi.mocked(pauseTaskSession).mockImplementation(async (_context, taskId) => {
        if (taskId === api.id) return 'paused';
        if (taskId === phone.id) throw new Error('suspend failed');
        return 'not-live';
      });

      const result = await service.pauseWorkflow(context, 'home', workflow.id, 'a test');

      expect(vi.mocked(pauseTaskSession).mock.calls.map(([, taskId, options]) => [taskId, options?.projectId]).sort())
        .toEqual(members.map((task) => [task.id, task.id === phone.id ? 'mobile' : 'home']).sort());
      expect(result).toMatchObject({ paused: 1, notLive: 1, failed: [{ projectId: 'mobile', taskId: phone.id, displayId: phone.display_id }] });
      expect(result.workflow.state).toBe('paused');
      // Turn-end work a running agent's last turn set off is stopped first, for every task.
      expect(vi.mocked(supersedeTurnEndWork).mock.calls.map(([taskId]) => taskId).sort())
        .toEqual(members.map((task) => task.id).sort());
    });

    // A member's own agent paused its workflow. Suspended before the reply, as
    // every member used to be, Claude exits without writing the call, and after
    // a Resume the agent pauses again. So its own session pauses once the turn
    // that made the call ends, and every other member at once.
    describe('a pause asked for by a member\'s own agent', () => {
      const CALLER_SESSION_ID = 'session-caller';

      /** A session manager the real turn wait listens to, with the caller mid-turn. */
      function withCallerMidTurn(): { runtime: IpcContext; sessionManager: EventEmitter } {
        const sessionManager = Object.assign(new EventEmitter(), {
          getActivityCache: () => ({ [CALLER_SESSION_ID]: 'thinking' }),
          getSession: (sessionId: string) => (sessionId === CALLER_SESSION_ID ? { id: sessionId, status: 'running' } : undefined),
        });
        return { runtime: { ...context, sessionManager } as unknown as IpcContext, sessionManager };
      }

      async function startedWithCaller(): Promise<{ workflowId: string; callerId: string; otherId: string }> {
        const { workflowId, taskIdOf } = await startedWith(['caller', 'other']);
        place(taskIdOf('caller'), 'Executing');
        place(taskIdOf('other'), 'Executing');
        homeDb().prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(CALLER_SESSION_ID, taskIdOf('caller'));
        vi.mocked(pauseTaskSession).mockResolvedValue('paused');
        return { workflowId, callerId: taskIdOf('caller'), otherId: taskIdOf('other') };
      }

      const pausedTaskIds = (): string[] => vi.mocked(pauseTaskSession).mock.calls.map(([, taskId]) => taskId);

      afterEach(() => {
        vi.useRealTimers();
      });

      it('pauses every other member at once, and the caller only once its turn has ended', async () => {
        const { workflowId, callerId, otherId } = await startedWithCaller();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { runtime, sessionManager } = withCallerMidTurn();

        const result = await service.pauseWorkflow(runtime, 'home', workflowId, 'a test', { callerSessionId: CALLER_SESSION_ID });

        expect(result).toMatchObject({ paused: 2, failed: [], callerPausesAfterTurn: true });
        expect(pausedTaskIds()).toEqual([otherId]);
        // Its turn's end must not run the column's rows on a paused workflow.
        expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(true);

        sessionManager.emit('activity', CALLER_SESSION_ID, 'idle');
        await vi.advanceTimersByTimeAsync(1_500);

        await vi.waitFor(() => expect(pausedTaskIds()).toEqual([otherId, callerId]));
        await vi.waitFor(() => expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(false));
      });

      it('leaves the caller working when a Resume landed before its turn ended', async () => {
        const { workflowId, otherId } = await startedWithCaller();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { runtime, sessionManager } = withCallerMidTurn();

        await service.pauseWorkflow(runtime, 'home', workflowId, 'a test', { callerSessionId: CALLER_SESSION_ID });
        new WorkflowRepository(homeDb()).setState(workflowId, 'running');
        sessionManager.emit('activity', CALLER_SESSION_ID, 'idle');
        await vi.advanceTimersByTimeAsync(1_500);

        await vi.waitFor(() => expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(false));
        expect(pausedTaskIds()).toEqual([otherId]);
      });

      it('releases the caller\'s mark and lets nothing escape when its pause fails after its turn ended', async () => {
        const { workflowId, callerId, otherId } = await startedWithCaller();
        vi.mocked(pauseTaskSession).mockImplementation(async (_context, taskId) => {
          if (taskId === callerId) throw new Error('suspend failed');
          return 'paused';
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const unhandledRejection = vi.fn();
        process.on('unhandledRejection', unhandledRejection);
        try {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
          const { runtime, sessionManager } = withCallerMidTurn();

          await service.pauseWorkflow(runtime, 'home', workflowId, 'a test', { callerSessionId: CALLER_SESSION_ID });
          expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(true);

          sessionManager.emit('activity', CALLER_SESSION_ID, 'idle');
          await vi.advanceTimersByTimeAsync(1_500);

          // A failed pause must still lift the mark, or the session's later turns run no column rows.
          await vi.waitFor(() => expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(false));
          // The caller's pause was attempted, so the release above is not an early return.
          expect(pausedTaskIds()).toEqual([otherId, callerId]);
          // An unhandled rejection is raised after the microtask queue drains: let one real turn of the loop pass.
          // setImmediate is not faked above.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(unhandledRejection).not.toHaveBeenCalled();
          // Handled, and not silently: the failure is logged.
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not pause'), expect.any(Error));
        } finally {
          process.off('unhandledRejection', unhandledRejection);
        }
      });

      it('pauses only the caller\'s own session after its turn: a newer live session of the task is declined', async () => {
        const { workflowId, callerId } = await startedWithCaller();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { runtime, sessionManager } = withCallerMidTurn();

        await service.pauseWorkflow(runtime, 'home', workflowId, 'a test', { callerSessionId: CALLER_SESSION_ID });
        sessionManager.emit('activity', CALLER_SESSION_ID, 'idle');
        await vi.advanceTimersByTimeAsync(1_500);
        await vi.waitFor(() => expect(pausedTaskIds()).toContain(callerId));

        const callerPause = vi.mocked(pauseTaskSession).mock.calls.find(([, taskId]) => taskId === callerId);
        const stillEligible = callerPause?.[2]?.stillEligible;
        expect(stillEligible).toBeDefined();
        expect(stillEligible!({ id: CALLER_SESSION_ID } as never)).toBe(true);
        // The task may have a newer session by now, one a Resume started: it is not the one that asked.
        expect(stillEligible!({ id: 'session-newer' } as never)).toBe(false);
        await vi.waitFor(() => expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(false));
      });

      it('pauses every member at once when the caller\'s session is no member\'s (the control)', async () => {
        const { workflowId, callerId, otherId } = await startedWithCaller();

        const result = await service.pauseWorkflow(context, 'home', workflowId, 'a test', { callerSessionId: 'session-elsewhere' });

        expect(result.callerPausesAfterTurn).toBe(false);
        expect(pausedTaskIds().sort()).toEqual([callerId, otherId].sort());
        expect(isSessionInOwnCall(CALLER_SESSION_ID)).toBe(false);
      });
    });

    it('pauses a held task\'s agent too: a workflow set down frees every agent it holds', async () => {
      // Decided 2026-10-27 (#925): #923's hold never suspends an agent by itself, but
      // the workflow's own Pause does, for every task.
      const { workflowId, taskIdOf } = await startedWith(['held', 'free']);
      place(taskIdOf('held'), 'Executing');
      place(taskIdOf('free'), 'Executing');
      homeDb().prepare('UPDATE tasks SET automations_disabled = 1 WHERE id = ?').run(taskIdOf('held'));
      vi.mocked(pauseTaskSession).mockResolvedValue('paused');

      const result = await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      expect(vi.mocked(pauseTaskSession).mock.calls.map(([, taskId]) => taskId).sort())
        .toEqual([taskIdOf('held'), taskIdOf('free')].sort());
      expect(result).toMatchObject({ paused: 2, failed: [] });
    });

    it('resumes a paused agent in any working column, starts one where there is none, and leaves a live one alone', async () => {
      const { workflowId, taskIdOf } = await startedWith(['paused', 'gate', 'empty', 'quiet', 'live', 'waiting', 'done']);
      place(taskIdOf('paused'), 'Executing');
      // A person resumed this one in a column that starts no agent, and the Pause stopped it.
      homeDb().prepare('UPDATE swimlanes SET auto_spawn = 0 WHERE id = ?').run(laneNamed('Code Review').id);
      place(taskIdOf('gate'), 'Code Review');
      place(taskIdOf('empty'), 'Testing');
      // Its Board Profile turns Testing's agent off, so Resume starts none for it.
      place(taskIdOf('quiet'), 'Testing');
      homeDb().prepare('UPDATE tasks SET profile_id = ? WHERE id = ?').run('quiet', taskIdOf('quiet'));
      place(taskIdOf('live'), 'Executing');
      place(taskIdOf('done'), 'Done');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const live = new Set([taskIdOf('live')]);
      const runtime = withSessions([taskIdOf('paused'), taskIdOf('gate')], live);
      vi.mocked(reconcileTaskSessionRef).mockImplementation((_context, _projectId, taskId) => ({
        task: tasksOf('home').getById(taskId)!,
        liveSession: live.has(taskId)
          ? ({ id: `live-${taskId}`, taskId, projectId: 'home', agentSessionId: 'agent-1', isolatedSwimlaneId: null } as never)
          : null,
      }));
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => ({ id: `resumed-${taskId}` }) as never);
      // A start that never settles: Resume answers on acceptance, as the phone's Start does.
      vi.mocked(autoSpawnForTask).mockImplementation(() => new Promise<void>(() => {}));
      const catchUps: unknown[] = [];
      setWorkflowCatchUp((resumed) => catchUps.push(resumed));

      let result: Awaited<ReturnType<typeof service.resumeWorkflow>>;
      try {
        result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');
      } finally {
        setWorkflowCatchUp(null);
      }

      expect(vi.mocked(resumeTaskSession).mock.calls.map(([, taskId]) => taskId).sort())
        .toEqual([taskIdOf('paused'), taskIdOf('gate')].sort());
      // Not an explicit start: the column's own auto_spawn and a held pause still decide.
      expect(vi.mocked(autoSpawnForTask).mock.calls).toEqual([
        [runtime, 'home', { id: taskIdOf('empty'), title: 'empty' }, laneNamed('Testing').id],
      ]);
      expect(result).toMatchObject({ resumed: 2, started: 1, alreadyRunning: 1, failed: [] });
      expect(result.workflow.state).toBe('running');
      // The agent left running gets its reply judged, so a card worked to the
      // end of its column during the pause moves on. The resumed ones get theirs
      // from their own resume.
      expect(catchUps).toEqual([{
        sessionId: `live-${taskIdOf('live')}`,
        taskId: taskIdOf('live'),
        projectId: 'home',
        agentSessionId: 'agent-1',
        isolatedSwimlaneId: null,
        workSerial: 7,
        resumedBy: 'user',
      }]);
    });

    it('brings back a held task\'s paused agent, and starts none for a held task with no agent', async () => {
      const { workflowId, taskIdOf } = await startedWith(['held paused', 'held empty']);
      place(taskIdOf('held paused'), 'Executing');
      place(taskIdOf('held empty'), 'Executing');
      homeDb().prepare('UPDATE tasks SET automations_disabled = 1 WHERE id IN (?, ?)').run(taskIdOf('held paused'), taskIdOf('held empty'));
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([taskIdOf('held paused')], new Set());
      vi.mocked(reconcileTaskSessionRef).mockImplementation((_context, _projectId, taskId) => ({
        task: tasksOf('home').getById(taskId)!,
        liveSession: null,
      }));
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => ({ id: `resumed-${taskId}` }) as never);

      const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');

      expect(vi.mocked(resumeTaskSession).mock.calls.map(([, taskId]) => taskId)).toEqual([taskIdOf('held paused')]);
      expect(autoSpawnForTask).not.toHaveBeenCalled();
      expect(result).toMatchObject({ resumed: 1, started: 0 });
    });

    it('counts no resume another action cancelled, and reports one that failed', async () => {
      const { workflowId, taskIdOf } = await startedWith(['cancelled', 'broken']);
      place(taskIdOf('cancelled'), 'Executing');
      place(taskIdOf('broken'), 'Executing');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([taskIdOf('cancelled'), taskIdOf('broken')], new Set());
      vi.mocked(reconcileTaskSessionRef).mockImplementation((_context, _projectId, taskId) => ({
        task: tasksOf('home').getById(taskId)!,
        liveSession: null,
      }));
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => {
        if (taskId === taskIdOf('broken')) throw new Error('Worktree setup failed: disk full');
        return null;
      });

      const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');

      const broken = tasksOf('home').getById(taskIdOf('broken'))!;
      expect(result).toMatchObject({
        resumed: 0,
        started: 0,
        failed: [{ projectId: 'home', taskId: broken.id, displayId: broken.display_id }],
      });
    });

    /** Resume reads each task as it is now: the row, and no live agent. */
    function reconcileToCurrentRows(): void {
      vi.mocked(reconcileTaskSessionRef).mockImplementation((_context, projectId, taskId) => ({
        task: tasksOf(projectId).getById(taskId)!,
        liveSession: null,
      }));
    }

    it('hands the resume a hook that shows the spawn-blocked notice for the task it failed on, on that task\'s own board', async () => {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, plan());
      await service.startWorkflow(context, 'home', workflow.id);
      // The phone task is on the mobile board, so the home board's id is the wrong answer.
      const phone = tasksOf('mobile').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets on the phone')!;
      const mobileExecuting = lanesOf('mobile').find((lane) => lane.name === 'Executing')!;
      (harness.dbs.get('mobile') as Database.Database).prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(mobileExecuting.id, phone.id);
      await service.pauseWorkflow(context, 'home', workflow.id, 'a test');

      const runtime = withSessions([phone.id], new Set());
      reconcileToCurrentRows();
      const received: { options?: Parameters<typeof resumeTaskSession>[2] } = {};
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId, options) => {
        received.options = options;
        return { id: `resumed-${taskId}` } as never;
      });

      const result = await service.resumeWorkflow(runtime, 'home', workflow.id, 'a test');

      expect(result).toMatchObject({ resumed: 1, failed: [] });
      expect(received.options?.projectId).toBe('mobile');
      expect(received.options?.onFailed).toBeTypeOf('function');
      // Nothing failed yet, so no notice: the hook is what raises one.
      expect(notifySpawnBlocked).not.toHaveBeenCalled();

      // The task the resume hands the hook is the one it re-read, not the one Resume listed.
      const failure = new Error('Worktree setup failed: disk full');
      const rereadTask = { ...phone, title: 'Budgets on the phone, re-read' };
      received.options!.onFailed!('worktree', failure, rereadTask);

      expect(notifySpawnBlocked).toHaveBeenCalledTimes(1);
      const [noticeContext, noticeTask, noticeStep, noticeError, noticeProjectId] = vi.mocked(notifySpawnBlocked).mock.calls[0];
      expect(noticeContext).toBe(runtime);
      expect(noticeTask).toBe(rereadTask);
      expect(noticeStep).toBe('worktree');
      expect(noticeError).toBe(failure);
      expect(noticeProjectId).toBe('mobile');
    });

    it('skips, and does not fail, a resume that rejects after its card left for To Do or Done or was archived', async () => {
      const { workflowId, taskIdOf } = await startedWith(['to do', 'done', 'archived']);
      for (const title of ['to do', 'done', 'archived']) place(taskIdOf(title), 'Executing');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([taskIdOf('to do'), taskIdOf('done'), taskIdOf('archived')], new Set());
      reconcileToCurrentRows();
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => {
        // The person's answer lands while the resume is in flight, after Resume
        // saw each card in a working column, so the resume then refuses.
        if (taskId === taskIdOf('to do')) place(taskId, 'To Do');
        else if (taskId === taskIdOf('done')) place(taskId, 'Done');
        else tasksOf('home').archive(taskId);
        throw new Error('Cannot resume a task that has left its working column');
      });

      const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');

      expect(vi.mocked(resumeTaskSession)).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ resumed: 0, started: 0, alreadyRunning: 0, failed: [] });
    });

    it('skips a resume that rejects after its card was deleted', async () => {
      const { workflowId, taskIdOf } = await startedWith(['deleted']);
      place(taskIdOf('deleted'), 'Executing');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([taskIdOf('deleted')], new Set());
      reconcileToCurrentRows();
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => {
        // A row delete, not TaskRepository.delete, which also releases dev ports through the global database.
        homeDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
        throw new Error('Task not found');
      });

      const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');

      expect(vi.mocked(resumeTaskSession)).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ resumed: 0, started: 0, alreadyRunning: 0, failed: [] });
    });

    it('a refusal does not hide a sibling\'s real failure: only the card still in its working column is reported failed', async () => {
      const { workflowId, taskIdOf } = await startedWith(['moved on', 'broken']);
      place(taskIdOf('moved on'), 'Executing');
      place(taskIdOf('broken'), 'Executing');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([taskIdOf('moved on'), taskIdOf('broken')], new Set());
      reconcileToCurrentRows();
      vi.mocked(resumeTaskSession).mockImplementation(async (_context, taskId) => {
        if (taskId === taskIdOf('moved on')) place(taskId, 'Done');
        throw new Error('Worktree setup failed: disk full');
      });

      const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');

      const broken = tasksOf('home').getById(taskIdOf('broken'))!;
      expect(result).toMatchObject({
        resumed: 0,
        failed: [{ projectId: 'home', taskId: broken.id, displayId: broken.display_id }],
      });
      expect(result.failed).toHaveLength(1);
    });

    it('counts a start as accepted when its agent later fails to start, and leaves that rejection caught', async () => {
      const { workflowId, taskIdOf } = await startedWith(['empty']);
      place(taskIdOf('empty'), 'Testing');
      await service.pauseWorkflow(context, 'home', workflowId, 'a test');

      const runtime = withSessions([], new Set());
      reconcileToCurrentRows();
      // autoSpawnForTask shows its own spawn-blocked notice before it rejects:
      // Resume only has to survive the rejection, not report it. Not
      // mockRejectedValue: vi.fn() attaches its own reaction to every real
      // Promise a mock returns, to record the settled result, and that marks the
      // rejection handled, so a missing catch would never reach Node's
      // unhandled-rejection tracking. A thenable that is not a Promise is left
      // alone; only a handler the code under test attaches handles it.
      const rejection = new Error('Worktree setup failed: disk full');
      vi.mocked(autoSpawnForTask).mockImplementation(() => {
        const rejected = Promise.reject(rejection);
        return {
          then: (onFulfilled: never, onRejected: never) => rejected.then(onFulfilled, onRejected),
          catch: (onRejected: never) => rejected.catch(onRejected),
        } as never;
      });
      const unhandled: unknown[] = [];
      const collectUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', collectUnhandled);

      try {
        const result = await service.resumeWorkflow(runtime, 'home', workflowId, 'a test');
        // Node reports an unhandled rejection once the microtask queue drains:
        // let the loop turn twice so a missing catch has been seen.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(autoSpawnForTask).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ resumed: 0, started: 1, alreadyRunning: 0, failed: [] });
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', collectUnhandled);
      }
    });
  });

  it('starts: tasks in To Do on their boards, with routes and cross-board links', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    const result = await service.startWorkflow(context, 'home', workflow.id);
    expect(result.workflow.state).toBe('running');
    expect(result.createdCount).toBe(3);

    const homeTasks = tasksOf('home').listByWorkflow(workflow.id);
    const mobileTasks = tasksOf('mobile').listByWorkflow(workflow.id);
    expect(homeTasks.map((task) => task.title).sort()).toEqual(['Budgets API', 'Budgets UI']);
    expect(mobileTasks.map((task) => task.title)).toEqual(['Budgets on the phone']);
    const homeTodo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    expect(homeTasks.every((task) => task.swimlane_id === homeTodo.id)).toBe(true);
    expect(mobileTasks[0].workflow_project_id).toBe('home');

    const links = new TaskLinkRepository(harness.dbs.get('home') as Database.Database).listForWorkflow(workflow.id);
    expect(links).toHaveLength(2);
    expect(links.some((link) => link.blocked_project_id === 'mobile')).toBe(true);

    const view = service.readWorkflow(context, 'home', workflow.id);
    const phone = view.tasks.find((task) => task.title === 'Budgets on the phone')!;
    expect(phone.route).toEqual(['Planning', 'Executing', 'Code Review']);
    expect(phone.waitsFor).toHaveLength(1);
  });

  describe('which board a task is on, in the read model', () => {
    // Task numbers count per board, so the home board's first task and the second
    // board's first task are both #1. The read model names the board of a task
    // that is not on the home board, and of a blocker that is not, so the
    // agent-facing text can tell the two #1s apart.

    it('names the project of a planned task on another board, and no project for one on the home board', () => {
      const workflow = planAcrossBoards(service, context);

      const view = service.readWorkflow(context, 'home', workflow.id);

      expect(taskTitled(view, 'Budgets on the phone').board).toBe('kangentic-mobile');
      expect(taskTitled(view, 'Budgets API').board).toBeNull();
      expect(taskTitled(view, 'Budgets UI').board).toBeNull();
    });

    it('names the board of a started task on another board, and names a blocker there by it when its number matches a home task', async () => {
      const workflow = planAcrossBoards(service, context);
      await service.startWorkflow(context, 'home', workflow.id);

      const view = service.readWorkflow(context, 'home', workflow.id);

      const api = taskTitled(view, 'Budgets API');
      const phone = taskTitled(view, 'Budgets on the phone');
      const ui = taskTitled(view, 'Budgets UI');
      // The pinned ambiguity: each board's first task is #1.
      expect(phone.displayId).toBe(api.displayId);
      expect(phone.board).toBe('kangentic-mobile');
      expect(api.board).toBeNull();
      expect(ui.board).toBeNull();
      expect(api.waitsFor).toEqual([`#${phone.displayId} on "kangentic-mobile"`]);
      // A blocker on the home board stays a bare number.
      expect(ui.waitsFor).toEqual([`#${api.displayId}`]);
    });

    it('falls back to the project id when the board\'s project is no longer registered', async () => {
      const workflow = planAcrossBoards(service, context);
      await service.startWorkflow(context, 'home', workflow.id);
      const registeredProject = context.projectRepo.getById.bind(context.projectRepo);
      vi.spyOn(context.projectRepo, 'getById').mockImplementation((projectId: string) => (
        projectId === 'mobile' ? undefined : registeredProject(projectId)
      ));

      const view = service.readWorkflow(context, 'home', workflow.id);

      const api = taskTitled(view, 'Budgets API');
      const phone = taskTitled(view, 'Budgets on the phone');
      expect(phone.board).toBe('mobile');
      expect(api.waitsFor).toEqual([`#${phone.displayId} on "mobile"`]);
    });
  });

  describe('the task a workflow was made from', () => {
    let wake: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.mocked(handleTaskMove).mockReset();
      vi.mocked(notifyWorkflowChanged).mockClear();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      wake = vi.fn();
      setWorkflowWake(wake);
    });

    afterEach(() => {
      setWorkflowWake(null);
    });

    /** A workflow planned from a task waiting in To Do on the home board. */
    function plannedFromSource(): { workflowId: string; source: { id: string; display_id: number }; todoId: string; doneId: string } {
      const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
      const done = lanesOf('home').find((lane) => lane.role === 'done')!;
      const source = tasksOf('home').create({ title: 'Budgets', description: '', swimlane_id: todo.id });
      const workflow = service.createWorkflow('home', { sourceTaskId: source.id });
      service.savePlan(context, 'home', workflow.id, plan());
      return { workflowId: workflow.id, source, todoId: todo.id, doneId: done.id };
    }

    it('moves it to Done on Start, and reports which task it superseded (the control)', async () => {
      const { workflowId, source, doneId } = plannedFromSource();

      const result = await service.startWorkflow(context, 'home', workflowId);

      expect(handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: source.id, targetSwimlaneId: doneId }),
        'workflow',
        'home',
        '/projects/home',
        expect.anything(),
      );
      expect(result.supersededSource).toBe(source.display_id);
    });

    it('still starts when it cannot move to Done: the workflow runs, the engine wakes, and the task stays in To Do', async () => {
      const { workflowId, source, todoId, doneId } = plannedFromSource();
      vi.mocked(handleTaskMove).mockRejectedValueOnce(new Error('Worktree setup failed: no space left'));
      wake.mockClear();
      vi.mocked(notifyWorkflowChanged).mockClear();

      const result = await service.startWorkflow(context, 'home', workflowId);

      expect(handleTaskMove).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ taskId: source.id, targetSwimlaneId: doneId }),
        'workflow',
        'home',
        '/projects/home',
        expect.anything(),
      );
      expect(result.workflow.state).toBe('running');
      expect(result.createdCount).toBe(3);
      expect(result.supersededSource).toBeNull();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
      expect(tasksOf('home').getById(source.id)!.swimlane_id).toBe(todoId);
      expect(tasksOf('home').listByWorkflow(workflowId)).toHaveLength(2);
    });
  });

  it('refuses to start an empty workflow, or one already started', async () => {
    const empty = service.createWorkflow('home', {});
    await expect(service.startWorkflow(context, 'home', empty.id)).rejects.toThrow(/no tasks yet/);
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toThrow(/already started/);
  });

  it('takes in a board task in To Do instead of creating one', async () => {
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Already here', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'old', title: 'Already here', existingTask: String(existing.display_id) }],
      links: [],
    });
    const result = await service.startWorkflow(context, 'home', workflow.id);
    expect(result.createdCount).toBe(0);
    expect(tasksOf('home').getById(existing.id)!.workflow_id).toBe(workflow.id);
  });

  it('a board task taken in with its own plan approval keeps it on the task row, as a created task does', async () => {
    // The seeded Planning column is Manual, so Automatic is an override that is stored.
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Already here', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    const saved = service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'old', title: 'Already here', existingTask: String(existing.display_id), planApproval: 'automatic' }],
      links: [],
    });
    // The controls: the plan holds it, and the board task carries nothing until Start joins it.
    expect(saved.draft?.tasks[0].plan_approval).toBe('automatic');
    expect(tasksOf('home').getById(existing.id)!.plan_approval).toBeNull();

    await service.startWorkflow(context, 'home', workflow.id);

    expect(tasksOf('home').getById(existing.id)!.plan_approval).toBe('automatic');
  });

  it('a board task taken in with no plan approval of its own joins following its plan columns', async () => {
    // The pair of the test above: only a planned value reaches the row, so a
    // Start that wrote one onto every taken-in task would fail here.
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Already here', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'old', title: 'Already here', existingTask: String(existing.display_id) }],
      links: [],
    });

    await service.startWorkflow(context, 'home', workflow.id);

    expect(tasksOf('home').getById(existing.id)!.workflow_id).toBe(workflow.id);
    expect(tasksOf('home').getById(existing.id)!.plan_approval).toBeNull();
  });

  it('a board task taken in with its automations switch on joins with it cleared, and the board hears it only after the write', async () => {
    // Joining clears the switch (setWorkflowMembership) without bumping
    // updated_at. A paired phone re-reads its board on the board event, so the
    // row must already read false when the event fires.
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const held = tasksOf('home').create({ title: 'Held', description: '', swimlane_id: todo.id, automations_disabled: true });
    expect(tasksOf('home').getById(held.id)!.automations_disabled).toBe(true);
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [{ key: 'held', title: 'Held', existingTask: String(held.display_id) }],
      links: [],
    });
    // Recorded, not asserted, in the listener, so a failure cannot be lost to
    // whatever catches a listener's throw.
    const switchAtEachEmit: boolean[] = [];
    vi.mocked(context.boardEvents.emitBoardChanged).mockImplementation((event) => {
      if (event.projectId === 'home') switchAtEachEmit.push(tasksOf('home').getById(held.id)!.automations_disabled);
    });

    await service.startWorkflow(context, 'home', workflow.id);

    expect(tasksOf('home').getById(held.id)!.automations_disabled).toBe(false);
    expect(switchAtEachEmit.length).toBeGreaterThan(0);
    expect(switchAtEachEmit.every((automationsDisabled) => automationsDisabled === false)).toBe(true);
  });

  describe('a Start whose write fails after an earlier board committed', () => {
    // Start writes one transaction per board, then the home database's links and
    // state: separate files, so no single transaction spans them. A write that
    // throws part way undoes what the committed boards hold (the tasks it
    // created are deleted, the board tasks it took in leave the workflow), so
    // the workflow stays a draft and a retry of Start can start it.
    const diskFull = new Error('disk full');

    /**
     * A taken-in home task, a new home task, then a new task on the second board.
     * Boards are written in the plan's order, so the home board commits before the
     * second one is touched: a failure on the second board has something to undo.
     */
    function plannedAcrossBoards() {
      const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
      const takenIn = tasksOf('home').create({ title: 'Already here', description: '', swimlane_id: todo.id });
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        title: 'Usage budgets',
        tasks: [
          { key: 'old', title: 'Already here', existingTask: String(takenIn.display_id) },
          { key: 'api', title: 'Budgets API' },
          { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
        ],
        links: [{ blocker: 'old', blocked: 'api' }, { blocker: 'api', blocked: 'phone' }],
      });
      return { workflow, takenIn, todoId: todo.id };
    }

    const homeLinks = () => new TaskLinkRepository(harness.dbs.get('home') as Database.Database);
    const titlesOn = (projectId: string) => tasksOf(projectId).list().map((task) => task.title).sort();

    /** Nothing of the failed Start is left: a draft with its plan, and the boards as they were. */
    function expectBoardsAsBeforeStart(workflowId: string, takenInId: string, todoId: string): void {
      const workflow = service.requireWorkflow('home', workflowId);
      expect(workflow.state).toBe('draft');
      expect(workflow.draft?.tasks).toHaveLength(3);
      // Created tasks are gone, and the one taken in is an ordinary task in To Do again.
      expect(titlesOn('home')).toEqual(['Already here']);
      expect(titlesOn('mobile')).toEqual([]);
      const takenIn = tasksOf('home').getById(takenInId)!;
      expect(takenIn.workflow_id).toBeNull();
      expect(takenIn.workflow_project_id).toBeNull();
      expect(takenIn.swimlane_id).toBe(todoId);
      expect(tasksOf('home').listByWorkflow(workflowId)).toEqual([]);
      expect(homeLinks().listForWorkflow(workflowId)).toEqual([]);
    }

    /** The retry the undo exists for: it succeeds, and each planned task exists exactly once. */
    async function expectRetryStartsOnce(workflowId: string, takenInId: string): Promise<void> {
      const result = await service.startWorkflow(context, 'home', workflowId);

      expect(result.workflow.state).toBe('running');
      expect(result.createdCount).toBe(2);
      expect(titlesOn('home')).toEqual(['Already here', 'Budgets API']);
      expect(titlesOn('mobile')).toEqual(['Budgets on the phone']);
      expect(tasksOf('home').getById(takenInId)!.workflow_id).toBe(workflowId);
      expect(tasksOf('home').listByWorkflow(workflowId)).toHaveLength(2);
      expect(tasksOf('mobile').listByWorkflow(workflowId)).toHaveLength(1);
      expect(homeLinks().listForWorkflow(workflowId)).toHaveLength(2);
    }

    it('undoes the home board\'s writes when the second board\'s write throws, and a retry of Start succeeds', async () => {
      const { workflow, takenIn, todoId } = plannedAcrossBoards();
      const createTask = TaskRepository.prototype.create;
      // Only the second board's task fails; the home board's own creates run for real.
      const createSpy = vi.spyOn(TaskRepository.prototype, 'create').mockImplementation(function (this: InstanceType<typeof TaskRepository>, input) {
        if (input.title === 'Budgets on the phone') throw diskFull;
        return createTask.call(this, input);
      });

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toBe(diskFull);

      // The home board committed first, so the failure came after real writes.
      expect(createSpy.mock.calls.map(([input]) => input.title)).toEqual(['Budgets API', 'Budgets on the phone']);
      expectBoardsAsBeforeStart(workflow.id, takenIn.id, todoId);

      createSpy.mockRestore();
      await expectRetryStartsOnce(workflow.id, takenIn.id);
    });

    it.each([
      ['a link write', () => vi.spyOn(TaskLinkRepository.prototype, 'insert')],
      ['marking the workflow started', () => vi.spyOn(WorkflowRepository.prototype, 'markStarted')],
    ])('undoes both boards\' writes when the home write throws (%s), and a retry of Start succeeds', async (_label, spyOnWrite) => {
      const { workflow, takenIn, todoId } = plannedAcrossBoards();
      const writeSpy = spyOnWrite().mockImplementation(() => {
        throw diskFull;
      });

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toBe(diskFull);

      // Both boards had committed their tasks by then: the home board's and the second board's.
      expect(writeSpy).toHaveBeenCalled();
      expectBoardsAsBeforeStart(workflow.id, takenIn.id, todoId);

      writeSpy.mockRestore();
      await expectRetryStartsOnce(workflow.id, takenIn.id);
    });

    it('reports the write\'s own error, not the undo\'s, when the undo cannot reach a board', async () => {
      // The failure that got here may be the disk under one of the boards too:
      // the error to report is the Start's, and the undo only logs its own.
      const { workflow, takenIn } = plannedAcrossBoards();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(WorkflowRepository.prototype, 'markStarted').mockImplementation(() => {
        throw diskFull;
      });
      const setMembership = TaskRepository.prototype.setWorkflowMembership;
      const membershipSpy = vi.spyOn(TaskRepository.prototype, 'setWorkflowMembership').mockImplementation(function (this: InstanceType<typeof TaskRepository>, taskId, membership) {
        // Start joins tasks to the workflow for real; only the undo's release (null) fails.
        if (membership === null) throw new Error('undo failed');
        setMembership.call(this, taskId, membership);
      });

      await expect(service.startWorkflow(context, 'home', workflow.id)).rejects.toBe(diskFull);

      expect(membershipSpy).toHaveBeenCalledWith(takenIn.id, null);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Could not undo a failed Start'), expect.objectContaining({ message: 'undo failed' }));
    });
  });

  it('only lets a task in To Do wait, and removes a task with its links', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const api = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets API')!;
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;

    // Start the API task by hand: a started task can no longer wait.
    const executing = lanesOf('home').find((lane) => lane.name === 'Executing')!;
    tasksOf('home').move({ taskId: api.id, targetSwimlaneId: executing.id, targetPosition: 0 }, { origin: 'workflow' });
    expect(() => service.linkTasks(context, 'home', workflow.id, { blocker: String(ui.display_id), blocked: String(api.display_id) }))
      .toThrow(/has started/);

    const removed = service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) });
    expect(removed.workflow_id).toBeNull();
    expect(new TaskLinkRepository(harness.dbs.get('home') as Database.Database).listBlockersOf(ui.id)).toEqual([]);
  });

  it('releasing a started task clears its own plan approval with the rest of its membership', async () => {
    // An ordinary task follows no workflow's plan columns, so a value left on
    // the row would be read again the day the task joins another workflow.
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
    const api = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets API')!;
    // Read raw, around the repository's narrowing.
    const storedApproval = (taskId: string): unknown => {
      const row = (harness.dbs.get('home') as Database.Database)
        .prepare('SELECT plan_approval FROM tasks WHERE id = ?')
        .get(taskId) as { plan_approval: unknown } | undefined;
      return row === undefined ? 'no such row' : row.plan_approval;
    };
    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: ui.id, projectId: 'home' }, 'automatic');
    service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: api.id, projectId: 'home' }, 'automatic');
    // The control: both carry it before the release.
    expect(storedApproval(ui.id)).toBe('automatic');
    expect(storedApproval(api.id)).toBe('automatic');

    service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) });

    expect(storedApproval(ui.id)).toBeNull();
    expect(tasksOf('home').getById(ui.id)!.workflow_id).toBeNull();
    // Only the released task: the one still in the workflow keeps its own value.
    expect(storedApproval(api.id)).toBe('automatic');
  });

  it('removes a task\'s links before it clears the task\'s membership, so a failure between the two writes leaves a member with no links', async () => {
    // The links are in the home database and the membership on the task's own
    // board: two writes. If the second fails, links left to a task outside the
    // workflow would hold a dependent back forever (a blocker the workflow
    // cannot see is never done), while a member with no links can be removed again.
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
    const links = new TaskLinkRepository(harness.dbs.get('home') as Database.Database);
    const linksOfUi = () => links.listForWorkflow(workflow.id)
      .filter((link) => link.blocker_task_id === ui.id || link.blocked_task_id === ui.id);
    expect(linksOfUi()).toHaveLength(1);
    vi.spyOn(TaskRepository.prototype, 'setWorkflowMembership').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) })).toThrow('disk full');

    expect(linksOfUi()).toEqual([]);
    // Still a member, and the other task's links are untouched.
    expect(tasksOf('home').getById(ui.id)!.workflow_id).toBe(workflow.id);
    expect(links.listForWorkflow(workflow.id)).toHaveLength(1);
  });

  it('keeps a started task\'s past route fixed, and lets what is ahead change', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
    const review = lanesOf('home').find((lane) => lane.name === 'Code Review')!;
    tasksOf('home').move({ taskId: ui.id, targetSwimlaneId: review.id, targetPosition: 0 }, { origin: 'workflow' });

    expect(() => service.setTaskRoute(context, 'home', workflow.id, { task: String(ui.display_id), skip: ['Planning'] }))
      .toThrow(/Only the columns after it can change/);
    const updated = service.setTaskRoute(context, 'home', workflow.id, { task: String(ui.display_id), skip: ['Testing'] });
    const testing = lanesOf('home').find((lane) => lane.name === 'Testing')!;
    expect(updated.skipped_swimlane_ids).toEqual([testing.id]);
  });

  describe('a route that starts after it ends', () => {
    // An empty route sends a task straight to Done when its blockers clear, with
    // no agent having worked it, so every writer of a route refuses this order.
    const REVERSED = /routeStart comes after routeLast/;

    const laneNamed = (name: string) => lanesOf('home').find((lane) => lane.name === name)!;

    /** A started workflow (the plan's three tasks), with its Budgets UI task waiting in To Do and no route set. */
    async function startedWithUiInTodo() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, plan());
      await service.startWorkflow(context, 'home', workflow.id);
      const ui = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets UI')!;
      return { workflow, ui };
    }

    const storedRoute = (taskId: string) => {
      const task = tasksOf('home').getById(taskId)!;
      return { start: task.route_start_swimlane_id, last: task.route_last_swimlane_id, skipped: task.skipped_swimlane_ids };
    };

    const titlesOf = (workflowId: string) => tasksOf('home').listByWorkflow(workflowId).map((task) => task.title).sort();

    it('refuses setTaskRoute with both ends given in reverse order on a task in To Do, and stores nothing', async () => {
      const { workflow, ui } = await startedWithUiInTodo();
      expect(storedRoute(ui.id)).toEqual({ start: null, last: null, skipped: [] });

      expect(() => service.setTaskRoute(context, 'home', workflow.id, {
        task: String(ui.display_id),
        routeStart: 'Code Review',
        routeLast: 'Planning',
      })).toThrow(REVERSED);
      expect(storedRoute(ui.id)).toEqual({ start: null, last: null, skipped: [] });

      // The same two columns in board order are accepted, so the order is what was refused.
      service.setTaskRoute(context, 'home', workflow.id, {
        task: String(ui.display_id),
        routeStart: 'Planning',
        routeLast: 'Code Review',
      });
      expect(storedRoute(ui.id)).toEqual({ start: laneNamed('Planning').id, last: laneNamed('Code Review').id, skipped: [] });
    });

    it('refuses setTaskRoute naming only routeLast when it falls before the routeStart already stored, and keeps the stored route', async () => {
      const { workflow, ui } = await startedWithUiInTodo();
      // Valid on its own: with no last column set there is nothing to reverse against.
      service.setTaskRoute(context, 'home', workflow.id, { task: String(ui.display_id), routeStart: 'Code Review' });
      const stored = storedRoute(ui.id);
      expect(stored).toEqual({ start: laneNamed('Code Review').id, last: null, skipped: [] });

      expect(() => service.setTaskRoute(context, 'home', workflow.id, {
        task: String(ui.display_id),
        routeLast: 'Planning',
      })).toThrow(REVERSED);

      expect(storedRoute(ui.id)).toEqual(stored);
    });

    it('refuses addWorkflowTask with the route reversed, creating no task', async () => {
      const { workflow } = await startedWithUiInTodo();
      const titlesBefore = titlesOf(workflow.id);

      expect(() => service.addWorkflowTask(context, 'home', workflow.id, {
        key: 'extra',
        title: 'Reversed extra',
        routeStart: 'Code Review',
        routeLast: 'Planning',
      })).toThrow(REVERSED);

      expect(titlesOf(workflow.id)).toEqual(titlesBefore);
      expect(titlesOf(workflow.id)).not.toContain('Reversed extra');

      // The same two columns in board order create the task, so the order is what was refused.
      const created = service.addWorkflowTask(context, 'home', workflow.id, {
        key: 'extra',
        title: 'Ordered extra',
        routeStart: 'Planning',
        routeLast: 'Code Review',
      });
      expect(storedRoute(created.id)).toEqual({ start: laneNamed('Planning').id, last: laneNamed('Code Review').id, skipped: [] });
    });

    it('refuses savePlan with a task whose route is reversed, and keeps the stored draft', () => {
      // A draft is where a reversed route would otherwise sit unseen until Start.
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, plan());
      const repository = new WorkflowRepository(harness.dbs.get('home') as Database.Database);
      const stored = repository.getById(workflow.id)!;
      expect(stored.draft?.tasks.map((task) => task.key)).toEqual(['api', 'ui', 'phone']);

      expect(() => service.savePlan(context, 'home', workflow.id, plan({
        title: 'Reversed budgets',
        tasks: [{ key: 'api', title: 'Budgets API', routeStart: 'Code Review', routeLast: 'Planning' }],
        links: [],
      }))).toThrow(REVERSED);

      const afterRefusal = repository.getById(workflow.id)!;
      expect(afterRefusal.draft).toEqual(stored.draft);
      expect(afterRefusal.title).toBe(stored.title);
      expect(afterRefusal.revision).toBe(stored.revision);

      // The same two columns in board order are saved, so the order is what was refused.
      const saved = service.savePlan(context, 'home', workflow.id, plan({
        tasks: [{ key: 'api', title: 'Budgets API', routeStart: 'Planning', routeLast: 'Code Review' }],
        links: [],
      }));
      expect(saved.draft?.tasks).toHaveLength(1);
      expect(saved.draft?.tasks[0].route_start_swimlane_id).toBe(laneNamed('Planning').id);
      expect(saved.draft?.tasks[0].route_last_swimlane_id).toBe(laneNamed('Code Review').id);
    });
  });

  describe('the tasks an added task waits for', () => {
    // Task numbers count per board, so api (home) and phone (kangentic-mobile) are
    // both #1. A task id names one task of the workflow on any of its boards; a
    // number can only name a task on the home board.

    /** A started workflow whose api task is on the home board and whose phone task is on the mobile one, both still in To Do. */
    async function startedAcrossBoards() {
      const workflow = planAcrossBoards(service, context);
      await service.startWorkflow(context, 'home', workflow.id);
      const api = tasksOf('home').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets API')!;
      const phone = tasksOf('mobile').listByWorkflow(workflow.id).find((task) => task.title === 'Budgets on the phone')!;
      expect(phone.display_id).toBe(api.display_id);
      return { workflow, api, phone };
    }

    const linksInto = (workflowId: string, blockedTaskId: string) =>
      new TaskLinkRepository(harness.dbs.get('home') as Database.Database)
        .listForWorkflow(workflowId)
        .filter((link) => link.blocked_task_id === blockedTaskId);

    it('waits for a member task on another board named by its id, linked from that board', async () => {
      const { workflow, phone } = await startedAcrossBoards();

      const created = service.addWorkflowTask(context, 'home', workflow.id, { key: 'docs', title: 'Budgets docs', waitsFor: [phone.id] });

      const links = linksInto(workflow.id, created.id);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        blocker_task_id: phone.id,
        blocker_project_id: 'mobile',
        blocked_task_id: created.id,
        blocked_project_id: 'home',
      });
    });

    it('reads a number as a task on the home board, though the other board has a task with that number', async () => {
      const { workflow, api, phone } = await startedAcrossBoards();

      const created = service.addWorkflowTask(context, 'home', workflow.id, { key: 'docs', title: 'Budgets docs', waitsFor: [String(api.display_id)] });

      const links = linksInto(workflow.id, created.id);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ blocker_task_id: api.id, blocker_project_id: 'home' });
      expect(links[0].blocker_task_id).not.toBe(phone.id);
    });

    it('waits for a task on each board in one call, by an id and by a number', async () => {
      const { workflow, api, phone } = await startedAcrossBoards();

      const created = service.addWorkflowTask(context, 'home', workflow.id, { key: 'docs', title: 'Budgets docs', waitsFor: [phone.id, String(api.display_id)] });

      const links = linksInto(workflow.id, created.id);
      expect(links.map((link) => [link.blocker_project_id, link.blocker_task_id]).sort()).toEqual(
        [['home', api.id], ['mobile', phone.id]].sort(),
      );
    });

    it('still names a member task on the home board by its id', async () => {
      const { workflow, api } = await startedAcrossBoards();

      const created = service.addWorkflowTask(context, 'home', workflow.id, { key: 'docs', title: 'Budgets docs', waitsFor: [api.id] });

      expect(linksInto(workflow.id, created.id)).toMatchObject([{ blocker_task_id: api.id, blocker_project_id: 'home' }]);
    });

    it('refuses the id of a task on another board that is not in the workflow, creating no task', async () => {
      const { workflow } = await startedAcrossBoards();
      const mobileTodo = lanesOf('mobile').find((lane) => lane.role === 'todo')!;
      const outsider = tasksOf('mobile').create({ title: 'Not in the workflow', description: '', swimlane_id: mobileTodo.id });
      const titlesBefore = tasksOf('home').listByWorkflow(workflow.id).map((task) => task.title).sort();

      expect(() => service.addWorkflowTask(context, 'home', workflow.id, { key: 'docs', title: 'Budgets docs', waitsFor: [outsider.id] }))
        .toThrow(/No task/);

      expect(tasksOf('home').listByWorkflow(workflow.id).map((task) => task.title).sort()).toEqual(titlesBefore);
    });
  });

  it('keeps only the text labels of an added task: a label that is not text never reaches the task row', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);

    const created = service.addWorkflowTask(context, 'home', workflow.id, {
      key: 'extra',
      title: 'Labelled extra',
      // An agent's input is not checked against the type: numbers and nulls arrive from the tool call.
      labels: ['ui', 1, null, 'api'] as unknown as string[],
    });

    expect(created.labels).toEqual(['ui', 'api']);
    // Read the column itself: the repository's read path drops non-text entries too,
    // so a re-read through it would pass whatever was written.
    const row = (harness.dbs.get('home') as Database.Database)
      .prepare('SELECT labels FROM tasks WHERE id = ?')
      .get(created.id) as { labels: string };
    expect(JSON.parse(row.labels)).toEqual(['ui', 'api']);
  });

  it('deletes a started workflow, leaving its unfinished tasks as ordinary tasks', async () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, plan());
    await service.startWorkflow(context, 'home', workflow.id);
    const result = service.deleteWorkflow(context, 'home', workflow.id);
    expect(result.released).toHaveLength(3);
    expect(tasksOf('home').listByWorkflow(workflow.id)).toEqual([]);
    expect(tasksOf('mobile').listByWorkflow(workflow.id)).toEqual([]);
  });

  // "Also delete its tasks that never started": a task in To Do that never had a
  // session, has no worktree and was never in another column. A move back to To
  // Do wipes a task's sessions and worktree, so only its moves say it ran.
  describe('deleting the tasks that never started', () => {
    beforeEach(() => {
      vi.mocked(deleteTaskWithCleanup).mockReset();
      vi.mocked(deleteTaskWithCleanup).mockImplementation(async (_context, projectId, _projectPath, taskId, onlyIf) => {
        const tasks = tasksOf(projectId!);
        const task = tasks.getById(taskId);
        if (task && onlyIf && !onlyIf(task)) return false;
        tasks.delete(taskId);
        return true;
      });
      // The delete ends the workflow agent's session in the background; this context has none to end.
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    /** A started workflow whose tasks have each done one thing a task that ran does. */
    async function startedWithHistory() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, {
        title: 'Usage budgets',
        tasks: [
          { key: 'fresh', title: 'Never started' },
          { key: 'ran', title: 'Had a session' },
          { key: 'checkout', title: 'Has a worktree' },
          { key: 'bounced', title: 'Left To Do and came back' },
          { key: 'phone', title: 'Never started on the phone', project: 'kangentic-mobile' },
        ],
        links: [],
      });
      await service.startWorkflow(context, 'home', workflow.id);
      const home = tasksOf('home');
      const byTitle = (title: string) => home.listByWorkflow(workflow.id).find((task) => task.title === title)!;
      const ran = byTitle('Had a session');
      // An exited session: the row's session_id is clear, only the record says it ran.
      new SessionRepository(harness.dbs.get('home') as Database.Database).insert({
        id: 'session-ran', task_id: ran.id, session_type: 'claude_agent', isolated_swimlane_id: null,
        agent_session_id: 'agent-ran', command: 'claude', cwd: '/projects/home', permission_mode: null, prompt: null,
        status: 'exited', exit_code: 0, started_at: '2026-10-01T00:00:00.000Z', suspended_at: null,
        exited_at: '2026-10-01T00:10:00.000Z', suspended_by: null,
      });
      const checkout = byTitle('Has a worktree');
      home.update({ id: checkout.id, worktree_path: '/projects/home/.kangentic/worktrees/checkout' });
      const bounced = byTitle('Left To Do and came back');
      const lanes = lanesOf('home');
      const planning = lanes.find((lane) => lane.name === 'Planning')!;
      const todo = lanes.find((lane) => lane.role === 'todo')!;
      home.move({ taskId: bounced.id, targetSwimlaneId: planning.id, targetPosition: 0 }, { origin: 'renderer' });
      home.move({ taskId: bounced.id, targetSwimlaneId: todo.id, targetPosition: 0 }, { origin: 'renderer' });
      const [phone] = tasksOf('mobile').listByWorkflow(workflow.id);
      return { workflow, fresh: byTitle('Never started'), ran, checkout, bounced, phone };
    }

    /** The `task-deleted` board events emitted so far: which board heard them, and the task ids each names. */
    function taskDeletedEvents(): Array<{ projectId: string; change: string; ids: string[] }> {
      return vi.mocked(context.boardEvents.emitBoardChanged).mock.calls
        .map(([event]) => event as { projectId: string; change: string; ids?: string[] })
        .filter((event) => event.change === 'task-deleted')
        .map((event) => ({ projectId: event.projectId, change: event.change, ids: event.ids ?? [] }));
    }

    it('marks only the tasks that never started, on every board', async () => {
      const { workflow, fresh, phone } = await startedWithHistory();

      const { released } = service.deleteWorkflow(context, 'home', workflow.id);

      expect(released.filter((task) => task.neverStarted).map((task) => task.taskId).sort()).toEqual([fresh.id, phone.id].sort());
      expect(released.find((task) => task.taskId === phone.id)).toMatchObject({ board: 'kangentic-mobile', displayId: phone.display_id });
      expect(released.find((task) => task.taskId === fresh.id)?.board).toBeNull();
      // Released: nothing is deleted until the caller asks.
      expect(tasksOf('home').getById(fresh.id)?.workflow_id).toBeNull();
      expect(deleteTaskWithCleanup).not.toHaveBeenCalled();
    });

    it('deletes those through the task delete on their own boards, and keeps every task that ran', async () => {
      const { workflow, fresh, ran, checkout, bounced, phone } = await startedWithHistory();

      const { released } = service.deleteWorkflow(context, 'home', workflow.id);
      const result = await service.deleteNeverStartedTasks(context, released);

      expect(result.deleted.map((task) => task.taskId).sort()).toEqual([fresh.id, phone.id].sort());
      expect(result.kept.map((task) => task.taskId).sort()).toEqual([ran.id, checkout.id, bounced.id].sort());
      expect(result.failed).toEqual([]);
      expect(tasksOf('home').getById(fresh.id)).toBeUndefined();
      expect(tasksOf('mobile').getById(phone.id)).toBeUndefined();
      for (const stays of [ran, checkout, bounced]) expect(tasksOf('home').getById(stays.id)?.workflow_id).toBeNull();
      const phoneCall = vi.mocked(deleteTaskWithCleanup).mock.calls.find((call) => call[3] === phone.id);
      expect(phoneCall?.slice(1, 3)).toEqual(['mobile', '/projects/mobile']);
      // Each board hears the event every other delete sends, naming its own deleted tasks.
      const deletedEvents = vi.mocked(context.boardEvents.emitBoardChanged).mock.calls
        .map(([event]) => event)
        .filter((event) => event.change === 'task-deleted');
      expect(deletedEvents).toEqual(expect.arrayContaining([
        { projectId: 'home', change: 'task-deleted', ids: [fresh.id] },
        { projectId: 'mobile', change: 'task-deleted', ids: [phone.id] },
      ]));
      expect(deletedEvents).toHaveLength(2);
    });

    it('keeps a task that started between the ask and its lock', async () => {
      const { workflow, fresh, phone } = await startedWithHistory();
      const { released } = service.deleteWorkflow(context, 'home', workflow.id);
      // A drag starts it after the delete chose it: its session is on the row by the time the lock is taken.
      tasksOf('home').update({ id: fresh.id, session_id: 'session-late' });

      const result = await service.deleteNeverStartedTasks(context, released);

      expect(result.kept.map((task) => task.taskId)).toContain(fresh.id);
      expect(result.deleted.map((task) => task.taskId)).not.toContain(fresh.id);
      expect(tasksOf('home').getById(fresh.id)).toBeDefined();
      // Nothing of it changed, so no board event names it. The other board's delete ran, so its event is the control.
      const namedIds = taskDeletedEvents().flatMap((event) => event.ids);
      expect(namedIds).not.toContain(fresh.id);
      expect(taskDeletedEvents()).toEqual([{ projectId: 'mobile', change: 'task-deleted', ids: [phone.id] }]);
    });

    it('keeps a task that another workflow took in between the ask and its lock', async () => {
      const { workflow, fresh } = await startedWithHistory();
      const { released } = service.deleteWorkflow(context, 'home', workflow.id);
      expect(released.find((task) => task.taskId === fresh.id)?.neverStarted).toBe(true);
      // The task gets no session, worktree or move, so it still reads as never started: only its membership says it is not free.
      const otherWorkflow = service.createWorkflow('home', {});
      tasksOf('home').setWorkflowMembership(fresh.id, {
        workflow_id: otherWorkflow.id, workflow_project_id: 'home',
        route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
        canvas_x: null, canvas_y: null, plan_approval: null,
      });

      const result = await service.deleteNeverStartedTasks(context, released);

      // The in-lock check refused it, not the pass-through double skipping it.
      expect(vi.mocked(deleteTaskWithCleanup).mock.calls.some((call) => call[3] === fresh.id)).toBe(true);
      expect(result.kept.map((task) => task.taskId)).toContain(fresh.id);
      expect(result.deleted.map((task) => task.taskId)).not.toContain(fresh.id);
      expect(result.failed).toEqual([]);
      expect(tasksOf('home').getById(fresh.id)?.workflow_id).toBe(otherWorkflow.id);
      expect(taskDeletedEvents().flatMap((event) => event.ids)).not.toContain(fresh.id);
    });

    it('names a task whose delete failed and goes on with the rest', async () => {
      const { workflow, fresh, phone } = await startedWithHistory();
      const { released } = service.deleteWorkflow(context, 'home', workflow.id);
      const passThrough = vi.mocked(deleteTaskWithCleanup).getMockImplementation()!;
      vi.mocked(deleteTaskWithCleanup).mockImplementation(async (...args) => {
        if (args[3] === fresh.id) throw new Error('worktree removal timed out');
        return passThrough(...args);
      });

      const result = await service.deleteNeverStartedTasks(context, released);

      expect(result.failed).toEqual([expect.objectContaining({ taskId: fresh.id, reason: 'worktree removal timed out' })]);
      expect(result.deleted.map((task) => task.taskId)).toEqual([phone.id]);
      // A failed delete may have removed its attachments while the row stayed, so its board's event names it, as a failed TASK_DELETE does.
      expect(taskDeletedEvents()).toEqual(expect.arrayContaining([
        { projectId: 'home', change: 'task-deleted', ids: [fresh.id] },
        { projectId: 'mobile', change: 'task-deleted', ids: [phone.id] },
      ]));
      expect(taskDeletedEvents()).toHaveLength(2);
    });
  });

  it('names the board task a planned task takes in at Start, by its number', () => {
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Budgets API', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      title: 'Usage budgets',
      tasks: [{ key: 'api', title: 'Budgets API', existingTask: existing.id }, { key: 'ui', title: 'Budgets UI' }],
      links: [],
    });

    const [takenIn, created] = service.readWorkflow(context, 'home', workflow.id).tasks;

    expect(takenIn).toMatchObject({ column: `To Do (#${existing.display_id}, taken in at Start)`, displayId: existing.display_id });
    expect(created).toMatchObject({ column: 'To Do (created at Start)', displayId: null });
  });

  it('still says a planned task takes in a board task whose row was deleted after the plan was saved, with no number', () => {
    const todo = lanesOf('home').find((lane) => lane.role === 'todo')!;
    const existing = tasksOf('home').create({ title: 'Budgets API', description: '', swimlane_id: todo.id });
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      title: 'Usage budgets',
      tasks: [{ key: 'api', title: 'Budgets API', existingTask: existing.id }, { key: 'ui', title: 'Budgets UI' }],
      links: [],
    });
    tasksOf('home').delete(existing.id);

    const [takenIn, created] = service.readWorkflow(context, 'home', workflow.id).tasks;

    // The plan still holds the take-in, so the read names it though the board task cannot be read.
    expect(takenIn).toMatchObject({ taskId: existing.id, column: 'To Do (taken in at Start)', displayId: null });
    expect(created).toMatchObject({ taskId: null, column: 'To Do (created at Start)', displayId: null });
  });

  it('lets a task its deleted workflow left in Done join a new workflow, once it is back in To Do', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const homeDb = harness.dbs.get('home') as Database.Database;
    const laneWithRole = (role: 'todo' | 'done') => lanesOf('home').find((lane) => lane.role === role)!.id;
    const first = service.createWorkflow('home', {});
    service.savePlan(context, 'home', first.id, { title: 'First pass', tasks: [{ key: 'only', title: 'Budgets API' }], links: [] });
    await service.startWorkflow(context, 'home', first.id);
    const [shipped] = tasksOf('home').listByWorkflow(first.id);
    homeDb.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(laneWithRole('done'), shipped.id);
    service.deleteWorkflow(context, 'home', first.id);
    // A deleted workflow's Done tasks keep their membership.
    expect(tasksOf('home').getById(shipped.id)?.workflow_id).toBe(first.id);
    homeDb.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(laneWithRole('todo'), shipped.id);

    const second = service.createWorkflow('home', {});
    service.savePlan(context, 'home', second.id, {
      title: 'Second pass',
      tasks: [{ key: 'again', title: 'Budgets API', existingTask: shipped.id }],
      links: [],
    });
    await service.startWorkflow(context, 'home', second.id);

    expect(tasksOf('home').getById(shipped.id)?.workflow_id).toBe(second.id);
  });

  // A running workflow task whose step is not done is nudged on a timer
  // (workflow-recovery.ts). The timer must not outlive the thing that justifies
  // it: a pause, a removal from the workflow, a delete. Each case asserts the
  // moment the operation returns, with real timers and no advance, so only the
  // operation's own call can have cleared the entry.
  describe('a task under recovery when its workflow changes', () => {
    const OTHER_WORKFLOW_ID = 'workflow-elsewhere';

    afterEach(() => {
      resetWorkflowRecoveryForTests();
    });

    /** A recovery waiting on its timer, as one is between two attempts. */
    function armRecovery(taskId: string, workflowId: string): void {
      setRecoveryEntry({
        projectId: 'home', taskId, workflowId, columnId: 'lane-doing', sessionId: `session-${taskId}`,
        attemptIndex: 0, countedNudges: 0, countedSinceNotice: 0, noticeSent: false, startedAt: Date.now(),
        workingWait: false, holdUntil: null, verdict: null, pendingNudge: null, lastTurnFromNudge: false,
        timer: setTimeout(() => undefined, 60 * 60_000), inFlight: false,
      });
      // The seed is live, so a later "not under recovery" can only come from the operation.
      expect(isUnderWorkflowRecovery(taskId)).toBe(true);
    }

    /** A started workflow of three tasks, two of them on the home board. */
    async function startedWorkflow() {
      const workflow = service.createWorkflow('home', {});
      service.savePlan(context, 'home', workflow.id, plan());
      await service.startWorkflow(context, 'home', workflow.id);
      const homeTasks = tasksOf('home').listByWorkflow(workflow.id);
      return {
        workflow,
        api: homeTasks.find((task) => task.title === 'Budgets API')!,
        ui: homeTasks.find((task) => task.title === 'Budgets UI')!,
      };
    }

    it('stops the recovery of a workflow\'s task when the workflow is paused, and leaves another workflow\'s alone', async () => {
      const { workflow, api } = await startedWorkflow();
      armRecovery(api.id, workflow.id);
      armRecovery('task-elsewhere', OTHER_WORKFLOW_ID);

      await service.pauseWorkflow(context, 'home', workflow.id, 'a test');

      expect(isUnderWorkflowRecovery(api.id)).toBe(false);
      expect(getRecoveryEntry(api.id)).toBeUndefined();
      expect(isUnderWorkflowRecovery('task-elsewhere')).toBe(true);
    });

    it('stops the recovery of a task taken out of its workflow, and only that task\'s', async () => {
      const { workflow, api, ui } = await startedWorkflow();
      armRecovery(ui.id, workflow.id);
      armRecovery(api.id, workflow.id);

      service.removeFromWorkflow(context, 'home', workflow.id, { task: String(ui.display_id) });

      expect(isUnderWorkflowRecovery(ui.id)).toBe(false);
      expect(getRecoveryEntry(ui.id)).toBeUndefined();
      // A task still in the workflow keeps its recovery: this forgets one task, it does not cancel the workflow's.
      expect(isUnderWorkflowRecovery(api.id)).toBe(true);
    });

    it('stops the recovery of a workflow\'s task when the workflow is deleted, and leaves another workflow\'s alone', async () => {
      // The delete ends the workflow agent's session in the background; this context has none to end.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { workflow, api } = await startedWorkflow();
      armRecovery(api.id, workflow.id);
      armRecovery('task-elsewhere', OTHER_WORKFLOW_ID);

      service.deleteWorkflow(context, 'home', workflow.id);

      expect(isUnderWorkflowRecovery(api.id)).toBe(false);
      expect(getRecoveryEntry(api.id)).toBeUndefined();
      expect(isUnderWorkflowRecovery('task-elsewhere')).toBe(true);
    });
  });
});
