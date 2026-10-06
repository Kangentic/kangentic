import { describe, it, expect, vi, beforeEach } from 'vitest';

const tasksList = vi.fn();
const tasksListArchivedPage = vi.fn();
const swimlanesList = vi.fn();
const backlogList = vi.fn();

vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({ tasks: { list: tasksList, listArchivedPage: tasksListArchivedPage }, swimlanes: { list: swimlanesList } })),
}));
vi.mock('../../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    list(): unknown {
      return backlogList();
    }
  },
}));
vi.mock('../../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getSummaryForTask(): unknown {
      return null;
    }
  },
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import type { BrowserWindow } from 'electron';
import { handleReadBoard } from '../../../src/main/mobile-bridge/handlers/read-board';
import { deriveProjectAccentColor, PROJECT_ACCENT_PALETTE } from '../../../src/main/mobile-bridge/handlers/project-color';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';
import type { SpawnProgressChangedListener } from '../../../src/main/mobile-bridge/spawn-progress-feed';
import { emitSpawnProgress, emitSpawnWaiting, __resetSpawnProgressForTest } from '../../../src/main/transition-engine/spawn-progress';

/** A spawn-progress feed that never fires, for the tests that are not about it. */
const noSpawnProgressFeed = { onTaskSpawnProgressChanged: vi.fn(() => vi.fn()) };

/** What the fake session registry lists; `resumable` reads it once per snapshot. */
let registryRows: Array<{ id: string; taskId: string; status: string; transient?: boolean }> = [];

/** A spawn-progress feed whose listener the test can fire, and whose release it can observe. */
function controllableSpawnProgressFeed(): {
  feed: { onTaskSpawnProgressChanged: (listener: SpawnProgressChangedListener) => () => void };
  fire: (projectId: string, taskId: string) => void;
  release: ReturnType<typeof vi.fn>;
} {
  let captured: SpawnProgressChangedListener | undefined;
  const release = vi.fn();
  return {
    feed: {
      onTaskSpawnProgressChanged: (listener) => {
        captured = listener;
        return release;
      },
    },
    fire: (projectId, taskId) => captured?.(projectId, taskId),
    release,
  };
}

function fakeWindow(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
}

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'read-board', payload };
}

function fakeSession(): BridgeSession {
  return { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn() } as unknown as BridgeSession;
}

/** The context the view, resumable and spawn-progress suites share; the session registry lists `registryRows`. */
function boardContext(): IpcContext {
  return {
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Alpha', path: 'C:/projects/alpha' })) },
    boardEvents: { onBoardChanged: vi.fn(() => vi.fn()) },
    sessionManager: { listSessions: () => registryRows },
    configManager: { getEffectiveConfig: vi.fn(() => ({ showTaskNumbers: true })) },
  } as unknown as IpcContext;
}

