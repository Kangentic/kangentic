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
import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  FrameTag,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  MAX_DECODED_LENGTH,
  MAX_FRAME_LENGTH,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type SecretstreamDirectionPair,
  type Transport,
  type TransportState,
} from '@kangentic/protocol';
import { BridgeSession, MessageEncodeError } from '../../../src/main/mobile-bridge/session/bridge-session';
import type { BridgeIdentity } from '../../../src/main/mobile-bridge/identity';

const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;
/** The session's presence budget, which is also the longest a rekey holds frames (REKEY_HOLD_MAX_MS). */
const REKEY_HOLD_MAX_MS = 10 * 1000;
/** Mirrors REKEY_HOLD_MAX_BYTES in bridge-session.ts, which is not exported: the encoded bytes a hold keeps before it releases early. */
const REKEY_HOLD_MAX_BYTES = 8 * 1024 * 1024;

function testIdentity(): BridgeIdentity {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

type DelayedPipe = ReturnType<typeof createDelayedPipe>;

/** Two transports whose frames wait in order until deliverToDevice() / deliverToDesktop(). */
function createDelayedPipe(): {
  desktop: Transport;
  device: Transport;
  deliverToDevice: () => void;
  deliverToDesktop: () => void;
  /**
   * Moves the desktop transport to `state` and notifies its listeners. Leaving
   * 'connected' also discards every frame in flight in both directions, the way
   * the relay force-closes both peers when either drops, and a send while the
   * desktop is not 'connected' goes nowhere.
   */
  setDesktopState: (state: TransportState) => void;
} {
  const toDevice: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  const desktopListeners = new Set<(frame: Uint8Array) => void>();
  const deviceListeners = new Set<(frame: Uint8Array) => void>();
  const desktopStateListeners = new Set<(state: TransportState) => void>();
  let desktopState: TransportState = 'connected';
  const desktop: Transport = {
    get state() {
      return desktopState;
    },
    connect: () => Promise.resolve(),
    send: (frame) => {
      if (desktopState === 'connected') toDevice.push(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      desktopListeners.add(listener);
      return () => desktopListeners.delete(listener);
    },
    onStateChange: (listener) => {
      desktopStateListeners.add(listener);
      return () => desktopStateListeners.delete(listener);
    },
  };
  const device: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      toDesktop.push(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      deviceListeners.add(listener);
      return () => deviceListeners.delete(listener);
    },
    onStateChange: () => () => undefined,
  };
  const drain = (queue: Uint8Array[], listeners: Set<(frame: Uint8Array) => void>) => {
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame) for (const listener of listeners) listener(frame);
    }
  };
  return {
    desktop,
    device,
    deliverToDevice: () => drain(toDevice, deviceListeners),
    deliverToDesktop: () => drain(toDesktop, desktopListeners),
    setDesktopState: (state) => {
      desktopState = state;
      if (state !== 'connected') {
        toDevice.length = 0;
        toDesktop.length = 0;
      }
      for (const listener of desktopStateListeners) listener(state);
    },
  };
}

/**
 * Runs `beforeSend` ahead of every frame the desktop transport sends. A throw
 * from it keeps the frame out of the pipe, the way a transport whose socket
 * just failed refuses it; it may also re-enter the session or change state.
 */
function interceptDesktopSend(pipe: DelayedPipe, beforeSend: (frame: Uint8Array) => void): void {
  const originalSend = pipe.desktop.send;
  vi.spyOn(pipe.desktop, 'send').mockImplementation((frame) => {
    beforeSend(frame);
    originalSend(frame);
  });
}

function isHandshakeFrame(frame: Uint8Array): boolean {
  return unwrapSessionFrame(frame).kind === SessionFrameKind.Handshake;
}

/** Every 'rekeyHoldReleased' the session emits, reduced to what the tests pin. */
function collectRekeyHoldReleases(session: BridgeSession): Array<{ frames: number; reason: string }> {
  const releases: Array<{ frames: number; reason: string }> = [];
  session.on('rekeyHoldReleased', (event: { frames: number; heldMs: number; reason: string }) => {
    releases.push({ frames: event.frames, reason: event.reason });
  });
  return releases;
}

/** Mirrors kangentic-mobile's sessionManager: new streams as soon as msg2 is written, unopenable frames dropped silently. */
class PhoneLikeResponder {
  streams: SecretstreamDirectionPair | null = null;
  private readonly transport: Transport;
  /** Every opened frame in arrival order: a requestId, a message type, or 'goodbye'. */
  readonly received: string[] = [];
  droppedFrames = 0;
  /** A phone that is away: handshakes go unanswered and its keys stay where they were. */
  ignoreHandshakes = false;

