/**
 * Unit tests for sendEvent (src/main/mobile-bridge/handlers/send-event.ts).
 *
 * sendEvent's try/catch used to swallow every BridgeSession.sendMessage
 * failure uniformly - both a routine torn-down-session throw (expected any
 * time a session outlives its last listener callback) and an oversize-frame
 * throw from encodeMessage (packages/protocol/src/wire/framing.ts), which is
 * NOT routine: retrying resends the same over-budget payload, and the phone
 * has no other signal that the event was dropped. It now distinguishes the
 * two by matching the encode/size throw's message prefix and warns only for
 * that case, staying silent for every other throw.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BridgeEvent } from '@kangentic/protocol';
import { sendEvent } from '../../../src/main/mobile-bridge/handlers/send-event';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';

function fakeSession(overrides: { isEstablished?: boolean; sendMessage?: ReturnType<typeof vi.fn> } = {}): BridgeSession {
  return {
    isEstablished: overrides.isEstablished ?? true,
    sendMessage: overrides.sendMessage ?? vi.fn(),
  } as unknown as BridgeSession;
}

const diffEvent: BridgeEvent = { kind: 'diff', taskId: 'task-1', payload: null };

describe('sendEvent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does not send or warn when the session is not established', () => {
    const sendMessage = vi.fn();
    const session = fakeSession({ isEstablished: false, sendMessage });

    sendEvent(session, diffEvent);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sends the event and does not warn on a successful send', () => {
    const sendMessage = vi.fn();
    const session = fakeSession({ sendMessage });

    sendEvent(session, diffEvent);

    expect(sendMessage).toHaveBeenCalledWith({ type: 'event', event: diffEvent });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when sendMessage throws an encode/size-cap error (framing.ts prefix)', () => {
    // Mirrors framing.ts's two throws verbatim: `Encoded bridge message
    // exceeds ${MAX_DECODED_LENGTH} bytes before compression` and
    // `Encoded bridge message exceeds ${MAX_FRAME_LENGTH} bytes`.
    const sendMessage = vi.fn(() => {
      throw new Error('Encoded bridge message exceeds 1048576 bytes before compression');
    });
    const session = fakeSession({ sendMessage });

    expect(() => sendEvent(session, diffEvent)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as unknown[];
    expect(String(message)).toContain('dropped oversize');
    expect(String(message)).toContain(diffEvent.kind);
  });

  it('stays silent for a routine send failure (e.g. a torn-down session)', () => {
    const sendMessage = vi.fn(() => {
      throw new Error('BridgeSession is disposed');
    });
    const session = fakeSession({ sendMessage });

    expect(() => sendEvent(session, diffEvent)).not.toThrow();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
