/**
 * `linkArtifacts` and `announceArtifactsChanged` (#1056): the one way Kangentic
 * itself puts a link on a task, on a real SQLite database and the real
 * `TaskRepository`. A user loses: a Command Terminal's links landing on some
 * task, an agent's publish added under the wrong source, a board that never
 * reloads after a detection (or toasts "updated by agent" for it), or a project
 * switch turning a detection into a thrown error in the middle of a hook.
 *
 * Only the project database lookup, the renderer send and the domain report are
 * mocked. The session manager and board events are fakes with the few methods
 * `linkArtifacts` calls.
 *
 * Red-green: drop the `session?.transient` return and the transient case
 * fails; announce when the write changed nothing and the unchanged case fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

const mocks = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  sendToRenderer: vi.fn(),
  reportDomains: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const database = mocks.databases.get(projectId);
    if (!database) throw new Error(`Project database ${projectId} is not open`);
    return database;
  },
}));

vi.mock('../../src/main/ipc/send-to-renderer', () => ({
  sendToRenderer: mocks.sendToRenderer,
}));

vi.mock('../../src/main/artifacts/artifact-domain-report', () => ({
  reportUnrecognisedArtifactDomains: mocks.reportDomains,
}));

import { announceArtifactsChanged, linkArtifacts } from '../../src/main/artifacts/artifact-linking';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const PROJECT_ID = 'project-1';

interface FakeSession {
  transient?: boolean;
}

describe('linkArtifacts', () => {
  let database: ReturnType<typeof openTestDatabase>;
  let tasks: TaskRepository;
  let taskId: string;
  let sessions: Map<string, FakeSession>;
  let sessionTasks: Map<string, string>;
  let emitBoardChanged: ReturnType<typeof vi.fn>;
  let context: IpcContext;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const laneId = new SwimlaneRepository(database).list().filter((lane) => lane.role === null)[0].id;
    taskId = tasks.create({ title: 'Task', description: '', swimlane_id: laneId }).id;

    mocks.databases.clear();
    mocks.databases.set(PROJECT_ID, database);
    mocks.sendToRenderer.mockReset();
    mocks.reportDomains.mockReset();

    sessions = new Map();
    sessionTasks = new Map();
    emitBoardChanged = vi.fn();
    context = {
      currentProjectId: PROJECT_ID,
      mainWindow: { isDestroyed: () => false },
      boardEvents: { emitBoardChanged },
      sessionManager: {
        getSession: (sessionId: string) => sessions.get(sessionId),
        getSessionProjectId: (sessionId: string) => (sessions.has(sessionId) ? PROJECT_ID : null),
        getSessionTaskId: (sessionId: string) => sessionTasks.get(sessionId),
      },
    } as unknown as IpcContext;
  });

  afterEach(() => database.close());

  function urls(): string[] {
    return (tasks.getById(taskId)?.artifacts ?? []).map((artifact) => artifact.url);
  }

  it('writes nothing and returns null for a transient session, which has no task', () => {
    sessions.set('terminal-1', { transient: true });
    sessionTasks.set('terminal-1', taskId);
    const result = linkArtifacts(context, { sessionId: 'terminal-1', artifacts: [{ url: FIGMA }], source: 'detected' });
    expect(result).toBeNull();
    expect(urls()).toEqual([]);
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
    expect(emitBoardChanged).not.toHaveBeenCalled();
  });

  it('returns null for an empty list without opening anything', () => {
    mocks.databases.clear();
    expect(linkArtifacts(context, { taskId, artifacts: [], source: 'agent' })).toBeNull();
  });

  it('resolves a session to its task and project and adds the links under the given source', () => {
    sessions.set('session-1', {});
    sessionTasks.set('session-1', taskId);
    const result = linkArtifacts(context, { sessionId: 'session-1', artifacts: [{ url: FIGMA, name: 'Checkout' }, { url: MIRO }], source: 'agent' });
    expect(result?.id).toBe(taskId);
    expect(tasks.getById(taskId)?.artifacts.map((artifact) => [artifact.url, artifact.name, artifact.source])).toEqual([
      [FIGMA, 'Checkout', 'agent'],
      [MIRO, null, 'agent'],
    ]);
  });

  it('falls back to the task the repository finds by session id', () => {
    sessions.set('session-2', {});
    tasks.update({ id: taskId, session_id: 'session-2' });
    const result = linkArtifacts(context, { sessionId: 'session-2', artifacts: [{ url: MIRO }], source: 'detected' });
    expect(result?.id).toBe(taskId);
    expect(urls()).toEqual([MIRO]);
  });

  it('returns null when the session has no task', () => {
    sessions.set('session-3', {});
    expect(linkArtifacts(context, { sessionId: 'session-3', artifacts: [{ url: MIRO }], source: 'detected' })).toBeNull();
  });

  it('returns null with no project to write to', () => {
    const noProject = { ...context, currentProjectId: null } as unknown as IpcContext;
    expect(linkArtifacts(noProject, { taskId, artifacts: [{ url: MIRO }], source: 'agent' })).toBeNull();
    expect(urls()).toEqual([]);
  });

  it('returns null, and does not throw, when the project database cannot be opened', () => {
    expect(() => linkArtifacts(context, { taskId, projectId: 'closed-project', artifacts: [{ url: MIRO }], source: 'agent' })).not.toThrow();
    expect(linkArtifacts(context, { taskId, projectId: 'closed-project', artifacts: [{ url: MIRO }], source: 'agent' })).toBeNull();
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
  });

  it('announces a changed write on the quiet channel and the board event, and reports the added hosts', () => {
    const result = linkArtifacts(context, { taskId, artifacts: [{ url: FIGMA }], source: 'detected' });
    expect(result?.artifacts.map((artifact) => artifact.url)).toEqual([FIGMA]);
    expect(mocks.sendToRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.sendToRenderer).toHaveBeenCalledWith(context.mainWindow, IPC.TASK_PR_LINK_CHANGED, PROJECT_ID);
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: PROJECT_ID, change: 'task-updated', ids: [taskId] });
    expect(mocks.reportDomains).toHaveBeenCalledWith([FIGMA], 'detected');
  });

  it('returns null and announces nothing when the same link is written twice', () => {
    expect(linkArtifacts(context, { taskId, artifacts: [{ url: FIGMA }], source: 'detected' })).not.toBeNull();
    mocks.sendToRenderer.mockClear();
    emitBoardChanged.mockClear();
    mocks.reportDomains.mockClear();

    expect(linkArtifacts(context, { taskId, artifacts: [{ url: FIGMA }], source: 'detected' })).toBeNull();
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
    expect(emitBoardChanged).not.toHaveBeenCalled();
    expect(mocks.reportDomains).not.toHaveBeenCalled();
    expect(urls()).toEqual([FIGMA]);
  });

  it('reports only the rows a write added, not a link that was only named', () => {
    linkArtifacts(context, { taskId, artifacts: [{ url: FIGMA }], source: 'agent' });
    mocks.reportDomains.mockClear();
    const result = linkArtifacts(context, { taskId, artifacts: [{ url: FIGMA, name: 'Named' }, { url: MIRO }], source: 'agent' });
    expect(result).not.toBeNull();
    expect(mocks.reportDomains).toHaveBeenCalledWith([MIRO], 'agent');
  });
});

describe('announceArtifactsChanged', () => {
  it('sends the quiet board reload with the project id, then emits the board change', () => {
    mocks.sendToRenderer.mockReset();
    const emitBoardChanged = vi.fn();
    const context = { mainWindow: { isDestroyed: () => false }, boardEvents: { emitBoardChanged } } as unknown as IpcContext;
    announceArtifactsChanged(context, 'project-9', 'task-9');
    expect(mocks.sendToRenderer).toHaveBeenCalledWith(context.mainWindow, IPC.TASK_PR_LINK_CHANGED, 'project-9');
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: 'project-9', change: 'task-updated', ids: ['task-9'] });
  });
});
