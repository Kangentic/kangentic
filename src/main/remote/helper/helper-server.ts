/**
 * The host-side half of #913: the unchanged `PtyHostCore` behind a framed, resumable link.
 * The daemon (`helper-entry.ts`) hands every accepted socket to `accept`. One link owns the
 * helper at a time, and what it started keeps running when its connection drops.
 *
 * - The core keeps its own PTY ids. A wire id is the link's, mapped here, so a link that
 *   restarts and counts from 1 again cannot route an old exit to a new handle. A reconnect
 *   from the same link process keeps its ids; a new `bootId` clears them and the link rebinds
 *   what it adopts after reading a `snapshot`.
 * - Terminal output leaves the core through a renderer port, not through `emit`, so the server
 *   gives the core a framed port while a link is attached and forgets it when the link goes. Output
 *   while nobody is attached is not queued: the core's ring keeps it and the link's replay reads it.
 * - One live PTY per task. A spawn beside a live PTY for the same task is refused here, so the
 *   invariant holds even if the link is wrong about what it started.
 * - Another installation is turned away while this one owns a session or a connection. Only a
 *   helper with nothing running changes hands.
 *
 * Imports nothing of electron or better-sqlite3 (`tests/unit/remote-helper-boundary.test.ts`).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { isFishShell, isNushellShell } from '../../../shared/shell-quote';
import { PtyHostCore, type PtyHostCoreDeps } from '../../pty/host/pty-host-core';
import {
  toPtyHostError,
  type PtyHostCommand,
  type PtyHostEvent,
  type PtyHostMethod,
  type PtyHostRequestMap,
  type PtyHostSpawnParams,
  type PtyHostSpawnResult,
  type RendererPort,
} from '../../pty/host/protocol';
import type { FromPtyHostPortMessage, ToPtyHostPortMessage } from '../../../shared/pty-port-protocol';
import type { ExitSequenceStep } from '../../../shared/types';
import { writeExitSteps } from '../../pty/shutdown/exit-sequence';
import { ResumeEndpoint, type PeerHello, type ResumeEndpointOptions } from '../protocol/resume-endpoint';
import {
  HOST_LOGIN_SHELL,
  joinPortMessage,
  parseLinkMessage,
  splitPortMessage,
  type HelperSessionRecord,
  type HostFileWrite,
  type HostInfo,
  type HelperSnapshot,
  type HelperToLinkMessage,
  type PortBody,
  type SuspendAllParams,
} from '../protocol/messages';

/** The one renderer the core sees: the link stands in for every renderer on this computer. */
const LINK_RENDERER_ID = 1;

export const HELPER_PROTOCOL = { min: 1, max: 1 } as const;

/** Variables that describe the ssh session that happened to start the daemon. A PTY has no use for them. */
const SESSION_ENV_PREFIXES = ['SSH_'] as const;
const SESSION_ENV_NAMES = new Set(['NODE_OPTIONS', 'NODE_PATH', '_']);
const MAX_READ_BYTES = 1_000_000;

/**
 * How each shell is asked to be a login shell, as `resolveShellArgs` asks it on this computer:
 * bash and zsh take --login, fish and nushell take nothing (they read their startup files anyway),
 * and sh, dash and ksh take only -l (dash rejects --login outright).
 */
function loginFlagsFor(shellPath: string): string[] {
  const name = path.basename(shellPath).toLowerCase();
  if (isFishShell(name) || isNushellShell(name)) return [];
  if (name === 'bash' || name === 'zsh') return ['--login'];
  return ['-l'];
}

export interface HelperServerOptions {
  /** The user's home on the host. Files are written, read and checked only beneath it. Defaults to the daemon's. */
  homeDirectory?: string;
  /** The environment every PTY starts from, before the spawn's own variables. Defaults to the daemon's. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Everything the core needs but `emit`, which the server owns. */
  coreDeps: Omit<PtyHostCoreDeps, 'emit'>;
  /** Timers and limits for the link's endpoint, which tests shorten. */
  endpoint?: Partial<ResumeEndpointOptions>;
  log?: (line: string) => void;
}