describe('handleReadBoard', () => {
  beforeEach(() => {
    // detail_view_state / handoff_context / external_metadata are renderer- or
    // desktop-internal fields the wire mappers must strip from the snapshot.
    tasksList.mockReset().mockReturnValue([{ id: 't-1', session_id: 'sess-1', detail_view_state: 'renderer-only-blob' }]);
    // role/auto_spawn given explicit values (rather than left undefined) so
    // toBoardColumnWire's spawns_session computes a real, assertable boolean
    // instead of silently deriving one from an absent field.
    swimlanesList.mockReset().mockReturnValue([{ id: 'lane-1', handoff_context: true, role: null, auto_spawn: true }]);
    backlogList.mockReset().mockReturnValue([{ id: 'b-1', external_metadata: { secret: true } }]);
    // getInFlightSpawnProgress() reads a module-level singleton; a label left
    // by one test would decorate another's snapshot.
    __resetSpawnProgressForTest();
    registryRows = [];
  });

  it('with no projectId, returns the project bootstrap list (with derived accent colors, group and position) and never touches task repos', async () => {
    const projectRepoList = vi.fn(() => [{ id: 'proj-1', name: 'Alpha', group_id: 'grp-1', position: 0 }]);
    const projectGroupList = vi.fn(() => [{ id: 'grp-1', name: 'Kangentic', position: 0, is_collapsed: false }]);
    const context = {
      projectRepo: { list: projectRepoList, getById: vi.fn() },
      projectGroupRepo: { list: projectGroupList },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadBoard(fakeRequest({}), fakeSession(), context, subscriptions, noSpawnProgressFeed);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({
      projects: [
        { id: 'proj-1', name: 'Alpha', color: deriveProjectAccentColor('proj-1'), groupId: 'grp-1', position: 0 },
      ],
      // is_collapsed stays desktop-internal: the phone's sheet is scrolled,
      // not collapsed, so a collapse flag would describe nothing it renders.
      groups: [{ id: 'grp-1', name: 'Kangentic', position: 0 }],
    });
    const listed = (response.payload as { projects: Array<{ color: string }> }).projects[0];
    expect(PROJECT_ACCENT_PALETTE).toContain(listed.color);
    expect(tasksList).not.toHaveBeenCalled();
  });

  it('rejects an unsubscribe with no projectId as a no-op success (nothing to tear down)', async () => {
    // action alone with no projectId falls through to the project-list branch
    // since there is no per-project subscription to identify.
    const context = {
      projectRepo: { list: vi.fn(() => []), getById: vi.fn() },
      projectGroupRepo: { list: vi.fn(() => []) },
    } as unknown as IpcContext;
    const response = await handleReadBoard(fakeRequest({ action: 'unsubscribe' }), fakeSession(), context, new SubscriptionRegistry(), noSpawnProgressFeed);
    expect(response.ok).toBe(true);
  });

  it('rejects an unknown project id', async () => {
    const context = { projectRepo: { getById: vi.fn(() => undefined) } } as unknown as IpcContext;
    const response = await handleReadBoard(fakeRequest({ projectId: 'ghost' }), fakeSession(), context, new SubscriptionRegistry(), noSpawnProgressFeed);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such project/i);
  });

  it('returns a full board snapshot and subscribes to board-changed events filtered by projectId', async () => {
    let capturedListener: ((event: unknown) => void) | undefined;
    const onBoardChanged = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return vi.fn();
    });
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Alpha', path: 'C:/projects/alpha' })) },
      boardEvents: { onBoardChanged },
      sessionManager: { listSessions: () => registryRows },
      configManager: { getEffectiveConfig: vi.fn(() => ({ showTaskNumbers: false })) },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions, noSpawnProgressFeed);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({
      projectId: 'proj-1',
      columns: [{ id: 'lane-1', role: null, spawns_session: true }],
      tasks: [{ id: 't-1', session_id: 'sess-1', spawn_progress: null, resumable: false }],
      backlog: [{ id: 'b-1' }],
      projectColor: deriveProjectAccentColor('proj-1'),
      showTicketNumbers: false,
    });
    const snapshot = response.payload as { columns: object[]; tasks: object[]; backlog: object[] };
    expect(snapshot.tasks[0]).not.toHaveProperty('detail_view_state');
    expect(snapshot.columns[0]).not.toHaveProperty('handoff_context');
    expect(snapshot.backlog[0]).not.toHaveProperty('external_metadata');
    expect(subscriptions.has('board:proj-1')).toBe(true);

    // A board-changed event for a DIFFERENT project must not push.
    capturedListener?.({ projectId: 'proj-OTHER', change: 'task-updated', ids: ['x'] });
    expect(session.sendMessage).not.toHaveBeenCalled();

    // The same project's event pushes a BoardEvent.
    capturedListener?.({ projectId: 'proj-1', change: 'task-updated', ids: ['t-9'] });
    expect(session.sendMessage).toHaveBeenCalledWith({
      type: 'event',
      event: { kind: 'board', projectId: 'proj-1', taskId: 't-9', payload: { change: 'task-updated', ids: ['t-9'] } },
    });
  });

  describe('view projections (protocol 0.9.0)', () => {
    beforeEach(() => {
      tasksList.mockReturnValue([
        { id: 't-1', swimlane_id: 'lane-1', session_id: 'sess-1' },
        { id: 't-2', swimlane_id: 'lane-1', session_id: null },
        { id: 't-3', swimlane_id: 'lane-2', session_id: null },
      ]);
    });

    it("'sessions' returns only session-bearing tasks, with real per-column counts and no backlog", async () => {
      const response = await handleReadBoard(
        fakeRequest({ projectId: 'proj-1', view: 'sessions' }),
        fakeSession(),
        boardContext(),
        new SubscriptionRegistry(),
        noSpawnProgressFeed,
      );

      const snapshot = response.payload as {
        tasks: Array<{ id: string }>;
        view: string;
        taskCountsByColumnId: Record<string, number>;
      };
      expect(snapshot.tasks.map((task) => task.id)).toEqual(['t-1']);
      expect(snapshot.view).toBe('sessions');
      // Counts describe the WHOLE column, not the filtered list - appending a
      // card to lane-1 has to land after t-2, not on top of it.
      expect(snapshot.taskCountsByColumnId).toEqual({ 'lane-1': 2, 'lane-2': 1 });
      expect(response.payload).not.toHaveProperty('backlog');
      expect(backlogList).not.toHaveBeenCalled();
    });

    it("'full' returns every task but still drops the backlog, and sends no counts", async () => {
      const response = await handleReadBoard(
        fakeRequest({ projectId: 'proj-1', view: 'full' }),
        fakeSession(),
        boardContext(),
        new SubscriptionRegistry(),
        noSpawnProgressFeed,
      );

      const snapshot = response.payload as { tasks: Array<{ id: string }>; view: string };
      expect(snapshot.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
      expect(snapshot.view).toBe('full');
      expect(response.payload).not.toHaveProperty('backlog');
      expect(response.payload).not.toHaveProperty('taskCountsByColumnId');
      expect(backlogList).not.toHaveBeenCalled();
    });

    it('a request with no view keeps the pre-0.9.0 payload, backlog included', async () => {
      const response = await handleReadBoard(
        fakeRequest({ projectId: 'proj-1' }),
        fakeSession(),
        boardContext(),
        new SubscriptionRegistry(),
        noSpawnProgressFeed,
      );

      expect(response.payload).toHaveProperty('backlog');
      expect(response.payload).not.toHaveProperty('view');
      expect(backlogList).toHaveBeenCalledTimes(1);
    });
  });

  it('unsubscribe tears down the board subscription', async () => {
    const unsubscribe = vi.fn();
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Alpha', path: 'C:/projects/alpha' })) },
      boardEvents: { onBoardChanged: vi.fn(() => unsubscribe) },
      sessionManager: { listSessions: () => registryRows },
      configManager: { getEffectiveConfig: vi.fn(() => ({ showTaskNumbers: true })) },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions, noSpawnProgressFeed);
    expect(subscriptions.has('board:proj-1')).toBe(true);

    const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', action: 'unsubscribe' }), session, context, subscriptions, noSpawnProgressFeed);
    expect(response.ok).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptions.has('board:proj-1')).toBe(false);
  });

  describe('resumable on the board row (protocol 0.16.0)', () => {
    beforeEach(() => {
      swimlanesList.mockReturnValue([
        { id: 'lane-review', role: null, auto_spawn: false },
        { id: 'lane-todo', role: 'todo', auto_spawn: false },
        { id: 'lane-done', role: 'done', auto_spawn: false },
      ]);
      // A desktop pause clears session_id, so every paused task here has none:
      // the registry row is the only thing that says it is paused.
      tasksList.mockReturnValue([
        { id: 't-paused', swimlane_id: 'lane-review', session_id: null, archived_at: null },
        { id: 't-paused-todo', swimlane_id: 'lane-todo', session_id: null, archived_at: null },
        { id: 't-paused-done', swimlane_id: 'lane-done', session_id: null, archived_at: null },
        { id: 't-paused-archived', swimlane_id: 'lane-review', session_id: null, archived_at: '2026-10-01T00:00:00.000Z' },
        { id: 't-ended', swimlane_id: 'lane-review', session_id: null, archived_at: null },
        { id: 't-running', swimlane_id: 'lane-review', session_id: 'sess-run', archived_at: null },
        { id: 't-fresh', swimlane_id: 'lane-review', session_id: null, archived_at: null },
      ]);
      registryRows = [
        { id: 'sess-1', taskId: 't-paused', status: 'suspended' },
        { id: 'sess-2', taskId: 't-paused-todo', status: 'suspended' },
        { id: 'sess-3', taskId: 't-paused-done', status: 'suspended' },
        { id: 'sess-4', taskId: 't-paused-archived', status: 'suspended' },
        { id: 'sess-5', taskId: 't-ended', status: 'exited' },
        { id: 'sess-run', taskId: 't-running', status: 'running' },
        // A Command Terminal session never makes a task resumable.
        { id: 'sess-terminal', taskId: 't-fresh', status: 'suspended', transient: true },
      ];
    });

    it('is true only for a paused task in a column that offers Resume, and false otherwise', async () => {
      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', view: 'full' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const tasks = (response.payload as { tasks: Array<{ id: string; resumable: boolean | null }> }).tasks;
      expect(Object.fromEntries(tasks.map((task) => [task.id, task.resumable]))).toEqual({
        't-paused': true,
        't-paused-todo': false,
        't-paused-done': false,
        't-paused-archived': false,
        't-ended': false,
        't-running': false,
        't-fresh': false,
      });
    });

    it("'sessions' keeps a resumable paused task, and still drops a paused task that offers no Resume", async () => {
      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', view: 'sessions' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const snapshot = response.payload as { tasks: Array<{ id: string }>; taskCountsByColumnId: Record<string, number> };
      // t-paused stays though its session_id is null; the paused tasks in To Do
      // and Done, the ended one, and the fresh one stay out as before.
      expect(snapshot.tasks.map((task) => task.id)).toEqual(['t-paused', 't-running']);
      // Counts still describe the whole column, not the filtered list.
      expect(snapshot.taskCountsByColumnId['lane-review']).toBe(5);
    });

    it('the archived page never offers Resume', async () => {
      tasksListArchivedPage.mockReturnValue({
        tasks: [{ id: 't-paused-archived', swimlane_id: 'lane-done', session_id: null, archived_at: '2026-10-01T00:00:00.000Z' }],
        totalCount: 1,
      });

      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', action: 'archived' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const archived = (response.payload as { archivedTasks: Array<{ resumable: boolean | null }> }).archivedTasks;
      expect(archived[0].resumable).toBe(false);
    });
  });

  describe('spawn progress (protocol 0.16.0)', () => {
    beforeEach(() => {
      tasksList.mockReturnValue([
        { id: 't-1', swimlane_id: 'lane-1', session_id: 'sess-1' },
        { id: 't-2', swimlane_id: 'lane-1', session_id: null },
        { id: 't-3', swimlane_id: 'lane-2', session_id: null },
      ]);
    });

    it('each task carries its in-flight label exactly as the card shows it, and null otherwise', async () => {
      emitSpawnProgress(fakeWindow(), 't-2', 'creating-worktree');
      emitSpawnWaiting(fakeWindow(), 't-3', 2);

      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', view: 'full' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const tasks = (response.payload as { tasks: Array<{ id: string; spawn_progress: string | null }> }).tasks;
      expect(tasks.map((task) => [task.id, task.spawn_progress])).toEqual([
        ['t-1', null],
        ['t-2', 'Creating worktree...'],
        ['t-3', 'Waiting (2 ahead)'],
      ]);
    });

    it("'sessions' keeps a session-less task while a label is in flight, and still drops one without", async () => {
      // A respawn nulls session_id for the whole gap its label describes.
      emitSpawnProgress(fakeWindow(), 't-2', 'switching-model');

      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', view: 'sessions' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const snapshot = response.payload as { tasks: Array<{ id: string }>; taskCountsByColumnId: Record<string, number> };
      expect(snapshot.tasks.map((task) => task.id)).toEqual(['t-1', 't-2']);
      expect(snapshot.taskCountsByColumnId).toEqual({ 'lane-1': 2, 'lane-2': 1 });
    });

    it('the archived page carries a restore label too', async () => {
      tasksListArchivedPage.mockReturnValue({ tasks: [{ id: 't-done', swimlane_id: 'lane-done', session_id: null }], totalCount: 1 });
      emitSpawnProgress(fakeWindow(), 't-done', 'resuming');

      const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', action: 'archived' }), fakeSession(), boardContext(), new SubscriptionRegistry(), noSpawnProgressFeed);

      const archived = (response.payload as { archivedTasks: Array<{ spawn_progress: string | null }> }).archivedTasks;
      expect(archived[0].spawn_progress).toBe('Resuming session...');
    });

    it("a label change for this project's task sends task-updated; another project's sends nothing", async () => {
      const { feed, fire } = controllableSpawnProgressFeed();
      const session = fakeSession();
      await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, boardContext(), new SubscriptionRegistry(), feed);

      fire('proj-OTHER', 't-x');
      expect(session.sendMessage).not.toHaveBeenCalled();

      fire('proj-1', 't-2');
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'board', projectId: 'proj-1', taskId: 't-2', payload: { change: 'task-updated', ids: ['t-2'] } },
      });
    });

    it('unsubscribe and a re-subscribe both release the feed listener', async () => {
      const first = controllableSpawnProgressFeed();
      const subscriptions = new SubscriptionRegistry();
      const session = fakeSession();
      const context = boardContext();
      await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions, first.feed);

      // The phone re-reads the board after an event, replacing the subscription.
      const second = controllableSpawnProgressFeed();
      await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions, second.feed);
      expect(first.release).toHaveBeenCalledTimes(1);

      await handleReadBoard(fakeRequest({ projectId: 'proj-1', action: 'unsubscribe' }), session, context, subscriptions, second.feed);
      expect(second.release).toHaveBeenCalledTimes(1);
    });
  });
});
