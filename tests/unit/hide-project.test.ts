/**
 * What removing an SSH host does to the running app for each of its projects (#913), with the things it
 * reaches mocked: which tasks are stopped, and what stops once the project is hidden.
 *
 * What a user loses if it breaks: a start in flight that runs in an empty folder on this computer, a queued agent
 * that starts after its host is gone, a PR refresh or a window left working on a project nobody can see, or a
 * board that loses its project while the removal is still running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pauseTaskSession: vi.fn(async () => 'paused'),
  endWorkflowAgentsOfProject: vi.fn(async () => undefined),
  pauseWorkflowsOfProject: vi.fn(async () => undefined),
  closeProjectTaskWindows: vi.fn(),
  prStop: vi.fn(),
  gitFetchStop: vi.fn(),
  retrievalStop: vi.fn(),
  reconcileEmbedWorker: vi.fn(),
  clearConversationExpired: vi.fn(),
  forgetCommandTerminalRestore: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: mocks.pauseTaskSession }));
vi.mock('../../src/main/workflows/workflow-agent', () => ({ endWorkflowAgentsOfProject: mocks.endWorkflowAgentsOfProject }));
vi.mock('../../src/main/workflows/workflow-hidden-project', () => ({ pauseWorkflowsOfProject: mocks.pauseWorkflowsOfProject }));
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({ closeProjectTaskWindows: mocks.closeProjectTaskWindows }));
vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({ prRefreshScheduler: { stop: mocks.prStop } }));
vi.mock('../../src/main/git/git-fetch-scheduler', () => ({ gitFetchScheduler: { stop: mocks.gitFetchStop } }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({ retrievalService: { stop: mocks.retrievalStop, reconcileEmbedWorker: mocks.reconcileEmbedWorker } }));
vi.mock('../../src/main/ipc/helpers/pending-conversation-expired', () => ({ clearConversationExpired: mocks.clearConversationExpired }));
vi.mock('../../src/main/ipc/handlers/command-terminal-restore', () => ({ forgetCommandTerminalRestore: mocks.forgetCommandTerminalRestore }));

import { suspendProjectForHiding, takeHiddenProjectOutOfApp } from '../../src/main/ipc/helpers/hide-project';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project, Session } from '../../src/shared/types';

const project = { id: 'project-api', name: 'api', path: '/shell/api' } as Project;

function makeContext(options: { sessions?: Array<Partial<Session>>; tasks?: Array<{ id: string }>; current?: boolean } = {}) {
  const endCommandTerminal = vi.fn();
  const detach = vi.fn();
  const context = {
    sessionManager: { listSessions: () => options.sessions ?? [], endCommandTerminal },
    boardConfigManager: { detach },
    recoveredProjects: new Set([project.id]),
    snapshottedProjects: new Set([project.id]),
    currentProjectId: options.current ? project.id : 'another-project',
    currentProjectPath: options.current ? project.path : '/elsewhere',
  } as unknown as IpcContext;
  const tasksOf = vi.fn(() => options.tasks ?? []);
  return { context, endCommandTerminal, detach, tasksOf };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('suspending a project whose host is being removed', () => {
  it('stops a queued session too, which would otherwise start after the host is gone', async () => {
    const { context, tasksOf } = makeContext({
      sessions: [
        { id: 'running', taskId: 'task-running', projectId: project.id, status: 'running', transient: false },
        { id: 'queued', taskId: 'task-queued', projectId: project.id, status: 'queued', transient: false },
        { id: 'other', taskId: 'task-other', projectId: 'another-project', status: 'running', transient: false },
      ],
    });

    await suspendProjectForHiding(context, project, tasksOf);

    expect(mocks.pauseTaskSession.mock.calls.map(([, taskId]) => taskId).sort()).toEqual(['task-queued', 'task-running']);
  });

  it('asks every task on the board, so a start still holding its task lock is stopped as it lands', async () => {
    const { context, tasksOf } = makeContext({ tasks: [{ id: 'task-starting' }, { id: 'task-idle' }] });

    await suspendProjectForHiding(context, project, tasksOf);

    expect(mocks.pauseTaskSession.mock.calls.map(([, taskId]) => taskId).sort()).toEqual(['task-idle', 'task-starting']);
  });

  it('records each stop as the system\'s, which recovery starts again, and never a held pause', async () => {
    const { context, tasksOf } = makeContext({ tasks: [{ id: 'task-one' }] });

    await suspendProjectForHiding(context, project, tasksOf);

    expect(mocks.pauseTaskSession).toHaveBeenCalledWith(context, 'task-one', { projectId: project.id, suspendedBy: 'system' });
  });

  it('pauses its workflows first, so their Pause reaches its members while the board is still visible', async () => {
    const order: string[] = [];
    mocks.pauseWorkflowsOfProject.mockImplementationOnce(async () => { order.push('workflows'); });
    mocks.pauseTaskSession.mockImplementationOnce(async () => { order.push('session'); return 'paused'; });
    const { context, tasksOf } = makeContext({ tasks: [{ id: 'task-one' }] });

    await suspendProjectForHiding(context, project, tasksOf);

    expect(order).toEqual(['workflows', 'session']);
  });

  it('ends its Command Terminals, and leaves the current project alone while the removal runs', async () => {
    const { context, endCommandTerminal, tasksOf } = makeContext({
      current: true,
      sessions: [{ id: 'terminal', taskId: 'made-up', projectId: project.id, status: 'running', transient: true }],
    });

    await suspendProjectForHiding(context, project, tasksOf);

    expect(endCommandTerminal).toHaveBeenCalledWith('terminal');
    expect(context.currentProjectId).toBe(project.id);
  });

  it('goes on when one task cannot be stopped', async () => {
    mocks.pauseTaskSession.mockRejectedValueOnce(new Error('locked'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { context, tasksOf } = makeContext({ tasks: [{ id: 'task-one' }, { id: 'task-two' }] });

    await expect(suspendProjectForHiding(context, project, tasksOf)).resolves.toBeUndefined();

    expect(mocks.pauseTaskSession).toHaveBeenCalledTimes(2);
    warned.mockRestore();
  });
});

describe('taking a hidden project out of the running app', () => {
  it('stops its background work and closes its windows, whether it is open or not', () => {
    const { context } = makeContext();

    takeHiddenProjectOutOfApp(context, project);

    expect(mocks.prStop).toHaveBeenCalledWith(project.id);
    expect(mocks.gitFetchStop).toHaveBeenCalledWith(project.id);
    expect(mocks.retrievalStop).toHaveBeenCalledWith(project.id);
    expect(mocks.clearConversationExpired).toHaveBeenCalledWith(project.id);
    expect(mocks.closeProjectTaskWindows).toHaveBeenCalledWith(project.id);
  });

  it('marks it for recovery again, since it is activated when it is shown', () => {
    const { context } = makeContext();

    takeHiddenProjectOutOfApp(context, project);

    expect(context.recoveredProjects.has(project.id)).toBe(false);
    expect(context.snapshottedProjects.has(project.id)).toBe(false);
    expect(mocks.forgetCommandTerminalRestore).toHaveBeenCalledWith(context, project.id);
  });

  it('lets go of the open project and its board config', () => {
    const { context, detach } = makeContext({ current: true });

    takeHiddenProjectOutOfApp(context, project);

    expect(context.currentProjectId).toBeNull();
    expect(context.currentProjectPath).toBeNull();
    expect(detach).toHaveBeenCalled();
    expect(mocks.reconcileEmbedWorker).toHaveBeenCalledWith(context);
  });

  it('leaves the open project and its board config alone when another project is hidden', () => {
    const { context, detach } = makeContext();

    takeHiddenProjectOutOfApp(context, project);

    expect(context.currentProjectId).toBe('another-project');
    expect(detach).not.toHaveBeenCalled();
  });
});