  /** Seals a heartbeat under the phone's current keys, the way the phone answers a desktop heartbeat. */
  sendHeartbeat(): void {
    if (!this.streams) throw new Error('sendHeartbeat(): not established');
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, this.streams.send.seal(encodeMessage({ type: 'heartbeat' }))));
  }

  constructor(deviceStatic: ReturnType<typeof generateX25519KeyPair>, desktopStaticPublicKey: Uint8Array, transport: Transport) {
    this.transport = transport;
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

    // Still held through the first presence window (the re-probe's msg1 is
    // also unanswered), released at the end of the presence budget.
    vi.advanceTimersByTime(5_000);
    pipe.deliverToDevice();
    expect(phone.received).toEqual([]);
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

  // A reply stalled past the presence window: the re-probe sends a second
  // msg1, the phone answers both in order and ends on the second keys. The
  // desktop used to read reply 1 with handshake 2, destroying it, then find
  // no handshake for reply 2, and stay on the old keys while the phone moved
  // on: every frame both ways was lost until the next 2-minute rekey.
  it('survives a reply that stalls past the presence window: both sides end on the same keys and nothing is lost', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const desktopReceived: string[] = [];
    session.on('message', (message: BridgeMessage) => desktopReceived.push(message.type));

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('r1'));
    // The phone answers msg1, but its reply is stuck in the relay.
    pipe.deliverToDevice();
    // The presence window expires and the re-probe sends a second msg1.
    vi.advanceTimersByTime(5_000);
    session.sendMessage(response('r2'));
    pipe.deliverToDevice();
    // Both replies arrive, in order.
    pipe.deliverToDesktop();
    pipe.deliverToDevice();

    session.sendMessage(response('r3'));
    pipe.deliverToDevice();
    phone.sendHeartbeat();
    pipe.deliverToDesktop();

    expect(phone.droppedFrames).toBe(0);
    expect(phone.received).toEqual(['r1', 'r2', 'r3']);
    expect(desktopReceived).toEqual(['heartbeat']);
    session.dispose();
  });

  // Every msg1 the phone receives gets an answer, in order. If the desktop
  // forgot an initiation while its msg1 was still on the way, that msg1's
  // reply would be tried against every initiation it still holds, and a
  // failed read destroys each one it touches.
  it('stays in step when more initiations go unanswered than it keeps', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const desktopReceived: string[] = [];
    session.on('message', (message: BridgeMessage) => desktopReceived.push(message.type));

    // The rekey tick, the presence re-probe, then unlock probes, all while
    // the phone's replies are stuck.
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    vi.advanceTimersByTime(5_000);
    for (let probe = 0; probe < 8; probe++) session.probePresenceNow();
    pipe.deliverToDevice();
    pipe.deliverToDesktop();

    session.sendMessage(response('after-the-stall'));
    pipe.deliverToDevice();
    phone.sendHeartbeat();
    pipe.deliverToDesktop();

    expect(phone.droppedFrames).toBe(0);
    expect(phone.received).toEqual(['after-the-stall']);
    expect(desktopReceived).toEqual(['heartbeat']);
    session.dispose();
  });

  it('keeps holding across a second msg1 and releases under the keys the phone ends on when the first msg1 never reached it', () => {
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

/** High-entropy text that deflate cannot shrink much, so a message made of it stays close to its raw size. */
function incompressibleText(byteCount: number): string {
  return randomBytes(byteCount).toString('base64');
}

function sessionOverTransport(transport: Transport): BridgeSession {
  return new BridgeSession({
    identity: testIdentity(),
    deviceId: 'device-1',
    remoteStaticPublicKey: generateX25519KeyPair().publicKey,
    capabilities: new Set(['read-board']),
    transport,
  });
}

describe('BridgeSession rekey hold: how it ends', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The relay force-closes both peers on a drop, so the phone discarded the
  // keys these frames would need. Sealing them after the reconnect would burn
  // send-counter slots on frames nobody can open, or, worse, deliver a
  // pre-disconnect answer into the new session.
  it('discards the frames a rekey was holding when the transport leaves connected, with no event and no timer left behind', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    const timersWhileEstablished = vi.getTimerCount();

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-before-the-drop'));
    pipe.setDesktopState('reconnecting');
    pipe.setDesktopState('connected');
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    expect(session.isEstablished).toBe(true);

    session.sendMessage(response('after-the-reconnect'));
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['after-the-reconnect']);
    expect(phone.droppedFrames).toBe(0);
    expect(releases).toEqual([]);
    // The rekey interval is the only timer an established session keeps. A
    // hold timer left armed would make this one higher.
    expect(vi.getTimerCount()).toBe(timersWhileEstablished);

    vi.advanceTimersByTime(REKEY_HOLD_MAX_MS);
    expect(releases).toEqual([]);
    session.dispose();
  });

  // An empty hold emits no event, and a hold opened by the failing msg1 itself
  // can only hold what a re-entrant send adds before the throw. The reason is
  // pinned here through exactly that path.
  it("releases a hold the failing msg1 opened with reason 'send-failed', under the old keys the phone still has", () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    interceptDesktopSend(pipe, (frame) => {
      if (!isHandshakeFrame(frame)) return;
      session.sendMessage(response('held-while-msg1-sends'));
      throw new Error('relay refused msg1');
    });

    expect(() => session.probePresenceNow()).toThrow('relay refused msg1');
    expect(releases).toEqual([{ frames: 1, reason: 'send-failed' }]);

    // msg1 never left, so the phone never switched keys.
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['held-while-msg1-sends']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('does not stay in a hold whose msg1 never left: the next message goes out at once under the old keys', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    let refuseHandshakes = true;
    interceptDesktopSend(pipe, (frame) => {
      if (refuseHandshakes && isHandshakeFrame(frame)) throw new Error('relay refused msg1');
    });

    expect(() => session.probePresenceNow()).toThrow('relay refused msg1');
    refuseHandshakes = false;
    session.sendMessage(response('after-the-failed-msg1'));
    pipe.deliverToDevice();

    expect(phone.received).toEqual(['after-the-failed-msg1']);
    expect(phone.droppedFrames).toBe(0);
    expect(releases).toEqual([]);
    session.dispose();
  });

  it('keeps a hold open when a LATER msg1 fails to send, and the first msg1\'s reply still establishes the session and flushes under the new keys', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    let refuseHandshakes = false;
    interceptDesktopSend(pipe, (frame) => {
      if (refuseHandshakes && isHandshakeFrame(frame)) throw new Error('relay refused msg1');
    });

    // The rekey tick's msg1 leaves and opens the hold.
    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-1'));

    // A second msg1 (an unlock probe) is refused. The hold belongs to the first.
    refuseHandshakes = true;
    expect(() => session.probePresenceNow()).toThrow('relay refused msg1');
    refuseHandshakes = false;
    session.sendMessage(response('held-2'));
    expect(releases).toEqual([]);

    // The phone answers the first msg1 only. The refused initiation was
    // forgotten, so this reply is the last one outstanding and completes the
    // rekey right away, with no timer advance to rescue it.
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    expect(releases).toEqual([{ frames: 2, reason: 'established' }]);
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['held-1', 'held-2']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('does not count refused initiations toward the outstanding cap', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const desktopReceived: string[] = [];
    session.on('message', (message: BridgeMessage) => desktopReceived.push(message.type));
    let refuseHandshakes = true;
    interceptDesktopSend(pipe, (frame) => {
      if (refuseHandshakes && isHandshakeFrame(frame)) throw new Error('relay refused msg1');
    });

    // As many refusals as the cap allows initiations. Were each one kept, the
    // list would be full and nothing could be sent afterwards.
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(() => session.probePresenceNow()).toThrow('relay refused msg1');
    }
    refuseHandshakes = false;
    expect(session.probePresenceNow()).toBe(true);
    pipe.deliverToDevice();
    pipe.deliverToDesktop();

    session.sendMessage(response('after-the-refusals'));
    pipe.deliverToDevice();
    phone.sendHeartbeat();
    pipe.deliverToDesktop();
    expect(phone.received).toEqual(['after-the-refusals']);
    expect(phone.droppedFrames).toBe(0);
    expect(desktopReceived).toEqual(['heartbeat']);
    session.dispose();
  });

  it("releases a hold at once with reason 'read-failed' when a handshake frame no outstanding initiation can read arrives", () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    const handshakeFailures: unknown[] = [];
    session.on('handshakeFailed', (error: unknown) => handshakeFailures.push(error));
    // A phone that is away: msg1 goes unanswered and its keys stay where they were.
    phone.ignoreHandshakes = true;

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-1'));
    expect(releases).toEqual([]);

    // The relay is an adversary: this is not a reply to anything the desktop sent.
    pipe.device.send(wrapSessionFrame(SessionFrameKind.Handshake, new Uint8Array(48).fill(7)));
    pipe.deliverToDesktop();

    // No timer has advanced: the hold ended on the failed read, not the deadline.
    expect(handshakeFailures).toHaveLength(1);
    expect(releases).toEqual([{ frames: 1, reason: 'read-failed' }]);
    pipe.deliverToDevice();
    expect(phone.received).toEqual(['held-1']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it("releases a hold early with reason 'overflow' on the send that takes it to 8 MiB, before any deadline", () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    phone.ignoreHandshakes = true;

    // Each message encodes to a bit under the 1 MiB frame cap, so reaching
    // 8 MiB takes several of them. encodeMessage is deterministic for one message.
    const largeMessage: BridgeMessage = { type: 'capability-response', requestId: 'large', ok: true, payload: incompressibleText(750_000) };
    const encodedFrameBytes = encodeMessage(largeMessage).byteLength;
    const sendsToCrossLimit = Math.ceil(REKEY_HOLD_MAX_BYTES / encodedFrameBytes);
    expect(sendsToCrossLimit).toBeGreaterThan(1);

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    for (let sendNumber = 1; sendNumber <= sendsToCrossLimit; sendNumber++) {
      expect(session.sendMessage(largeMessage)).toBe(encodedFrameBytes);
      // Held, with nothing released, on every send that leaves the total under 8 MiB.
      if (sendNumber < sendsToCrossLimit) expect(releases).toEqual([]);
    }
    expect(releases).toEqual([{ frames: sendsToCrossLimit, reason: 'overflow' }]);

    // Released under the keys the session still holds, which an absent phone still has.
    pipe.deliverToDevice();
    expect(phone.received).toEqual(Array.from({ length: sendsToCrossLimit }, () => 'large'));
    expect(phone.droppedFrames).toBe(0);

    // The hold is closed: the next message is sent at once rather than held again.
    session.sendMessage(response('after-the-overflow'));
    pipe.deliverToDevice();
    expect(phone.received.at(-1)).toBe('after-the-overflow');
    vi.advanceTimersByTime(REKEY_HOLD_MAX_MS);
    expect(releases).toHaveLength(1);
    session.dispose();
  });

  // The flush of held frames is a burst of sends. The relay client closes a
  // socket that crosses its byte cap, and that close reaches the session as
  // 'reconnecting' from inside the send that caused it.
  it('does not announce an establishment that a re-entrant disconnect during the flush already undid', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    let establishedEvents = 0;
    session.on('established', () => {
      establishedEvents += 1;
    });
    let dropSocketOnApplicationSend = false;
    interceptDesktopSend(pipe, (frame) => {
      if (dropSocketOnApplicationSend && !isHandshakeFrame(frame)) pipe.setDesktopState('reconnecting');
    });

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    session.sendMessage(response('held-1'));
    pipe.deliverToDevice();
    dropSocketOnApplicationSend = true;
    pipe.deliverToDesktop();

    expect(releases).toEqual([{ frames: 1, reason: 'established' }]);
    expect(session.isEstablished).toBe(false);
    expect(establishedEvents).toBe(0);

    // The next 'connected' edge recovers normally, and only that one announces.
    dropSocketOnApplicationSend = false;
    pipe.setDesktopState('connected');
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    expect(session.isEstablished).toBe(true);
    expect(establishedEvents).toBe(1);
    session.sendMessage(response('after-the-reconnect'));
    pipe.deliverToDevice();
    expect(phone.received.at(-1)).toBe('after-the-reconnect');
    session.dispose();
  });
});

