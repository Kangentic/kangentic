import { EventEmitter } from 'node:events';
import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';

/**
 * The desktop's outbound relay connection: dials OUT to a blind WebSocket
 * relay (self-hostable or Kangentic's hosted one) and reconnects with
 * capped backoff. The relay forwards only opaque ciphertext frames - it
 * authenticates nothing and reads nothing, since every frame sent through
 * it is already Noise-encrypted (or, during pairing, is itself a Noise
 * handshake message).
 *
 * Node 24 exposes a global `WebSocket` (browser-compatible API), so this
 * has no runtime dependency beyond that - `ws` is a devDependency used
 * only by the in-repo relay test double (tests/unit/mobile-bridge/).
 *
 * Wire contract with the relay (defined here because the relay SERVER is
 * a separate task/repo; this is the assumed contract until that lands):
 * connect to `${relayUrl}?slot=<hex-encoded-slot-id>`. The slot id is the
 * pairing token during pairing (so the relay can rendezvous the phone and
 * desktop connections that present the SAME token) or a value derived
 * from the paired device's static key for an ongoing session. The relay
 * never sees the slot id's cryptographic meaning, only its bytes.
 *
 * Accountless: no Kangentic account/entitlement coupling here. Any such
 * gate lives only on the hosted relay's own connection-acceptance policy,
 * per the open-core design - this client behaves identically against a
 * self-hosted or hosted relay.
 */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export interface RelayClientOptions {
  relayUrl: string;
  slotId: string;
  /** Per-session byte cap (defense-in-depth against a runaway loop on either end). */
  maxBytesPerSession?: number;
}

export class RelayClient implements Transport {
  private readonly relayUrl: string;
  private readonly slotId: string;
  private readonly maxBytesPerSession: number;
  private readonly emitter = new EventEmitter();

  private socket: WebSocket | null = null;
  private currentState: TransportState = 'idle';
  private reconnectBackoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bytesSentThisSession = 0;
  private explicitlyClosed = false;
  /** Reject of the in-flight dial() promise, if a connect() is still pending. */
  private pendingDialReject: ((error: Error) => void) | null = null;

  constructor(options: RelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.slotId = options.slotId;
    this.maxBytesPerSession = options.maxBytesPerSession ?? 256 * 1024 * 1024;
  }

  get state(): TransportState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    return this.dial();
  }

  private dial(): Promise<void> {
    this.setState(this.currentState === 'idle' ? 'connecting' : 'reconnecting');

    let url: URL;
    try {
      url = new URL(this.relayUrl);
    } catch (error) {
      // A malformed relayUrl is a configuration bug, not a transient network
      // hiccup - src/shared/relay.ts's resolveRelayUrl() guarantees a valid
      // URL reaches every real caller, so this should be unreachable in
      // practice. Fail the connect() immediately rather than entering the
      // 500ms->30s backoff loop against a URL that can never parse.
      this.setState('closed');
      return Promise.reject(error instanceof Error ? error : new Error(`Invalid relay URL: ${String(error)}`));
    }
    url.searchParams.set('slot', this.slotId);

    return new Promise<void>((resolve, reject) => {
      // Wrap resolve/reject so the pendingDialReject pointer is cleared once
      // this dial settles by any path. close() consults that pointer to
      // settle a dial still in flight (see close()).
      const settle = () => {
        this.pendingDialReject = null;
      };
      const resolveOnce = () => {
        settle();
        resolve();
      };
      const rejectOnce = (error: Error) => {
        settle();
        reject(error);
      };
      this.pendingDialReject = rejectOnce;

      let socket: WebSocket;
      try {
        socket = new WebSocket(url.href);
      } catch (error) {
        this.scheduleReconnect();
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectBackoffMs = INITIAL_BACKOFF_MS;
        this.bytesSentThisSession = 0;
        this.setState('connected');
        resolveOnce();
      };

      socket.onmessage = (event: MessageEvent) => {
        const frame = toUint8Array(event.data);
        if (frame) this.emitter.emit('frame', frame);
      };

      socket.onerror = () => {
        // The corresponding onclose fires right after in every browser-compatible
        // WebSocket implementation; reconnect logic lives there, not here.
      };

      socket.onclose = () => {
        this.socket = null;
        if (this.explicitlyClosed) {
          this.setState('closed');
          // close() already settled any pending dial synchronously; this is a
          // no-op if so. Guard against a socket closed via close() while still
          // connecting so the awaiter is never left hanging.
          rejectOnce(new Error('Relay connection closed before it opened'));
          return;
        }
        this.scheduleReconnect();
        // Only reject the in-flight connect() promise if we never reached 'open'.
        if (this.currentState !== 'connected') rejectOnce(new Error('Relay connection closed before it opened'));
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed) return;
    this.setState('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch(() => {
        // dial() already scheduled the next attempt on failure.
      });
    }, this.reconnectBackoffMs);
    this.reconnectTimer.unref?.();
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  send(frame: Uint8Array): void {
    if (!this.socket || this.currentState !== 'connected') {
      throw new Error('RelayClient.send() called while not connected');
    }
    if (this.bytesSentThisSession + frame.byteLength > this.maxBytesPerSession) {
      throw new Error('RelayClient per-session byte cap exceeded');
    }
    this.bytesSentThisSession += frame.byteLength;
    // Send the underlying bytes as a plain ArrayBuffer rather than the
    // Uint8Array view directly: lib.dom's WebSocket.send() expects an
    // ArrayBufferView<ArrayBuffer>, but a Uint8Array's generic buffer type
    // is ArrayBufferLike (which also covers SharedArrayBuffer), so passing
    // the view itself does not typecheck.
    this.socket.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // best-effort
      }
      this.socket = null;
    }
    this.setState('closed');
    // If close() raced an in-flight connect() before it opened, settle that
    // pending dial() promise now so its awaiter (e.g. startPairing) does not
    // hang forever. A socket closed while still CONNECTING may never deliver
    // an onclose that settles the promise, so we settle it here directly.
    if (this.pendingDialReject) {
      const rejectPending = this.pendingDialReject;
      this.pendingDialReject = null;
      rejectPending(new Error('Relay connection closed before it opened'));
    }
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    this.emitter.on('frame', listener);
    return () => this.emitter.off('frame', listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    this.emitter.on('state', listener);
    return () => this.emitter.off('state', listener);
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emitter.emit('state', state);
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
