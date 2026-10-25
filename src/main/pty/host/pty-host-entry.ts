/**
 * The pty host: the `kangentic-pty-host` Electron utility process that owns
 * every node-pty instance, so PTY output never crosses the main process's
 * event loop (VS Code runs its terminals the same way). The work itself is in
 * `pty-host-core.ts`; this file adds the message loop, the host's own database
 * connection for raw transcripts, and the dev-only relays.
 *
 * Bundled by esbuild as its own entry (`.vite/build/pty-host.js`) and forked
 * from the unpacked tree, so node-pty and better-sqlite3 load from real
 * directories. Kept free of `electron`'s main-only modules, analytics and
 * Sentry by `tests/unit/pty-host-boundary.test.ts`.
 */

import { format } from 'node:util';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import { closeProjectDb, configureProjectDbAccess, getProjectDb, setWalAutoCheckpoint } from '../../db/database';
import { TranscriptRepository } from '../../db/repositories/transcript-repository';
import { agentRegistry } from '../../agent/agent-registry';
import { relaySlowSyncSpans, startEventLoopLagMonitor } from '../../diagnostics/event-loop-lag';
import { setTerminalTraceRelay } from '../terminal-trace';
import { skipConsoleListHelper } from '../spawn/conpty-console-list';
import { loadWin32OrphanApi } from '../process-tag/win32-reader';
import { createTaggedProcessReader } from '../process-tag/reader-factory';
import type { TranscriptSink } from '../buffer/transcript-writer';
import { PtyHostCore } from './pty-host-core';
import { HostProcessTable } from './host-process-table';
import { setMainExecutable } from './host-exec';
import { runToolThrough, type SpawnServiceHooks } from './host-spawn-service';
import { WorkerSpawnService, relayWorkerSpan, type SpawnWorkerHandle } from './worker-spawn-service';
import { toPtyHostError, type FromPtyHostMessage, type PtyHostInitMessage, type PtyHostRequest, type ToPtyHostMessage } from './protocol';

// This process forks node-pty's Windows kill helper too, under the same
// RunAsNode fuse as main: without this a packaged build boots a second
// Kangentic.exe on every kill (see conpty-console-list.ts).
skipConsoleListHelper();

/** How long the host merges "output happened" events per session: a flood
 *  costs main a few messages a second instead of one per chunk. */
const COALESCE_MS = 250;
/** After a shutdown, how long to wait for the PTYs' exit callbacks before
 *  exiting anyway, when main names no bound. An exit callback that lands after
 *  Node has stopped crashes the process (Sentry DESKTOP-C), so the host waits
 *  for them first. Main normally sends the bound: its quit drain's deadline
 *  less a margin, so this process is gone before main stops waiting for it. */
const DEFAULT_SHUTDOWN_EXIT_WAIT_MS = 1300;
const MAX_SHUTDOWN_EXIT_WAIT_MS = 10_000;
const SHUTDOWN_POLL_MS = 25;

const parentPort = process.parentPort;

function post(message: FromPtyHostMessage): void {
  parentPort.postMessage(message);
}

// The host's stdout is not captured and its stderr is kept for crash reports,
// so what it logs goes to main's log as messages. An error still writes to
// stderr too, where a crash report reads it.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try {
      post({ type: 'log', level, text: format(...args) });
    } catch {
      // The port is gone: the host is exiting.
    }
    if (level === 'error') original(...args);
  };
}

const transcriptRepositories = new WeakMap<Database.Database, TranscriptRepository>();

/**
 * The host's own connection to a project's database, for the raw transcript
 * pieces. Opened with `fileMustExist` and no migrations (main opened and
 * migrated it first), so a late flush for a deleted project throws and is
 * dropped instead of creating the file again.
 */
function transcriptSinkFor(projectId: string): TranscriptSink | null {
  let db: Database.Database;
  try {
    db = getProjectDb(projectId);
  } catch {
    return null;
  }
  let repository = transcriptRepositories.get(db);
  if (!repository) {
    repository = new TranscriptRepository(db);
    transcriptRepositories.set(db, repository);
  }
  return repository;
}

let core: PtyHostCore | null = null;

/**
 * Every child process this host starts runs on the spawn worker's thread, never
 * on this one, which carries every terminal's input and output: on Windows a
 * process start holds its thread for the whole CreateProcess, 190 to 454 ms a
 * git start under heavy disk IO (2026-10-25).
 */