interface LedgerEntry {
  sessionId: string;
  taskId: string | null;
  projectId: string;
  corePtyId: number;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  /** The adapter's keys, from the spawn, for a quit that names no plan for this session. */
  exitSequence: ExitSequenceStep[];
}

/** How long an agent that is typed into gets, after its keys, before it is killed. The young-session grace. */
const EXIT_GRACE_MS = 1_500;

/** The core's renderer port, over whichever link is attached. */
class FramedPort implements RendererPort {
  private messageListener: ((messageEvent: { data: unknown }) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private closed = false;

  constructor(private readonly sendToLink: (message: FromPtyHostPortMessage) => void) {}

  postMessage(message: FromPtyHostPortMessage): void {
    if (!this.closed) this.sendToLink(message);
  }

  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'message' | 'close', listener: ((messageEvent: { data: unknown }) => void) | (() => void)): unknown {
    if (event === 'message') this.messageListener = listener as (messageEvent: { data: unknown }) => void;
    else this.closeListener = listener as () => void;
    return this;
  }

  start(): void {
    // A frame is delivered as it is decoded.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.();
  }

  deliver(message: ToPtyHostPortMessage): void {
    if (!this.closed) this.messageListener?.({ data: message });
  }
}

export class HelperServer {
  readonly core: PtyHostCore;
  private readonly endpoint: ResumeEndpoint;
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly wireToCore = new Map<number, number>();
  private readonly coreToWire = new Map<number, number>();
  private readonly startedAt = new Date().toISOString();
  private nextCorePtyId = 1;
  /** Keeps two writes to one target from sharing a staging file. */
  private nextStagingSuffix = 1;
  private ownerInstallId: string | null = null;
  private ownerBootId: string | null = null;
  private ownerLabel = 'unknown';
  private ownerEpoch = 0;
  private port: FramedPort | null = null;

  constructor(private readonly options: HelperServerOptions) {
    this.core = new PtyHostCore({ ...options.coreDeps, emit: (event) => this.onCoreEvent(event) });
    this.endpoint = new ResumeEndpoint(
      {
        onMessage: (json, raw) => this.onLinkMessage(json, raw),
        onAttached: () => this.onAttached(),
        onDetached: (reason, info) => this.onDetached(reason, info.wasActive),
        onGap: (info) => this.log(`gap ${info.direction} ${info.cause} ${info.lostFrom} to ${info.lostTo}`),
        vetPeer: (peer) => this.vetPeer(peer),
        onError: (error) => this.log(`a handler threw: ${String(error)}`),
      },
      { role: 'helper', protocol: HELPER_PROTOCOL, identity: { startedAt: this.startedAt }, ...options.endpoint },
    );
  }

  /** A new connection from a link. It takes over from the current owner only if its handshake passes. */
  accept(stream: Duplex): void {
    this.endpoint.attach(stream);
  }

  get connected(): boolean {
    return this.endpoint.connected;
  }

  get liveSessionCount(): number {
    return [...this.ledger.values()].filter((entry) => entry.alive).length;
  }

  snapshot(): HelperSnapshot {
    const altScreen = new Map(this.core.getDiagnostics().dimensions.map((entry) => [entry.sessionId, entry.inAltScreen]));
    const sessions: HelperSessionRecord[] = [...this.ledger.values()].map((entry) => ({
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      projectId: entry.projectId,
      pid: entry.pid,
      alive: entry.alive,
      exitCode: entry.exitCode,
      wirePtyId: this.coreToWire.get(entry.corePtyId) ?? null,
      inAltScreen: altScreen.get(entry.sessionId) ?? false,
    }));
    return { ownerEpoch: this.ownerEpoch, daemonPid: process.pid, daemonStartedAt: this.startedAt, sessions };
  }

