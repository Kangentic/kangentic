/**
 * Every SSH host's link behind one `PtyHostTransport` (#913). Main's client, or the utility process
 * that holds the links, talks to the hub exactly as it talks to the pty host: a spawn names its host
 * in `hostId`, and everything after it follows the PTY or the session it was spawned for. A request
 * that has no meaning on a remote host is refused with a sentence, never sent to the wrong machine.
 *
 * - A drop is a `remoteLink` event, never an `exit`. Each link redials by itself.
 * - Terminal ports are handed to every link. A link forwards a renderer's keystrokes for a session it
 *   holds, and an unknown session is the helper's no-op, so one port serves local and remote alike.
 * - Routes are kept from spawn to the end of the PTY or the removal of its session, and rebuilt from
 *   nothing on a restart: the links reconcile, and a session the hub does not know is `adoptable`.
 *
 * Imports nothing of electron.
 */

import type {
  PtyHostCommand,
  PtyHostEvent,
  PtyHostMethod,
  PtyHostRequestMap,
  PtyHostSpawnParams,
  RendererPort,
} from '../../pty/host/protocol';
import type { PtyHostRequestOptions, PtyHostTransport } from '../../pty/host/pty-host-client';
import type { SuspendPlan } from '../protocol/messages';
import { RemoteLink, type RemoteLinkHandlers, type RemoteLinkOptions } from './remote-link';

export interface HubHostOptions extends Omit<RemoteLinkOptions, 'log'> {
  log?: (line: string) => void;
}

/** The requests that name a session, and so follow it to its host. */
const SESSION_REQUESTS = new Set<PtyHostMethod>([
  'getScrollback',
  'getScrollbackForRenderer',
  'getPromptDraft',
  'getSerializedFrame',
  'getSeedFrame',
  'getRawScrollback',
  'getOutputPeek',
]);

/** Commands every host needs to hear: what each renderer shows and what a phone streams. */
const BROADCAST_COMMANDS = new Set<PtyHostCommand['type']>(['setRendererFocus', 'forgetRenderer', 'setTapped', 'releaseBackpressure']);

/** Commands that name a session rather than a PTY. */
const SESSION_COMMANDS = new Set<PtyHostCommand['type']>([
  'resizeBuffer',
  'markResized',
  'setActivity',
  'setAgentSessionIdKnown',
  'finalizeTranscript',
  'removeSession',
  'cancelSpawn',
  'initSession',
]);

export class HostUnreachableError extends Error {
  constructor(readonly hostId: string, message: string) {
    super(message);
    this.name = 'HostUnreachableError';
  }
}

export class LinkHub implements PtyHostTransport {
  readonly hostPid = null;
  private readonly links = new Map<string, RemoteLink>();
  private readonly ptyHosts = new Map<number, string>();
  private readonly sessionHosts = new Map<string, string>();
  private readonly ports = new Map<number, RendererPort>();
  private eventListener: ((event: PtyHostEvent) => void) | null = null;
  private handlers: RemoteLinkHandlers = {};

  /** Add a host and start dialing it. A second call for the same id replaces the first. */
  addHost(hostId: string, options: HubHostOptions): RemoteLink {
    this.removeHost(hostId);
    const link = new RemoteLink(options);
    link.setEventListener((event) => this.onLinkEvent(event));
    link.setHandlers({
      ...this.handlers,
      onStateChanged: (state, detail) => {
        this.eventListener?.({ type: 'remoteLink', hostId, state, detail });
        this.handlers.onStateChanged?.(state, detail);
      },
      onSessionsLost: (sessionIds) => {
        this.eventListener?.({ type: 'remoteSessions', hostId, lost: sessionIds, adoptable: [] });
        this.handlers.onSessionsLost?.(sessionIds);
      },
      onAdoptable: (records) => {
        this.eventListener?.({ type: 'remoteSessions', hostId, lost: [], adoptable: records });
        this.handlers.onAdoptable?.(records);
      },
    });
    this.links.set(hostId, link);
    for (const [rendererId, port] of this.ports) link.attachRendererPort(rendererId, port);
    link.start();
    return link;
  }

  /** Stop dialing a host and forget its routes. Its agents keep running there. */
  removeHost(hostId: string): void {
    const link = this.links.get(hostId);
    if (!link) return;
    link.stop();
    this.links.delete(hostId);
    for (const [ptyId, owner] of this.ptyHosts) if (owner === hostId) this.ptyHosts.delete(ptyId);
    for (const [sessionId, owner] of this.sessionHosts) if (owner === hostId) this.sessionHosts.delete(sessionId);
  }

  linkOf(hostId: string): RemoteLink | undefined {
    return this.links.get(hostId);
  }

  /** What each link's reconcile reports, for every host. */
  setHandlers(handlers: RemoteLinkHandlers): void {
    this.handlers = handlers;
  }

  hostOfSession(sessionId: string): string | null {
    return this.sessionHosts.get(sessionId) ?? null;
  }

