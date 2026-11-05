/**
 * The link-side half of #913: one connection manager per host, speaking the pty host's own
 * `PtyHostTransport` so `PtyHostClient` can sit on it unchanged. It dials through an injected
 * `connect()` (an `ssh` child's pipes in production, an in-memory pair in tests), keeps the
 * session going across drops, and rebuilds what a drop lost.
 *
 * - A drop is a link state, never an exit. Every agent keeps running on the host. The link
 *   redials with backoff, and the resume layer (`resume-endpoint.ts`) replays what was in flight.
 * - After every attach the link reads the helper's `snapshot` and reconciles: a session the
 *   helper says exited while the link was away gets its exit event, a session the helper no
 *   longer holds is reported lost, and a session the helper holds under no id of this link's is
 *   rebound. Events replace what a gap in the stream lost, so nothing depends on every frame
 *   surviving.
 * - Terminal output arrives as port messages for one stand-in renderer. The link hands each to
 *   every real renderer port whose visible set holds the session, and routes a scrollback answer
 *   to the renderer that asked.
 *
 * Imports nothing of electron. It runs in the pty host process, built and routed by `LinkHub` behind `HostRouter`.
 */

import type { Duplex } from 'node:stream';
import {
  fromPtyHostError,
  type PtyHostCommand,
  type PtyHostEvent,
  type PtyHostMethod,
  type PtyHostRequestMap,
  type RendererPort,
} from '../../pty/host/protocol';
import type { PtyHostRequestOptions, PtyHostTransport } from '../../pty/host/pty-host-client';
import type { FromPtyHostPortMessage, ToPtyHostPortMessage } from '../../../shared/pty-port-protocol';
import { MAX_FRAME_JSON_BYTES, MAX_FRAME_RAW_BYTES } from '../protocol/frame-codec';
import { ResumeEndpoint, type GapInfo, type ResumeEndpointOptions } from '../protocol/resume-endpoint';
import {
  joinPortMessage,
  parseHelperMessage,
  splitPortMessage,
  type HelperMethod,
  type HelperSessionRecord,
  type HelperSnapshot,
  type LinkToHelperMessage,
  type PortBody,
  type RemoteMethod,
  type RemoteRequestParams,
  type RemoteRequestResult,
  type SuspendPlan,
} from '../protocol/messages';

/** The one renderer id the helper's core knows. Real renderers are mapped onto it here. */
const HELPER_RENDERER_ID = 1;
const LINK_PROTOCOL = { min: 1, max: 1 } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RemoteLinkState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface RemoteLinkIdentity {
  /** One per Kangentic installation on this computer. */
  installId: string;
  /** One per run of this link. A new one tells the helper every PTY id this link used before is void. */
  bootId: string;
  /** Shown to another installation that is turned away. */
  label: string;
}

export interface RemoteLinkHandlers {
  onStateChanged?(state: RemoteLinkState, detail: string | null): void;
  onGap?(info: GapInfo): void;
  /** Sessions this link believed alive that the helper no longer holds. */
  onSessionsLost?(sessionIds: string[]): void;
  /** Sessions the helper holds alive that this link knows nothing about. */
  onAdoptable?(records: HelperSessionRecord[]): void;
  onSnapshot?(snapshot: HelperSnapshot): void;
}

export interface RemoteLinkOptions {
  identity: RemoteLinkIdentity;
  connect(): Promise<Duplex>;
  endpoint?: Partial<ResumeEndpointOptions>;
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LinkSession {
  ptyId: number;
  alive: boolean;
}

export class RemoteLink implements PtyHostTransport {
  readonly hostPid = null;
  private readonly endpoint: ResumeEndpoint;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, LinkSession>();
  private readonly rendererPorts = new Map<number, RendererPort>();
  private readonly rendererFocus = new Map<number, string[]>();
  private tapped: string[] = [];
  /** A scrollback request made on the helper's behalf: its id here, the renderer and the id that asked. */
  private readonly scrollbackRoutes = new Map<number, { rendererId: number; requestId: number }>();
  private eventListener: ((event: PtyHostEvent) => void) | null = null;
  private handlers: RemoteLinkHandlers = {};
  private nextRequestId = 1;
  private nextScrollbackId = 1;
  /** The helper's owner epoch as the last snapshot reported it, sent back with the quit. */
  private ownerEpoch = 0;
  private quitPlan: (() => SuspendPlan[]) | null = null;
  private currentState: RemoteLinkState = 'connecting';
  private stopped = true;
  /** The quit frame is sent and the link has not let go yet: the app's quit waits for this. */
  private shutdownInFlight = false;
  private everConnected = false;
  private cycleWaiter: (() => void) | null = null;
  private cycleAttached = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ends the wait between dials early, for `redialNow` and `stop`. */
  private retryWake: (() => void) | null = null;
  /** Counts `start` calls, so a loop a `stop` left mid-await ends when a later `start` has begun another. */
  private loopGeneration = 0;

