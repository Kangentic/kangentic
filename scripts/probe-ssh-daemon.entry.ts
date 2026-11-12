/**
 * Spike entry for the #913 daemon probe: the real `PtyHostCore` behind a unix socket
 * under plain Node. Not product code. `scripts/probe-ssh-daemon.mjs` bundles it with
 * esbuild and copies it to the rig; run that script, not this file. `tsconfig.json`
 * covers `src/` only, so `npm run typecheck` does not see this file: esbuild strips the
 * types, and a change to the core's signatures shows up only when the probe runs.
 *
 *   node daemon.js --dir <0700 folder> [--socket-relative] [--sample-ms <n>]
 *
 * Differences from `pty-host-entry.ts`, each one a question the probe answers:
 * - No Electron parent port. Messages cross a socket as newline-delimited JSON.
 * - No database. The TranscriptSink is a stub that counts what it was given.
 * - `resolveAgent` answers undefined. The agent registry has its own bundle, so a
 *   failure there cannot block the survival runs (`probe-ssh-daemon.agent-check.ts`).
 * - The core keeps its own ptyIds. The wire ptyIds are mapped here, so a reattach can
 *   hand out fresh ones with no change to the core.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createTaggedProcessReader } from '../src/main/pty/process-tag/reader-factory';
import type { TranscriptSink } from '../src/main/pty/buffer/transcript-writer';
import { HostProcessTable } from '../src/main/pty/host/host-process-table';
import { runToolThrough, type SpawnServiceHooks } from '../src/main/pty/host/host-spawn-service';
import { PtyHostCore } from '../src/main/pty/host/pty-host-core';
import {
  toPtyHostError,
  type FromPtyHostMessage,
  type PtyHostCommand,
  type PtyHostMethod,
  type PtyHostRequestMap,
  type PtyHostSpawnParams,
  type PtyHostSpawnResult,
  type RendererPort,
} from '../src/main/pty/host/protocol';
import { WorkerSpawnService, type SpawnWorkerHandle } from '../src/main/pty/host/worker-spawn-service';
import type { FromPtyHostPortMessage } from '../src/shared/pty-port-protocol';

const RENDERER_ID = 1;
const COALESCE_MS = 250;
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const hostDir = path.resolve(argumentValue('--dir') ?? '');
const socketRelative = process.argv.includes('--socket-relative');
const sampleMs = Number(argumentValue('--sample-ms') ?? 0);
const logPath = path.join(hostDir, 'daemon.log');
const lastExitPath = path.join(hostDir, 'last-exit.json');
const startedAt = new Date().toISOString();

function log(line: string): void {
  fs.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
}

function readCgroup(): string {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
  } catch (error) {
    return `unreadable: ${String(error)}`;
  }
}

interface SessionRecord {
  sessionId: string;
  taskId: string | null;
  corePtyId: number;
  pid: number;
  alive: boolean;
  exitCode: number | null;
}

interface Connection {
  socket: net.Socket;
  epoch: number;
  port: SocketRendererPort | null;
}

const sessionsById = new Map<string, SessionRecord>();
const wireToCorePtyId = new Map<number, number>();
const coreToWirePtyId = new Map<number, number>();
const droppedEventCounts: Record<string, number> = {};
let nextCorePtyId = 1;
let currentConnection: Connection | null = null;
let nextEpoch = 1;
let transcriptChunks = 0;
let transcriptChars = 0;

/** Written at every death the process can see, then read by the next daemon. */
function recordExit(reason: string, detail?: string): void {
  try {
    fs.writeFileSync(lastExitPath, JSON.stringify({
      reason,
      detail,
      pid: process.pid,
      at: new Date().toISOString(),
      startedAt,
      cgroup: readCgroup(),
      liveSessions: [...sessionsById.values()].filter((session) => session.alive).length,
    }));
    log(`exit: ${reason} ${detail ?? ''}`);
  } catch {
    // The folder is gone. Nothing else can record this death.
  }
}