  /** Whether this command follows a PTY or session a link holds, so a router sends it here and not to the local core. */
  ownsCommand(command: PtyHostCommand): boolean {
    return this.linkForCommand(command) !== undefined;
  }

  /** Whether this request follows a session or PTY a link holds, or is a spawn onto a host. */
  ownsRequest<M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params']): boolean {
    if (method === 'spawn') return (params as PtyHostSpawnParams).hostId !== undefined;
    return this.linkForRequest(method, params) !== undefined;
  }

  /** How each session on `hostId` ends if the app quits. Sent as the one `suspendAll` frame at `shutdown`. */
  setQuitPlan(hostId: string, sessions: SuspendPlan[]): void {
    this.links.get(hostId)?.setQuitPlan(() => sessions);
  }

  /** Links that have sent, or are sending, their quit frame and have not let go yet. The quit waits for these. */
  get shuttingDownCount(): number {
    let count = 0;
    for (const link of this.links.values()) if (link.isShuttingDown) count += 1;
    return count;
  }

  // PtyHostTransport

  setEventListener(listener: (event: PtyHostEvent) => void): void {
    this.eventListener = listener;
  }

  attachRendererPort(rendererId: number, port: RendererPort): void {
    this.ports.set(rendererId, port);
    for (const link of this.links.values()) link.attachRendererPort(rendererId, port);
  }

  post(command: PtyHostCommand): void {
    if (BROADCAST_COMMANDS.has(command.type)) {
      for (const link of this.links.values()) link.post(command);
      return;
    }
    if (command.type === 'shutdown') return;
    const link = this.linkForCommand(command);
    if (link) link.post(command);
    if (command.type === 'removeSession') this.sessionHosts.delete(command.sessionId);
  }

  request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: PtyHostRequestOptions<PtyHostRequestMap[M]['result']>,
  ): Promise<PtyHostRequestMap[M]['result']> {
    if (method === 'spawn') return this.spawn(params as PtyHostSpawnParams, options) as Promise<PtyHostRequestMap[M]['result']>;
    if (method === 'ping') return Promise.resolve('pong' as PtyHostRequestMap[M]['result']);
    const link = this.linkForRequest(method, params);
    if (!link) {
      return Promise.reject(new HostUnreachableError('', `${method} is not available on a remote host`));
    }
    return link.request(method, params, options);
  }

  /** The app is quitting: each link sends its one `suspendAll` and lets go once answered or out of time. */
  shutdown(exitWaitMs?: number): void {
    for (const link of this.links.values()) link.shutdown(exitWaitMs);
  }

  // Routing

  private async spawn(
    params: PtyHostSpawnParams,
    options?: PtyHostRequestOptions<PtyHostRequestMap['spawn']['result']>,
  ): Promise<PtyHostRequestMap['spawn']['result']> {
    const hostId = params.hostId;
    const link = hostId ? this.links.get(hostId) : undefined;
    if (!hostId || !link) {
      throw new HostUnreachableError(hostId ?? '', hostId ? `Kangentic has no connection set up for host ${hostId}` : 'a spawn that names no host reached the link hub');
    }
    // Routed before the answer, so a command that follows the spawn finds its host.
    this.ptyHosts.set(params.ptyId, hostId);
    this.sessionHosts.set(params.sessionId, hostId);
    try {
      const result = await link.request('spawn', params, options);
      if (!result.ok) this.forgetPty(params.ptyId, params.sessionId);
      return result;
    } catch (error) {
      this.forgetPty(params.ptyId, params.sessionId);
      throw error;
    }
  }

  private forgetPty(ptyId: number, sessionId: string): void {
    this.ptyHosts.delete(ptyId);
    this.sessionHosts.delete(sessionId);
  }

  private linkForCommand(command: PtyHostCommand): RemoteLink | undefined {
    if ('ptyId' in command) {
      const hostId = this.ptyHosts.get(command.ptyId);
      return hostId ? this.links.get(hostId) : undefined;
    }
    if (SESSION_COMMANDS.has(command.type) && 'sessionId' in command) {
      const hostId = this.sessionHosts.get(command.sessionId);
      return hostId ? this.links.get(hostId) : undefined;
    }
    // A command with no host to follow: a local CLI run, or one a remote host has no use for.
    return undefined;
  }

  private linkForRequest<M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params']): RemoteLink | undefined {
    if (SESSION_REQUESTS.has(method)) {
      const hostId = this.sessionHosts.get((params as { sessionId: string }).sessionId);
      return hostId ? this.links.get(hostId) : undefined;
    }
    if (method === 'drainWrites') {
      const hostId = this.ptyHosts.get((params as { ptyId: number }).ptyId);
      return hostId ? this.links.get(hostId) : undefined;
    }
    return undefined;
  }

  private onLinkEvent(event: PtyHostEvent): void {
    this.eventListener?.(event);
    // The PTY is over. Its commands after this are the late ones a renderer or main still had in flight.
    if (event.type === 'exit') this.ptyHosts.delete(event.ptyId);
  }
}