  /** Drop the connection and let go of the core's port. PTYs keep running. */
  dispose(): void {
    this.endpoint.detach('the helper is shutting down');
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private vetPeer(peer: PeerHello): string | null {
    if (peer.role !== 'link') return 'This helper only talks to a Kangentic link.';
    const installId = String(peer.identity.installId ?? '');
    if (!installId) return 'The link did not say which Kangentic installation it is.';
    if (this.ownerInstallId !== null && installId !== this.ownerInstallId && (this.endpoint.connected || this.liveSessionCount > 0)) {
      return `This host is in use by another Kangentic installation (${this.ownerLabel}).`;
    }
    // Accepted, and the endpoint replays right after this returns, so the owner is recorded now.
    this.adoptOwner(installId, String(peer.identity.bootId ?? ''), String(peer.identity.label ?? 'another computer'));
    return null;
  }

  private onAttached(): void {
    this.ownerEpoch += 1;
    this.port = new FramedPort((message) => this.sendPort(message));
    this.core.attachRendererPort(LINK_RENDERER_ID, this.port);
    this.log(`link attached, owner epoch ${this.ownerEpoch}`);
  }

  private onDetached(reason: string, wasActive: boolean): void {
    this.log(`connection ended: ${reason}`);
    if (!wasActive) return;
    // A drop keeps every agent running. What the link had on screen is gone with it: stop sending
    // to a port nobody reads and let the PTYs run free instead of pausing on output no one acks.
    this.core.handleCommand({ type: 'forgetRenderer', rendererId: LINK_RENDERER_ID });
    this.core.handleCommand({ type: 'releaseBackpressure', sessionIds: [...this.ledger.keys()] });
    this.port = null;
  }

  private adoptOwner(installId: string, bootId: string, label: string): void {
    if (this.ownerBootId !== null && bootId !== this.ownerBootId) {
      // A link that restarted counts its PTY ids from 1 again, so the old ones mean nothing, and
      // neither does anything kept for the process that is gone: it must not be replayed to this one.
      this.wireToCore.clear();
      this.coreToWire.clear();
      this.endpoint.discardRetained();
    }
    this.ownerInstallId = installId;
    this.ownerBootId = bootId;
    this.ownerLabel = label;
  }

  private sendPort(message: FromPtyHostPortMessage): void {
    const { body, raw } = splitPortMessage(message);
    this.endpoint.send({ t: 'port', message: body } satisfies HelperToLinkMessage, raw);
  }

  private onCoreEvent(hostEvent: PtyHostEvent): void {
    if (hostEvent.type === 'exit') {
      const entry = this.ledger.get(hostEvent.sessionId);
      if (entry && entry.corePtyId === hostEvent.ptyId) {
        entry.alive = false;
        entry.exitCode = hostEvent.exitCode;
      }
    }
    if ('ptyId' in hostEvent) {
      const wirePtyId = this.coreToWire.get(hostEvent.ptyId);
      if (wirePtyId === undefined) return;
      this.endpoint.send({ t: 'event', event: { ...hostEvent, ptyId: wirePtyId } } satisfies HelperToLinkMessage);
      return;
    }
    this.endpoint.send({ t: 'event', event: hostEvent } satisfies HelperToLinkMessage);
  }

  private onLinkMessage(json: unknown, raw: Buffer): void {
    const message = parseLinkMessage(json);
    if (!message) return;
    if (message.t === 'command') {
      this.handleCommand(message.command);
    } else if (message.t === 'request') {
      void this.answerRequest(message.id, message.method, message.params);
    } else if (message.t === 'port') {
      this.port?.deliver(joinPortMessage<ToPtyHostPortMessage>(message.message as PortBody, raw));
    }
  }

  private handleCommand(command: PtyHostCommand): void {
    if ('ptyId' in command) {
      const corePtyId = this.wireToCore.get(command.ptyId);
      if (corePtyId === undefined) return;
      this.core.handleCommand({ ...command, ptyId: corePtyId });
      return;
    }
    if (command.type === 'removeSession') this.ledger.delete(command.sessionId);
    this.core.handleCommand(command);
  }

  private async answerRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.runRequest(method, params);
      this.endpoint.send({ t: 'reply', id, ok: true, result } satisfies HelperToLinkMessage);
    } catch (error) {
      this.endpoint.send({ t: 'reply', id, ok: false, error: toPtyHostError(error) } satisfies HelperToLinkMessage);
    }
  }

  private runRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (method === 'spawn') return this.spawnSession(params as PtyHostSpawnParams);
    if (method === 'snapshot') return this.snapshot();
    if (method === 'suspendAll') return this.suspendAll(params as SuspendAllParams);
    if (method === 'hostInfo') return this.hostInfo();
    if (method === 'writeFiles') return this.writeFiles((params as { files: HostFileWrite[] }).files);
    if (method === 'readFile') return this.readFile(params as { path: string; maxBytes?: number });
    if (method === 'pathPresence') return this.pathPresence((params as { paths: string[] }).paths);
    if (method === 'rebind') {
      const { sessionId, ptyId } = params as { sessionId: string; ptyId: number };
      return this.rebind(sessionId, ptyId);
    }
    if (method === 'drainWrites') {
      const corePtyId = this.wireToCore.get((params as { ptyId: number }).ptyId);
      if (corePtyId === undefined) throw new Error(`no PTY is bound to wire id ${(params as { ptyId: number }).ptyId}`);
      return this.core.handleRequest('drainWrites', { ptyId: corePtyId });
    }
    return this.core.handleRequest(method as PtyHostMethod, params as PtyHostRequestMap[PtyHostMethod]['params']);
  }

  private async spawnSession(params: PtyHostSpawnParams): Promise<PtyHostSpawnResult> {
    const live = params.taskId
      ? [...this.ledger.values()].find((entry) => entry.alive && entry.taskId === params.taskId && entry.sessionId !== params.sessionId)
      : undefined;
    if (live) {
      return {
        ok: false,
        error: { message: `refused: task ${params.taskId} already has a live PTY here (pid ${live.pid})`, code: 'SPAWN_REFUSED_LIVE' },
        previousScrollback: '',
      };
    }
    const corePtyId = this.nextCorePtyId++;
    const result = await this.core.handleRequest('spawn', { ...this.prepareSpawn(params), ptyId: corePtyId });
    if (result.ok) {
      this.wireToCore.set(params.ptyId, corePtyId);
      this.coreToWire.set(corePtyId, params.ptyId);
      this.ledger.set(params.sessionId, {
        sessionId: params.sessionId,
        taskId: params.taskId ?? null,
        projectId: params.projectId,
        corePtyId,
        pid: result.pid,
        alive: true,
        exitCode: null,
        exitSequence: params.exitSequence ?? [],
      });
    }
    return result;
  }

  /**
   * Quit: end every live session the way its adapter ends it, without waiting for the link. An agent
   * whose console close is its graceful exit is hung up and nothing is typed into it. Any other gets
   * its exit keys, with their pauses, and a kill once the keys and the grace have had their time.
   */
  private suspendAll(params: SuspendAllParams): { suspended: number; ignored: boolean } {
    if (params.ownerEpoch !== this.ownerEpoch) {
      this.log(`ignored a suspendAll for epoch ${params.ownerEpoch}, the owner epoch is ${this.ownerEpoch}`);
      return { suspended: 0, ignored: true };
    }
    const plans = new Map(params.sessions.map((plan) => [plan.sessionId, plan]));
    let suspended = 0;
    for (const entry of this.ledger.values()) {
      if (!entry.alive) continue;
      suspended += 1;
      const plan = plans.get(entry.sessionId);
      const steps = plan?.exitSequence ?? entry.exitSequence;
      const kill = (): void => {
        if (entry.alive) this.core.handleCommand({ type: 'kill', ptyId: entry.corePtyId });
      };
      if (plan?.consoleCloseIsGraceful === true || steps.length === 0) {
        kill();
        continue;
      }
      writeExitSteps((data) => this.core.handleCommand({ type: 'write', ptyId: entry.corePtyId, data }), steps);
      const pauses = steps.reduce<number>((total, step) => total + (typeof step === 'string' ? 0 : step.delayMs), 0);
      setTimeout(kill, pauses + EXIT_GRACE_MS).unref?.();
    }
    return { suspended, ignored: false };
  }

  /**
   * A spawn's shell and environment as this host should have them. The app cannot know either: main's
   * environment is another machine's and never reaches a host, so a PTY starts from the daemon's own
   * (minus the ssh session that started it), with the spawn's variables on top.
   */
  private prepareSpawn(params: PtyHostSpawnParams): PtyHostSpawnParams {
    const baseEnv = this.options.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (SESSION_ENV_NAMES.has(name) || SESSION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      env[name] = value;
    }
    const wantsLoginShell = params.file === HOST_LOGIN_SHELL;
    const shell = this.hostInfo().shellPath;
    return {
      ...params,
      file: wantsLoginShell ? shell : params.file,
      args: wantsLoginShell ? [...loginFlagsFor(shell), ...params.args] : params.args,
      env: { ...env, ...params.env },
    };
  }

  private hostInfo(): HostInfo {
    const shellPath = (this.options.baseEnv ?? process.env).SHELL || '/bin/sh';
    return {
      home: path.resolve(this.options.homeDirectory ?? os.homedir()),
      shellPath,
      shellName: path.basename(shellPath).toLowerCase(),
    };
  }

  /** A path the app named, resolved and held beneath the user's home. Anything outside it is refused. */
  private homePath(requested: string): string {
    const home = path.resolve(this.options.homeDirectory ?? os.homedir());
    const resolved = path.resolve(requested);
    const relative = path.relative(home, resolved);
    if (!path.isAbsolute(requested) || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${requested} is not inside the home folder of this host, so it was not touched`);
    }
    return resolved;
  }

  private async writeFiles(files: HostFileWrite[]): Promise<{ written: number }> {
    for (const file of files) {
      const target = this.homePath(file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Beside the file, then renamed in: a reader never sees half a settings file.
      const staging = `${target}.${process.pid}.${this.nextStagingSuffix++}.tmp`;
      await fs.writeFile(staging, file.content, { encoding: 'utf8', mode: file.mode ?? 0o600 });
      await fs.chmod(staging, file.mode ?? 0o600);
      await fs.rename(staging, target);
    }
    return { written: files.length };
  }

  private async readFile(request: { path: string; maxBytes?: number }): Promise<{ exists: boolean; content: string | null }> {
    const target = this.homePath(request.path);
    try {
      const buffer = await fs.readFile(target);
      return { exists: true, content: buffer.subarray(0, Math.min(request.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES)).toString('utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, content: null };
      throw error;
    }
  }

  private async pathPresence(paths: string[]): Promise<Array<'present' | 'absent'>> {
    return Promise.all(paths.map(async (requested) => {
      try {
        await fs.access(this.homePath(requested));
        return 'present' as const;
      } catch (error) {
        // A refusal to look is not an answer: only a path that is not there is absent.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent' as const;
        throw error;
      }
    }));
  }

  private rebind(sessionId: string, wirePtyId: number): { ok: boolean } {
    const entry = this.ledger.get(sessionId);
    if (!entry) return { ok: false };
    const previousWire = this.coreToWire.get(entry.corePtyId);
    if (previousWire !== undefined) this.wireToCore.delete(previousWire);
    this.wireToCore.set(wirePtyId, entry.corePtyId);
    this.coreToWire.set(entry.corePtyId, wirePtyId);
    return { ok: true };
  }
}
