/**
 * One side of the link between this computer and a host, for #913. The same class runs in
 * the helper and in the link. It outlives any one connection: a connection is a byte stream
 * handed to `attach`, and when it dies the endpoint keeps what it sent, waits for the next
 * one, and the two sides pick up where each other stopped.
 *
 * - Everything sent with `send` is a sequenced frame (`frame-codec.ts`) kept until the peer
 *   acknowledges it. A new connection starts with a hello whose offset is the next byte the
 *   sender expects, so the peer replays exactly what was lost: no gap and no duplicate.
 * - A peer that cannot replay (it dropped old frames at its retention limit, or it restarted
 *   and remembers nothing) sends a `reset` and tells us what range is gone. The layer above
 *   answers with a snapshot, which replaces the lost events (`onGap`).
 * - Damage ends the connection and never reaches a handler. A decoder error, a silent peer, a
 *   send queue that stopped draining and a refused or mismatched peer all detach, and the
 *   owner reconnects.
 *
 * The endpoint owns no transport. It is given a duplex stream per connection, so the link
 * can hand it an `ssh` child's pipes and a unit test an in-memory pair.
 */

import type { Duplex } from 'node:stream';
import { FrameDecoder, FrameError, FrameKind, encodeFrame, type DecodedFrame } from './frame-codec';

export interface PeerHello {
  protocol: { min: number; max: number };
  role: 'link' | 'helper';
  /** Whatever the owner wants the peer to know about this side, such as an install id. */
  identity: Record<string, string | number>;
}

export interface GapInfo {
  /** `incoming`: bytes we never received. `outgoing`: bytes the peer asked for and we could not replay. */
  direction: 'incoming' | 'outgoing';
  lostFrom: number;
  lostTo: number;
  cause: 'retention' | 'peer-ahead';
}

export interface ResumeEndpointHandlers {
  onMessage(json: unknown, raw: Buffer): void;
  onAttached(info: { protocolVersion: number; peer: PeerHello }): void;
  /** A connection ended. `wasActive` is false for one that never got past its handshake. */
  onDetached(reason: string, info: { wasActive: boolean }): void;
  onGap(info: GapInfo): void;
  /** A reason to refuse this peer. It is told, in words, and the connection ends. */
  vetPeer?(peer: PeerHello): string | null;
  /** A handler threw. Reported here so one bad message cannot take the stream down. */
  onError?(error: unknown): void;
}

export interface ResumeEndpointOptions {
  role: PeerHello['role'];
  /** The newest protocol version this side speaks and the oldest it still accepts. */
  protocol: { min: number; max: number };
  identity: Record<string, string | number>;
  /** Sent frames kept for a replay. Past this, the oldest go and a resume past them becomes a gap. */
  retainLimitBytes?: number;
  /** Send an acknowledgement after this many received bytes. */
  ackEveryBytes?: number;
  /** An acknowledgement goes out at least this often while any is owed. */
  ackIntervalMs?: number;
  /** A heartbeat goes out after this long with nothing sent. */
  heartbeatMs?: number;
  /** A connection with no frame from the peer for this long is dead. */
  deadAfterMs?: number;
  /** A connection whose unsent queue passes this is stuck behind a dead network: end it. */
  maxWritableBytes?: number;
}

const DEFAULTS = {
  retainLimitBytes: 8 * 1024 * 1024,
  ackEveryBytes: 64 * 1024,
  ackIntervalMs: 500,
  heartbeatMs: 5_000,
  deadAfterMs: 20_000,
  // Above the retention limit with room to spare: a replay writes every retained frame at once, and
  // a cap below what it may replay would end the very connection it is replaying onto, every time.
  maxWritableBytes: 16 * 1024 * 1024,
} as const;

/** How long a refused connection gets to carry the reason before it is cut. */
const REFUSAL_LINGER_MS = 1_000;

interface RetainedFrame {
  offset: number;
  frame: Buffer;
}

interface Connection {
  stream: Duplex;
  decoder: FrameDecoder;
  ready: boolean;
  protocolVersion: number;
  lastReceivedAt: number;
  lastSentAt: number;
  receivedSinceAck: number;
  timer: ReturnType<typeof setInterval>;
}