  constructor(private readonly options: RemoteLinkOptions) {
    this.endpoint = new ResumeEndpoint(
      {
        onMessage: (json, raw) => this.onHelperMessage(json, raw),
        onAttached: () => this.onAttached(),
        onDetached: (reason) => this.onDetached(reason),
        onGap: (info) => this.handlers.onGap?.(info),
        onError: (error) => this.log(`a handler threw: ${String(error)}`),
      },
      {
        role: 'link',
        protocol: LINK_PROTOCOL,
        identity: { installId: options.identity.installId, bootId: options.identity.bootId, label: options.identity.label },
        ...options.endpoint,
      },
    );
  }

  get state(): RemoteLinkState {
    return this.currentState;
  }

  setHandlers(handlers: RemoteLinkHandlers): void {
    this.handlers = handlers;
  }

  /** Start dialing, and keep dialing until `stop`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopGeneration += 1;
    void this.connectLoop(this.loopGeneration);
  }

  /** Stop dialing and let go of the connection. Every agent keeps running on the host. */
  stop(): void {
    this.stopped = true;
    this.shutdownInFlight = false;
    this.endRetryWait();
    this.endpoint.detach('the link stopped');
    this.failPending(new Error('the link stopped'));
    this.setState('stopped', null);
  }

  /** Dial now instead of after the backoff (the user asked to reconnect). A connected link is left alone. */
  redialNow(): void {
    if (this.stopped) {
      this.start();
      return;
    }
    this.endRetryWait();
  }

  /**
   * Take on sessions this app already holds handles for, as when the process holding the links
   * restarted. The reconcile after the next connect then rebinds each to its PTY on the host, or
   * reports it lost, instead of calling it adoptable.
   */
  adoptSessions(routes: readonly { sessionId: string; ptyId: number }[]): void {
    for (const route of routes) this.sessions.set(route.sessionId, { ptyId: route.ptyId, alive: true });
  }

  private endRetryWait(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const wake = this.retryWake;
    this.retryWake = null;
    wake?.();
  }

  // PtyHostTransport

  post(command: PtyHostCommand): void {
    if (command.type === 'setRendererFocus') {
      this.rendererFocus.set(command.rendererId, command.sessionIds);
      this.sendCommand({ type: 'setRendererFocus', rendererId: HELPER_RENDERER_ID, sessionIds: this.focusUnion() });
      return;
    }
    if (command.type === 'forgetRenderer') {
      this.rendererFocus.delete(command.rendererId);
      this.rendererPorts.delete(command.rendererId);
      this.sendCommand({ type: 'setRendererFocus', rendererId: HELPER_RENDERER_ID, sessionIds: this.focusUnion() });
      return;
    }
    if (command.type === 'setTapped') this.tapped = command.sessionIds;
    this.sendCommand(command);
  }

  attachRendererPort(rendererId: number, port: RendererPort): void {
    this.rendererPorts.set(rendererId, port);
    port.on('message', (messageEvent) => {
      // A removed host's link still hears the port; it must not keep every keystroke in its retention.
      if (this.stopped) return;
      const { body, raw } = splitPortMessage(messageEvent.data as ToPtyHostPortMessage);
      this.endpoint.send({ t: 'port', message: body } satisfies LinkToHelperMessage, raw);
    });
    port.on('close', () => {
      this.rendererPorts.delete(rendererId);
      this.rendererFocus.delete(rendererId);
    });
    port.start();
  }

  request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: PtyHostRequestOptions<PtyHostRequestMap[M]['result']>,
  ): Promise<PtyHostRequestMap[M]['result']> {
    if (method === 'getScrollbackForRenderer') return this.requestScrollback(params as PtyHostRequestMap['getScrollbackForRenderer']['params'], options?.timeoutMs) as Promise<PtyHostRequestMap[M]['result']>;
    return this.requestRemote(method, params, options?.timeoutMs).then((result) => {
      if (method === 'spawn') this.noteSpawn(params as PtyHostRequestMap['spawn']['params'], result as PtyHostRequestMap['spawn']['result']);
      return result as PtyHostRequestMap[M]['result'];
    });
  }

  setEventListener(listener: (event: PtyHostEvent) => void): void {
    this.eventListener = listener;
  }

  /** What the app knows about ending each session, which the helper cannot: the adapters' exit sequences. */
  setQuitPlan(provider: () => SuspendPlan[]): void {
    this.quitPlan = provider;
  }

