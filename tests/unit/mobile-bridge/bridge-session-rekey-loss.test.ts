/**
 * A rekey must not lose desktop-to-phone frames.
 *
 * The phone (Noise responder) installs the new streams the moment it writes
 * msg2 and silently drops any frame it cannot open (kangentic-mobile's
 * src/channel/sessionManager.ts). The desktop (initiator) keeps sealing under
 * the old streams until msg2 reaches it. Every frame the desktop sends in that
 * window arrives after the phone switched, so it is dropped. The window is one
 * relay round trip, and it opens on every 2-minute rekey.
 *
 * WireGuard's protocol page states the rule: "The responder must wait to use
 * the new session until it has recieved one encrypted session packet from the
 * initiator", and a sender "must either queue up packets to be sent later, or
 * use the previous session" (https://www.wireguard.com/protocol/).
 *
 * The loopback pairs elsewhere in this directory deliver synchronously, so the
 * phone's msg2 lands inside the desktop's own send() and the window is zero.
 * This file holds frames in each direction until the test delivers them, which
 * is what a relay with latency does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  FrameTag,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type SecretstreamDirectionPair,
  type Transport,
} from '@kangentic/protocol';
import { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import type { BridgeIdentity } from '../../../src/main/mobile-bridge/identity';

const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;

function testIdentity(): BridgeIdentity {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

/** Two transports whose frames wait in order until deliverToDevice() / deliverToDesktop(). */
function createDelayedPipe(): { desktop: Transport; device: Transport; deliverToDevice: () => void; deliverToDesktop: () => void } {
  const toDevice: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  const desktopListeners = new Set<(frame: Uint8Array) => void>();
  const deviceListeners = new Set<(frame: Uint8Array) => void>();
  const transport = (outbox: Uint8Array[], listeners: Set<(frame: Uint8Array) => void>): Transport => ({
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      outbox.push(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStateChange: () => () => undefined,
  });
  const drain = (queue: Uint8Array[], listeners: Set<(frame: Uint8Array) => void>) => {
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame) for (const listener of listeners) listener(frame);
    }
  };
  return {
    desktop: transport(toDevice, desktopListeners),
    device: transport(toDesktop, deviceListeners),
    deliverToDevice: () => drain(toDevice, deviceListeners),
    deliverToDesktop: () => drain(toDesktop, desktopListeners),
  };
}

/** Mirrors kangentic-mobile's sessionManager: new streams as soon as msg2 is written, unopenable frames dropped silently. */
class PhoneLikeResponder {
  streams: SecretstreamDirectionPair | null = null;
  /** Every opened frame in arrival order: a requestId, a message type, or 'goodbye'. */
  readonly received: string[] = [];
  droppedFrames = 0;
  /** A phone that is away: handshakes go unanswered and its keys stay where they were. */
  ignoreHandshakes = false;

  constructor(deviceStatic: ReturnType<typeof generateX25519KeyPair>, desktopStaticPublicKey: Uint8Array, transport: Transport) {
    transport.onFrame((rawFrame) => {
      const { kind, payload } = unwrapSessionFrame(rawFrame);
      if (kind === SessionFrameKind.Handshake) {
        if (this.ignoreHandshakes) return;
        const handshake = createKKHandshake({ initiator: false, localStatic: deviceStatic, remoteStatic: desktopStaticPublicKey });
        handshake.readMessage(payload);
        const { message, split } = handshake.writeMessage(new Uint8Array(0));
        transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
        if (split) this.streams = deriveSecretstreamPair(handshake.getChainingKey(), false);
        return;
      }
      if (!this.streams) return;
      try {
        const opened = this.streams.receive.open(payload);
        if (opened.tag === FrameTag.Final) {
          this.received.push('goodbye');
          return;
        }
        const message = decodeMessage(opened.plaintext);
        this.received.push(message.type === 'capability-response' ? message.requestId : message.type);
      } catch {
        this.droppedFrames += 1;
      }
    });
  }
}

/** A session established over a delayed pipe, with the phone-like responder on the other end. */
function establishedSession(): { session: BridgeSession; phone: PhoneLikeResponder; pipe: ReturnType<typeof createDelayedPipe> } {
  const desktopIdentity = testIdentity();
  const deviceStatic = generateX25519KeyPair();
  const pipe = createDelayedPipe();
  const phone = new PhoneLikeResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, pipe.device);
  const session = new BridgeSession({
    identity: desktopIdentity,
    deviceId: 'device-1',
    remoteStaticPublicKey: deviceStatic.publicKey,
    capabilities: new Set(['read-board']),
    transport: pipe.desktop,
  });
  session.start();
  pipe.deliverToDevice();
  pipe.deliverToDesktop();
  if (!session.isEstablished) throw new Error('establishedSession(): the first handshake did not complete');
  return { session, phone, pipe };
}

function response(requestId: string): BridgeMessage {
  return { type: 'capability-response', requestId, ok: true };
}

describe('BridgeSession rekey', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers every desktop frame sent while a rekey is in flight', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    session.sendMessage(response('before-rekey'));
    pipe.deliverToDevice();

    // The 2-minute rekey sends msg1. Until msg2 comes back, the desktop keeps
    // answering requests and pushing terminal output.
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('during-rekey-1'));
    session.sendMessage(response('during-rekey-2'));
    pipe.deliverToDevice();
    pipe.deliverToDesktop();

    session.sendMessage(response('after-rekey'));
    pipe.deliverToDevice();

    expect(phone.droppedFrames).toBe(0);
    expect(phone.received).toEqual(['before-rekey', 'during-rekey-1', 'during-rekey-2', 'after-rekey']);
    session.dispose();
  });

  it('reports what it held when the reply arrives', () => {
    vi.useFakeTimers();
    const { session, pipe } = establishedSession();
    const releases: Array<{ frames: number; reason: string }> = [];
    session.on('rekeyHoldReleased', (event: { frames: number; reason: string }) => releases.push({ frames: event.frames, reason: event.reason }));
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held'));
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    expect(releases).toEqual([{ frames: 1, reason: 'established' }]);
    session.dispose();
  });

  it('releases under the old keys at the deadline when the phone never answers, and the phone (which never switched) opens them', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    phone.ignoreHandshakes = true;
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-1'));
    pipe.deliverToDevice();
    expect(phone.received).toEqual([]);

    // The presence window and the hold deadline are the same 5 s.
    vi.advanceTimersByTime(5_000);
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['held-1']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('keeps a goodbye behind the frames sent before it', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('last-answer'));
    session.sendGoodbye();
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['last-answer', 'goodbye']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('flushes held frames on dispose, so a revoke behind a rekey still says goodbye', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    phone.ignoreHandshakes = true;
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendGoodbye();
    session.dispose();
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['goodbye']);
  });

  it('flushes an earlier hold ahead of a second msg1, so a re-probe never strands frames behind a key switch', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    phone.ignoreHandshakes = true;
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-before-reprobe'));
    // The first msg1 reaches a phone that is away, so its keys never move.
    pipe.deliverToDevice();
    // The phone comes back and the screen-unlock probe sends a fresh msg1.
    phone.ignoreHandshakes = false;
    expect(session.probePresenceNow()).toBe(true);
    session.sendMessage(response('held-after-reprobe'));
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['held-before-reprobe', 'held-after-reprobe']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });
});