function parseHello(json: unknown): PeerHello | null {
  if (typeof json !== 'object' || json === null) return null;
  const candidate = json as Partial<PeerHello>;
  const protocol = candidate.protocol;
  if (!protocol || !Number.isInteger(protocol.min) || !Number.isInteger(protocol.max)) return null;
  if (candidate.role !== 'link' && candidate.role !== 'helper') return null;
  const identity = typeof candidate.identity === 'object' && candidate.identity !== null ? candidate.identity : {};
  return { protocol: { min: protocol.min, max: protocol.max }, role: candidate.role, identity };
}

export class ResumeEndpoint {
  private readonly options: Required<ResumeEndpointOptions>;
  /** The connection frames flow over: its handshake passed and it replaced any earlier one. */
  private active: Connection | null = null;
  /** A connection still shaking hands. It replaces the active one only once its peer is vetted, so a
   *  stranger that gets refused never knocks the owner off. */
  private pending: Connection | null = null;
  private sendOffset = 0;
  private receiveOffset = 0;
  private retained: RetainedFrame[] = [];
  private retainedByteCount = 0;

  constructor(private readonly handlers: ResumeEndpointHandlers, options: ResumeEndpointOptions) {
    this.options = { ...DEFAULTS, ...options };
  }

  get connected(): boolean {
    return this.active !== null;
  }

  get stats(): { sendOffset: number; receiveOffset: number; retainedBytes: number; retainedFrames: number } {
    return {
      sendOffset: this.sendOffset,
      receiveOffset: this.receiveOffset,
      retainedBytes: this.retainedByteCount,
      retainedFrames: this.retained.length,
    };
  }

  /** Send a message in order. It is kept until acknowledged and written at once when a connection is up. */
  send(message: unknown, raw?: Uint8Array): void {
    const frame = encodeFrame({ kind: FrameKind.message, offset: this.sendOffset, json: message, raw });
    this.retained.push({ offset: this.sendOffset, frame });
    this.retainedByteCount += frame.length;
    this.sendOffset += frame.length;
    while (this.retainedByteCount > this.options.retainLimitBytes && this.retained.length > 1) {
      const dropped = this.retained.shift() as RetainedFrame;
      this.retainedByteCount -= dropped.frame.length;
    }
    if (this.active) this.write(this.active, frame);
  }

  /**
   * Start talking over a new connection. It replaces the active one when its handshake
   * passes, not before, and a connection still shaking hands is replaced by this one.
   */
  attach(stream: Duplex): void {
    if (this.pending) this.drop(this.pending, 'replaced by a newer connection attempt');
    const connection: Connection = {
      stream,
      decoder: new FrameDecoder({ expectedOffset: this.receiveOffset }),
      ready: false,
      protocolVersion: 0,
      lastReceivedAt: Date.now(),
      lastSentAt: Date.now(),
      receivedSinceAck: 0,
      timer: setInterval(() => this.tick(connection), Math.min(this.options.ackIntervalMs, this.options.heartbeatMs)),
    };
    connection.timer.unref?.();
    this.pending = connection;
    stream.on('data', (chunk: Buffer) => this.handleData(connection, chunk));
    stream.on('end', () => this.drop(connection, 'the peer ended the connection'));
    stream.on('close', () => this.drop(connection, 'the connection closed'));
    stream.on('error', (error: Error) => this.drop(connection, `the connection failed: ${error.message}`));
    this.write(connection, encodeFrame({
      kind: FrameKind.hello,
      offset: this.receiveOffset,
      json: { protocol: this.options.protocol, role: this.options.role, identity: this.options.identity } satisfies PeerHello,
    }));
  }

  /**
   * Forget every frame kept for a replay. The stream's offset stays, so a peer that asks to
   * resume is told, with a reset, that what it missed is gone. For a peer that is a different
   * process from the one the kept frames were meant for.
   */
  discardRetained(): void {
    this.retained = [];
    this.retainedByteCount = 0;
  }

  /** End every connection. What was sent stays kept for the next one. */
  detach(reason = 'detached'): void {
    if (this.pending) this.drop(this.pending, reason);
    if (this.active) this.drop(this.active, reason);
  }

  private isLive(connection: Connection): boolean {
    return this.active === connection || this.pending === connection;
  }

