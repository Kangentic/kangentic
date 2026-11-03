/**
 * The pty host's front door when it also holds SSH links (#913). One renderer port serves every
 * terminal, local and remote (a `MessagePortMain` belongs to one process), so the link hub runs in
 * the pty host process beside the core and this router sends each command and request where its
 * PTY or session lives:
 *
 * - A spawn that names a host, and everything that follows its PTY or session, goes to the hub.
 * - Focus and tap commands go to both: every host needs to hear what a renderer shows.
 * - Everything else is the core's, exactly as before. A local-only deployment never builds a router.
 *
 * The core and the hub stay unaware of each other. Imports nothing of electron.
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { PtyHostCommand, PtyHostEvent, PtyHostMethod, PtyHostRequestMap, RendererPort } from '../pty/host/protocol';
import type { PtyHostRequestOptions } from '../pty/host/pty-host-client';
import { commandRoute } from './host-routes';
import { HostUnreachableError, LinkHub } from './link/link-hub';
import { openSshStream } from './link/ssh-connection';
import type { HelperMethod, RemoteHostConnection, RemoteHostRequest, RemoteRequestParams } from './protocol/messages';

/** What the router needs of the local core. `PtyHostCore` has all of it. */
export interface RoutedCore {
  handleCommand(command: PtyHostCommand): void;
  handleRequest<M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params']): PtyHostRequestMap[M]['result'] | Promise<PtyHostRequestMap[M]['result']>;
  attachRendererPort(rendererId: number, port: RendererPort): void;
  readonly liveChildCount: number;
}

export interface HostRouterOptions {
  core: RoutedCore;
  /** Where the hub's events go: the same channel as the core's. */
  emit: (event: PtyHostEvent) => void;
  /** Dials a host. A test swaps it for an in-memory stream. */
  connectTo?: (connection: RemoteHostConnection) => () => Promise<Duplex>;
  log?: (line: string) => void;
  /** Overrides how soon a lost link redials, for a test. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
}

function sshConnectionFor(connection: RemoteHostConnection): () => Promise<Duplex> {
  return async () => openSshStream({ sshPath: connection.sshPath, args: connection.args, remoteCommand: connection.remoteCommand });
}

export class HostRouter {
  readonly hub = new LinkHub();
  private readonly core: RoutedCore;
  private readonly connectTo: (connection: RemoteHostConnection) => () => Promise<Duplex>;
  /** One per process start, so a restarted host's PTY ids are never mistaken for the last run's. */
  private readonly bootId = randomUUID();

  constructor(private readonly options: HostRouterOptions) {
    this.core = options.core;
    this.connectTo = options.connectTo ?? sshConnectionFor;
    this.hub.setEventListener(options.emit);
  }

  /** The PTYs the core still runs, and the links still sending their quit frame. */
  get liveChildCount(): number {
    return this.core.liveChildCount + this.hub.shuttingDownCount;
  }

  attachRendererPort(rendererId: number, port: RendererPort): void {
    this.core.attachRendererPort(rendererId, port);
    this.hub.attachRendererPort(rendererId, port);
  }

  handleCommand(command: PtyHostCommand): void {
    if (command.type === 'remoteQuitPlan') {
      this.hub.setQuitPlan(command.hostId, command.sessions);
      return;
    }
    const route = commandRoute(command);
    if (route === 'every-host' || route === 'core-and-session') {
      this.core.handleCommand(command);
      this.hub.post(command);
      return;
    }
    if (this.hub.ownsCommand(command)) {
      this.hub.post(command);
      return;
    }
    this.core.handleCommand(command);
  }

  handleRequest<M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params'], options?: PtyHostRequestOptions<PtyHostRequestMap[M]['result']>): Promise<PtyHostRequestMap[M]['result']> {
    if (method === 'remote') return this.handleRemote(params as RemoteHostRequest) as Promise<PtyHostRequestMap[M]['result']>;
    if (this.hub.ownsRequest(method, params)) return this.hub.request(method, params, options);
    return Promise.resolve(this.core.handleRequest(method, params));
  }

  /**
   * The app is quitting. The core is told to shut down and each link sends its quit frame; the host
   * process stays up until both are done (`liveChildCount`), or the bound passes.
   */
  beginShutdown(exitWaitMs: number | undefined): void {
    this.core.handleCommand({ type: 'shutdown' });
    this.hub.shutdown(exitWaitMs);
  }

  private async handleRemote(request: RemoteHostRequest): Promise<unknown> {
    switch (request.op) {
      case 'addHost':
        this.hub.addHost(request.hostId, {
          identity: { installId: request.connection.installId, bootId: this.bootId, label: request.connection.label },
          connect: this.connectTo(request.connection),
          reconnect: this.options.reconnect,
          log: (line) => this.options.log?.(`[ssh ${request.hostId.slice(0, 8)}] ${line}`),
        }, request.sessions ?? []);
        return { ok: true };
      case 'removeHost':
        this.hub.removeHost(request.hostId);
        return { ok: true };
      case 'helper': {
        const link = this.hub.linkOf(request.hostId);
        if (!link) throw new HostUnreachableError(request.hostId, `Kangentic has no connection set up for host ${request.hostId}`);
        const params = request.params as RemoteRequestParams<HelperMethod>;
        return request.raw
          ? link.requestHelperRaw(request.method as HelperMethod, params, Buffer.from(request.raw))
          : link.requestHelper(request.method as HelperMethod, params);
      }
      default: {
        const unknownOperation: never = request;
        throw new Error(`unknown remote operation: ${JSON.stringify(unknownOperation)}`);
      }
    }
  }
}