describe('BridgeSession initiation cap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends eight unanswered initiations and no more, and the replies to those eight keep both ends in step', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const desktopReceived: string[] = [];
    session.on('message', (message: BridgeMessage) => desktopReceived.push(message.type));
    let initiationsAtPhone = 0;
    pipe.device.onFrame((frame) => {
      if (isHandshakeFrame(frame)) initiationsAtPhone += 1;
    });

    // The phone's replies stay in the relay while the probes go out.
    const probeResults = Array.from({ length: 12 }, () => session.probePresenceNow());
    expect(probeResults).toEqual([...Array.from({ length: 8 }, () => true), ...Array.from({ length: 4 }, () => false)]);
    pipe.deliverToDevice();
    expect(initiationsAtPhone).toBe(8);

    pipe.deliverToDesktop();
    session.sendMessage(response('after-the-stall'));
    pipe.deliverToDevice();
    phone.sendHeartbeat();
    pipe.deliverToDesktop();

    expect(phone.droppedFrames).toBe(0);
    expect(phone.received).toEqual(['after-the-stall']);
    expect(desktopReceived).toEqual(['heartbeat']);
    session.dispose();
  });
});

describe('BridgeSession sendMessage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const overCapPayloads: Array<[string, () => string]> = [
    ['the JSON passes the 4 MiB pre-compression cap', () => 'a'.repeat(MAX_DECODED_LENGTH)],
    ['the compressed frame passes the 1 MiB frame cap', () => incompressibleText(Math.ceil(MAX_FRAME_LENGTH * 1.2))],
  ];

  it.each(overCapPayloads)('throws MessageEncodeError when %s, before sealing, so the next message still opens on the phone', (_label, makePayload) => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const overCap: BridgeMessage = { type: 'capability-response', requestId: 'over-cap', ok: true, payload: makePayload() };

    expect(() => session.sendMessage(overCap)).toThrow(MessageEncodeError);
    expect(() => session.sendMessage(overCap)).toThrow(MessageEncodeError);
    session.sendMessage(response('after-over-cap'));
    pipe.deliverToDevice();

    // A burned send-counter slot would make this frame fail to open.
    expect(phone.received).toEqual(['after-over-cap']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('throws MessageEncodeError for an over-cap message during a rekey without holding anything for it', () => {
    vi.useFakeTimers();
    const { session, phone, pipe } = establishedSession();
    const releases = collectRekeyHoldReleases(session);
    const overCap: BridgeMessage = { type: 'capability-response', requestId: 'over-cap', ok: true, payload: 'a'.repeat(MAX_DECODED_LENGTH) };

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    expect(() => session.sendMessage(overCap)).toThrow(MessageEncodeError);
    session.sendMessage(response('held-after-over-cap'));
    pipe.deliverToDevice();
    pipe.deliverToDesktop();
    pipe.deliverToDevice();

    expect(releases).toEqual([{ frames: 1, reason: 'established' }]);
    expect(phone.received).toEqual(['held-after-over-cap']);
    expect(phone.droppedFrames).toBe(0);
    session.dispose();
  });

  it('returns the length of the frame it handed to the transport, and the encoded length while a rekey holds it', () => {
    vi.useFakeTimers();
    const { session, pipe } = establishedSession();
    const applicationFrames: Uint8Array[] = [];
    interceptDesktopSend(pipe, (frame) => {
      if (!isHandshakeFrame(frame)) applicationFrames.push(frame);
    });
    const message = response('measured');
    const encodedBytes = encodeMessage(message).byteLength;

    const sentLength = session.sendMessage(message);
    expect(applicationFrames).toHaveLength(1);
    expect(sentLength).toBe(applicationFrames[0].byteLength);
    // The wire frame carries the session-frame tag and the secretstream tag and MAC on top.
    expect(sentLength).toBeGreaterThan(encodedBytes);

    vi.advanceTimersByTime(REHANDSHAKE_INTERVAL_MS);
    const heldLength = session.sendMessage(message);
    expect(applicationFrames).toHaveLength(1);
    expect(heldLength).toBe(encodedBytes);
    session.dispose();
  });
});

describe('BridgeSession transportBufferedBytes', () => {
  const baseTransport = (): Transport => createDelayedPipe().desktop;

  it("returns the transport's bufferedAmount, zero included", () => {
    expect(sessionOverTransport(Object.assign(baseTransport(), { bufferedAmount: 1234 })).transportBufferedBytes).toBe(1234);
    expect(sessionOverTransport(Object.assign(baseTransport(), { bufferedAmount: 0 })).transportBufferedBytes).toBe(0);
  });

  it('returns null when the transport has no bufferedAmount, or one that is not a number', () => {
    expect(sessionOverTransport(baseTransport()).transportBufferedBytes).toBeNull();
    expect(sessionOverTransport(Object.assign(baseTransport(), { bufferedAmount: '1234' })).transportBufferedBytes).toBeNull();
    expect(sessionOverTransport(Object.assign(baseTransport(), { bufferedAmount: undefined })).transportBufferedBytes).toBeNull();
  });
});