  private write(connection: Connection, frame: Buffer): void {
    connection.lastSentAt = Date.now();
    connection.stream.write(frame);
    if (connection.stream.writableLength > this.options.maxWritableBytes) {
      this.drop(connection, 'the send queue stopped draining');
    }
  }

  private handleData(connection: Connection, chunk: Buffer): void {
    if (!this.isLive(connection)) return;
    let frames: DecodedFrame[];
    try {
      frames = connection.decoder.push(chunk);
    } catch (error) {
      const detail = error instanceof FrameError ? `${error.code}: ${error.message}` : String(error);
      this.drop(connection, `the stream is damaged (${detail})`);
      return;
    }
    for (const frame of frames) {
      if (!this.isLive(connection)) return;
      connection.lastReceivedAt = Date.now();
      this.handleFrame(connection, frame);
    }
  }

  private handleFrame(connection: Connection, frame: DecodedFrame): void {
    if (!connection.ready) {
      if (frame.kind !== FrameKind.hello) {
        this.drop(connection, 'the peer did not start with a hello');
        return;
      }
      this.completeHandshake(connection, frame);
      return;
    }
    switch (frame.kind) {
      case FrameKind.message:
        // The peer replays from the offset this side's hello named, and the old connection can deliver
        // those same frames until the new handshake drops it. A frame already taken is not taken twice.
        if (frame.offset + frame.byteLength <= this.receiveOffset) return;
        this.receiveOffset = frame.offset + frame.byteLength;
        connection.receivedSinceAck += frame.byteLength;
        try {
          this.handlers.onMessage(frame.json, frame.raw);
        } catch (error) {
          this.handlers.onError?.(error);
        }
        if (this.isLive(connection) && connection.receivedSinceAck >= this.options.ackEveryBytes) this.sendAck(connection);
        return;
      case FrameKind.ack:
        this.acknowledge(connection, frame.offset);
        return;
      case FrameKind.reset: {
        const lostFrom = this.receiveOffset;
        this.receiveOffset = frame.offset;
        const cause = (frame.json as { cause?: string } | undefined)?.cause === 'peer-ahead' ? 'peer-ahead' : 'retention';
        this.safely(() => this.handlers.onGap({ direction: 'incoming', lostFrom, lostTo: frame.offset, cause }));
        return;
      }
      case FrameKind.close:
        this.drop(connection, `the peer hung up: ${(frame.json as { reason?: string } | undefined)?.reason ?? 'no reason given'}`);
        return;
      default:
        // A heartbeat, a second hello, or a kind from a newer peer: nothing to do.
    }
  }

  private completeHandshake(connection: Connection, frame: DecodedFrame): void {
    const peer = parseHello(frame.json);
    if (!peer) {
      this.refuse(connection, 'the peer sent a malformed hello');
      return;
    }
    const version = Math.min(this.options.protocol.max, peer.protocol.max);
    if (version < Math.max(this.options.protocol.min, peer.protocol.min)) {
      this.refuse(connection, `no protocol version in common (this side ${this.options.protocol.min} to ${this.options.protocol.max}, the peer ${peer.protocol.min} to ${peer.protocol.max})`);
      return;
    }
    let refusal: string | null;
    try {
      refusal = this.handlers.vetPeer?.(peer) ?? null;
    } catch (error) {
      // A check that cannot answer is a refusal, never an accepted stranger.
      this.handlers.onError?.(error);
      refusal = 'this side could not check the peer';
    }
    if (refusal) {
      this.refuse(connection, refusal);
      return;
    }
    // The peer is accepted: it takes over from the connection that was active, whatever that one's state.
    // Under a dropped network the old connection stays open with no one reading it.
    if (this.active) this.drop(this.active, 'replaced by a newer connection');
    if (!this.isLive(connection)) return;
    this.pending = null;
    this.active = connection;
    connection.ready = true;
    connection.protocolVersion = version;
    if (!this.replay(connection, frame.offset)) return;
    this.safely(() => this.handlers.onAttached({ protocolVersion: version, peer }));
  }

  /** A handler that throws is reported, never thrown out of the stream's data listener. */
  private safely(call: () => void): void {
    try {
      call();
    } catch (error) {
      this.handlers.onError?.(error);
    }
  }

