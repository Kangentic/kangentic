/**
 * move-task must route through handleTaskMove (withTaskLock + transition
 * engine + rollback), never TaskRepository.move() directly, and must never
 * forward a continuationPrompt from the wire payload - see task-move.ts's
 * own doc comment on why that field is deliberately excluded from `input`.
 *
 * It must also answer the phone when the move COMMITS, not when the tail of
 * the move (suspend, leftover reap, worktree removal, worktree create + spawn)
 * finishes. The phone gives every verb 10s; measured desktop moves run past
 * that in 9% of cases, so awaiting the whole move reported a committed move as
 * "Move failed" on the phone. The handler under test is given a mocked
 * handleTaskMove, so what this file can pin is the contract between the two:
 * the verb resolves on the commit signal, a pre-commit rejection still surfaces
 * as a failure, and a post-commit rejection is logged without escaping into the
 * bridge's request loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { handleTaskMove as HandleTaskMove } from '../../../src/main/ipc/handlers/task-move';

const handleTaskMoveMock = vi.hoisted(() =>
  vi.fn((..._args: Parameters<typeof HandleTaskMove>): Promise<void> => Promise.resolve()),
);
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

const MOVE_PAYLOAD = { taskId: 't-1', targetSwimlaneId: 'lane-1', targetPosition: 0, projectId: 'proj-1' };

/** The options bag handleTaskMove was handed on its most recent call. */
function passedOptionsOfLastCall(): Parameters<typeof HandleTaskMove>[5] {
  const lastCall = handleTaskMoveMock.mock.calls.at(-1);
  if (!lastCall) throw new Error('handleTaskMove was never called');
  return lastCall[5];
}

/** A tick after the microtask queue drains, which is when Node would have reported an unhandled rejection. */
function afterUnhandledRejectionWindow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('handleMoveTask', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handleTaskMoveMock.mockClear();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
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
    const [passedContext, passedInput, passedOrigin, passedProjectId, passedProjectPath, passedOptions] = handleTaskMoveMock.mock.calls[0];
    expect(passedContext).toBe(context);
    expect(passedInput).toEqual({ taskId: 't-1', targetSwimlaneId: 'lane-2', targetPosition: 3 });
    expect(passedProjectId).toBe('proj-1');
    expect(passedProjectPath).toBe('/projects/proj-1');
    // The options bag carries ONLY the commit signal. The continuationPrompt
    // from the wire payload must not ride along: that field is deliberately
    // excluded from the raw renderer-facing input shape, and a phone is no more
    // trusted than the renderer here.
    expect(passedOptions).toEqual({ onCommitted: expect.any(Function) });
    expect(passedOptions).not.toHaveProperty('continuationPrompt');

    // The whole point of the origin: it is what makes handleTaskMove announce
    // the move to the desktop board and to every other paired phone. A phone
    // move used to land in the DB and tell nobody, leaving the desktop card
    // rendering in the column it had just left.
    expect(passedOrigin).toBe('mobile');
  });

  it('answers as soon as the move commits, while the side effects are still running', async () => {
    // The move signals its commit and then never settles: this stands in for a
    // Done move whose worktree removal outlasts the phone's 10s budget. Against
    // a handler that awaits the whole move this test hangs to the vitest
    // timeout, which is the bug.
    handleTaskMoveMock.mockImplementationOnce((_context, _input, _origin, _projectId, _projectPath, options) => {
      options?.onCommitted?.();
      return new Promise<void>(() => {});
    });

    const response = await handleMoveTask(fakeRequest(MOVE_PAYLOAD), fakeContext());

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ ok: true });
  });

  it('reports a failed response when handleTaskMove rejects BEFORE signalling commit', async () => {
    // Task not found, lock contention, a throw before tasks.move: nothing landed
    // on disk, so the phone must hear "failed" exactly as before. The router
    // turns the thrown error into the ok:false response.
    handleTaskMoveMock.mockRejectedValueOnce(new Error('lock contention'));
    const context = fakeContext();
    await expect(
      handleMoveTask(fakeRequest(MOVE_PAYLOAD), context),
    ).rejects.toThrow('lock contention');

    await afterUnhandledRejectionWindow();
    // The rejection surfaced through the response; it is not ALSO logged as a
    // post-commit failure, which would misreport a move that never committed.
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('failed after commit'), expect.anything());
  });

  it('answers ok, logs, and leaves no unhandled rejection when the move fails AFTER committing', async () => {
    // Phase 2/3 blew up after the row landed. handleTaskMove already ran its own
    // rollback and announced the outcome on the board-changed bus; the phone
    // was told the row moved, which was true, and the follow-up board event is
    // what corrects it. What must NOT happen is the rejection escaping into the
    // bridge's request loop as an unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      handleTaskMoveMock.mockImplementationOnce((_context, _input, _origin, _projectId, _projectPath, options) => {
        options?.onCommitted?.();
        return Promise.reject(new Error('Worktree setup failed: disk full'));
      });

      const response = await handleMoveTask(fakeRequest(MOVE_PAYLOAD), fakeContext());
      expect(response.ok).toBe(true);
      expect(response.payload).toEqual({ ok: true });

      await afterUnhandledRejectionWindow();
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('failed after commit'),
        expect.objectContaining({ message: 'Worktree setup failed: disk full' }),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps answering a clean move that never signalled commit', async () => {
    // The shutdown-swallow path inside handleTaskMove resolves without ever
    // reaching tasks.move. Today that reads as ok:true; the commit signal must
    // not turn it into a hang.
    handleTaskMoveMock.mockResolvedValueOnce(undefined);
    const response = await handleMoveTask(fakeRequest(MOVE_PAYLOAD), fakeContext());
    expect(response.ok).toBe(true);
    expect(passedOptionsOfLastCall()?.onCommitted).toEqual(expect.any(Function));
  });
});