  /**
   * The app is quitting. Sends the one `suspendAll` frame now, the quit being what the helper
   * cannot learn later, and lets go of the connection once the helper answers or `exitWaitMs` has
   * passed. Never blocks: the helper ends every session on its own clock, so a frame that never
   * gets through leaves the agents running until the next connect suspends them or the lease ends.
   */
  shutdown(exitWaitMs = 1_300): void {
    if (this.stopped) return;
    this.shutdownInFlight = true;
    const finish = (): void => {
      this.shutdownInFlight = false;
      this.stop();
    };
    let sessions: SuspendPlan[];
    try {
      sessions = this.quitPlan?.() ?? [];
    } catch (error) {
      // The helper still ends every session by its own recorded exit sequence.
      this.log(`the quit plan could not be read: ${String(error)}`);
      sessions = [];
    }
    this.requestHelper('suspendAll', { ownerEpoch: this.ownerEpoch, sessions }, exitWaitMs).then(finish, finish);
  }

  /** True from the quit frame being sent until the link lets go. */
  get isShuttingDown(): boolean {
    return this.shutdownInFlight;
  }

  /** A request only the helper answers. */
  requestHelper<M extends HelperMethod>(method: M, params: RemoteRequestParams<M>, timeoutMs?: number): Promise<RemoteRequestResult<M>> {
    return this.requestRemote(method, params, timeoutMs) as Promise<RemoteRequestResult<M>>;
  }

  /** A helper request that carries bytes in the frame's raw part, for a payload too large for the JSON body. */
  requestHelperRaw<M extends HelperMethod>(method: M, params: RemoteRequestParams<M>, raw: Buffer, timeoutMs?: number): Promise<RemoteRequestResult<M>> {
    return this.requestRemote(method, params, timeoutMs, raw) as Promise<RemoteRequestResult<M>>;
  }

  // Connection

  private setState(state: RemoteLinkState, detail: string | null): void {
    if (this.currentState === state && detail === null) return;
    this.currentState = state;
    this.handlers.onStateChanged?.(state, detail);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private async connectLoop(generation: number): Promise<void> {
    const initialDelayMs = this.options.reconnect?.initialDelayMs ?? 250;
    const maxDelayMs = this.options.reconnect?.maxDelayMs ?? 10_000;
    const superseded = (): boolean => this.stopped || generation !== this.loopGeneration;
    let failures = 0;
    while (!superseded()) {
      this.setState(this.everConnected ? 'reconnecting' : 'connecting', null);
      this.cycleAttached = false;
      try {
        const stream = await this.options.connect();
        if (superseded()) {
          stream.destroy();
          return;
        }
        const ended = new Promise<void>((resolve) => { this.cycleWaiter = resolve; });
        this.endpoint.attach(stream);
        await ended;
      } catch (error) {
        // A dial that fails after `stop` belongs to a link that is over: nothing brings a stopped state back.
        if (superseded()) return;
        this.log(`could not connect: ${error instanceof Error ? error.message : String(error)}`);
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
      }
      failures = this.cycleAttached ? 0 : failures + 1;
      if (superseded()) return;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(failures, 10));
      await new Promise<void>((resolve) => {
        this.retryWake = resolve;
        this.retryTimer = setTimeout(resolve, delay);
      });
      this.retryWake = null;
    }
  }

  private onAttached(): void {
    this.cycleAttached = true;
    this.everConnected = true;
    this.setState('connected', null);
    // What the helper's core only knows from this link: what is on screen and what a phone streams.
    this.sendCommand({ type: 'setRendererFocus', rendererId: HELPER_RENDERER_ID, sessionIds: this.focusUnion() });
    if (this.tapped.length > 0) this.sendCommand({ type: 'setTapped', sessionIds: this.tapped });
    void this.reconcile();
  }

  private onDetached(reason: string): void {
    this.log(`connection ended: ${reason}`);
    // A drop is a state with its reason. So is a refusal before the link ever connected: that reason
    // is what the user is shown, in the peer's own words. A stopped link redials nothing, and `stop`
    // reports its own state, so a reconnect is never announced.
    if (!this.stopped) {
      if (this.currentState === 'connected') this.setState('reconnecting', reason);
      else this.handlers.onStateChanged?.(this.currentState, reason);
    }
    const waiter = this.cycleWaiter;
    this.cycleWaiter = null;
    waiter?.();
  }

