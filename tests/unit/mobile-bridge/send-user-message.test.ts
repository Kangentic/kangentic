import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

const hoisted = vi.hoisted(() => ({
  holdTaskMessage: vi.fn<(...callArguments: unknown[]) => unknown>(() => ({ status: 'held', displayId: 412, rowId: 'held-1' })),
}));
vi.mock('../../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: hoisted.holdTaskMessage }));

import { handleSendUserMessage } from '../../../src/main/mobile-bridge/handlers/send-user-message';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'send-user-message', payload };
}

function contextWith(session: Record<string, unknown> | undefined, writable: boolean, submitContent = vi.fn(() => Promise.resolve())): IpcContext {
  return {
    sessionManager: { getSession: vi.fn(() => session), isWritable: vi.fn(() => writable) },
    terminalSubmit: { submitContent },
  } as unknown as IpcContext;
}

describe('handleSendUserMessage', () => {
  beforeEach(() => {
    hoisted.holdTaskMessage.mockReset();
    hoisted.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 412, rowId: 'held-1' });
  });

  it('rejects with the unknown-session code when the session does not exist', async () => {
    const context = contextWith(undefined, false);
    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response).toMatchObject({ ok: false, code: 'unknown-session', error: 'No such session: sess-1' });
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('refuses a row with no task that ended, with the unknown-session code and no paste attempt', async () => {
    // A suspended or exited row stays in the registry with no PTY. The paste
    // engine would drop every byte and fail about 6 s later with no code.
    const context = contextWith({ id: 'sess-1', status: 'suspended' }, false);
    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(response.error).toMatch(/not accepting input/i);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('refuses a queued row with no task without the unknown-session code, since its PTY is still coming', async () => {
    const context = contextWith({ id: 'sess-1', status: 'queued' }, false);
    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response.ok).toBe(false);
    expect(response.code).toBeUndefined();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('delivers via the bracketed-paste submit path, not a raw PTY write', async () => {
    const submitContent = vi.fn(() => Promise.resolve());
    const context = contextWith({ id: 'sess-1', status: 'running', taskId: 'task-1', projectId: 'proj-1' }, true, submitContent);
    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'please continue' }), context);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ delivered: true });
    expect(submitContent).toHaveBeenCalledWith('sess-1', 'please continue', { source: 'mobile-bridge' });
    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
  });

  describe('a task with no running agent (held messages)', () => {
    it('holds the phone\'s message for a paused task\'s next agent, as a person sends, and answers it was delivered', async () => {
      const context = contextWith({ id: 'sess-1', status: 'suspended', taskId: 'task-1', projectId: 'proj-1' }, false);
      const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'Lower the cap to 3.' }), context);

      expect(response).toMatchObject({ ok: true, payload: { delivered: true } });
      // No caller ids: a person sent it.
      expect(hoisted.holdTaskMessage).toHaveBeenCalledWith(context, { projectId: 'proj-1', taskId: 'task-1', message: 'Lower the cap to 3.' });
      expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    });

    it('holds for a queued or exited task session too, as the MCP send tool does', async () => {
      for (const status of ['queued', 'exited']) {
        hoisted.holdTaskMessage.mockClear();
        const context = contextWith({ id: 'sess-1', status, taskId: 'task-1', projectId: 'proj-1' }, false);
        const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
        expect(response.ok).toBe(true);
        expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
      }
    });

    it('a refused hold keeps the refusal code phones branch on, with the hold\'s reason as its text', async () => {
      const reason = 'Task #412 is in Done, where no agent runs, so nothing is held for it. Move it out of Done first.';
      hoisted.holdTaskMessage.mockReturnValue({ status: 'refused', error: reason });
      const suspended = contextWith({ id: 'sess-1', status: 'suspended', taskId: 'task-1', projectId: 'proj-1' }, false);
      expect(await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), suspended)).toMatchObject({
        ok: false,
        code: 'unknown-session',
        error: reason,
      });

      const queued = contextWith({ id: 'sess-1', status: 'queued', taskId: 'task-1', projectId: 'proj-1' }, false);
      const queuedResponse = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), queued);
      expect(queuedResponse).toMatchObject({ ok: false, error: reason });
      expect(queuedResponse.code).toBeUndefined();
    });

    it('never holds for a transient session (a Command Terminal or a workflow\'s own agent): it has no task', async () => {
      const context = contextWith({ id: 'sess-1', status: 'suspended', taskId: 'ct-1', projectId: 'proj-1', transient: true }, false);
      const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
      expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
      expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    });

    it('never holds for a task session that carries no project id: there is no project to hold it under', async () => {
      const context = contextWith({ id: 'sess-1', status: 'suspended', taskId: 'task-1' }, false);
      const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
      expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
      expect(response.error).toMatch(/not accepting input/i);
      expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
      expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    });

    it('never holds for a session that carries a project id but no task id: there is no task to hold it for', async () => {
      const context = contextWith({ id: 'sess-1', status: 'suspended', projectId: 'proj-1' }, false);
      const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
      expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
      expect(response.error).toMatch(/not accepting input/i);
      expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
      expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    });
  });
});