for (const signal of Object.keys(SIGNAL_NUMBERS)) {
  process.on(signal, () => {
    recordExit(signal);
    process.exit(128 + SIGNAL_NUMBERS[signal]);
  });
}
process.on('uncaughtException', (error) => {
  recordExit('uncaughtException', error.stack ?? String(error));
  process.exit(70);
});

function readPreviousExit(): unknown {
  try {
    const text = fs.readFileSync(lastExitPath, 'utf8');
    fs.renameSync(lastExitPath, `${lastExitPath}.seen`);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const previousExit = readPreviousExit();

function writeFrame(connection: Connection | null, frame: unknown): void {
  if (!connection || connection.socket.destroyed) return;
  connection.socket.write(`${JSON.stringify(frame)}\n`);
}

function countDropped(type: string): void {
  droppedEventCounts[type] = (droppedEventCounts[type] ?? 0) + 1;
}

/** Every event from the core. With no connection it is counted and dropped, never thrown. */
function emit(event: FromPtyHostMessage): void {
  if (event.type === 'exit') {
    const session = sessionsById.get(event.sessionId);
    if (session && session.corePtyId === event.ptyId) {
      session.alive = false;
      session.exitCode = event.exitCode;
    }
  }
  if (!currentConnection) {
    countDropped(event.type);
    return;
  }
  if ('ptyId' in event) {
    const wirePtyId = coreToWirePtyId.get(event.ptyId);
    if (wirePtyId === undefined) {
      countDropped(`${event.type}:unbound`);
      return;
    }
    writeFrame(currentConnection, { t: 'event', event: { ...event, ptyId: wirePtyId } });
    return;
  }
  writeFrame(currentConnection, { t: 'event', event });
}

/** A renderer's port, as the core sees it, over the one socket a connection has. */
class SocketRendererPort implements RendererPort {
  private messageListener: ((messageEvent: { data: unknown }) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private closed = false;

  constructor(private readonly connection: Connection) {}

  postMessage(message: FromPtyHostPortMessage): void {
    if (!this.closed) writeFrame(this.connection, { t: 'port', message });
  }

  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'message' | 'close', listener: ((messageEvent: { data: unknown }) => void) | (() => void)): unknown {
    if (event === 'message') this.messageListener = listener as (messageEvent: { data: unknown }) => void;
    else this.closeListener = listener as () => void;
    return this;
  }

  start(): void {
    // A socket frame is delivered as it is read.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.();
  }

  deliver(data: unknown): void {
    this.messageListener?.({ data });
  }
}

const transcriptSink: TranscriptSink = {
  appendChunk(_sessionId, chunk) {
    transcriptChunks += 1;
    transcriptChars += chunk.length;
  },
};

let spawnService: WorkerSpawnService | null = null;

function spawnServiceOf(): WorkerSpawnService {
  if (!spawnService) throw new Error('The spawn service is not created yet');
  return spawnService;
}

const preKillProcessTable = new HostProcessTable({ createFallbackProbe: () => spawnServiceOf().processTableProbe() });

const core = new PtyHostCore({
  emit,
  resolveAgent: () => undefined,
  transcriptSinkFor: () => transcriptSink,
  coalesceMs: COALESCE_MS,
  createSpawnService: (hooks: SpawnServiceHooks) => {
    spawnService = new WorkerSpawnService({
      ...hooks,
      createWorker: (data): SpawnWorkerHandle => new Worker(path.join(__dirname, 'spawn-worker.js'), { workerData: data }),
    });
    return spawnService;
  },
  createTaggedProcessReader: () => createTaggedProcessReader(process.platform, { runTool: runToolThrough(spawnServiceOf()) }),
  listProcessesBeforeKill: () => preKillProcessTable.list(),
});

/** One live PTY per task: the helper refuses a spawn beside a live PTY for the same task. */
function liveSessionForTask(taskId: string | null | undefined): SessionRecord | undefined {
  if (!taskId) return undefined;
  return [...sessionsById.values()].find((session) => session.alive && session.taskId === taskId);
}

async function spawnSession(params: PtyHostSpawnParams): Promise<PtyHostSpawnResult> {
  const live = liveSessionForTask(params.taskId);
  if (live) {
    return {
      ok: false,
      error: { message: `refused: task ${params.taskId} already has live PTY pid ${live.pid}`, code: 'SPAWN_REFUSED_LIVE' },
      previousScrollback: '',
    };
  }
  const corePtyId = nextCorePtyId++;
  const result = await core.handleRequest('spawn', { ...params, ptyId: corePtyId });
  if (result.ok) {
    wireToCorePtyId.set(params.ptyId, corePtyId);
    coreToWirePtyId.set(corePtyId, params.ptyId);
    sessionsById.set(params.sessionId, {
      sessionId: params.sessionId,
      taskId: params.taskId ?? null,
      corePtyId,
      pid: result.pid,
      alive: true,
      exitCode: null,
    });
  }
  return result;
}

/** A fresh wire ptyId for a session that outlived its connection. */
function rebind(sessionId: string, wirePtyId: number): { ok: boolean } {
  const session = sessionsById.get(sessionId);
  if (!session) return { ok: false };
  wireToCorePtyId.set(wirePtyId, session.corePtyId);
  coreToWirePtyId.set(session.corePtyId, wirePtyId);
  return { ok: true };
}

function translateCommand(command: PtyHostCommand): PtyHostCommand | null {
  if (!('ptyId' in command)) return command;
  const corePtyId = wireToCorePtyId.get(command.ptyId);
  return corePtyId === undefined ? null : { ...command, ptyId: corePtyId };
}

/** The one request that names a PTY the core already holds, so its wire id needs mapping. */
async function drainWrites(wirePtyId: number): Promise<true> {
  const corePtyId = wireToCorePtyId.get(wirePtyId);
  if (corePtyId === undefined) throw new Error(`no PTY is bound to wire ptyId ${wirePtyId}`);
  return core.handleRequest('drainWrites', { ptyId: corePtyId });
}

function sessionSummaries(): SessionRecord[] {
  return [...sessionsById.values()];
}

function statusSnapshot(): Record<string, unknown> {
  return {
    daemonPid: process.pid,
    daemonStartedAt: startedAt,
    cgroup: readCgroup(),
    sessions: sessionSummaries(),
    droppedEventCounts,
    transcriptChunks,
    transcriptChars,
    rssBytes: process.memoryUsage().rss,
    previousExit,
  };
}

/** A connection is gone or replaced: stop sending to it and let its PTYs run free. */
function detach(connection: Connection, reason: string): void {
  log(`detach epoch ${connection.epoch}: ${reason}`);
  if (currentConnection === connection) {
    currentConnection = null;
    core.handleCommand({ type: 'forgetRenderer', rendererId: RENDERER_ID });
    core.handleCommand({ type: 'releaseBackpressure', sessionIds: sessionSummaries().map((session) => session.sessionId) });
    wireToCorePtyId.clear();
    coreToWirePtyId.clear();
  }
}

/**
 * One owner at a time. The newest hello takes over, whatever the old connection's
 * state: under a dropped network the old relay stays connected with no one reading.
 * A close arriving afterwards from the old socket must not detach the new owner,
 * which is why `detach` compares connections rather than clearing unconditionally.
 */
function takeOwnership(connection: Connection): void {
  const previous = currentConnection;
  if (previous && previous !== connection) {
    writeFrame(previous, { t: 'closed', reason: 'taken over' });
    detach(previous, 'taken over');
    previous.socket.destroy();
  }
  connection.epoch = nextEpoch++;
  currentConnection = connection;
  connection.port = new SocketRendererPort(connection);
  core.attachRendererPort(RENDERER_ID, connection.port);
  log(`owner epoch ${connection.epoch}`);
}

type WireFrame =
  | { t: 'hello' }
  | { t: 'request'; id: number; method: string; params: unknown }
  | { t: 'command'; command: PtyHostCommand }
  | { t: 'port'; data: unknown };

async function answerRequest(connection: Connection, id: number, method: string, params: unknown): Promise<void> {
  try {
    let result: unknown;
    if (method === 'spawn') result = await spawnSession(params as PtyHostSpawnParams);
    else if (method === 'rebind') {
      const { sessionId, ptyId } = params as { sessionId: string; ptyId: number };
      result = rebind(sessionId, ptyId);
    } else if (method === 'drainWrites') result = await drainWrites((params as { ptyId: number }).ptyId);
    else result = await core.handleRequest(method as PtyHostMethod, params as PtyHostRequestMap[PtyHostMethod]['params']);
    writeFrame(connection, { t: 'reply', id, ok: true, result });
  } catch (error) {
    writeFrame(connection, { t: 'reply', id, ok: false, error: toPtyHostError(error) });
  }
}

function handleFrame(connection: Connection, frame: WireFrame): void {
  if (frame.t === 'hello') {
    if (connection !== currentConnection) takeOwnership(connection);
    writeFrame(connection, { t: 'hello', epoch: connection.epoch, ...statusSnapshot() });
    return;
  }
  if (connection !== currentConnection) return;
  if (frame.t === 'request') {
    void answerRequest(connection, frame.id, frame.method, frame.params);
    return;
  }
  if (frame.t === 'command') {
    const translated = translateCommand(frame.command);
    if (translated) core.handleCommand(translated);
    return;
  }
  if (frame.t === 'port') connection.port?.deliver(frame.data);
}

function handleConnection(socket: net.Socket): void {
  const connection: Connection = { socket, epoch: 0, port: null };
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      try {
        handleFrame(connection, JSON.parse(line) as WireFrame);
      } catch (error) {
        log(`dropped a malformed frame: ${String(error)}`);
      }
    }
  });
  socket.on('close', () => detach(connection, 'socket closed'));
  socket.on('error', (error) => log(`socket error: ${error.message}`));
}