  private async reconcile(): Promise<void> {
    let snapshot: HelperSnapshot;
    try {
      snapshot = await this.requestHelper('snapshot', {});
    } catch (error) {
      this.log(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.ownerEpoch = snapshot.ownerEpoch;
    this.handlers.onSnapshot?.(snapshot);
    const held = new Map(snapshot.sessions.map((record) => [record.sessionId, record]));
    const lost: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.alive) continue;
      const record = held.get(sessionId);
      if (!record) {
        session.alive = false;
        lost.push(sessionId);
      } else if (!record.alive) {
        session.alive = false;
        this.eventListener?.({ type: 'exit', ptyId: session.ptyId, sessionId, exitCode: record.exitCode ?? -1 });
      } else if (record.wirePtyId !== session.ptyId) {
        void this.requestHelper('rebind', { sessionId, ptyId: session.ptyId }).catch((error) => this.log(`rebind failed: ${String(error)}`));
      }
    }
    if (lost.length > 0) this.handlers.onSessionsLost?.(lost);
    const adoptable = snapshot.sessions.filter((record) => record.alive && !this.sessions.has(record.sessionId));
    if (adoptable.length > 0) this.handlers.onAdoptable?.(adoptable);
  }

  // Requests

  private sendCommand(command: PtyHostCommand): void {
    this.endpoint.send({ t: 'command', command } satisfies LinkToHelperMessage);
  }

  private requestRemote(method: RemoteMethod, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, raw?: Buffer): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // A frame over its cap ends the connection, so a request too big for one is refused here, with a
      // sentence, instead of dropping the link and being replayed into the same failure.
      const bodyBytes = Buffer.byteLength(JSON.stringify({ t: 'request', id: 0, method, params }));
      if (bodyBytes > MAX_FRAME_JSON_BYTES - 1024) {
        reject(new Error(`The ${method} request is too large to send to the host (${bodyBytes} bytes).`));
        return;
      }
      if (raw && raw.length > MAX_FRAME_RAW_BYTES) {
        reject(new Error(`The ${method} request carries too much data to send to the host (${raw.length} bytes).`));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the host did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.endpoint.send({ t: 'request', id, method, params } satisfies LinkToHelperMessage, raw);
    });
  }

  private failPending(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
  }

  private noteSpawn(params: PtyHostRequestMap['spawn']['params'], result: PtyHostRequestMap['spawn']['result']): void {
    if (result.ok) this.sessions.set(params.sessionId, { ptyId: params.ptyId, alive: true });
  }

  /** A scrollback request for a real renderer, asked of the helper as its one stand-in renderer. */
  private requestScrollback(params: PtyHostRequestMap['getScrollbackForRenderer']['params'], timeoutMs?: number): Promise<PtyHostRequestMap['getScrollbackForRenderer']['result']> {
    const helperRequestId = this.nextScrollbackId++;
    this.scrollbackRoutes.set(helperRequestId, { rendererId: params.rendererId, requestId: params.requestId });
    return this.requestRemote('getScrollbackForRenderer', { ...params, rendererId: HELPER_RENDERER_ID, requestId: helperRequestId }, timeoutMs).then(
      (result) => {
        const answered = result as PtyHostRequestMap['getScrollbackForRenderer']['result'];
        // Answered inline, with no port message to wait for.
        if (!answered.sentToPort) this.scrollbackRoutes.delete(helperRequestId);
        return answered;
      },
      (error: unknown) => {
        this.scrollbackRoutes.delete(helperRequestId);
        throw error;
      },
    );
  }

  // Messages from the helper

  private onHelperMessage(json: unknown, raw: Buffer): void {
    const message = parseHelperMessage(json);
    if (!message) return;
    if (message.t === 'reply') {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(fromPtyHostError(message.error));
    } else if (message.t === 'event') {
      this.onHelperEvent(message.event);
    } else {
      this.onHelperPort(joinPortMessage<FromPtyHostPortMessage>(message.message as PortBody, raw));
    }
  }

  private onHelperEvent(event: PtyHostEvent): void {
    if (event.type === 'exit') {
      const session = this.sessions.get(event.sessionId);
      // The snapshot may already have reported this exit, or this is a replay of one already seen.
      if (session && !session.alive) return;
      if (session) session.alive = false;
    }
    this.eventListener?.(event);
  }

  private onHelperPort(message: FromPtyHostPortMessage): void {
    if (message.type === 'data') {
      for (const [rendererId, sessionIds] of this.rendererFocus) {
        if (sessionIds.includes(message.sessionId)) this.rendererPorts.get(rendererId)?.postMessage(message);
      }
      return;
    }
    const route = this.scrollbackRoutes.get(message.requestId);
    if (!route) return;
    this.scrollbackRoutes.delete(message.requestId);
    this.rendererPorts.get(route.rendererId)?.postMessage({ ...message, requestId: route.requestId });
  }

  private focusUnion(): string[] {
    return [...new Set([...this.rendererFocus.values()].flat())];
  }
}
