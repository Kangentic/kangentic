import { describe, it, expect, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleInteractiveTerminal } from '../../../src/main/mobile-bridge/handlers/interactive-terminal';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'interactive-terminal', payload };
}

describe('handleInteractiveTerminal', () => {
  it('rejects when the session does not exist', () => {
    const context = { sessionManager: { getSession: vi.fn(() => undefined), write: vi.fn() } } as unknown as IpcContext;
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), context);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such session/i);
  });

  it('writes raw keystrokes straight through to the live session (full terminal parity)', () => {
    const write = vi.fn();
    const context = {
      sessionManager: { getSession: vi.fn(() => ({ id: 'sess-1' })), isWritable: vi.fn(() => true), write },
    } as unknown as IpcContext;

    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'npm login\r' }), context);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ written: true });
    expect(write).toHaveBeenCalledWith('sess-1', 'npm login\r');
  });

  it('rejects (never reports written:true) when the session exists but has no live PTY', () => {
    // A suspended/queued/exited session is still in the registry, so getSession
    // is truthy, but write() would silently drop the bytes - the handler must
    // surface that instead of a false written:true.
    const write = vi.fn();
    const context = {
      sessionManager: { getSession: vi.fn(() => ({ id: 'sess-1' })), isWritable: vi.fn(() => false), write },
    } as unknown as IpcContext;

    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), context);

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not accepting input/i);
    expect(write).not.toHaveBeenCalled();
  });
});
