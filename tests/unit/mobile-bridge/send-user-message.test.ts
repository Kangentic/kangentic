import { describe, it, expect, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleSendUserMessage } from '../../../src/main/mobile-bridge/handlers/send-user-message';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'send-user-message', payload };
}

describe('handleSendUserMessage', () => {
  it('rejects when the session does not exist', async () => {
    const context = {
      sessionManager: { getSession: vi.fn(() => undefined) },
      terminalSubmit: { submitContent: vi.fn() },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'hello' }), context);
    expect(response.ok).toBe(false);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('delivers via the bracketed-paste submit path, not a raw PTY write', async () => {
    const submitContent = vi.fn(() => Promise.resolve());
    const context = {
      sessionManager: { getSession: vi.fn(() => ({ id: 'sess-1' })) },
      terminalSubmit: { submitContent },
    } as unknown as IpcContext;

    const response = await handleSendUserMessage(fakeRequest({ sessionId: 'sess-1', text: 'please continue' }), context);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ delivered: true });
    expect(submitContent).toHaveBeenCalledWith('sess-1', 'please continue', { source: 'mobile-bridge' });
  });
});
