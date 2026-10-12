/**
 * `findLiveSessionInDirectory` (src/main/ipc/helpers/task-git.ts): which live
 * session, if any, is working in a directory.
 *
 * The workflow case is the one that matters here. A workflow's own agent runs
 * read-only in the project root for as long as its workflow is open, so if it
 * counted as an occupant it would block every branch switch and every
 * occupancy-guarded mutation in the project root for that whole time. It is
 * recognised by `Session.workflowId`.
 *
 * The workflow session is listed FIRST in these fixtures on purpose. `find`
 * returns the first match, so with the plain session first, a filter that
 * stopped skipping workflow sessions would still return the plain one and the
 * test could never go red.
 */

import { describe, it, expect } from 'vitest';
import { findLiveSessionInDirectory } from '../../src/main/ipc/helpers/task-git';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Session } from '../../src/shared/types';

const PROJECT_ROOT = '/mock/project';

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-default',
    taskId: 'task-default',
    status: 'running',
    cwd: PROJECT_ROOT,
    ...overrides,
  } as Session;
}

function contextWith(sessions: Session[]): IpcContext {
  return { sessionManager: { listSessions: () => sessions } } as unknown as IpcContext;
}

describe('findLiveSessionInDirectory', () => {
  it('skips a workflow agent\'s session and returns the plain session in the same directory', () => {
    const workflowAgent = session({ id: 'session-workflow', taskId: 'workflow-agent-task', workflowId: 'workflow-1' });
    const plain = session({ id: 'session-plain', taskId: 'plain-task' });

    const occupant = findLiveSessionInDirectory(contextWith([workflowAgent, plain]), PROJECT_ROOT);

    expect(occupant?.taskId).toBe('plain-task');
  });

  it('finds no occupant when the only live session in the directory is a workflow agent\'s', () => {
    const workflowAgent = session({ id: 'session-workflow', taskId: 'workflow-agent-task', workflowId: 'workflow-1' });

    const occupant = findLiveSessionInDirectory(contextWith([workflowAgent]), PROJECT_ROOT);

    expect(occupant).toBeUndefined();
  });

  it('returns the plain session when it is the only one', () => {
    const plain = session({ id: 'session-plain', taskId: 'plain-task' });

    expect(findLiveSessionInDirectory(contextWith([plain]), PROJECT_ROOT)?.taskId).toBe('plain-task');
  });

  it('still skips a workflow session when excluding a task, and returns the plain one', () => {
    const workflowAgent = session({ id: 'session-workflow', taskId: 'workflow-agent-task', workflowId: 'workflow-1' });
    const excluded = session({ id: 'session-excluded', taskId: 'excluded-task' });
    const plain = session({ id: 'session-plain', taskId: 'plain-task' });

    const occupant = findLiveSessionInDirectory(
      contextWith([workflowAgent, excluded, plain]),
      PROJECT_ROOT,
      { excludeTaskId: 'excluded-task' },
    );

    expect(occupant?.taskId).toBe('plain-task');
  });
});