function createSpawnService(message: PtyHostInitMessage, hooks: SpawnServiceHooks): WorkerSpawnService {
  return new WorkerSpawnService({
    ...hooks,
    mainExecutable: message.mainExecutable,
    createWorker: (data): SpawnWorkerHandle => {
      if (!message.spawnWorkerPath) throw new Error('main named no spawn worker');
      return new Worker(message.spawnWorkerPath, { workerData: data });
    },
    onSlowSpan: __KANGENTIC_DEV__
      ? relayWorkerSpan((label, ms) => post({ type: 'slow-span', label, ms: Math.round(ms) }))
      : undefined,
  });
}

function initialize(message: PtyHostInitMessage): void {
  configureProjectDbAccess({ projectsDir: message.projectsDir, migrate: false });
  setMainExecutable(message.mainExecutable);
  // The retrieval worker runs the PASSIVE checkpoints for every process; a
  // commit here must not run one on this thread.
  setWalAutoCheckpoint(0);
  let spawnService: WorkerSpawnService | null = null;
  const spawnServiceOf = (): WorkerSpawnService => {
    if (!spawnService) throw new Error('The pty host spawn service is not created yet');
    return spawnService;
  };
  /** POSIX: `ps` per call on the spawn worker (no child kept); unused on Windows. */
  const preKillProcessTable = new HostProcessTable({ createFallbackProbe: () => spawnServiceOf().processTableProbe() });
  core = new PtyHostCore({
    emit: post,
    resolveAgent: (_sessionId, agentName) => (agentName ? agentRegistry.get(agentName) : undefined),
    transcriptSinkFor,
    closeProject: (projectId) => closeProjectDb(projectId),
    coalesceMs: COALESCE_MS,
    createSpawnService: (hooks) => {
      spawnService = createSpawnService(message, hooks);
      return spawnService;
    },
    // macOS runs `lsappinfo` during a reap; it starts on the spawn worker too.
    createTaggedProcessReader: () => createTaggedProcessReader(process.platform, { runTool: runToolThrough(spawnServiceOf()) }),
    loadOrphanApi: () => loadWin32OrphanApi(),
    // POSIX only (the core ignores it on Windows): the shell's descendants
    // before a kill, for a reap's agent-exit wait (`exited-root-wait.ts`).
    listProcessesBeforeKill: () => preKillProcessTable.list(),
    onBatchStarted: (method) => post({ type: 'batch-started', method }),
  });
  if (__KANGENTIC_DEV__) {
    relaySlowSyncSpans((label, elapsedMs) => post({ type: 'slow-span', label, ms: Math.round(elapsedMs) }));
    setTerminalTraceRelay((sessionId, event, detail, ts) => post({ type: 'trace', sessionId, event, detail, ts }));
    // The host's own stall record (lag sampler, 1 ms delay histogram, GC), read
    // through `devLagReport`. The spans above only name wrapped work; this
    // catches a stall in anything else, the headless parse included.
    startEventLoopLagMonitor();
  }
  post({ type: 'ready' });
}

async function dispatchRequest(message: PtyHostRequest): Promise<void> {
  if (!core) {
    post({ type: 'reply', id: message.id, ok: false, error: { message: 'The pty host is not initialized' } });
    return;
  }
  try {
    const result = await core.handleRequest(message.method, message.params);
    post({ type: 'reply', id: message.id, ok: true, result });
  } catch (error) {
    post({ type: 'reply', id: message.id, ok: false, error: toPtyHostError(error) });
  }
}

/**
 * The app is quitting: flush the transcripts and exit once every PTY's exit
 * callback has run (main posts the kills), so none is dispatched after Node
 * stops.
 */
function shutdown(exitWaitMs: number | undefined): void {
  const hostCore = core;
  if (!hostCore) process.exit(0);
  hostCore.handleCommand({ type: 'shutdown' });
  const waitMs = typeof exitWaitMs === 'number' && Number.isFinite(exitWaitMs)
    ? Math.max(0, Math.min(MAX_SHUTDOWN_EXIT_WAIT_MS, exitWaitMs))
    : DEFAULT_SHUTDOWN_EXIT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const waitForExits = (): void => {
    if (hostCore.liveChildCount === 0 || Date.now() >= deadline) {
      process.exit(0);
      return;
    }
    setTimeout(waitForExits, SHUTDOWN_POLL_MS);
  };
  waitForExits();
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as ToPtyHostMessage;
  // A malformed payload is ignored, never thrown inside the handler.
  if (typeof message !== 'object' || message === null) return;
  switch (message.type) {
    case 'init':
      initialize(message);
      return;
    case 'request':
      void dispatchRequest(message);
      return;
    case 'shutdown':
      shutdown(message.exitWaitMs);
      return;
    case 'attachRendererPort': {
      // A renderer's own port: its keystrokes and output skip main entirely.
      const port = event.ports[0];
      if (port) core?.attachRendererPort(message.rendererId, port);
      return;
    }
    default:
      core?.handleCommand(message);
  }
});