/**
 * The start lock is an abstract socket: the bind is atomic and the kernel releases it
 * at any death, so two racing relays start one daemon and a stale socket file can be
 * removed safely. It is a lock only. Its name is open to every local user, so the
 * connection itself stays on the path inside the 0700 folder.
 */
function takeStartLock(onLocked: () => void): void {
  const uid = process.getuid?.() ?? 0;
  const hash = createHash('sha256').update(hostDir).digest('hex').slice(0, 16);
  const lock = net.createServer();
  lock.on('error', (error: NodeJS.ErrnoException) => {
    log(`start lock not taken: ${error.code ?? error.message}`);
    process.exit(0);
  });
  lock.listen(`\0kangentic-host-lock-${uid}-${hash}`, onLocked);
}

function listenOnSocket(): void {
  const socketPath = socketRelative ? 's' : path.join(hostDir, 's');
  if (socketRelative) process.chdir(hostDir);
  fs.rmSync(path.join(hostDir, 's'), { force: true });
  const server = net.createServer(handleConnection);
  server.on('error', (error: NodeJS.ErrnoException) => {
    recordExit('listen failed', `${error.code ?? ''} ${error.message}`);
    process.stderr.write(`listen failed: ${error.message}\n`);
    process.exit(71);
  });
  server.listen(socketPath, () => {
    fs.chmodSync(path.join(hostDir, 's'), 0o600);
    log(`listening on ${socketPath} (${path.join(hostDir, 's').length} characters absolute), node ${process.version}, cgroup ${readCgroup()}`);
  });
}

if (sampleMs > 0) {
  setInterval(() => {
    const diagnostics = core.getDiagnostics();
    fs.appendFileSync(path.join(hostDir, 'samples.jsonl'), `${JSON.stringify({
      at: Date.now(),
      rssBytes: process.memoryUsage().rss,
      socketQueuedBytes: currentConnection?.socket.writableLength ?? null,
      hasOwner: currentConnection !== null,
      pipeline: diagnostics.pipeline,
    })}\n`);
  }, sampleMs);
}

takeStartLock(listenOnSocket);
