// #913 Phase 0, the flood spike: can one SSH connection carry every terminal for a host, and is
// system `ssh` or the `ssh2` library better? Not shipped, and nothing under src/ imports it.
//
// It starts an sshd container, installs pinned Node in it, and runs probe-ssh-flood-host.mjs over
// one SSH exec channel. That host multiplexes one echo session and N flood sessions over framed
// stdio. This client types into the echo session every 100 ms and records the echo latency of
// each keystroke, while it reads and acks the floods.
//
// Usage. Paths come from arguments, so nothing here names a machine:
//   node scripts/probe-ssh-flood.mjs setup   --public-key "<key>" [--port 2234] [--container <name>]
//   node scripts/probe-ssh-flood.mjs matrix  --key <file> --known-hosts <file> --ssh2-dir <dir>
//                                            --out <dir> --plan <name>[,<name>] [--port 2234]
//                                            [--electron <electron binary>] [--overwrite]
//                                            [--cipher <name>] [--seconds <n>]
//   node scripts/probe-ssh-flood.mjs report  --out <dir>
//   node scripts/probe-ssh-flood.mjs shape   --profile fifo|fair --rtt <ms> --rate <Mbit> --loss <percent>
//   node scripts/probe-ssh-flood.mjs teardown [--container <name>]
//   node scripts/probe-ssh-flood.mjs run     <one run, see parseRunOptions>
//   <electron> scripts/probe-ssh-flood.mjs electron <same flags as run>
//
// `--ssh2-dir` is a folder holding node_modules/ssh2, installed outside the repo. `matrix` starts
// from an empty `--known-hosts`, because every new container has new host keys.
//
// Plans:
//   floor   no SSH at all, for the event loop's timer floor on this machine
//   pipe    one flood with no shaping, to see what the rig's path can carry
//   base    RTT 50 and 0, caps 20 and 100 Mbit/s, three transports, idle, 1 and 4 floods
//   loss    the same at RTT 50 with 1% loss
//   sweep   4 floods at RTT 50, stepping the window down
//   cap     4 floods at RTT 50, a per-session cap at a quarter of the link, then 80% and 60% of that
//   second  4 floods with bulk output on a second connection, on a FIFO and on a flow-fair link
//   repeat  the passing window, three times per transport
//   tuned   `base` and `loss` at the passing window
//   electron  the client in an Electron utilityProcess, to read main's busy percent
//
// Transports:
//   ssh-direct  ssh child, its stdio read by the thread doing the framing
//   ssh-worker  ssh child started and read on a worker_threads worker, each chunk posted to the
//               framing thread, the shape of src/main/pty/host/worker-spawn-service.ts
//   ssh2        the ssh2 library's exec channel in the framing thread
//
// Accepts `--kangentic-no-activity-hold` and ignores it: a matrix runs for an hour in the
// background, and the flag keeps it from holding a task active.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { encodeFrame, FRAME_HEADER_BYTES, FrameType } from './probe-ssh-flood-host.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOST_SCRIPT_PATH = path.join(path.dirname(SCRIPT_PATH), 'probe-ssh-flood-host.mjs');
const DEFAULT_CONTAINER = 'kangentic-ssh-rig-flood';
const DEFAULT_PORT = 2234;
const NODE_VERSION = 'v24.15.0';
const REMOTE_NODE = '/home/dev/node/bin/node';
const REMOTE_HOST_SCRIPT = '/home/dev/probe-ssh-flood-host.mjs';
const RIG_IMAGE = 'kangentic-ssh-rig';
const RIG_USER = 'dev';

const STOCK_HIGH_WATER = 1024 * 1024;
const STOCK_LOW_WATER = 256 * 1024;
/** Linux hands a PTY reader at most about 4 KB at a time. */
const FLOOD_FRAME_BYTES = 4096;
const KEYSTROKE_INTERVAL_MS = 100;
const WARM_UP_MS = 5000;
const ECHO_DRAIN_MS = 10000;
const NETEM_LIMIT_PACKETS = 1000;
const ECHO_SESSION_ID = 1;
const FIRST_FLOOD_SESSION_ID = 2;
const TRANSPORTS = ['ssh-direct', 'ssh-worker', 'ssh2'];

