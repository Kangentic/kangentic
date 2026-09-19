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
 * Wire contract with the relay (the relay SERVER lives in a separate repo):
 * connect to `${relayUrl}?slot=<hex-encoded-slot-id>&role=desktop`, where the
 * slot id is derived - `derivePairingSlotId(token)` during pairing, and
 * `deriveSessionSlotId(desktopKey, phoneKey)` for an ongoing session - so
 * the relay can rendezvous the two connections presenting the SAME value.
 * The relay never sees the slot id's cryptographic meaning, only its bytes.
 * `role` is a metrics hint the relay attributes its waiting-peer gauge by;
 * it is authenticated by nothing, can never cause a rejection, and nothing
 * in pairing or routing reads it (kangentic-relay's guards/peerRole.ts).
 *
 * Both slots are ROUTING LABELS, never key material. That is a deliberate
 * property to preserve: the slot rides in a URL query string, which is the
 * most-logged part of a request, so anything secret placed here is published
 * to every hop that can read a request URI. The pairing slot used to be the
 * pairing token verbatim, which meant dialing published the Noise PSK.
 *
 * Accountless: no Kangentic account/entitlement coupling here. Any such
 * gate lives only on the hosted relay's own connection-acceptance policy,
 * per the open-core design - this client behaves identically against a
 * self-hosted or hosted relay.
 *
 * Liveness is NOT this class's job. A socket can read OPEN and carry nothing
 * indefinitely: a router restart leaves the desktop holding an ESTABLISHED
 * socket the relay reaped minutes ago, and the OS never reports it (measured
 * on 2026-09-18: four sockets sat that way for 31 minutes). Only the
 * application layer can tell, so BridgeSession's presence budget is the
 * verdict and `redialNow({ force })` is how it acts on it. What this class
 * does own is the one state nothing above it can see: a dial that never
 * opens, never errors, and never closes, which the dial watchdog bounds.
 */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * How long a dial may sit without reaching `onopen`, `onerror`, or `onclose`
 * before it is abandoned and the backoff ladder takes over. undici's own
 * connector bounds TCP and TLS at 10 s; this covers a black-holed upgrade
 * reply, the only way a transport can sit in 'connecting' for minutes. Every
 * presence path in BridgeSession skips a non-connected transport, so nothing
 * above this class could ever rescue such a dial.
 */
const DIAL_TIMEOUT_MS = 30_000;

/**
 * kangentic-relay's CLOSE_CODE.PARK_TIMEOUT: a connection that stayed unpaired
 * past the relay's park timeout (60 s on the hosted relay). For a roster
 * device whose phone is away this fires once a minute forever, so it is the
 * one close that logs at `log` level; every other code is a diagnostic edge
 * and logs at `warn`, which log-mirror.ts persists on every build.
 */
const RELAY_CLOSE_CODE_PARK_TIMEOUT = 4408;

export interface RelayClientOptions {
  relayUrl: string;
  slotId: string;
  /** Per-session byte cap (defense-in-depth against a runaway loop on either end). */
  maxBytesPerSession?: number;
  /**
   * Short tag for this client's log lines: a truncated device id for a roster
   * session, 'pairing' for the ceremony. Never the slot id, which is the most
   * logged part of a URL already and must not gain a second home.
   */
  logLabel?: string;
}

export interface RedialOptions {
  /**
   * Abandon a socket that exists, open or mid-dial, and dial afresh. For a
   * caller that has PROVEN the socket dead: BridgeSession's spent presence
   * budget, which wrote two initiations into it and got nothing back. A
   * socket can read open and carry nothing indefinitely (a network stall the
   * OS never reports), and only the application layer can tell.
   */
  force?: boolean;
  /** Why the caller is redialing, for the log line. */
  reason?: string;
}

/**
 * A Transport that can be told to abandon its reconnect backoff and dial at
 * once. Deliberately an extension local to the desktop rather than a member
 * of the protocol package's Transport, mirroring the phone's own
 * RedialableTransport (kangentic-mobile's relayTransport.ts): every existing
 * test double stays a plain Transport that the guard below rejects, and no
 * cross-repo protocol release rides on a desktop-only fix.
 */
export interface RedialableTransport extends Transport {
  redialNow(options?: RedialOptions): void;
}

export function isRedialableTransport(transport: Transport): transport is RedialableTransport {
  return typeof (transport as Partial<RedialableTransport>).redialNow === 'function';
}

export class RelayClient implements RedialableTransport {
  private readonly relayUrl: string;
  private readonly slotId: string;
  private readonly maxBytesPerSession: number;
  private readonly logPrefix: string;
  private readonly emitter = new EventEmitter();

  private socket: WebSocket | null = null;
  private currentState: TransportState = 'idle';
  private reconnectBackoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dialWatchdog: ReturnType<typeof setTimeout> | null = null;
  private bytesSentThisSession = 0;
  private explicitlyClosed = false;
  /** Reject of the in-flight dial() promise, if a connect() is still pending. */
  private pendingDialReject: ((error: Error) => void) | null = null;
  /** When the current socket opened, for the "connected for N s" part of a close line. */
  private connectedAtMs = 0;
  /**
   * The last `onerror` message on the current socket. `onerror` carries the
   * dial error (ECONNREFUSED, a TLS failure) and `onclose` only ever carries
   * 1006 for it, so the two are joined into one line at close time rather
   * than logged as two.
   */
  private pendingErrorMessage: string | null = null;

  constructor(options: RelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.slotId = options.slotId;
    this.maxBytesPerSession = options.maxBytesPerSession ?? 256 * 1024 * 1024;
    this.logPrefix = `[mobile-bridge/relay-client ${options.logLabel ?? 'relay'}]`;
  }

  get state(): TransportState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    return this.dial();
  }

  /**
   * Abandon the reconnect backoff and dial now. Without `force` this only
   * rescues a transport sitting in backoff: `this.socket` is assigned right
   * after construction and nulled only by `onclose`, `close()`, and
   * `abandonSocket()`, so non-null means exactly "a dial is in flight or the
   * socket is open", and a second dial on top of it is the two-live-sockets
   * hazard (the loser's onclose nulls the winner). Every production caller
   * today passes `force` (BridgeSession has proven its socket dead before it
   * gets here); the non-forced branch is the kick a caller with only a hint
   * would use, and the unit test pins it. With `force` the existing socket is
   * abandoned first, handlers detached, so its late close can neither null
   * the socket this dial installs nor arm a reconnect on top of it. Either
   * way the backoff ladder restarts at the floor.
   */
  redialNow(options: RedialOptions = {}): void {
    if (this.explicitlyClosed || this.currentState === 'idle' || this.currentState === 'closed') return;
    const reason = options.reason ?? 'unspecified';
    this.reconnectBackoffMs = INITIAL_BACKOFF_MS;
    if (this.socket !== null) {
      if (!options.force) {
        console.log(`${this.logPrefix} redial kick (${reason}) skipped: a dial is in flight or the socket is open`);
        return;
      }
      console.warn(`${this.logPrefix} forced redial (${reason}) from ${this.currentState}`);
      this.abandonSocket(new Error('Relay connection abandoned by a forced redial'));
    } else {
      console.log(`${this.logPrefix} redial kick (${reason}) from ${this.currentState}: dialing now`);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dial().catch(() => {
      // dial() already scheduled the next attempt on failure.
    });
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
    url.searchParams.set('role', 'desktop');

    return new Promise<void>((resolve, reject) => {
      // Wrap resolve/reject so the pendingDialReject pointer is cleared once
      // this dial settles by any path. close() consults that pointer to
      // settle a dial still in flight (see close()). Identity-checked: a
      // listener that reacts to this dial's own 'reconnecting' notification
      // by calling redialNow() installs the NEXT dial's rejecter before this
      // closure runs, and an unconditional null here would orphan it.
      const settle = () => {
        if (this.pendingDialReject === rejectOnce) this.pendingDialReject = null;
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
        const delayMs = this.scheduleReconnect();
        // A constructor error is the one message that can quote the dial URL,
        // slot and all (undici's never does; a browser-shaped one may), and
        // the slot must not gain a second home in the log.
        const detail = (error instanceof Error ? error.message : String(error)).split(this.slotId).join('<slot>');
        console.warn(`${this.logPrefix} dial failed: ${detail}; redial in ${delayMs} ms`);
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.pendingErrorMessage = null;
      const dialStartedAtMs = Date.now();
      this.armDialWatchdog(socket);

      socket.onopen = () => {
        this.clearDialWatchdog();
        this.reconnectBackoffMs = INITIAL_BACKOFF_MS;
        this.bytesSentThisSession = 0;
        this.connectedAtMs = Date.now();
        console.log(`${this.logPrefix} connected after ${this.connectedAtMs - dialStartedAtMs} ms`);
        this.setState('connected');
        resolveOnce();
      };

      socket.onmessage = (event: MessageEvent) => {
        const frame = toUint8Array(event.data);
        if (frame) this.emitter.emit('frame', frame);
      };

      socket.onerror = (event: Event) => {
        // The corresponding onclose fires right after in every browser-compatible
        // WebSocket implementation; reconnect logic lives there, not here. Only
        // the error's text is kept, for the close line.
        this.pendingErrorMessage = describeErrorEvent(event);
      };

      socket.onclose = (event: CloseEvent) => {
        this.clearDialWatchdog();
        this.socket = null;
        if (this.explicitlyClosed) {
          this.setState('closed');
          // close() already settled any pending dial synchronously; this is a
          // no-op if so. Guard against a socket closed via close() while still
          // connecting so the awaiter is never left hanging.
          rejectOnce(new Error('Relay connection closed before it opened'));
          return;
        }
        const wasConnected = this.currentState === 'connected';
        const delayMs = this.scheduleReconnect();
        this.logClose(event, wasConnected, delayMs);
        // Only reject the in-flight connect() promise if we never reached 'open'.
        if (!wasConnected) rejectOnce(new Error('Relay connection closed before it opened'));
      };
    });
  }

  /**
   * One line per close, split by what the code says. The relay's park timeout
   * (4408) is the routine once-a-minute churn of a slot whose phone is away
   * and stays at `log`; everything else is the signal: 1006 is a keepalive
   * `terminate()` or a dead TCP peer, 4000 the phone's half leaving, 4409 a
   * third peer on the slot, 1001 the relay draining. A dial that never opened
   * folds the `onerror` text in, since its close code is always 1006.
   */
  private logClose(event: CloseEvent, wasConnected: boolean, delayMs: number): void {
    if (!wasConnected) {
      const detail = this.pendingErrorMessage ?? `close code ${event.code}`;
      console.warn(`${this.logPrefix} dial failed: ${detail}; redial in ${delayMs} ms`);
      return;
    }
    const connectedForSeconds = Math.round((Date.now() - this.connectedAtMs) / 1000);
    if (event.code === RELAY_CLOSE_CODE_PARK_TIMEOUT) {
      console.log(`${this.logPrefix} parked slot timed out (code ${event.code}) after ${connectedForSeconds} s; redial in ${delayMs} ms`);
      return;
    }
    console.warn(
      `${this.logPrefix} closed: code=${event.code} reason="${event.reason}" clean=${event.wasClean} after ${connectedForSeconds} s connected; redial in ${delayMs} ms`,
    );
  }

  /**
   * Arms the next dial and returns the delay it armed. The timer is armed
   * BEFORE the 'reconnecting' notification: a listener that reacts by calling
   * redialNow() or close() then clears an armed timer instead of racing one
   * that has not been created yet, which is what keeps a re-entrant kick from
   * ending up with two live sockets.
   */
  private scheduleReconnect(): number {
    if (this.explicitlyClosed) return 0;
    const delayMs = this.reconnectBackoffMs;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch(() => {
        // dial() already scheduled the next attempt on failure.
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    this.setState('reconnecting');
    return delayMs;
  }

  /**
   * Bounds a dial that reaches none of its handlers. Identity-checked against
   * the socket it was armed for, so a watchdog left over from a dial that was
   * abandoned or superseded can never tear down a healthy successor.
   */
  private armDialWatchdog(socket: WebSocket): void {
    this.clearDialWatchdog();
    this.dialWatchdog = setTimeout(() => {
      this.dialWatchdog = null;
      if (this.socket !== socket) return;
      this.abandonSocket(new Error(`Relay dial timed out after ${DIAL_TIMEOUT_MS} ms`));
      const delayMs = this.scheduleReconnect();
      console.warn(`${this.logPrefix} dial timed out after ${DIAL_TIMEOUT_MS / 1000} s; redial in ${delayMs} ms`);
    }, DIAL_TIMEOUT_MS);
    this.dialWatchdog.unref?.();
  }

  private clearDialWatchdog(): void {
    if (!this.dialWatchdog) return;
    clearTimeout(this.dialWatchdog);
    this.dialWatchdog = null;
  }

  /**
   * Drops the current socket without letting it schedule anything: the
   * handlers come off FIRST, so the abandoned socket's own late onclose can
   * neither null the socket a forced dial is about to install nor arm a
   * reconnect on top of it. Its dial promise, if still pending, is rejected
   * the way close() rejects one. The close itself is best-effort and never
   * awaited: on a dead TCP peer the close frame sits in the kernel's send
   * buffer until the retransmit timeout, and with the handlers gone the
   * lingering socket is inert.
   */
  private abandonSocket(rejection: Error): void {
    const abandoned = this.socket;
    if (!abandoned) return;
    this.clearDialWatchdog();
    abandoned.onopen = null;
    abandoned.onmessage = null;
    abandoned.onerror = null;
    abandoned.onclose = null;
    try {
      abandoned.close();
    } catch {
      // best-effort; the socket may already be tearing down
    }
    this.socket = null;
    if (this.pendingDialReject) {
      const rejectPending = this.pendingDialReject;
      this.pendingDialReject = null;
      rejectPending(rejection);
    }
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
    this.clearDialWatchdog();
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

/**
 * undici delivers an ErrorEvent carrying `message` and `error`; lib.dom types
 * the handler's argument as a bare Event, so both are read through `in`
 * narrowing rather than a cast.
 */
function describeErrorEvent(event: Event): string {
  if ('message' in event && typeof event.message === 'string' && event.message.length > 0) return event.message;
  if ('error' in event && event.error instanceof Error) return event.error.message;
  return `${event.type} event with no message`;
}
