/**
 * answer-permission-prompt is the most sensitive verb - it can authorize an
 * agent to run a command. These tests lock the binding check that makes it
 * safer than a plain interactive-terminal write: the response must match
 * the LIVE outstanding prompt id, rejecting a stale or already-resolved one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleAnswerPermissionPrompt } from '../../../src/main/mobile-bridge/handlers/answer-permission-prompt';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'answer-permission-prompt', payload };
}

function fakeContext(overrides: {
  session?: unknown;
  snapshot?: { permissionPending: boolean; permissionAwaitedToolId: string | null } | null;
  write?: ReturnType<typeof vi.fn>;
  writable?: boolean;
} = {}): IpcContext {
  const write = overrides.write ?? vi.fn();
  return {
    sessionManager: {
      getSession: vi.fn(() => (overrides.session === undefined ? { id: 'sess-1' } : overrides.session)),
      getActivityStatsSnapshot: vi.fn(() => (overrides.snapshot === undefined ? null : overrides.snapshot)),
      isWritable: vi.fn(() => overrides.writable ?? true),
      write,
    },
  } as unknown as IpcContext;
}

describe('handleAnswerPermissionPrompt', () => {
  it('rejects when the session does not exist', () => {
    const context = fakeContext({ session: null });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-1', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such session/i);
  });

  it('rejects when no permission prompt is currently outstanding', () => {
    const context = fakeContext({ snapshot: { permissionPending: false, permissionAwaitedToolId: null } });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-1', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no permission prompt/i);
  });

  it('rejects a stale/mismatched promptId without writing to the PTY', () => {
    const write = vi.fn();
    const context = fakeContext({
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-CURRENT' },
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-STALE', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/does not match/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the keystrokes only when promptId matches the live awaited prompt exactly', () => {
    const write = vi.fn();
    const context = fakeContext({
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-9' },
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ answered: true });
    // Tagged 'user': a phone answering a permission prompt is human input, and
    // the prompt-draft ledger must see it the same way it sees the keyboard.
    expect(write).toHaveBeenCalledWith('sess-1', '1\r', 'user');
  });

  it('rejects (without writing) when the prompt matches but the PTY is no longer writable', () => {
    const write = vi.fn();
    const context = fakeContext({
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-9' },
      writable: false,
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not accepting input/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects when the request carries a different sessionId than the awaited prompt was bound to', () => {
    // A prompt id is built as `${sessionId}:${toolId}` - reusing another
    // session's tool id under a different sessionId must not match.
    const write = vi.fn();
    const context = fakeContext({
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-9' },
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-OTHER:tool-9', keystrokes: '1\r' }),
      context,
    );
    expect(response.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
