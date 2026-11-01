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
  /** The session's open tool calls (`getOpenWork`). */
  toolCalls?: Array<{ id: string | null; tool: string; since: number }>;
  /** When a person last typed into the session (`getLastUserInputAt`). */
  lastUserInputAt?: number | null;
} = {}): IpcContext {
  const write = overrides.write ?? vi.fn();
  return {
    sessionManager: {
      getSession: vi.fn(() => (overrides.session === undefined ? { id: 'sess-1', status: 'running' } : overrides.session)),
      getActivityStatsSnapshot: vi.fn(() => (overrides.snapshot === undefined ? null : overrides.snapshot)),
      isWritable: vi.fn(() => overrides.writable ?? true),
      getOpenWork: vi.fn(() => ({ toolCalls: overrides.toolCalls ?? [], backgroundShells: [], backgroundSubagents: [] })),
      getLastUserInputAt: vi.fn(() => overrides.lastUserInputAt ?? null),
      write,
    },
  } as unknown as IpcContext;
}

describe('handleAnswerPermissionPrompt', () => {
  it('rejects with the unknown-session code when the session does not exist', () => {
    const context = fakeContext({ session: null });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-1', keystrokes: '1\r' }),
      context,
    );
    expect(response).toMatchObject({ ok: false, code: 'unknown-session', error: 'No such session: sess-1' });
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
    // A running row whose PTY a kill just nulled is not yet ended as far as
    // the row says, so the phone is not told the session is gone.
    expect(response.code).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('answers the unknown-session code when the prompt matches but the session was suspended', () => {
    const write = vi.fn();
    const context = fakeContext({
      session: { id: 'sess-1', status: 'suspended' },
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-9' },
      writable: false,
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1\r' }),
      context,
    );
    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(response.error).toMatch(/not accepting input/i);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'exited'])('answers the unknown-session code for a %s session with no prompt on record', (status) => {
    // A suspend drops the session's activity state, so the snapshot reads null,
    // and an exited row need not hold a pending prompt either. The phone must
    // still learn the session ended, not that no prompt is outstanding.
    const write = vi.fn();
    const context = fakeContext({
      session: { id: 'sess-1', status },
      snapshot: null,
      writable: false,
      write,
    });
    const response = handleAnswerPermissionPrompt(
      fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1\r' }),
      context,
    );
    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(response.error).toMatch(/not accepting input/i);
    expect(write).not.toHaveBeenCalled();
  });

  // Task #952: a stray "1" reached two agents' input right after a prompt
  // closed, likely a phone tap on a prompt the desktop already answered. The
  // cause is unconfirmed, so the answer goes as before and the log says what
  // it typed and whether someone typed after the call began: the evidence a
  // fix needs.
  it.each([
    { case: 'someone typed after the call began', typedOffsetMs: 3_000, logged: ['after the call began'] },
    { case: 'the last typing came before the call began', typedOffsetMs: -60_000, logged: ['Phone answered the Bash prompt', 'keys "1"'] },
  ])('answers, and logs the answer when $case', ({ typedOffsetMs, logged }) => {
    const write = vi.fn();
    const since = Date.now() - 20_000;
    const context = fakeContext({
      snapshot: { permissionPending: true, permissionAwaitedToolId: 'tool-9' },
      toolCalls: [{ id: 'tool-9', tool: 'Bash', since }],
      lastUserInputAt: since + typedOffsetMs,
      write,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = handleAnswerPermissionPrompt(
        fakeRequest({ sessionId: 'sess-1', promptId: 'sess-1:tool-9', keystrokes: '1' }),
        context,
      );
      expect(response.ok).toBe(true);
      expect(write).toHaveBeenCalledWith('sess-1', '1', 'user');
      expect(log.mock.calls.some((call) => logged.every((part) => String(call[0]).includes(part)))).toBe(true);
    } finally {
      log.mockRestore();
    }
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
