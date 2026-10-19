import { describe, it, expect } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import {
  notAcceptingInputRefusal,
  unknownSessionRefusal,
} from '../../../src/main/mobile-bridge/handlers/session-refusals';
import type { SessionStatus } from '../../../src/shared/types';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'send-user-message', payload };
}

// All four SessionStatus members, split by what the row says. A row whose
// session ended gets the unknown-session code; a row that is still live does
// not. Typed as SessionStatus[] so a renamed or removed member is a type error.
const ENDED_STATUSES: SessionStatus[] = ['exited', 'suspended'];
const LIVE_STATUSES: SessionStatus[] = ['running', 'queued'];

describe('unknownSessionRefusal', () => {
  it('builds the full refusal shape with the unknown-session code', () => {
    const request = fakeRequest({ sessionId: 'sess-1' });

    expect(unknownSessionRefusal(request, 'sess-1')).toEqual({
      type: 'capability-response',
      requestId: 'req-1',
      ok: false,
      error: 'No such session: sess-1',
      code: 'unknown-session',
    });
  });

  it('echoes the request id and the given session id', () => {
    const request: CapabilityRequestMessage = {
      type: 'capability-request',
      requestId: 'req-42',
      verb: 'read-stream',
      payload: {},
    };

    const response = unknownSessionRefusal(request, 'sess-gone');

    expect(response.requestId).toBe('req-42');
    expect(response.error).toBe('No such session: sess-gone');
  });
});

describe('notAcceptingInputRefusal', () => {
  it.each(ENDED_STATUSES)('carries the unknown-session code for a %s session', (status) => {
    const request = fakeRequest({ sessionId: 'sess-1' });

    expect(notAcceptingInputRefusal(request, { id: 'sess-1', status })).toEqual({
      type: 'capability-response',
      requestId: 'req-1',
      ok: false,
      error: 'Session is not accepting input (not running): sess-1',
      code: 'unknown-session',
    });
  });

  it.each(LIVE_STATUSES)('omits the code key entirely for a %s session', (status) => {
    const request = fakeRequest({ sessionId: 'sess-1' });

    const response = notAcceptingInputRefusal(request, { id: 'sess-1', status });

    expect(response).toEqual({
      type: 'capability-response',
      requestId: 'req-1',
      ok: false,
      error: 'Session is not accepting input (not running): sess-1',
    });
    // toEqual treats an undefined property as absent, so assert the key itself.
    expect(response).not.toHaveProperty('code');
  });
});
