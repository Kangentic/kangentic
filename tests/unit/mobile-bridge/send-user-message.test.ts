import { describe, it, expect, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleSendUserMessage } from '../../../src/main/mobile-bridge/handlers/send-user-message';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'send-user-message', payload };
}

describe('handleSendUserMessage', () => {
  it('rejects with the unknown-session code when the session does not exist', async () => {
    const context = {
      sessionManager: { getSession: vi.fn(() => undefined), isWritable: vi.fn(() => false) },
      terminalSubmit: { submitContent: vi.fn() },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response).toMatchObject({ ok: false, code: 'unknown-session', error: 'No such session: sess-1' });
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('refuses a session that ended but kept its row, with the unknown-session code and no paste attempt', async () => {
    // A suspended or exited row stays in the registry with no PTY. The paste
    // engine would drop every byte and fail about 6 s later with no code.
    const submitContent = vi.fn(() => Promise.resolve());
    const context = {
      sessionManager: {
        getSession: vi.fn(() => ({ id: 'sess-1', status: 'suspended' })),
        isWritable: vi.fn(() => false),
      },
      terminalSubmit: { submitContent },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(response.error).toMatch(/not accepting input/i);
    expect(submitContent).not.toHaveBeenCalled();
  });

  it('refuses a queued session without the unknown-session code, since its PTY is still coming', async () => {
    const submitContent = vi.fn(() => Promise.resolve());
    const context = {
      sessionManager: {
        getSession: vi.fn(() => ({ id: 'sess-1', status: 'queued' })),
        isWritable: vi.fn(() => false),
      },
      terminalSubmit: { submitContent },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response.ok).toBe(false);
    expect(response.code).toBeUndefined();
    expect(submitContent).not.toHaveBeenCalled();
  });

  it('delivers via the bracketed-paste submit path, not a raw PTY write', async () => {
    const submitContent = vi.fn(() => Promise.resolve());
    const context = {
      sessionManager: {
        getSession: vi.fn(() => ({ id: 'sess-1', status: 'running' })),
        isWritable: vi.fn(() => true),
      },
      terminalSubmit: { submitContent },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'please continue' }), context);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ delivered: true });
    expect(submitContent).toHaveBeenCalledWith('sess-1', 'please continue', { source: 'mobile-bridge' });
  });
});