  /** Send the peer what it has not got, from the offset its hello named. False when the connection was dropped. */
  private replay(connection: Connection, peerResumeFrom: number): boolean {
    if (peerResumeFrom > this.sendOffset) {
      // The peer remembers bytes this side never produced: this side restarted. Tell it where the stream starts
      // now, which is the first frame this side still holds. A process that queued a request before it connected
      // (the app, right after it dials) holds it from offset 0, and neither trimming those frames against the
      // peer's offset (which belongs to the stream before the restart) nor a reset to the END of the stream may
      // drop it: the request would never be answered. What is held is sent after the reset.
      const heldFrom = this.retained.length > 0 ? this.retained[0].offset : this.sendOffset;
      this.write(connection, encodeFrame({ kind: FrameKind.reset, offset: heldFrom, json: { cause: 'peer-ahead' } }));
      this.safely(() => this.handlers.onGap({ direction: 'outgoing', lostFrom: heldFrom, lostTo: peerResumeFrom, cause: 'peer-ahead' }));
      if (!this.isLive(connection)) return false;
      for (const entry of this.retained) {
        this.write(connection, entry.frame);
        if (!this.isLive(connection)) return false;
      }
      return true;
    }
    this.trimThrough(peerResumeFrom);
    const retainedStart = this.retained.length > 0 ? this.retained[0].offset : this.sendOffset;
    if (peerResumeFrom < retainedStart) {
      this.write(connection, encodeFrame({ kind: FrameKind.reset, offset: retainedStart, json: { cause: 'retention' } }));
      this.safely(() => this.handlers.onGap({ direction: 'outgoing', lostFrom: peerResumeFrom, lostTo: retainedStart, cause: 'retention' }));
      if (!this.isLive(connection)) return false;
    } else if (peerResumeFrom !== retainedStart) {
      this.refuse(connection, `the peer asked to resume at ${peerResumeFrom}, which is inside a frame`);
      return false;
    }
    for (const entry of this.retained) {
      this.write(connection, entry.frame);
      if (!this.isLive(connection)) return false;
    }
    return true;
  }

  private acknowledge(connection: Connection, offset: number): void {
    if (offset > this.sendOffset) {
      this.refuse(connection, `the peer acknowledged ${offset}, past what was sent (${this.sendOffset})`);
      return;
    }
    this.trimThrough(offset);
  }

  private trimThrough(offset: number): void {
    while (this.retained.length > 0) {
      const first = this.retained[0];
      if (first.offset + first.frame.length > offset) break;
      this.retained.shift();
      this.retainedByteCount -= first.frame.length;
    }
  }

  private sendAck(connection: Connection): void {
    connection.receivedSinceAck = 0;
    this.write(connection, encodeFrame({ kind: FrameKind.ack, offset: this.receiveOffset }));
  }

  private tick(connection: Connection): void {
    if (!this.isLive(connection)) return;
    const now = Date.now();
    if (now - connection.lastReceivedAt > this.options.deadAfterMs) {
      this.drop(connection, `no frame from the peer for ${Math.round((now - connection.lastReceivedAt) / 1000)} s`);
      return;
    }
    if (!connection.ready) return;
    if (connection.receivedSinceAck > 0) this.sendAck(connection);
    if (this.isLive(connection) && now - connection.lastSentAt >= this.options.heartbeatMs) {
      this.write(connection, encodeFrame({ kind: FrameKind.heartbeat, offset: 0 }));
    }
  }

  /** Tell the peer why, then end the connection. The reason reaches both sides' `onDetached`. */
  private refuse(connection: Connection, reason: string): void {
    if (!this.isLive(connection)) return;
    connection.stream.write(encodeFrame({ kind: FrameKind.close, offset: 0, json: { reason } }));
    this.drop(connection, reason, true);
  }

  private drop(connection: Connection, reason: string, lingerForPeer = false): void {
    if (!this.isLive(connection)) return;
    const wasActive = this.active === connection;
    if (wasActive) this.active = null;
    else this.pending = null;
    clearInterval(connection.timer);
    if (lingerForPeer) {
      connection.stream.end();
      setTimeout(() => connection.stream.destroy(), REFUSAL_LINGER_MS).unref?.();
    } else {
      connection.stream.destroy();
    }
    this.safely(() => this.handlers.onDetached(reason, { wasActive }));
  }
}
