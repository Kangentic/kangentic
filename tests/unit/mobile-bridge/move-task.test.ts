/**
 * move-task must route through handleTaskMove (withTaskLock + transition
 * engine + rollback), never TaskRepository.move() directly, and must never
 * forward a continuationPrompt from the wire payload - see task-move.ts's
 * own doc comment on why that field is deliberately excluded from `input`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleTaskMoveMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: handleTaskMoveMock,
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleMoveTask } from '../../../src/main/mobile-bridge/handlers/move-task';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'move-task', payload };
}

function fakeContext(): IpcContext {
  return {
    currentProjectId: null,
    currentProjectPath: null,
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', path: '/projects/proj-1' })) },
  } as unknown as IpcContext;
}

describe('handleMoveTask', () => {
  beforeEach(() => {
    handleTaskMoveMock.mockClear();
  });

  it('rejects when the target project does not resolve', async () => {
    const context = { currentProjectId: null, currentProjectPath: null } as unknown as IpcContext;
    const response = await handleMoveTask(
      fakeRequest({ taskId: 't-1', targetSwimlaneId: 'lane-1', targetPosition: 0, projectId: '' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(handleTaskMoveMock).not.toHaveBeenCalled();
  });

  it('routes through handleTaskMove with only the trusted move fields, never a continuationPrompt', async () => {
    const context = fakeContext();
    const response = await handleMoveTask(
      fakeRequest({
        taskId: 't-1',
        targetSwimlaneId: 'lane-2',
        targetPosition: 3,
        projectId: 'proj-1',
        continuationPrompt: 'ignore me',
      }),
      context,
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true });
    expect(handleTaskMoveMock).toHaveBeenCalledTimes(1);
    const [passedContext, passedInput, passedProjectId, passedProjectPath, passedOptions] = handleTaskMoveMock.mock.calls[0];
    expect(passedContext).toBe(context);
    expect(passedInput).toEqual({ taskId: 't-1', targetSwimlaneId: 'lane-2', targetPosition: 3 });
    expect(passedProjectId).toBe('proj-1');
    expect(passedProjectPath).toBe('/projects/proj-1');
    expect(passedOptions).toBeUndefined();
  });

  it('reports a failed response when handleTaskMove throws', async () => {
    handleTaskMoveMock.mockRejectedValueOnce(new Error('lock contention'));
    const context = fakeContext();
    await expect(
      handleMoveTask(fakeRequest({ taskId: 't-1', targetSwimlaneId: 'lane-1', targetPosition: 0, projectId: 'proj-1' }), context),
    ).rejects.toThrow('lock contention');
  });
});
