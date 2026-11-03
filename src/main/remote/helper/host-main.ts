/**
 * The program that runs on the host for #913: `node host.js daemon` or `node host.js relay`.
 * A Linux program, built by esbuild as its own bundle (`app/host.js` in the host asset that
 * `scripts/build-host.mjs` packs), with node-pty beside it. It imports nothing of electron or better-sqlite3
 * (`tests/unit/remote-helper-boundary.test.ts`).
 *
 * - `daemon` owns the PTYs. It listens on a unix socket in a private folder and hands every
 *   connection to the `HelperServer`, so it outlives any one `ssh` connection.
 * - `relay` is what `ssh <host> node host.js relay` runs: it joins its own stdio to the daemon's
 *   socket, starting the daemon first when none is running. Its stdout carries frames and nothing
 *   else, so it never logs there.
 *
 * Phase 0 measured the choices here. The daemon starts as its own session (`detached`), because a
 * logout or a dropped `ssh` kills the rest of the process group. The socket is bound by a relative
 * name after a `chdir`, because a unix socket path over 108 bytes fails with EINVAL. Two relays that
 * race start one daemon: an abstract socket is the lock, the kernel releases it at any death, and
 * only a daemon that holds it listens.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentRegistry } from '../../agent/agent-registry';
import { HelperServer } from './helper-server';

const SOCKET_NAME = 's';
const DAEMON_LOG = 'daemon.log';
const LAST_EXIT = 'last-exit.json';
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const COALESCE_MS = 250;
const RELAY_CONNECT_WINDOW_MS = 8_000;
const RELAY_RETRY_MS = 100;

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hostDirectory(): string {
  const directory = path.resolve(argumentValue('--dir') ?? path.join(os.homedir(), '.kangentic', 'host', 'run'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function runDaemon(): void {
  const directory = hostDirectory();
  const logPath = path.join(directory, DAEMON_LOG);
  const startedAt = new Date().toISOString();
  const log = (line: string): void => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  };

  const recordExit = (reason: string, detail?: string): void => {
    try {
      fs.writeFileSync(path.join(directory, LAST_EXIT), JSON.stringify({ reason, detail, pid: process.pid, at: new Date().toISOString(), startedAt }));
      log(`exit: ${reason} ${detail ?? ''}`);
    } catch {
      // The folder is gone. Nothing else can record this.
    }
  };
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

  const server = new HelperServer({
    coreDeps: {
      resolveAgent: (_sessionId, agentName) => (agentName ? agentRegistry.get(agentName) : undefined),
      // The transcript spool is Phase 2's. Until then a host session keeps no raw transcript.
      transcriptSinkFor: () => null,
      coalesceMs: COALESCE_MS,
    },
    log,
  });

  // The start lock. Its name is open to every local user, so the connection stays on the path in the folder.
  const lock = net.createServer();
  lock.on('error', (error: NodeJS.ErrnoException) => {
    log(`start lock not taken: ${error.code ?? error.message}`);
    process.exit(0);
  });
  const uid = process.getuid?.() ?? 0;
  const lockName = `\0kangentic-host-lock-${uid}-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`;
  lock.listen(lockName, () => {
    process.chdir(directory);
    fs.rmSync(path.join(directory, SOCKET_NAME), { force: true });
    const socketServer = net.createServer((socket) => server.accept(socket));
    socketServer.on('error', (error: NodeJS.ErrnoException) => {
      recordExit('listen failed', `${error.code ?? ''} ${error.message}`);
      process.exit(71);
    });
    socketServer.listen(SOCKET_NAME, () => {
      fs.chmodSync(path.join(directory, SOCKET_NAME), 0o600);
      log(`listening in ${directory}, node ${process.version}`);
    });
  });
}

function connectToDaemon(directory: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // Relative, as the daemon binds it: the absolute path may be past the socket limit.
    process.chdir(directory);
    const socket = net.connect(SOCKET_NAME);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function startDaemon(directory: string): void {
  const child = spawn(process.execPath, [process.argv[1], 'daemon', '--dir', directory], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function runRelay(): Promise<void> {
  const directory = hostDirectory();
  const deadline = Date.now() + RELAY_CONNECT_WINDOW_MS;
  let started = false;
  for (;;) {
    try {
      const socket = await connectToDaemon(directory);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      socket.on('close', () => process.exit(0));
      process.stdin.on('end', () => socket.end());
      process.stdout.on('error', () => process.exit(0));
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      if (!started) {
        startDaemon(directory);
        started = true;
      }
      if (Date.now() > deadline) {
        throw new Error(`the Kangentic helper did not start within ${RELAY_CONNECT_WINDOW_MS / 1000} s (see ${path.join(directory, DAEMON_LOG)})`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_MS));
    }
  }
}

const command = process.argv[2];
if (command === 'daemon') {
  runDaemon();
} else if (command === 'relay') {
  runRelay().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`usage: node ${path.basename(process.argv[1] ?? 'host.js')} daemon|relay [--dir <folder>]\n`);
  process.exit(2);
}