function parseFlags(argumentList) {
  const flags = {};
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    const value = argumentList[index + 1];
    if (value === undefined || value.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = value;
      index += 1;
    }
  }
  return flags;
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil((percent / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

/**
 * The Windows system client by full path. A bare `ssh` resolves through PATH, and from Git Bash
 * that finds Git's own MSYS OpenSSH, a different build that refuses `-F NUL`.
 */
function systemSshBinary() {
  if (process.platform !== 'win32') return 'ssh';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
}

function sshArguments(options) {
  const args = [
    '-v',
    '-p', String(options.port),
    '-i', options.key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${options.knownHosts}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-F', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
  if (options.cipher) args.push('-c', options.cipher);
  args.push(`${RIG_USER}@127.0.0.1`, REMOTE_NODE, REMOTE_HOST_SCRIPT);
  return args;
}

/** ssh's own CPU seconds. It runs beside the client, so a fair count of the crypto includes it. */
function readChildCpuSeconds(pid) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CPU`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk.toString('utf8'); });
    child.on('close', () => {
      const seconds = Number.parseFloat(text.trim());
      resolve(Number.isFinite(seconds) ? seconds : null);
    });
    child.on('error', () => resolve(null));
  });
}

function openDirectSsh(options, handlers) {
  const child = spawn(options.sshBinary, sshArguments(options), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', handlers.onChunk);
  child.stderr.on('data', (chunk) => handlers.onDiagnostic(chunk.toString('utf8')));
  child.on('exit', handlers.onExit);
  child.stdin.on('error', () => {});
  return {
    write: (data) => child.stdin.write(data),
    close: () => child.kill(),
    pids: () => [child.pid],
  };
}

/** The worker side of ssh-worker. Runs only inside a worker_threads Worker. */
function runSshWorker() {
  const child = spawn(workerData.sshBinary, workerData.sshArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  parentPort.postMessage({ type: 'started', pid: child.pid });
  child.stdout.on('data', (chunk) => parentPort.postMessage({ type: 'chunk', data: chunk }));
  child.stderr.on('data', (chunk) => parentPort.postMessage({ type: 'diagnostic', text: chunk.toString('utf8') }));
  child.on('exit', (code) => {
    parentPort.postMessage({ type: 'exit', code });
    parentPort.close();
  });
  child.stdin.on('error', () => {});
  parentPort.on('message', (message) => {
    if (message.type === 'write') child.stdin.write(message.data);
    if (message.type === 'close') child.kill();
  });
}

function openWorkerSsh(options, handlers) {
  const worker = new Worker(SCRIPT_PATH, { workerData: { sshBinary: options.sshBinary, sshArgs: sshArguments(options) } });
  let childPid = null;
  worker.on('message', (message) => {
    switch (message.type) {
      case 'started':
        childPid = message.pid;
        return;
      case 'chunk':
        handlers.onChunk(message.data);
        return;
      case 'diagnostic':
        handlers.onDiagnostic(message.text);
        return;
      case 'exit':
        handlers.onExit(message.code);
        return;
      default:
    }
  });
  worker.on('error', (error) => handlers.onDiagnostic(`worker error: ${error.message}\n`));
  return {
    write: (data) => worker.postMessage({ type: 'write', data }),
    close: () => worker.postMessage({ type: 'close' }),
    pids: () => [childPid],
  };
}

/** One ssh2 connection, ready for `exec` calls. Reports the negotiated algorithms. */
function connectSsh2(options, handlers) {
  const require = createRequire(path.join(path.resolve(options.ssh2Dir), 'package.json'));
  const { Client } = require('ssh2');
  const connection = new Client();
  connection.on('handshake', (negotiated) => handlers.onDiagnostic(`ssh2 negotiated ${JSON.stringify(negotiated)}\n`));
  connection.on('error', (error) => handlers.onDiagnostic(`ssh2 error: ${error.message}\n`));
  const connected = new Promise((resolve) => connection.once('ready', resolve));
  connection.connect({
    host: '127.0.0.1',
    port: options.port,
    username: RIG_USER,
    privateKey: fs.readFileSync(options.key),
    hostVerifier: () => true,
    readyTimeout: 30000,
    algorithms: options.cipher ? { cipher: [options.cipher] } : undefined,
  });
  return { connection, connected };
}

function openSsh2Channel(connectionHandle, handlers) {
  let channel = null;
  const pendingWrites = [];
  connectionHandle.connected.then(() => {
    connectionHandle.connection.exec(`${REMOTE_NODE} ${REMOTE_HOST_SCRIPT}`, (error, stream) => {
      if (error) {
        handlers.onDiagnostic(`ssh2 exec failed: ${error.message}\n`);
        return;
      }
      channel = stream;
      stream.on('data', handlers.onChunk);
      stream.stderr.on('data', (chunk) => handlers.onDiagnostic(chunk.toString('utf8')));
      stream.on('close', () => handlers.onExit(0));
      for (const data of pendingWrites) stream.write(data);
      pendingWrites.length = 0;
    });
  });
  return {
    write: (data) => {
      if (channel) channel.write(data);
      else pendingWrites.push(data);
    },
    close: () => connectionHandle.connection.end(),
    pids: () => [],
  };
}

/** Reads frames out of a byte stream. A data payload is counted and skipped, never copied. */
class FrameReader {
  constructor(onData, onFrame) {
    this.onData = onData;
    this.onFrame = onFrame;
    this.header = Buffer.alloc(FRAME_HEADER_BYTES);
    this.headerFill = 0;
    this.sessionId = 0;
    this.frameType = 0;
    this.payloadRemaining = 0;
    this.payload = null;
    this.payloadFill = 0;
  }

  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payloadRemaining > 0) {
        const take = Math.min(this.payloadRemaining, chunk.length - offset);
        if (this.frameType === FrameType.data) {
          this.onData(this.sessionId, take);
        } else {
          chunk.copy(this.payload, this.payloadFill, offset, offset + take);
          this.payloadFill += take;
        }
        offset += take;
        this.payloadRemaining -= take;
        if (this.payloadRemaining === 0 && this.frameType !== FrameType.data) {
          this.onFrame(this.sessionId, this.frameType, this.payload);
        }
        continue;
      }
      const take = Math.min(FRAME_HEADER_BYTES - this.headerFill, chunk.length - offset);
      chunk.copy(this.header, this.headerFill, offset, offset + take);
      this.headerFill += take;
      offset += take;
      if (this.headerFill < FRAME_HEADER_BYTES) continue;
      this.headerFill = 0;
      this.payloadRemaining = this.header.readUInt32BE(0);
      this.sessionId = this.header.readUInt32BE(4);
      this.frameType = this.header.readUInt8(8);
      if (this.payloadRemaining > 16 * 1024 * 1024 || this.frameType < FrameType.ready || this.frameType > FrameType.stats) {
        throw new Error(`Bad frame: type ${this.frameType}, ${this.payloadRemaining} bytes`);
      }
      if (this.frameType !== FrameType.data) {
        this.payload = Buffer.alloc(this.payloadRemaining);
        this.payloadFill = 0;
        if (this.payloadRemaining === 0) this.onFrame(this.sessionId, this.frameType, this.payload);
      }
    }
  }
}

function parseRunOptions(flags) {
  return {
    transport: String(flags.transport ?? 'ssh-direct'),
    floods: Number(flags.floods ?? 0),
    seconds: Number(flags.seconds ?? 60),
    highWater: Number(flags['high-water'] ?? STOCK_HIGH_WATER),
    lowWater: Number(flags['low-water'] ?? STOCK_LOW_WATER),
    capBytesPerSecond: Number(flags['cap-bytes-per-second'] ?? 0),
    bulk: String(flags.bulk ?? 'none'),
    cipher: flags.cipher ? String(flags.cipher) : null,
    port: Number(flags.port ?? DEFAULT_PORT),
    key: flags.key ? String(flags.key) : null,
    knownHosts: flags['known-hosts'] ? String(flags['known-hosts']) : null,
    ssh2Dir: flags['ssh2-dir'] ? String(flags['ssh2-dir']) : null,
    sshBinary: flags['ssh-binary'] ? String(flags['ssh-binary']) : systemSshBinary(),
    out: flags.out ? String(flags.out) : null,
  };
}

/** One measured run. `onWindow` hears when the measured window opens and closes. */
async function runClient(options, onWindow = () => {}) {
  const pendingKeystrokes = new Map();
  const latencies = [];
  const dueLatencies = [];
  const sendSkews = [];
  const floodSessionIds = [];
  for (let index = 0; index < options.floods; index += 1) floodSessionIds.push(FIRST_FLOOD_SESSION_ID + index);
  const receivedBytes = new Map(floodSessionIds.map((sessionId) => [sessionId, 0]));
  const diagnostics = [];
  const hostStats = [];
  const links = [];
  const useBulkLink = options.floods > 0 && options.bulk !== 'none';
  const linkCount = options.transport === 'none' ? 0 : useBulkLink ? 2 : 1;
  const linkForSession = (sessionId) => links[useBulkLink && sessionId !== ECHO_SESSION_ID ? 1 : 0];

  const openedAtMs = performance.now();
  let connectMs = null;
  const readyLinks = [];
  const statsWaiters = [];
  let sharedSsh2 = null;

  for (let linkIndex = 0; linkIndex < linkCount; linkIndex += 1) {
    const creditOwed = new Map();
    const reader = new FrameReader(
      (sessionId, bytes) => {
        receivedBytes.set(sessionId, (receivedBytes.get(sessionId) ?? 0) + bytes);
        creditOwed.set(sessionId, (creditOwed.get(sessionId) ?? 0) + bytes);
      },
      (sessionId, frameType, payload) => {
        if (frameType === FrameType.echo) {
          const sequence = payload.readUInt32BE(0);
          const keystroke = pendingKeystrokes.get(sequence);
          if (keystroke === undefined) return;
          pendingKeystrokes.delete(sequence);
          const echoedAtMs = performance.now();
          latencies.push(echoedAtMs - keystroke.sentAtMs);
          dueLatencies.push(echoedAtMs - keystroke.dueAtMs);
        } else if (frameType === FrameType.ready) {
          readyLinks.push(linkIndex);
          connectMs = performance.now() - openedAtMs;
        } else if (frameType === FrameType.stats) {
          hostStats.push(JSON.parse(payload.toString('utf8')));
          statsWaiters.shift()?.();
        }
      },
    );
    const handlers = {
      onChunk: (chunk) => {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        // One ack per chunk read, per session, as the renderer acks one per xterm write.
        for (const [sessionId, bytes] of creditOwed) {
          const payload = Buffer.allocUnsafe(4);
          payload.writeUInt32BE(bytes, 0);
          links[linkIndex].write(encodeFrame(sessionId, FrameType.credit, payload));
        }
        creditOwed.clear();
      },
      onDiagnostic: (text) => diagnostics.push(text),
      onExit: () => {},
    };
    if (options.transport === 'ssh-direct') {
      links.push(openDirectSsh(options, handlers));
    } else if (options.transport === 'ssh-worker') {
      links.push(openWorkerSsh(options, handlers));
    } else if (options.transport === 'ssh2') {
      if (!sharedSsh2 || options.bulk === 'connection') sharedSsh2 = connectSsh2(options, handlers);
      links.push(openSsh2Channel(sharedSsh2, handlers));
    } else {
      throw new Error(`Unknown transport ${options.transport}`);
    }
  }

  const connectDeadlineMs = performance.now() + 30000;
  while (readyLinks.length < linkCount) {
    if (performance.now() > connectDeadlineMs) throw new Error(`No ready frame. ${diagnostics.join('').slice(-2000)}`);
    await delay(5);
  }

  const settings = Buffer.from(JSON.stringify({
    highWater: options.highWater,
    lowWater: options.lowWater,
    frameBytes: FLOOD_FRAME_BYTES,
    capBytesPerSecond: options.capBytesPerSecond,
  }), 'utf8');
  for (const link of links) link.write(encodeFrame(0, FrameType.config, settings));
  if (linkCount > 0) {
    linkForSession(ECHO_SESSION_ID).write(encodeFrame(ECHO_SESSION_ID, FrameType.open, Buffer.from('echo', 'utf8')));
    for (const sessionId of floodSessionIds) {
      linkForSession(sessionId).write(encodeFrame(sessionId, FrameType.open, Buffer.from('flood', 'utf8')));
    }
  }

  // The floods run first, so the queues are at their steady depth when typing starts.
  await delay(WARM_UP_MS);
  const childPids = links.flatMap((link) => link.pids()).filter(Boolean);
  const childCpuStartedAtMs = performance.now();
  const childCpuStart = await Promise.all(childPids.map(readChildCpuSeconds));
  await delay(500);

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
  eventLoopDelay.enable();
  onWindow('open');
  const bytesAtOpen = new Map(receivedBytes);
  const cpuAtOpen = process.cpuUsage();
  const windowOpenedAtMs = performance.now();
  const keystrokeCount = Math.round((options.seconds * 1000) / KEYSTROKE_INTERVAL_MS);
  for (let sequence = 0; sequence < keystrokeCount; sequence += 1) {
    const dueAtMs = windowOpenedAtMs + sequence * KEYSTROKE_INTERVAL_MS;
    await delay(dueAtMs - performance.now());
    if (linkCount === 0) continue;
    const payload = Buffer.alloc(16);
    payload.writeUInt32BE(sequence, 0);
    const sentAtMs = performance.now();
    sendSkews.push(sentAtMs - dueAtMs);
    pendingKeystrokes.set(sequence, { sentAtMs, dueAtMs });
    linkForSession(ECHO_SESSION_ID).write(encodeFrame(ECHO_SESSION_ID, FrameType.keystroke, payload));
  }
  const windowClosedAtMs = performance.now();
  const wallSeconds = (windowClosedAtMs - windowOpenedAtMs) / 1000;
  const cpu = process.cpuUsage(cpuAtOpen);
  const bytesAtClose = new Map(receivedBytes);
  eventLoopDelay.disable();
  onWindow('close');

  // Started before the echo drain, which can last 10 s on a lossy cell while the floods still run.
  const childCpuEndedAtMs = performance.now();
  const childCpuEndRead = Promise.all(childPids.map(readChildCpuSeconds));
  const drainDeadlineMs = performance.now() + ECHO_DRAIN_MS;
  while (pendingKeystrokes.size > 0 && performance.now() < drainDeadlineMs) await delay(20);
  const childCpuEnd = await childCpuEndRead;

  // Every link is stopped, and its stats collected, before any closes: the ssh2 channel cells share one
  // connection, and closing the first link ends it for the second, whose stop then reaches nothing.
  for (const link of links) {
    const stopped = new Promise((resolve) => statsWaiters.push(resolve));
    link.write(encodeFrame(0, FrameType.stop, Buffer.alloc(0)));
    await Promise.race([stopped, delay(5000)]);
  }
  for (const link of links) link.close();

  const sorted = [...latencies].sort((left, right) => left - right);
  const sortedFromDue = [...dueLatencies].sort((left, right) => left - right);
  const perSessionMbps = floodSessionIds.map((sessionId) => {
    const bytes = (bytesAtClose.get(sessionId) ?? 0) - (bytesAtOpen.get(sessionId) ?? 0);
    return (bytes * 8) / wallSeconds / 1e6;
  });
  let childCpuPercent = null;
  if (childPids.length > 0 && childCpuStart.every((value) => value !== null) && childCpuEnd.every((value) => value !== null)) {
    const seconds = childCpuEnd.reduce((sum, value, index) => sum + value - childCpuStart[index], 0);
    // Over the span between the two reads, which starts before the window opens.
    childCpuPercent = (seconds / ((childCpuEndedAtMs - childCpuStartedAtMs) / 1000)) * 100;
  }
  const diagnosticText = diagnostics.join('');
  const sortedSkews = [...sendSkews].sort((left, right) => left - right);
  return {
    options: { ...options, key: undefined, knownHosts: undefined, ssh2Dir: undefined, out: undefined },
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    connectMs,
    keystrokesSent: sendSkews.length,
    keystrokesLost: pendingKeystrokes.size,
    latencyMs: {
      min: sorted[0] ?? null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? null,
    },
    // From when the key was due. A client stall delays the send, so it shows here and not in latencyMs.
    latencyFromDueMs: {
      p50: percentile(sortedFromDue, 50),
      p99: percentile(sortedFromDue, 99),
    },
    sendSkewP99Ms: percentile(sortedSkews, 99),
    perSessionMbps,
    aggregateMbps: perSessionMbps.reduce((sum, value) => sum + value, 0),
    clientCpuPercent: ((cpu.user + cpu.system) / 1e6 / wallSeconds) * 100,
    childCpuPercent,
    eventLoopDelayMs: {
      p50: eventLoopDelay.percentile(50) / 1e6,
      p99: eventLoopDelay.percentile(99) / 1e6,
      max: eventLoopDelay.max / 1e6,
    },
    cipher: (diagnosticText.match(/kex: server->client cipher: (\S+)/) ?? diagnosticText.match(/"cs":\{"cipher":"([^"]+)"/) ?? [])[1] ?? null,
    clientBuild: (diagnosticText.match(/debug1: (OpenSSH\S+)/) ?? [])[1] ?? null,
    hostStats,
    diagnosticTail: diagnosticText.includes('error') ? diagnosticText.slice(-400) : null,
    latencies: sorted.map((value) => Math.round(value * 100) / 100),
  };
}

function writeResult(options, result) {
  if (!options.out) {
    process.stdout.write(`${JSON.stringify({ ...result, latencies: undefined }, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
}

// --- Electron: the client in a utilityProcess, main reads its own busy percent. ---

async function runElectronMain(flags) {
  const electronModule = await import('electron');
  const { app, utilityProcess } = electronModule.default ?? electronModule;
  await app.whenReady();
  const passThrough = process.argv.slice(process.argv.indexOf('electron') + 1);
  const child = utilityProcess.fork(SCRIPT_PATH, ['run', '--in-utility', ...passThrough], { stdio: 'inherit', serviceName: 'kangentic-ssh-link-probe' });
  let cpuAtOpen = null;
  let openedAtMs = 0;
  let mainBusyPercent = null;
  child.on('message', (message) => {
    if (message === 'open') {
      cpuAtOpen = process.cpuUsage();
      openedAtMs = performance.now();
    } else if (message === 'close' && cpuAtOpen) {
      const cpu = process.cpuUsage(cpuAtOpen);
      mainBusyPercent = ((cpu.user + cpu.system) / 1e6 / ((performance.now() - openedAtMs) / 1000)) * 100;
    }
  });
  child.on('exit', () => {
    if (flags.out && fs.existsSync(String(flags.out))) {
      const result = JSON.parse(fs.readFileSync(String(flags.out), 'utf8'));
      fs.writeFileSync(String(flags.out), `${JSON.stringify({ ...result, mainBusyPercent }, null, 2)}\n`);
    }
    app.quit();
  });
}

// --- The rig: container, shaping. ---

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function dockerExecShell(container, command, options) {
  return docker(['exec', container, 'sh', '-c', command], options);
}

function setupRig(flags) {
  if (typeof flags['public-key'] !== 'string') throw new Error('setup needs --public-key "<key>"');
  const container = String(flags.container ?? DEFAULT_CONTAINER);
  const port = Number(flags.port ?? DEFAULT_PORT);
  docker(['rm', '-f', container], { allowFailure: true });
  docker(['run', '-d', '--name', container, '--cap-add', 'NET_ADMIN', '-p', `127.0.0.1:${port}:22`, '-e', `AUTHORIZED_KEY=${flags['public-key']}`, RIG_IMAGE]);
  try {
    dockerExecShell(container, 'apt-get update -qq && apt-get install -y -qq ethtool');
    const archive = `node-${NODE_VERSION}-linux-x64.tar.xz`;
    dockerExecShell(container, [
      'set -e',
      'mkdir -p /tmp/node-download /home/dev/node',
      'cd /tmp/node-download',
      `curl -fsSLO https://nodejs.org/dist/${NODE_VERSION}/${archive}`,
      `curl -fsSLO https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`,
      `grep " ${archive}$" SHASUMS256.txt | sha256sum -c -`,
      `tar -xJf ${archive} -C /home/dev/node --strip-components=1`,
      'chown -R dev:dev /home/dev/node',
    ].join(' && '));
    docker(['cp', HOST_SCRIPT_PATH, `${container}:${REMOTE_HOST_SCRIPT}`]);
    dockerExecShell(container, `chown dev:dev ${REMOTE_HOST_SCRIPT}`);
    // netem counts a queued packet, not a byte, so an offload super-packet would be one entry.
    // 1% loss would also drop 44 packets at a time.
    dockerExecShell(container, 'ethtool -K eth0 tso off gso off gro off');
    process.stdout.write(`${dockerExecShell(container, `${REMOTE_NODE} --version`)}`);
  } catch (error) {
    docker(['rm', '-f', container], { allowFailure: true });
    throw error;
  }
}

function clearShaping(container) {
  for (const command of [
    'tc qdisc del dev eth0 root',
    'tc qdisc del dev eth0 ingress',
    'tc qdisc del dev ifb0 root',
    'ip link del ifb0',
  ]) dockerExecShell(container, `${command} 2>/dev/null; true`, { allowFailure: true });
}

/** `fifo` is plain netem. `fair` keeps the same rate, but its queue is per flow (fq_codel). */
function applyShaping(container, shaping) {
  clearShaping(container);
  if (shaping.profile === 'none') return;
  if (shaping.profile === 'fifo') {
    const parts = ['tc qdisc replace dev eth0 root netem', `delay ${shaping.rttMs}ms`];
    if (shaping.rateMbit) parts.push(`rate ${shaping.rateMbit}mbit`);
    if (shaping.lossPercent) parts.push(`loss ${shaping.lossPercent}%`);
    parts.push(`limit ${NETEM_LIMIT_PACKETS}`);
    dockerExecShell(container, parts.join(' '));
    return;
  }
  // The rate must come before the delay for a queue to form in fq_codel, and a qdisc cannot do
  // both in that order on one device, so the delay sits on the keystroke direction instead.
  dockerExecShell(container, [
    `tc qdisc add dev eth0 root handle 1: tbf rate ${shaping.rateMbit}mbit burst 32k latency 2000ms`,
    'tc qdisc add dev eth0 parent 1:1 handle 10: fq_codel',
    'ip link add ifb0 type ifb',
    'ip link set ifb0 up',
    `tc qdisc add dev ifb0 root netem delay ${shaping.rttMs}ms limit ${NETEM_LIMIT_PACKETS}`,
    'tc qdisc add dev eth0 handle ffff: ingress',
    'tc filter add dev eth0 parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0',
  ].join(' && '));
}

// --- Plans. ---

function cell(transport, rttMs, rateMbit, floods, extra = {}) {
  return { transport, floods, shaping: { profile: 'fifo', rttMs, rateMbit, lossPercent: 0 }, ...extra };
}

function fullMatrix(window = {}, tag = '') {
  const cells = [];
  for (const rttMs of [50, 0]) {
    for (const transport of TRANSPORTS) {
      cells.push(cell(transport, rttMs, 100, 0, { ...window, tag }));
      for (const rateMbit of [20, 100]) {
        for (const floods of [1, 4]) cells.push(cell(transport, rttMs, rateMbit, floods, { ...window, tag }));
      }
    }
  }
  return cells;
}

function lossMatrix(window = {}, tag = '') {
  const cells = [];
  for (const transport of TRANSPORTS) {
    const shaping = (rateMbit) => ({ profile: 'fifo', rttMs: 50, rateMbit, lossPercent: 1 });
    cells.push({ transport, floods: 0, shaping: shaping(100), ...window, tag });
    for (const rateMbit of [20, 100]) {
      for (const floods of [1, 4]) cells.push({ transport, floods, shaping: shaping(rateMbit), ...window, tag });
    }
  }
  return cells;
}

function windowOf(highWater) {
  return { highWater, lowWater: Math.floor(highWater / 4) };
}

function plannedCells(planName, flags) {
  const passingWindow = windowOf(Number(flags['passing-window'] ?? 64 * 1024));
  switch (planName) {
    case 'floor':
      return [{ transport: 'none', floods: 0, shaping: { profile: 'none' } }];
    case 'pipe':
      return TRANSPORTS.map((transport) => ({ transport, floods: 1, seconds: 15, shaping: { profile: 'none' }, tag: 'unshaped' }));
    case 'base':
      return fullMatrix();
    case 'loss':
      return lossMatrix();
    case 'tuned':
      return [...fullMatrix(passingWindow, 'tuned'), ...lossMatrix(passingWindow, 'tuned')];
    case 'sweep': {
      const cells = [];
      const highWaters = String(flags.windows ?? '524288,262144,131072,65536,32768,16384').split(',').map(Number);
      for (const transport of TRANSPORTS) {
        for (const rateMbit of [20, 100]) {
          for (const highWater of highWaters) {
            cells.push(cell(transport, 50, rateMbit, 4, { ...windowOf(highWater), tag: 'sweep' }));
          }
        }
      }
      return cells;
    }
    case 'cap': {
      const cells = [];
      for (const transport of TRANSPORTS) {
        for (const rateMbit of [20, 100]) {
          // A quarter of the link, then 80% and 60% of that, stock window.
          for (const share of [1, 0.8, 0.6]) {
            const capBytesPerSecond = Math.round(((rateMbit * 1e6) / 8 / 4) * share);
            cells.push(cell(transport, 50, rateMbit, 4, { capBytesPerSecond, tag: 'cap' }));
          }
        }
      }
      return cells;
    }
    case 'second': {
      const cells = [];
      for (const profile of ['fifo', 'fair']) {
        for (const rateMbit of [20, 100]) {
          const shaping = { profile, rttMs: 50, rateMbit, lossPercent: 0 };
          for (const transport of TRANSPORTS) {
            cells.push({ transport, floods: 4, bulk: 'none', shaping, tag: `one-${profile}` });
            cells.push({ transport, floods: 4, bulk: 'connection', shaping, tag: `second-${profile}` });
          }
          cells.push({ transport: 'ssh2', floods: 4, bulk: 'channel', shaping, tag: `channel-${profile}` });
        }
      }
      return cells;
    }
    case 'repeat': {
      const cells = [];
      for (const transport of TRANSPORTS) {
        for (const rateMbit of [20, 100]) {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            cells.push(cell(transport, 50, rateMbit, 4, { ...passingWindow, tag: `repeat${attempt}` }));
          }
        }
      }
      return cells;
    }
    case 'electron':
      return TRANSPORTS.map((transport) => cell(transport, 50, 20, 4, { ...passingWindow, inElectron: true, tag: 'electron' }));
    default:
      throw new Error(`Unknown plan ${planName}`);
  }
}

function cellName(entry, planName) {
  const shaping = entry.shaping;
  const parts = [
    planName,
    entry.transport,
    `f${entry.floods}`,
    shaping.profile,
    `rtt${shaping.rttMs ?? 'x'}`,
    `rate${shaping.rateMbit ?? 'x'}`,
    `loss${shaping.lossPercent ?? 0}`,
    `hw${entry.highWater ?? STOCK_HIGH_WATER}`,
    `cap${entry.capBytesPerSecond ?? 0}`,
    `bulk${entry.bulk ?? 'none'}`,
    entry.tag ?? '',
  ];
  return parts.join('_').replace(/_+$/, '');
}

function runCellProcess(entry, flags, outputFile) {
  const runFlags = [
    '--transport', entry.transport,
    '--floods', String(entry.floods),
    '--seconds', String(entry.seconds ?? flags.seconds ?? 60),
    '--high-water', String(entry.highWater ?? STOCK_HIGH_WATER),
    '--low-water', String(entry.lowWater ?? STOCK_LOW_WATER),
    '--cap-bytes-per-second', String(entry.capBytesPerSecond ?? 0),
    '--bulk', String(entry.bulk ?? 'none'),
    '--port', String(flags.port ?? DEFAULT_PORT),
    '--key', String(flags.key),
    '--known-hosts', String(flags['known-hosts']),
    '--ssh2-dir', String(flags['ssh2-dir']),
    '--out', outputFile,
  ];
  if (flags.cipher) runFlags.push('--cipher', String(flags.cipher));
  const command = entry.inElectron ? String(flags.electron) : process.execPath;
  const commandArgs = entry.inElectron ? [SCRIPT_PATH, 'electron', ...runFlags] : [SCRIPT_PATH, 'run', ...runFlags];
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return spawnSync(command, commandArgs, { encoding: 'utf8', timeout: ((entry.seconds ?? Number(flags.seconds ?? 60)) + 90) * 1000, env: environment });
}

function runMatrix(flags) {
  const container = String(flags.container ?? DEFAULT_CONTAINER);
  const outputDirectory = path.resolve(String(flags.out));
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (typeof flags['known-hosts'] === 'string') fs.rmSync(flags['known-hosts'], { force: true });
  for (const planName of String(flags.plan).split(',')) {
    for (const entry of plannedCells(planName, flags)) {
      if (entry.inElectron && typeof flags.electron !== 'string') throw new Error(`plan ${planName} needs --electron <electron binary>`);
      const name = cellName(entry, planName);
      const outputFile = path.join(outputDirectory, `${name}.json`);
      if (fs.existsSync(outputFile) && !flags.overwrite) continue;
      // Gone before the run, so a failed run can never pass off the last result as its own.
      fs.rmSync(outputFile, { force: true });
      const startedAt = new Date().toISOString();
      applyShaping(container, entry.shaping);
      const run = runCellProcess(entry, flags, outputFile);
      if (!fs.existsSync(outputFile)) {
        // One retry: a dropped connection in setup is a rig fault and not a measurement.
        process.stdout.write(`RETRY ${name}: ${(run.stderr ?? '').slice(-600)}\n`);
        const retry = runCellProcess(entry, flags, outputFile);
        if (!fs.existsSync(outputFile)) {
          fs.writeFileSync(path.join(outputDirectory, `${name}.failed.txt`), `${retry.stdout}\n${retry.stderr}\n`);
          process.stdout.write(`FAILED ${name}\n`);
          continue;
        }
      }
      const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      fs.writeFileSync(outputFile, `${JSON.stringify({ ...result, cell: { ...entry, plan: planName, startedAt } }, null, 2)}\n`);
      const latency = result.latencyMs;
      process.stdout.write(`${name} p50 ${latency.p50?.toFixed(1)} p99 ${latency.p99?.toFixed(1)} max ${latency.max?.toFixed(1)} lost ${result.keystrokesLost} per-session ${result.perSessionMbps.map((value) => value.toFixed(1)).join(' ')} Mbit/s cpu ${result.clientCpuPercent.toFixed(1)}\n`);
    }
  }
  clearShaping(container);
}

// --- Report. ---

function formatNumber(value, digits = 1) {
  return value === null || value === undefined ? '-' : value.toFixed(digits);
}

function barFor(result) {
  const shaping = result.cell.shaping;
  if (shaping.rttMs !== 50 || shaping.lossPercent) return '';
  const limit = result.options.floods === 0 ? 100 : result.options.floods === 4 ? 200 : null;
  if (limit === null) return '';
  // The bar is what a typing user waits, so it reads from the due time. Older result files lack that field.
  const p99 = result.latencyFromDueMs?.p99 ?? result.latencyMs.p99;
  const pass = result.keystrokesLost === 0 && p99 !== null && p99 <= limit;
  return `${pass ? 'PASS' : 'FAIL'} (${limit})`;
}

function writeReport(flags) {
  const outputDirectory = path.resolve(String(flags.out));
  const rows = [];
  for (const fileName of fs.readdirSync(outputDirectory)) {
    if (!fileName.endsWith('.json')) continue;
    const result = JSON.parse(fs.readFileSync(path.join(outputDirectory, fileName), 'utf8'));
    if (result.cell) rows.push(result);
  }
  rows.sort((left, right) => (left.cell.startedAt < right.cell.startedAt ? -1 : 1));
  const header = '| Plan | Transport | Added RTT | Mbit/s | Loss | Queue | Floods | Window KiB | Cap Mbit/s | Bulk | min | p50 | p95 | p99 | p99 from due | max | Lost | Per session Mbit/s | Client CPU % | ssh CPU % | Loop p99 ms | Connect ms | Cipher | Bar |';
  const divider = `|${' --- |'.repeat(header.split('|').length - 2)}`;
  const lines = [header, divider];
  for (const result of rows) {
    const { cell: entry, options, latencyMs: latency } = result;
    const shaping = entry.shaping;
    const perSession = result.perSessionMbps.length === 0 ? '-' : result.perSessionMbps.map((value) => value.toFixed(1)).join(' ');
    const label = entry.tag ? `${entry.plan}/${entry.tag}` : entry.plan;
    lines.push(`| ${label} | ${options.transport} | ${shaping.rttMs ?? '-'} | ${shaping.rateMbit ?? '-'} | ${shaping.lossPercent ?? 0} | ${shaping.profile} | ${options.floods} | ${options.highWater / 1024} | ${options.capBytesPerSecond ? ((options.capBytesPerSecond * 8) / 1e6).toFixed(1) : '-'} | ${options.bulk} | ${formatNumber(latency.min)} | ${formatNumber(latency.p50)} | ${formatNumber(latency.p95)} | ${formatNumber(latency.p99)} | ${formatNumber(result.latencyFromDueMs?.p99)} | ${formatNumber(latency.max)} | ${result.keystrokesLost} | ${perSession} | ${formatNumber(result.clientCpuPercent)} | ${formatNumber(result.childCpuPercent)} | ${formatNumber(result.eventLoopDelayMs.p99)} | ${formatNumber(result.connectMs, 0)} | ${result.cipher ?? '-'} | ${barFor(result)} |`);
  }
  fs.writeFileSync(path.join(outputDirectory, 'table.md'), `${lines.join('\n')}\n`);
  process.stdout.write(`${rows.length} rows to ${path.join(outputDirectory, 'table.md')}\n`);
}

// --- Entry. ---

async function main() {
  const mode = process.argv.includes('electron') && process.type === 'browser' ? 'electron' : process.argv[2];
  const flags = parseFlags(process.argv.slice(2));
  switch (mode) {
    case 'setup':
      setupRig(flags);
      return;
    case 'teardown':
      docker(['rm', '-f', String(flags.container ?? DEFAULT_CONTAINER)], { allowFailure: true });
      return;
    case 'shape':
      applyShaping(String(flags.container ?? DEFAULT_CONTAINER), {
        profile: String(flags.profile ?? 'fifo'),
        rttMs: Number(flags.rtt ?? 0),
        rateMbit: Number(flags.rate ?? 0),
        lossPercent: Number(flags.loss ?? 0),
      });
      return;
    case 'matrix':
      runMatrix(flags);
      return;
    case 'report':
      writeReport(flags);
      return;
    case 'electron':
      // Not awaited: Electron holds `ready` until an ES module main finishes loading.
      runElectronMain(flags).catch((error) => {
        process.stderr.write(`${error.stack}\n`);
        process.exit(1);
      });
      return;
    case 'run': {
      const options = parseRunOptions(flags);
      const parent = process.parentPort;
      const result = await runClient(options, (edge) => parent?.postMessage(edge));
      writeResult(options, result);
      process.exit(0);
      return;
    }
    default:
      process.stderr.write(`Usage: see the header of ${path.basename(SCRIPT_PATH)} (${os.platform()})\n`);
      process.exitCode = 2;
  }
}

if (!isMainThread && workerData?.sshArgs) {
  runSshWorker();
} else if (isMainThread) {
  await main();
}
