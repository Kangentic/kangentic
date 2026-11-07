#!/usr/bin/env node
// Local half of the #913 Phase 0 mirror spike: should CLI session folders reach Kangentic through a
// local read mirror or through remote reads, and are the mirror's numbers acceptable? Not shipped.
//
// Usage:
//   node scripts/probe-ssh-mirror.mjs <step> --scratch <dir> [options]
//
// <dir> holds rig/id_ed25519 and rig/id_ed25519.pub (a scratch key) and gets phase0/mirror/ for all
// output. The rig image must exist: docker build -t kangentic-ssh-rig scripts/probe-ssh-rig
//
// Steps, each writing phase0/mirror/results/<step>.json:
//   setup       start the container on 2235, install pinned Node with its checksum, copy the host
//               script, build the decision bundle from the real sources
//   generate    the Claude-shaped tree on the host (--files 5000 --total-bytes 2147483648)
//   status      status latency at idle, with 8 busy sessions, in-place writes, and with a sync in flight
//   reads       the same status read by `ssh cat` per poll and by one request on a held connection
//   sync        initial sync, drop and resume, deltas after a drop, gzip (--credit-mb 4)
//   stall       full syncs with no recovery, each desync counted (--repeats 3 --rekey-limit 64M --discard
//               --transport docker --ssh-path <exe> --ssh-config <path> --label <name>)
//   integrity   a counter stream through ssh.exe, to name who loses bytes (--only <keys a to m, default
//               c,e,a,b,d> --repeats 1 --total-mb 1536)
//   resumes     500 resumes with injected lag, by the helper and by the mirror, real decision code
//   inotify     watch counts, new-folder race, folder replaced by rename, queue overflow, exhaustion
//   paths       Windows only: path hazards with real writes, and the mapping the mirror must use
//   teardown    remove the container, its known_hosts and the local mirrors
//
// Run order: setup, generate, status, reads, sync, resumes, inotify, paths, teardown. Run one container step
// at a time. Each frame down the link carries a magic, its stream offset and a CRC, because System32 ssh.exe
// lost bytes in this traffic; a framing error ends the connection and the reconnect's manifest finds the gap.
// netem shapes the container's egress only, so `delay 50ms` puts all 50 ms on host to local.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { FRAME_MAGIC, hashRange, HASH_WINDOW, tailRange } from './probe-ssh-mirror-host.mjs';
import { mirrorPath, mirrorSegment, unmirrorSegment } from './probe-ssh-mirror-paths.mjs';

const execFileAsync = promisify(execFile);
const gunzip = promisify(zlib.gunzip);
const wallNow = () => performance.timeOrigin + performance.now();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WAIT_DEADLINE_MS = 5 * 60_000;
const SYNC_DEADLINE_MS = 30 * 60_000;

/** A host-side failure must end the run with a cause, not leave it spinning with netem on. */
async function waitFor(condition, label, timeoutMs = WAIT_DEADLINE_MS) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`gave up after ${timeoutMs} ms waiting for ${label}`);
    await delay(20);
  }
}

function withDeadline(promise, label, timeoutMs = SYNC_DEADLINE_MS) {
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${timeoutMs} ms waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const CONTAINER = 'kangentic-ssh-rig-mirror';
const PORT = 2235;
// Each probe pins the Node it measured on, so the pins can differ between probes.
const NODE_VERSION = '24.15.0';
const REMOTE_NODE = '/home/dev/node/bin/node';
const REMOTE_SCRIPT = '/home/dev/probe/host.mjs';
const REMOTE_BUNDLE = '/home/dev/probe/decision-bundle.cjs';
const HOST_HOME = '/home/dev';
const childEnvironment = { ...process.env };

function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) options[argv[index].slice(2)] = true;
      else { options[argv[index].slice(2)] = next; index += 1; }
    } else options._.push(argv[index]);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const step = options._[0];
const scratch = options.scratch ?? process.env.KANGENTIC_PROBE_SCRATCH;
if (!step || !scratch) { console.error('usage: probe-ssh-mirror.mjs <step> --scratch <dir>'); process.exit(2); }
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const workDirectory = path.join(scratch, 'phase0', 'mirror');
const resultsDirectory = path.join(workDirectory, 'results');
const keyPath = path.join(scratch, 'rig', 'id_ed25519');
const knownHostsPath = path.join(scratch, 'rig', 'known_hosts-mirror');
fs.mkdirSync(resultsDirectory, { recursive: true });

function saveResult(name, value) {
  fs.writeFileSync(path.join(resultsDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`[${name}] ${JSON.stringify(value).slice(0, 1500)}`);
}

function summarize(values) {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(1));
  return { count: sorted.length, min: Number(sorted[0].toFixed(1)), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Number(sorted.at(-1).toFixed(1)) };
}

async function run(command, args, { maxBuffer = 256 * 1024 * 1024, allowFailure = false, verbatim = false } = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer, env: childEnvironment, windowsVerbatimArguments: verbatim });
    return stdout;
  } catch (error) {
    if (allowFailure) return error.stdout ?? '';
    throw error;
  }
}
const dockerRoot = (command, container = CONTAINER) => run('docker', ['exec', container, 'sh', '-c', command]);
const dockerDev = (command, container = CONTAINER) => run('docker', ['exec', '-u', 'dev', '-w', HOST_HOME, container, 'sh', '-c', command]);
const hostProbe = (argumentsText) => dockerDev(`${REMOTE_NODE} ${REMOTE_SCRIPT} ${argumentsText}`);

const netemOff = () => run('docker', ['exec', CONTAINER, 'tc', 'qdisc', 'del', 'dev', 'eth0', 'root'], { allowFailure: true });
async function netemOn(extra = []) {
  await netemOff();
  await run('docker', ['exec', CONTAINER, 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', '50ms', ...extra]);
}
const netemStatistics = () => run('docker', ['exec', CONTAINER, 'tc', '-s', 'qdisc', 'show', 'dev', 'eth0']);

async function hostCounters() {
  const output = await dockerRoot('cat /sys/fs/cgroup/cpu.stat /sys/class/net/eth0/statistics/tx_bytes /sys/class/net/eth0/statistics/rx_bytes');
  const lines = output.trim().split('\n');
  const usage = Number(lines.find((line) => line.startsWith('usage_usec')).split(' ')[1]);
  return { cpuMicroseconds: usage, transmitBytes: Number(lines.at(-2)), receiveBytes: Number(lines.at(-1)) };
}

function counterDelta(before, after) {
  return {
    hostCpuSeconds: Number(((after.cpuMicroseconds - before.cpuMicroseconds) / 1e6).toFixed(1)),
    hostToLocalWireBytes: after.transmitBytes - before.transmitBytes,
    localToHostWireBytes: after.receiveBytes - before.receiveBytes,
  };
}

const extraSshOptions = [];
function sshArguments(remoteCommand) {
  return [...extraSshOptions, '-p', String(PORT), '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=accept-new', '-F', options['ssh-config'] ?? (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-T', 'dev@127.0.0.1', remoteCommand];
}

function sshExecutable() {
  if (options['ssh-path']) return options['ssh-path'];
  if (process.platform !== 'win32') return 'ssh';
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return fs.existsSync(system) ? system : 'ssh';
}

/** What carried the bytes in a stall or integrity result, so results from two clients can be compared. */
function transportLabel() {
  return options.transport === 'docker' ? 'docker exec' : sshExecutable();
}

// ---------- The link and the local writer ----------

async function renameWithRetry(source, target, onRetry) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fsPromises.rename(source, target); return; } catch (error) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      onRetry?.();
      await delay(5);
    }
  }
}

const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;

class Link {
  constructor(mirrorHome) {
    this.mirrorHome = mirrorHome;
    this.resyncs = [];
    this.autoResync = false;
    this.consumed = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.applyChain = Promise.resolve();
    this.statusChains = new Map();
    this.statusSamples = [];
    this.tornStatus = 0;
    this.statusRenameRetries = 0;
    this.errors = [];
    this.plan = null;
    this.held = [];
    this.heldFrames = [];
    this.openFile = null;
    this.hostMtimes = new Map();
    this.frameBytes = 0;
    this.up = false;
    this.payloadReceived = 0;
    this.onSyncDone = null;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.neededBytes = 0;
  }

  /** Starts the link. The promise resolves at the first sync's end, however many reconnects that takes. */
  connect(hello) {
    this.resyncHello = hello;
    this.finished ??= new Promise((resolve) => { this.onSyncDone = resolve; });
    this.start(hello);
    return this.finished;
  }

  start(hello) {
    const remote = `${REMOTE_NODE} ${REMOTE_SCRIPT} agent --decision-bundle ${REMOTE_BUNDLE}`;
    this.child = options.transport === 'docker'
      ? spawn('docker', ['exec', '-i', '-u', 'dev', '-w', HOST_HOME, CONTAINER, 'sh', '-c', `exec ${remote}`], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment, windowsHide: true })
      : spawn(sshExecutable(), sshArguments(remote), { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment, windowsHide: true });
    this.up = true;
    this.broken = false;
    this.buffered = []; this.bufferedBytes = 0; this.neededBytes = 0; this.consumed = 0;
    // A cached header belongs to the connection that parsed it, and every connection restarts at offset 0.
    this.parsedHeaderFor = -1; this.parsedHeader = null;
    const child = this.child;
    child.stdout.on('data', (chunk) => { if (child === this.child) this.onData(chunk); });
    child.stderr.on('data', (chunk) => { this.errors.push(`ssh: ${chunk.toString().trim()}`); });
    child.stdin.on('error', () => undefined);
    child.on('exit', () => {
      if (child !== this.child) return;
      this.up = false;
      for (const entry of this.pending.values()) entry.reject(new Error('link down'));
      this.pending.clear();
    });
    this.watchdog ??= setInterval(() => {
      // A partial frame that stops arriving: the bytes it waits for are gone.
      if (this.up && !this.broken && this.bufferedBytes > 0 && performance.now() - this.lastDataAt > 3000) this.desync('no bytes for 3 s inside a frame');
    }, 500);
    this.watchdog.unref?.();
    if (hello) this.send({ t: 'hello', ...hello });
  }

  /**
   * The stream has lost its place. A framing error ends the connection: nothing after it can be trusted,
   * and the manifest on the reconnect finds exactly what the mirror holds.
   */
  desync(reason) {
    if (this.broken) return;
    this.broken = true;
    const entry = { reason, atMs: Math.round(performance.now()), payloadReceived: this.payloadReceived, lastStatusAt: this.lastStatusAt ?? null };
    this.resyncs.push(entry);
    if (this.autoResync && this.resyncs.length <= 20) this.resyncInFlight = this.resync(entry);
  }

  /** The end of a run: a reconnect still in flight finishes first, so nothing writes after this. */
  async shutdown() {
    this.autoResync = false;
    await this.resyncInFlight;
    await this.kill();
  }

  async resync(entry) {
    const startedAt = performance.now();
    await this.kill();
    const manifest = await computeManifest(this.mirrorHome, this.hostMtimes);
    entry.manifestMs = Math.round(performance.now() - startedAt);
    this.pendingDark = entry;
    this.start({ ...this.resyncHello, manifest });
    entry.reconnectedMs = Math.round(performance.now() - startedAt);
  }

  send(header) {
    if (!this.up) return;
    const headerBytes = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(4 + headerBytes.length, 0);
    prefix.writeUInt32BE(headerBytes.length, 4);
    this.child.stdin.write(Buffer.concat([prefix, headerBytes]));
  }

  async kill() {
    if (!this.child) return;
    const child = this.child;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    const exited = alreadyExited ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, delay(3000)]);
    this.up = false;
    for (const entry of this.pending.values()) entry.reject(new Error('link down'));
    this.pending.clear();
    await this.drain();
    await this.closeOpenFile();
  }

  drain() { return this.applyChain; }

  rpc(method, params, timeoutMs = 5000) {
    if (!this.up) return Promise.reject(new Error('link down'));
    const id = this.nextId; this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ t: 'rpc', id, method, params });
    });
  }

  async ping() {
    if (!this.up) throw new Error('link down');
    const id = this.nextId; this.nextId += 1;
    const sentAt = wallNow();
    const hostAt = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.errors.push(`ping ${id} unanswered after 20 s, payload ${this.payloadReceived}`);
        reject(new Error('ping timeout'));
      }, 20_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.send({ t: 'ping', id });
    });
    return { sentAt, hostAt, receivedAt: wallNow() };
  }

  /** Offset host minus local, from the fastest tenth of pings on a symmetric path. */
  async measureClock(count = 300) {
    const samples = [];
    for (let index = 0; index < count; index += 1) {
      samples.push(await this.ping());
      await delay(4);
    }
    samples.sort((left, right) => (left.receivedAt - left.sentAt) - (right.receivedAt - right.sentAt));
    const fastest = samples.slice(0, Math.max(5, Math.floor(count / 10)));
    const offsets = fastest.map((sample) => sample.hostAt - (sample.sentAt + sample.receivedAt) / 2).sort((left, right) => left - right);
    return { offsetMs: offsets[Math.floor(offsets.length / 2)], minimumRoundTripMs: samples[0].receivedAt - samples[0].sentAt, medianRoundTripMs: samples[Math.floor(count / 2)].receivedAt - samples[Math.floor(count / 2)].sentAt };
  }

  onData(chunk) {
    if (this.broken) return;
    this.lastDataAt = performance.now();
    this.buffered.push(chunk); this.bufferedBytes += chunk.length;
    for (;;) {
      // A frame whose header passed waits here, so its payload is joined once and not on every chunk.
      if (this.bufferedBytes < Math.max(12, this.neededBytes)) return;
      this.neededBytes = 0;
      let joined = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
      this.buffered = [joined];
      if (joined.readUInt32BE(0) !== FRAME_MAGIC) { this.desync(`bad magic at stream offset ${this.consumed}`); return; }
      const length = joined.readUInt32BE(4);
      const headerLength = joined.readUInt32BE(8);
      if (length > MAXIMUM_FRAME_BYTES || headerLength > length) { this.desync(`bad length ${length} at stream offset ${this.consumed}`); return; }
      if (joined.length < 12 + headerLength) return;
      // The header is checked as soon as it is here: a bad frame must never wait for a payload.
      let header;
      try { header = this.parsedHeaderFor === this.consumed ? this.parsedHeader : JSON.parse(joined.subarray(12, 12 + headerLength).toString('utf8')); } catch { this.desync(`bad header at stream offset ${this.consumed}`); return; }
      this.parsedHeaderFor = this.consumed; this.parsedHeader = header;
      if (header.so !== this.consumed) { this.desync(`stream offset ${header.so} from the host, ${this.consumed} here`); return; }
      if (joined.length < 8 + length) { this.neededBytes = 8 + length; return; }
      const raw = joined.subarray(12 + headerLength, 8 + length);
      if (zlib.crc32(raw) !== header.crc) { this.desync(`bad crc on ${header.t} at stream offset ${this.consumed}`); return; }
      this.consumed += 8 + length;
      joined = joined.subarray(8 + length);
      this.buffered = joined.length > 0 ? [joined] : [];
      this.bufferedBytes = joined.length;
      this.onFrame(header, raw);
      if (this.broken) return;
    }
  }

  onFrame(header, raw) {
    const receivedAt = wallNow();
    switch (header.t) {
      case 'pong': { const entry = this.pending.get(header.id); this.pending.delete(header.id); entry?.resolve(header.hostAt); return; }
      case 'rpcResult': {
        const entry = this.pending.get(header.id);
        this.pending.delete(header.id);
        if (!entry) return;
        if (header.ok) entry.resolve({ json: header.result, raw, hostAt: header.hostAt, receivedAt });
        else entry.reject(new Error(header.message));
        return;
      }
      case 'plan': this.plan = header; return;
      case 'syncDone': this.syncDoneAt ??= wallNow(); this.applyChain.then(() => this.onSyncDone?.(header)); return;
      case 'agentError': case 'watchFailed': this.errors.push(JSON.stringify(header)); return;
      case 'w':
        if (this.pendingDark) {
          this.pendingDark.firstStatusAfter = receivedAt;
          if (this.pendingDark.lastStatusAt) this.pendingDark.darkWindowMs = Math.round(receivedAt - this.pendingDark.lastStatusAt);
          this.pendingDark = null;
        }
        this.lastStatusAt = receivedAt;
        this.applyWhole(header, raw, receivedAt);
        return;
      default: this.enqueue(header, raw);
    }
  }

  /** Lag injection: a held prefix keeps its content frames back, and a delete is never held. */
  hold(prefix, untilMs) {
    this.held.push({ prefix });
    if (Number.isFinite(untilMs)) setTimeout(() => this.release(prefix), Math.max(0, untilMs - wallNow()));
  }

  release(prefix) {
    this.held = this.held.filter((entry) => entry.prefix !== prefix);
    const frames = this.heldFrames.filter((frame) => frame.header.p.startsWith(prefix));
    this.heldFrames = this.heldFrames.filter((frame) => !frame.header.p.startsWith(prefix));
    for (const frame of frames) this.enqueue(frame.header, frame.raw);
  }

  enqueue(header, raw) {
    if (header.b) { this.payloadReceived += raw.length; }
    if (this.discard) { if (header.b) this.send({ t: 'ack', bytes: raw.length }); return; }
    if (header.t !== 'd' && this.held.some((entry) => header.p.startsWith(entry.prefix))) {
      if (header.b) { this.send({ t: 'ack', bytes: raw.length }); header.b = 0; }
      this.heldFrames.push({ header, raw });
      return;
    }
    this.applyChain = this.applyChain.then(() => this.applyFrame(header, raw)).catch((error) => {
      this.errors.push(`apply ${header.t} ${header.p}: ${error.code ?? error.message}`);
    });
  }

  async fileHandle(target, flags) {
    if (this.openFile?.target === target && this.openFile.flags === flags) return this.openFile.handle;
    await this.closeOpenFile();
    let handle;
    try { handle = await fsPromises.open(target, flags); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      handle = await fsPromises.open(target, flags === 'r+' ? 'w' : flags);
    }
    this.openFile = { target, flags, handle };
    return handle;
  }

  async closeOpenFile() {
    if (!this.openFile) return;
    const { handle } = this.openFile;
    this.openFile = null;
    await handle.close();
  }

  async applyFrame(header, raw) {
    const target = mirrorPath(this.mirrorHome, header.p.replaceAll('\\', '/'));
    if (header.t === 'a') {
      const bytes = header.z ? await gunzip(raw) : raw;
      const destination = header.r ? `${target}.kpart` : target;
      const handle = await this.fileHandle(destination, header.o === 0 && !header.r ? 'w' : 'r+');
      if (bytes.length > 0) await handle.write(bytes, 0, bytes.length, header.o);
      if (header.b) this.send({ t: 'ack', bytes: raw.length });
    } else if (header.t === 'rs') {
      await this.closeOpenFile();
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await this.fileHandle(`${target}.kpart`, 'w');
    } else if (header.t === 're') {
      await this.closeOpenFile();
      await renameWithRetry(`${target}.kpart`, target);
    } else if (header.t === 'fin') {
      await this.closeOpenFile();
      this.hostMtimes.set(header.p, header.mtimeMs);
    } else if (header.t === 'd') {
      await this.closeOpenFile();
      await fsPromises.rm(target, { recursive: true, force: true });
      this.hostMtimes.delete(header.p);
    }
  }

  applyWhole(header, raw, receivedAt) {
    const relative = header.p.replaceAll('\\', '/');
    const target = mirrorPath(this.mirrorHome, relative);
    const previous = this.statusChains.get(target) ?? Promise.resolve();
    const next = previous.then(async () => {
      const temporary = `${target}.ktmp`;
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(temporary, raw);
      await renameWithRetry(temporary, target, () => { this.statusRenameRetries += 1; });
      const visibleAt = wallNow();
      let parsed = null;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { this.tornStatus += 1; }
      if (parsed?.probe) {
        this.statusSamples.push({ session: parsed.probe.sessionIndex, sequence: parsed.probe.sequence, writtenAt: parsed.probe.writtenAt, eventAt: header.eventAt, readAt: header.readAt, sentAt: header.sentAt, receivedAt, visibleAt });
        this.send({ t: 'statusAck', writtenAt: parsed.probe.writtenAt });
      }
    }).catch((error) => { this.errors.push(`status ${error.code ?? error.message}`); });
    this.statusChains.set(target, next);
  }
}

/** The local half of a resume: what the mirror holds, fingerprinted the way the agent will check it. */
async function computeManifest(mirrorHome, hostMtimes) {
  const entries = [];
  const walk = async (directory, relative) => {
    let listing;
    try { listing = await fsPromises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of listing) {
      const entryPath = path.join(directory, entry.name);
      const hostName = unmirrorSegment(entry.name);
      const hostRelative = relative ? `${relative}/${hostName}` : hostName;
      if (entry.isDirectory()) await walk(entryPath, hostRelative);
      else if (entry.name.endsWith('.kpart') || entry.name.endsWith('.ktmp')) await fsPromises.rm(entryPath, { force: true });
      else if (entry.isFile() && entry.name !== 'status.json') entries.push({ entryPath, hostRelative });
    }
  };
  await walk(mirrorHome, '');
  const manifest = [];
  let nextEntry = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (nextEntry < entries.length) {
      const { entryPath, hostRelative } = entries[nextEntry];
      nextEntry += 1;
      const handle = await fsPromises.open(entryPath, 'r');
      try {
        const { size } = await handle.stat();
        const head = await hashRange(handle, 0, Math.min(size, HASH_WINDOW));
        const tailWindow = tailRange(size);
        const tail = await hashRange(handle, tailWindow.position, tailWindow.length);
        manifest.push([hostRelative, { size, head, tail, hostMtimeMs: hostMtimes.get(hostRelative) }]);
      } finally { await handle.close(); }
    }
  }));
  return manifest;
}

async function hashLocalTree(mirrorHome) {
  const result = {};
  const walk = async (directory, relative) => {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const hostRelative = `${relative}/${unmirrorSegment(entry.name)}`;
      if (entry.isDirectory()) await walk(entryPath, hostRelative);
      else result[hostRelative] = crypto.createHash('sha256').update(await fsPromises.readFile(entryPath)).digest('hex');
    }
  };
  await walk(path.join(mirrorHome, '.claude', 'projects'), '.claude/projects');
  return result;
}

async function verifyTrees(mirrorHome) {
  const hostHashes = JSON.parse(await hostProbe('hash-tree'));
  const localHashes = await hashLocalTree(mirrorHome);
  const missing = Object.keys(hostHashes).filter((key) => !(key in localHashes));
  const extra = Object.keys(localHashes).filter((key) => !(key in hostHashes));
  const different = Object.keys(hostHashes).filter((key) => key in localHashes && localHashes[key] !== hostHashes[key]);
  return { hostFiles: Object.keys(hostHashes).length, missing: missing.length, extra: extra.length, different: different.length, sampleProblems: [...missing, ...extra, ...different].slice(0, 5) };
}

const freshMirror = async (name) => {
  const mirrorHome = path.join(workDirectory, `mirror-${name}`);
  await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(mirrorHome, '.claude', 'projects'), { recursive: true });
  return mirrorHome;
};

const removeLiveSessions = () => dockerDev('rm -rf /home/dev/project/.kangentic/sessions/* /home/dev/.claude/projects/-home-dev-live-* /home/dev/.claude/projects/-home-dev-trial-*');

// ---------- status ----------

function stageReport(samples, offsetMs, observed) {
  const toHost = (localTime) => localTime + offsetMs;
  const pick = (selector) => summarize(samples.map(selector));
  const visible = samples.filter((sample) => observed?.has(`${sample.session}:${sample.sequence}`));
  return {
    observerCoverage: samples.length ? Number((visible.length / samples.length).toFixed(3)) : null,
    hostWriteToLocalVisibleMs: pick((sample) => toHost(sample.visibleAt) - sample.writtenAt),
    hostWriteToLocalObserverMs: summarize(visible.map((sample) => toHost(observed.get(`${sample.session}:${sample.sequence}`)) - sample.writtenAt)),
    stages: {
      writeToInotifyEventMs: pick((sample) => sample.eventAt - sample.writtenAt),
      eventToFileReadMs: pick((sample) => sample.readAt - sample.eventAt),
      readToSocketMs: pick((sample) => sample.sentAt - sample.readAt),
      socketToLocalReceiveMs: pick((sample) => toHost(sample.receivedAt) - sample.sentAt),
      receiveToVisibleMs: pick((sample) => sample.visibleAt - sample.receivedAt),
      visibleToObserverMs: summarize(visible.map((sample) => observed.get(`${sample.session}:${sample.sequence}`) - sample.visibleAt)),
    },
  };
}

function watchMirrorStatus(mirrorHome) {
  const sessionsRoot = path.join(mirrorHome, 'project', '.kangentic', 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const observed = new Map();
  const reads = new Map();
  let readFailures = 0;
  // No re-read after a read: on Windows a read fires its own watch event, so re-reading on an event seen
  // during a read holds the file open without end, and the mirror's rename fails until status lags 14 s
  // (measured). `observerCoverage` in the report shows any event this drops.
  const watcher = fs.watch(sessionsRoot, { recursive: true }, (eventType, name) => {
    if (!name || !name.endsWith('status.json')) return;
    if (reads.get(name)) return;
    reads.set(name, true);
    void fsPromises.readFile(path.join(sessionsRoot, name), 'utf8').then((text) => {
      const seenAt = wallNow();
      const probe = JSON.parse(text).probe;
      const key = `${probe.sessionIndex}:${probe.sequence}`;
      if (!observed.has(key)) observed.set(key, seenAt);
    }).catch(() => { readFailures += 1; }).finally(() => reads.set(name, false));
  });
  return { observed, close: () => watcher.close(), failures: () => readFailures };
}

async function statusRun(name, { sessions, seconds, statusMode = 'rename', rewriteEvery = 0, inflightCreditBytes = null, netemExtra = [] }) {
  await netemOff();
  await removeLiveSessions();
  const mirrorHome = await freshMirror(`status-${name}`);
  const link = new Link(mirrorHome);
  link.autoResync = true;
  const inflight = inflightCreditBytes !== null;
  link.resyncHello = { creditBytes: inflight ? inflightCreditBytes : 4 * 1024 * 1024, assumeSynced: !inflight };
  link.finished = new Promise((resolve) => { link.onSyncDone = resolve; });
  link.start(inflight ? null : { ...link.resyncHello, manifest: [] });
  await delay(200);
  // The agent fingerprints the whole tree before its plan, and that work must not overlap the measured run.
  if (!inflight) await waitFor(() => link.plan, 'the agent plan');
  const progress = setInterval(() => console.log(`[status ${name}] payload=${Math.round(link.payloadReceived / 1e6)}MB pending=${link.pending.size} samples=${link.statusSamples.length} errors=${link.errors.length}`), 5000);
  const clockBefore = await link.measureClock();
  await netemOn(netemExtra);
  const shaped = await link.measureClock(60);
  if (inflight) {
    link.send({ t: 'hello', creditBytes: inflightCreditBytes, manifest: [] });
    await waitFor(() => link.plan, 'the agent plan');
  }
  const observer = watchMirrorStatus(mirrorHome);
  const agentStatsBefore = await link.rpc('stats', {}, 15000).catch(() => null);
  const before = await hostCounters();
  const busyArguments = `busy --sessions ${sessions} --seconds ${seconds} --status-mode ${statusMode}${rewriteEvery ? ` --rewrite-every ${rewriteEvery}` : ''}${sessions === 1 ? ' --no-transcripts' : ''}`;
  const busyOutput = JSON.parse(await hostProbe(busyArguments));
  await delay(1000);
  const after = await hostCounters();
  const netemAfterRun = await netemStatistics();
  const clockAck = await link.rpc('ackSamples', {}, 15000).catch(() => null);
  const agentStats = await link.rpc('stats', {}, 15000).catch(() => null);
  const payloadReceived = link.payloadReceived;
  observer.close();
  await netemOff();
  await delay(300);
  const clockAfter = await link.measureClock().catch(() => clockBefore);
  clearInterval(progress);
  await link.shutdown();
  const offsetMs = (clockBefore.offsetMs + clockAfter.offsetMs) / 2;
  const sequencesWritten = busyOutput.sessions * Math.floor(seconds * 4);
  const uniqueSequences = new Set(link.statusSamples.map((sample) => `${sample.session}:${sample.sequence}`)).size;
  const withinBar = link.statusSamples.filter((sample) => sample.visibleAt + offsetMs - sample.writtenAt <= 500);
  const uniqueWithinBar = new Set(withinBar.map((sample) => `${sample.session}:${sample.sequence}`)).size;
  const insideSync = inflight && link.syncDoneAt ? link.statusSamples.filter((sample) => sample.visibleAt <= link.syncDoneAt) : link.statusSamples;
  const agentCpuMicroseconds = (stats) => (stats ? stats.json.cpu.user + stats.json.cpu.system : null);
  const agentCpuBefore = agentCpuMicroseconds(agentStatsBefore);
  const agentCpuAfter = agentCpuMicroseconds(agentStats);
  const report = {
    name, sessions, seconds, statusMode, inflightCreditBytes, busy: busyOutput,
    clock: { before: clockBefore, shaped, after: clockAfter, driftMs: clockAfter.offsetMs - clockBefore.offsetMs },
    framesDelivered: link.statusSamples.length, approximateWritten: sequencesWritten, uniqueWritesDelivered: uniqueSequences, uniqueWritesWithinBar: uniqueWithinBar,
    resyncs: link.resyncs.map(({ lastStatusAt, firstStatusAfter, ...rest }) => rest), worstDarkWindowMs: Math.max(0, ...link.resyncs.map((entry) => entry.darkWindowMs ?? 0)),
    tornStatus: link.tornStatus, statusRenameRetries: link.statusRenameRetries, observerReadFailures: observer.failures(),
    framesInsideSync: insideSync.length, syncFinishedDuringRun: Boolean(link.syncDoneAt),
    ...stageReport(insideSync, offsetMs, observer.observed),
    clockFreeRoundTripMs: summarize(clockAck?.json?.samples ?? []),
    // `wire.hostCpuSeconds` is the whole container, the `busy` load generator included. The agent's cost is this field.
    wire: counterDelta(before, after), bulkPayloadDuringRunMb: Math.round(payloadReceived / 1e6),
    agentCpuSeconds: agentCpuBefore === null || agentCpuAfter === null ? null : Number(((agentCpuAfter - agentCpuBefore) / 1e6).toFixed(1)),
    netem: netemAfterRun.replace(/\s+/g, ' ').trim(), agent: agentStats?.json, errors: link.errors.slice(0, 5),
  };
  saveResult(`status-${name}`, report);
  await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  return report;
}

async function stepStatus() {
  const only = options.only?.split(',');
  const runs = [
    ['idle-1', { sessions: 1, seconds: 60 }],
    ['busy-8', { sessions: 8, seconds: 60, rewriteEvery: 15 }],
    ['busy-8-inplace', { sessions: 8, seconds: 30, statusMode: 'inplace' }],
    ['sync-credit-1mb', { sessions: 8, seconds: 40, inflightCreditBytes: 1024 * 1024 }],
    ['sync-credit-1mb-again', { sessions: 8, seconds: 40, inflightCreditBytes: 1024 * 1024 }],
    ['sync-credit-4mb', { sessions: 8, seconds: 40, inflightCreditBytes: 4 * 1024 * 1024 }],
    ['sync-credit-4mb-again', { sessions: 8, seconds: 40, inflightCreditBytes: 4 * 1024 * 1024 }],
    ['sync-no-credit', { sessions: 8, seconds: 40, inflightCreditBytes: 1024 ** 4 }],
    ['sync-no-credit-again', { sessions: 8, seconds: 40, inflightCreditBytes: 1024 ** 4 }],
  ];
  for (const [name, config] of runs) {
    if (!only || only.includes(name)) await statusRun(name, config);
  }
}

// ---------- reads ----------

async function stepReads() {
  await netemOff();
  await removeLiveSessions();
  const mirrorHome = await freshMirror('reads');
  const link = new Link(mirrorHome);
  link.connect({ creditBytes: 4 * 1024 * 1024, assumeSynced: true, manifest: [] });
  await delay(300);
  const clockBefore = await link.measureClock();
  await netemOn();
  const shaped = await link.measureClock(60);
  const busyDone = hostProbe('busy --sessions 8 --seconds 170 --status-mode rename --no-transcripts');
  await delay(1500);
  const relativePaths = (await dockerDev('ls -1 /home/dev/project/.kangentic/sessions/*/status.json')).trim().split('\n').map((line) => path.posix.relative(HOST_HOME, line));
  const offsetProbe = () => clockBefore.offsetMs;
  const staleness = (text, receivedAt) => (receivedAt + offsetProbe()) - JSON.parse(text).probe.writtenAt;

  const sshCat = (remoteCommand) => new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(sshExecutable(), sshArguments(remoteCommand), { stdio: ['ignore', 'pipe', 'ignore'], env: childEnvironment, windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), receivedAt: wallNow(), elapsedMs: performance.now() - startedAt }));
  });

  const sshDurations = [];
  const sshStaleness = [];
  for (let index = 0; index < 40; index += 1) {
    const result = await sshCat(`cat ${relativePaths[0]}`);
    sshDurations.push(result.elapsedMs);
    if (result.text.startsWith('{')) sshStaleness.push(staleness(result.text, result.receivedAt));
  }
  const eightDurations = [];
  for (let index = 0; index < 10; index += 1) {
    const startedAt = performance.now();
    await Promise.all(relativePaths.slice(0, 8).map((relative) => sshCat(`cat ${relative}`)));
    eightDurations.push(performance.now() - startedAt);
  }

  const heldDurations = [];
  const heldStaleness = [];
  for (let index = 0; index < 240; index += 1) {
    const startedAt = performance.now();
    const result = await link.rpc('read', { p: relativePaths[0] });
    heldDurations.push(performance.now() - startedAt);
    heldStaleness.push(staleness(result.raw.toString('utf8'), result.receivedAt));
    await delay(Math.max(0, 250 - (performance.now() - startedAt)));
  }
  const heldEight = [];
  for (let index = 0; index < 40; index += 1) {
    const startedAt = performance.now();
    await Promise.all(relativePaths.slice(0, 8).map((relative) => link.rpc('read', { p: relative })));
    heldEight.push(performance.now() - startedAt);
    await delay(200);
  }

  // The same read from the mirror, which is what a synchronous reader on main does.
  const mirrorTarget = mirrorPath(mirrorHome, relativePaths[0]);
  await delay(500);
  const mirrorRead = [];
  const statSync = [];
  for (let index = 0; index < 2000; index += 1) {
    let startedAt = performance.now();
    await fsPromises.readFile(mirrorTarget).catch(() => null);
    mirrorRead.push(performance.now() - startedAt);
    startedAt = performance.now();
    try { fs.statSync(mirrorTarget); } catch { /* rename in flight */ }
    statSync.push(performance.now() - startedAt);
  }
  await busyDone.catch(() => null);
  await link.shutdown();
  await netemOff();
  saveResult('reads', {
    shapedRoundTrip: shaped,
    sshCatPerPollMs: summarize(sshDurations), sshCatStalenessMs: summarize(sshStaleness), sshCatFailed: 40 - sshStaleness.length,
    sshCatEightSessionsPerRoundMs: summarize(eightDurations),
    heldRequestMs: summarize(heldDurations), heldStalenessMs: summarize(heldStaleness),
    heldEightSessionsPerRoundMs: summarize(heldEight),
    mirrorFileReadMs: summarize(mirrorRead), mirrorStatSyncMs: summarize(statSync), errors: link.errors.slice(0, 3),
  });
  await fsPromises.rm(mirrorHome, { recursive: true, force: true });
}

// ---------- sync ----------

async function indexPass(mirrorHome) {
  const startedAt = performance.now();
  let lines = 0;
  let bytes = 0;
  const walk = async (directory) => {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.name.endsWith('.jsonl')) {
        const text = await fsPromises.readFile(entryPath, 'utf8');
        bytes += text.length;
        for (const line of text.split('\n')) {
          if (!line) continue;
          try { JSON.parse(line); lines += 1; } catch { /* the generator's last line of a file is cut short */ }
        }
      }
    }
  };
  await walk(path.join(mirrorHome, '.claude', 'projects'));
  return { parseEveryTranscriptMs: Math.round(performance.now() - startedAt), lines, megabytes: Math.round(bytes / 1e6) };
}

async function syncRun(name, { creditBytes, gzip = false, dropAtFraction = null, verify = true }) {
  await netemOff();
  await removeLiveSessions();
  const mirrorHome = await freshMirror(`sync-${name}`);
  await netemOn(options['netem-limit'] ? ['limit', String(options['netem-limit'])] : []);
  const before = await hostCounters();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const link = new Link(mirrorHome);
  link.autoResync = true;
  const finished = link.connect({ creditBytes, gzip, manifest: [] });
  const report = { name, creditBytes, gzip };
  if (dropAtFraction !== null) {
    await waitFor(() => link.plan, 'the agent plan');
    const dropBytes = link.plan.bytesToSend * dropAtFraction;
    await waitFor(() => link.payloadReceived >= dropBytes, 'the payload before the drop', SYNC_DEADLINE_MS);
    await link.kill();
    const atDrop = await hostCounters();
    report.drop = { atMs: Math.round(performance.now() - startedAt), payloadBeforeDrop: link.payloadReceived, ...counterDelta(before, atDrop) };
    await delay(1000);
    const resumeStartedAt = performance.now();
    const manifest = await computeManifest(mirrorHome, link.hostMtimes);
    report.resume = { manifestEntries: manifest.length, manifestBytes: JSON.stringify(manifest).length, manifestMs: Math.round(performance.now() - resumeStartedAt) };
    const resumed = new Link(mirrorHome);
    resumed.autoResync = true;
    resumed.hostMtimes = link.hostMtimes;
    const resumedDone = await withDeadline(resumed.connect({ creditBytes, gzip, manifest }), 'the resume to finish');
    report.resyncsDuringResume = resumed.resyncs.map(({ reason, payloadReceived }) => ({ reason, payloadReceived }));
    const afterResume = await hostCounters();
    Object.assign(report.resume, { totalMs: Math.round(performance.now() - resumeStartedAt), plan: resumed.plan, agentBulkPayload: resumedDone.bulkPayloadBytes, ...counterDelta(atDrop, afterResume) });
    await resumed.kill();
    report.errors = [...link.errors, ...resumed.errors].slice(0, 5);
  } else {
    const done = await withDeadline(finished, 'the sync to finish');
    const after = await hostCounters();
    const cpu = process.cpuUsage(cpuBefore);
    Object.assign(report, { totalMs: Math.round(performance.now() - startedAt), resyncs: link.resyncs.map(({ reason, payloadReceived, reconnectedMs }) => ({ reason, payloadReceived, reconnectedMs })), plan: link.plan, agent: done, ...counterDelta(before, after), localCpuSeconds: Number(((cpu.user + cpu.system) / 1e6).toFixed(1)) });
    report.errors = link.errors.slice(0, 5);
    report.link = link;
  }
  report.netem = (await netemStatistics()).replace(/\s+/g, ' ').trim();
  await netemOff();
  const linkForDeltas = report.link;
  delete report.link;
  if (verify) report.verify = await verifyTrees(mirrorHome);
  saveResult(`sync-${name}`, report);
  return { report, mirrorHome, link: linkForDeltas };
}

async function deltaRun(mirrorHome, previousLink, creditBytes) {
  await previousLink.kill();
  const noChange = {};
  {
    await netemOn();
    const before = await hostCounters();
    const startedAt = performance.now();
    const manifest = await computeManifest(mirrorHome, previousLink.hostMtimes);
    noChange.manifestMs = Math.round(performance.now() - startedAt);
    const link = new Link(mirrorHome);
    link.autoResync = true;
    link.hostMtimes = previousLink.hostMtimes;
    const done = await withDeadline(link.connect({ creditBytes, manifest }), 'the no-change resync to finish');
    Object.assign(noChange, { totalMs: Math.round(performance.now() - startedAt), plan: link.plan, agentBulkPayload: done.bulkPayloadBytes, ...counterDelta(before, await hostCounters()) });
    await link.kill();
  }
  const mutation = JSON.parse(await hostProbe('mutate-for-deltas'));
  const deltas = { mutation };
  {
    const before = await hostCounters();
    const startedAt = performance.now();
    const manifest = await computeManifest(mirrorHome, previousLink.hostMtimes);
    const link = new Link(mirrorHome);
    link.autoResync = true;
    link.hostMtimes = previousLink.hostMtimes;
    const done = await withDeadline(link.connect({ creditBytes, manifest }), 'the delta sync to finish');
    Object.assign(deltas, { totalMs: Math.round(performance.now() - startedAt), resyncs: link.resyncs.length, plan: link.plan, agentBulkPayload: done.bulkPayloadBytes, ...counterDelta(before, await hostCounters()), errors: link.errors.slice(0, 5) });
    await link.kill();
  }
  await netemOff();
  deltas.verify = await verifyTrees(mirrorHome);
  saveResult('sync-deltas', { noChange, deltas });
}

async function stepSync() {
  const creditBytes = Number(options['credit-mb'] ?? 4) * 1024 * 1024;
  const only = options.only?.split(',');
  const wanted = (name) => !only || only.includes(name);
  if (wanted('plain')) {
    const { report, mirrorHome, link } = await syncRun('plain', { creditBytes });
    const index = await indexPass(mirrorHome);
    saveResult('sync-index-pass', index);
    if (report.verify) await deltaRun(mirrorHome, link, creditBytes);
  }
  if (wanted('drop')) {
    const { mirrorHome } = await syncRun('drop', { creditBytes, dropAtFraction: 0.4 });
    await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  }
  if (wanted('gzip')) {
    const { mirrorHome, link } = await syncRun('gzip', { creditBytes, gzip: true, verify: true });
    await link.kill();
    await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  }
  if (wanted('unlimited')) {
    const { mirrorHome, link } = await syncRun('unlimited', { creditBytes: 1024 ** 4 });
    await link.kill();
    await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  }
}

// ---------- stall ----------

/** Full syncs watched for a desync, with no recovery, so each one is counted. */
async function stallRun(label, { creditBytes, rekeyLimit, repeats }) {
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    await netemOff();
    await removeLiveSessions();
    const mirrorHome = await freshMirror('stall');
    await netemOn();
    extraSshOptions.length = 0;
    if (rekeyLimit) extraSshOptions.push('-o', `RekeyLimit=${rekeyLimit}`);
    const link = new Link(mirrorHome);
    link.discard = options.discard === true;
    const startedAt = performance.now();
    link.lastDataAt = startedAt;
    let finished = false;
    void link.connect({ creditBytes, manifest: [] }).then(() => { finished = true; });
    while (!finished && link.resyncs.length === 0 && performance.now() - link.lastDataAt < 15_000) await delay(250);
    const outcome = { repeat, finished, ms: Math.round(performance.now() - startedAt), payloadMb: Math.round(link.payloadReceived / 1e6), desync: link.resyncs[0]?.reason ?? null };
    await link.kill();
    await netemOff();
    runs.push(outcome);
    console.log(`[stall ${label}] ${JSON.stringify(outcome)}`);
  }
  extraSshOptions.length = 0;
  saveResult(`stall-${label}`, { transport: transportLabel(), creditBytes, rekeyLimit: rekeyLimit ?? 'default', desynced: runs.filter((entry) => entry.desync).length, repeats, runs });
}

async function stepStall() {
  const creditBytes = Number(options['credit-mb'] ?? 4) * 1024 * 1024;
  await stallRun(options.label ?? 'default', { creditBytes, rekeyLimit: options['rekey-limit'], repeats: Number(options.repeats ?? 3) });
}

// ---------- integrity ----------

/**
 * A counter stream with no Node on the host, so a byte lost here is not the agent's. Each byte up the
 * channel acknowledges one chunk, which makes the same two-way traffic the mirror's credit does.
 */
const COUNTER_WRITER = `
import os, random, struct, sys, threading, time
total, credit, chunk, ack_bytes, bursty = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
generator = random.Random(7)
condition = threading.Condition()
acknowledged = [0]
def reader():
    while True:
        data = os.read(0, 65536)
        if not data:
            os._exit(0)
        with condition:
            acknowledged[0] += len(data) / ack_bytes
            condition.notify_all()
threading.Thread(target=reader, daemon=True).start()
counter = 0
sent = 0
words = chunk // 8
sizes = [200, 1000, 8000, 64000, 262144, 262144, 262144]
while sent < total:
    if bursty:
        words = generator.choice(sizes) // 8
    if credit:
        with condition:
            while sent - acknowledged[0] * chunk >= credit:
                condition.wait()
    block = struct.pack('>%dQ' % words, *range(counter, counter + words))
    counter += words
    view = memoryview(block)
    while view:
        written = os.write(1, view)
        view = view[written:]
    sent += words * 8
    if bursty and generator.random() < 0.3:
        time.sleep(generator.random() * 0.002)
`;

async function integrityRun(label, { totalBytes, creditBytes, chunkBytes = 256 * 1024, rekeyLimit, toFile = false, writer = 'python', cipher, slowReader = null, ackBytes = 1, bursty = false }) {
  await netemOn();
  const arguments_ = [];
  if (rekeyLimit) arguments_.push('-o', `RekeyLimit=${rekeyLimit}`);
  if (cipher) arguments_.push('-c', cipher);
  const remote = writer === 'python'
    ? `python3 /home/dev/probe/counter.py ${totalBytes} ${creditBytes} ${chunkBytes} ${ackBytes} ${bursty ? 1 : 0}`
    : `${REMOTE_NODE} ${REMOTE_SCRIPT} counter-stream --bytes ${totalBytes} --credit ${creditBytes} --chunk ${chunkBytes}`;
  const filePath = path.join(workDirectory, 'integrity-stream.bin');
  const output = toFile ? fs.openSync(filePath, 'w') : 'pipe';
  const startedAt = performance.now();
  const child = spawn(sshExecutable(), [...arguments_, ...sshArguments(remote)], { stdio: ['pipe', output, 'pipe'], env: childEnvironment, windowsHide: true });
  child.stdin.on('error', () => undefined);
  let received = 0;
  let firstMismatch = null;
  let pendingAcks = 0;
  const verify = (buffer, offsetInStream) => {
    if (firstMismatch) return;
    const firstAligned = (8 - (offsetInStream % 8)) % 8;
    for (let position = firstAligned; position + 8 <= buffer.length; position += 8 * 1024) {
      const expected = (offsetInStream + position) / 8;
      const found = buffer.readUInt32BE(position) * 4294967296 + buffer.readUInt32BE(position + 4);
      if (found !== expected) {
        firstMismatch = { offset: offsetInStream + position, expected, found, bytesSkipped: (found - expected) * 8 };
        return;
      }
    }
  };
  let endedEarly = false;
  const done = new Promise((resolve) => child.on('close', resolve));
  const watchdog = setInterval(() => { if (performance.now() - startedAt > 180_000) { endedEarly = true; child.kill(); } }, 1000);
  if (toFile) {
    const ticker = setInterval(() => {
      if (!creditBytes) return;
      const size = fs.fstatSync(output).size;
      const owed = Math.floor(size / chunkBytes) - pendingAcks;
      if (owed > 0) { pendingAcks += owed; child.stdin.write(Buffer.alloc(owed, 65)); }
      if (size >= totalBytes) child.stdin.end();
    }, 5);
    await done;
    clearInterval(ticker);
    fs.closeSync(output);
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) { verify(chunk, received); received += chunk.length; }
    fs.rmSync(filePath, { force: true });
  } else {
    let unacknowledged = 0;
    let chunksSeen = 0;
    child.stdout.on('data', (chunk) => {
      chunksSeen += 1;
      // A reader that falls behind now and then, the way a writer busy with files does.
      if (slowReader?.mode === 'block' && chunksSeen % slowReader.everyChunks === 0) {
        const until = performance.now() + slowReader.ms;
        while (performance.now() < until) { /* hold the loop */ }
      }
      if (slowReader?.mode === 'pause' && chunksSeen % slowReader.everyChunks === 0) {
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), slowReader.ms);
      }
      verify(chunk, received);
      received += chunk.length;
      unacknowledged += chunk.length;
      if (creditBytes && unacknowledged >= chunkBytes) {
        const owed = Math.floor(unacknowledged / chunkBytes);
        unacknowledged -= owed * chunkBytes;
        for (let index = 0; index < (ackBytes > 1 ? owed : 1); index += 1) child.stdin.write(Buffer.alloc(ackBytes > 1 ? ackBytes : owed, 65));
      }
      if (received >= totalBytes) child.stdin.end();
    });
    await done;
  }
  clearInterval(watchdog);
  await netemOff();
  const report = { transport: transportLabel(), label, writer, toFile, totalBytes, received, rekeyLimit: rekeyLimit ?? 'default', creditBytes, cipher: cipher ?? 'default', seconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)), firstMismatch, endedEarly };
  console.log(`[integrity] ${JSON.stringify(report)}`);
  return report;
}

/** The real tree through plain `cat`: no framing, no Node on the host, a hash at each end. */
async function treeThroughCat({ rekeyLimit, repeats }) {
  await removeLiveSessions();
  const pipeline = 'find .claude/projects -type f -print0 | sort -z | xargs -0 cat';
  const hostHash = (await dockerDev(`${pipeline} | sha256sum`)).trim().split(' ')[0];
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    await netemOn();
    const child = spawn(sshExecutable(), [...(rekeyLimit ? ['-o', `RekeyLimit=${rekeyLimit}`] : []), ...sshArguments(pipeline)], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment, windowsHide: true });
    const hash = crypto.createHash('sha256');
    let received = 0;
    const startedAt = performance.now();
    child.stdout.on('data', (chunk) => { received += chunk.length; hash.update(chunk); });
    await new Promise((resolve) => child.on('close', resolve));
    await netemOff();
    const localHash = hash.digest('hex');
    runs.push({ repeat, received, seconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)), hashMatches: localHash === hostHash });
    console.log(`[integrity cat] ${JSON.stringify(runs.at(-1))}`);
  }
  return { transport: transportLabel(), rekeyLimit: rekeyLimit ?? 'default', runs };
}

async function stepIntegrity() {
  if (options['tree-cat']) {
    saveResult(options.label ?? 'integrity-tree-cat', await treeThroughCat({ rekeyLimit: options['rekey-limit'], repeats: Number(options.repeats ?? 3) }));
    return;
  }
  await copyHostScript(CONTAINER);
  fs.writeFileSync(path.join(workDirectory, 'counter.py'), COUNTER_WRITER);
  await run('docker', ['cp', path.join(workDirectory, 'counter.py'), `${CONTAINER}:/home/dev/probe/counter.py`]);
  const totalBytes = Number(options['total-mb'] ?? 1536) * 1024 * 1024;
  const fourMegabytes = 4 * 1024 * 1024;
  const plan = {
    a: ['open-loop-default-rekey', { totalBytes, creditBytes: 0 }],
    b: ['open-loop-rekey-64m', { totalBytes, creditBytes: 0, rekeyLimit: '64M' }],
    c: ['credit-rekey-64m', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M' }],
    d: ['credit-rekey-64m-to-file', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', toFile: true }],
    e: ['credit-default-rekey', { totalBytes, creditBytes: fourMegabytes }],
    f: ['credit-rekey-64m-node-writer', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', writer: 'node' }],
    g: ['credit-aes-gcm-rekey-64m', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', cipher: 'aes128-gcm@openssh.com' }],
    h: ['credit-rekey-64m-blocked-reader', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', slowReader: { mode: 'block', everyChunks: 200, ms: 120 } }],
    i: ['credit-rekey-64m-paused-reader', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', slowReader: { mode: 'pause', everyChunks: 200, ms: 120 } }],
    j: ['open-loop-default-rekey-blocked-reader', { totalBytes, creditBytes: 0, slowReader: { mode: 'block', everyChunks: 200, ms: 120 } }],
    k: ['credit-rekey-64m-frame-sized-acks', { totalBytes, creditBytes: fourMegabytes, rekeyLimit: '64M', ackBytes: 48 }],
    l: ['bursty-rekey-64m', { totalBytes, creditBytes: 0, rekeyLimit: '64M', bursty: true }],
    m: ['bursty-default-rekey', { totalBytes, creditBytes: 0, bursty: true }],
  };
  const results = [];
  for (const key of (options.only ?? 'c,e,a,b,d').split(',')) {
    for (let repeat = 0; repeat < Number(options.repeats ?? 1); repeat += 1) results.push(await integrityRun(...plan[key]));
  }
  saveResult(options.label ?? 'integrity', results);
}

// ---------- resumes ----------

function buildDecisionBundle(outfile) {
  const requireFromRoot = createRequire(path.join(repositoryRoot, 'package.json'));
  const esbuild = requireFromRoot('esbuild');
  const realConfirmedMissing = path.join(repositoryRoot, 'src', 'main', 'agent', 'shared', 'confirmed-missing.ts').replaceAll('\\', '/');
  const seams = {
    name: 'probe-seams',
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'probe-stub' }));
      build.onLoad({ filter: /^electron$/, namespace: 'probe-stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
      // The one seam the design changes: a host path asks the helper. A local path stays real.
      build.onResolve({ filter: /confirmed-missing$/ }, () => ({ path: 'confirmed-missing', namespace: 'probe-seam' }));
      build.onLoad({ filter: /.*/, namespace: 'probe-seam' }, () => ({
        loader: 'js',
        resolveDir: repositoryRoot,
        contents: `import { isConfirmedMissing as real } from ${JSON.stringify(realConfirmedMissing)};
          export function isConfirmedMissing(filePath) {
            const hook = globalThis.__probeConfirmedMissing;
            return hook && hook.applies(filePath) ? hook.ask(filePath) : real(filePath);
          }`,
      }));
    },
  };
  return esbuild.build({
    stdin: {
      resolveDir: repositoryRoot,
      loader: 'ts',
      contents: `export { assessResumeConversation } from './src/main/transition-engine/resume-conversation-guard';
        export { proveClaudeConversationGone } from './src/main/agent/adapters/claude/conversation-gone';
        export { ClaudeStatusParser } from './src/main/agent/adapters/claude/status-parser';
        export { claudeProjectSlug } from './src/main/agent/adapters/claude/transcript-parser';`,
    },
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile, plugins: [seams], logLevel: 'error',
    external: ['better-sqlite3', 'node-pty', 'koffi', 'original-fs', '@sentry/*'],
    define: { __KANGENTIC_DEV__: 'false' },
  });
}

const zeroStatus = (agentSessionId, transcriptPath) => JSON.stringify({
  session_id: agentSessionId, transcript_path: transcriptPath, model: { id: 'stand-in', display_name: 'Stand-in' },
  context_window: { used_percentage: 0, context_window_size: 200000, total_input_tokens: 0, total_output_tokens: 0 }, cost: { total_cost_usd: 0 },
});

async function stepResumes() {
  const bundlePath = path.join(workDirectory, 'decision-bundle.cjs');
  await netemOff();
  const hostRoot = `${HOST_HOME}/.claude/projects`;
  const mirrorHome = path.join(workDirectory, 'mirror-resumes');
  await removeLiveSessions();
  await fsPromises.rm(mirrorHome, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(mirrorHome, '.claude', 'projects'), { recursive: true });
  // A mirror of the whole tree, so the folder scan in the proof has real folders to read.
  const seedLink = new Link(mirrorHome);
  seedLink.autoResync = true;
  await seedLink.connect({ creditBytes: 16 * 1024 * 1024, manifest: [] });
  const absentId = crypto.randomUUID();
  const proofOfLoad = await seedLink.rpc('proveGone', { agentSessionId: absentId, reportedPaths: [`${hostRoot}/-home-dev-none/${absentId}.jsonl`], cwd: `${HOST_HOME}/none` }, 20000);
  console.log(`[resumes] the helper's bundle answered: ${JSON.stringify(proofOfLoad.json)}`);
  await seedLink.kill();
  // Every home lookup in the decision code now lands in the mirror, never in this machine's real home.
  process.env.USERPROFILE = mirrorHome;
  process.env.HOME = mirrorHome;
  const decisions = createRequire(import.meta.url)(bundlePath);
  const shellFolder = path.join(workDirectory, 'shell-project');
  await fsPromises.rm(shellFolder, { recursive: true, force: true });
  await netemOn();

  let link = new Link(mirrorHome);
  link.hostMtimes = seedLink.hostMtimes;
  const allResyncs = [];
  const reconnect = async () => {
    const manifest = await computeManifest(mirrorHome, link.hostMtimes);
    const next = new Link(mirrorHome);
    next.autoResync = true;
    next.hostMtimes = link.hostMtimes;
    allResyncs.push(...link.resyncs);
    await next.connect({ creditBytes: 16 * 1024 * 1024, manifest });
    link = next;
  };
  await reconnect();

  // Design rule: a host path asks the helper. A link that is down, or a slow answer, is not proof.
  globalThis.__probeConfirmedMissing = {
    applies: (filePath) => filePath.startsWith(`${HOST_HOME}/`),
    ask: async (filePath) => {
      try { return (await link.rpc('confirmedMissing', { path: filePath })).json.missing; } catch { return false; }
    },
  };
  const parseStatus = decisions.ClaudeStatusParser.parseStatus;
  const helperAdapter = {
    runtime: { statusFile: { parseStatus } },
    proveConversationGone: async (params) => (await link.rpc('proveGone', { agentSessionId: params.agentSessionId, reportedPaths: params.reportedPaths, cwd: params.cwd })).json.gone,
  };
  const mirrorAdapter = {
    runtime: { statusFile: { parseStatus } },
    proveConversationGone: (params) => decisions.proveClaudeConversationGone(params),
  };

  const makeTrial = (scenario, batch, index, truth, turns) => {
    const agentSessionId = crypto.randomUUID();
    const cwd = `${HOST_HOME}/trial/${scenario}-${batch}`;
    const slug = decisions.claudeProjectSlug(cwd);
    return {
      scenario, truth, turns, agentSessionId, cwd, slug, index,
      hostPath: `${hostRoot}/${slug}/${agentSessionId}.jsonl`,
      relativePrefix: `.claude/projects/${slug}`,
      mirrorFile: path.join(mirrorHome, '.claude', 'projects', slug, `${agentSessionId}.jsonl`),
    };
  };

  const assess = async (trial, rule) => {
    const recordId = crypto.randomUUID();
    const reported = rule === 'helper' ? trial.hostPath : (trial.reportedMirrorFile ?? trial.mirrorFile);
    const reportedHost = trial.reportedHostPath ?? trial.hostPath;
    const reportedPath = rule === 'helper' ? reportedHost : reported;
    const projectPath = path.join(shellFolder, rule);
    if (!trial.turns) {
      const sessionDirectory = path.join(projectPath, '.kangentic', 'sessions', recordId);
      await fsPromises.mkdir(sessionDirectory, { recursive: true });
      await fsPromises.writeFile(path.join(sessionDirectory, 'status.json'), zeroStatus(trial.agentSessionId, reportedPath));
    }
    const startedAt = performance.now();
    const verdict = await decisions.assessResumeConversation({
      adapter: rule === 'helper' ? helperAdapter : mirrorAdapter,
      agentSessionId: trial.agentSessionId,
      records: [{ id: recordId, transcript_path: reportedPath, total_input_tokens: trial.turns ? 1200 : 0, total_output_tokens: trial.turns ? 340 : 0, total_cost_usd: trial.turns ? 0.1 : 0 }],
      cwd: trial.cwd,
      projectPath,
    });
    return { verdict, elapsedMs: performance.now() - startedAt };
  };

  const outcomes = [];
  const judge = async (trial, lagMs) => {
    const [helper, mirror] = await Promise.all([assess(trial, 'helper'), assess(trial, 'mirror')]);
    outcomes.push({ scenario: trial.scenario, truth: trial.truth, lagMs, helper: helper.verdict, mirror: mirror.verdict, helperMs: helper.elapsedMs, mirrorMs: mirror.elapsedMs, mirrorHadFile: fs.existsSync(trial.mirrorFile), linkUp: link.up });
  };
  const waitForMirror = async (trials, wanted, timeoutMs = 8000) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (trials.every((trial) => fs.existsSync(trial.mirrorFile) === wanted)) return true;
      await delay(25);
    }
    return false;
  };
  const LAGS = [0, 250, 1000, 5000];
  const BATCH = 20;
  const batchesOf = (total) => Math.ceil(total / BATCH);
  const sizedBatch = (total, batch) => Math.min(BATCH, total - batch * BATCH);

  const runScenario = async (scenario, total, truth, turns, body) => {
    for (let batch = 0; batch < batchesOf(total); batch += 1) {
      const trials = Array.from({ length: sizedBatch(total, batch) }, (unused, index) => makeTrial(scenario, batch, index, truth, turns));
      await body(trials, LAGS[batch % LAGS.length]);
      console.log(`[resumes] ${scenario} batch ${batch + 1}/${batchesOf(total)} done=${outcomes.length}`);
    }
  };
  const createAll = (trials) => Promise.all(trials.map((trial) => link.rpc('createConversation', { path: trial.hostPath, agentSessionId: trial.agentSessionId }, 20000)));
  const justCreated = async (trials, lagMs) => {
    if (lagMs > 0) link.hold(trials[0].relativePrefix, wallNow() + lagMs);
    await createAll(trials);
    await Promise.all(trials.map(async (trial) => { await delay(Math.random() * 1500); await judge(trial, lagMs); }));
    await delay(Math.max(0, lagMs - 1500));
  };

  await runScenario('just-created', 120, 'present', true, justCreated);

  await runScenario('slug-renamed', 120, 'present', true, async (trials, lagMs) => {
    await createAll(trials);
    await waitForMirror(trials, true);
    const oldSlug = trials[0].slug;
    const newCwd = `${trials[0].cwd}-renamed`;
    const newSlug = decisions.claudeProjectSlug(newCwd);
    const newPrefix = `.claude/projects/${newSlug}`;
    link.hold(newPrefix, wallNow() + Math.max(lagMs, 1));
    for (const trial of trials) {
      trial.reportedHostPath = trial.hostPath;
      trial.reportedMirrorFile = trial.mirrorFile;
      trial.cwd = newCwd;
      trial.mirrorFile = path.join(mirrorHome, '.claude', 'projects', newSlug, `${trial.agentSessionId}.jsonl`);
    }
    await link.rpc('renameFolder', { from: `${hostRoot}/${oldSlug}`, to: `${hostRoot}/${newSlug}` });
    await delay(150);
    await Promise.all(trials.map(async (trial) => { await delay(Math.random() * 300); await judge(trial, lagMs); }));
    await delay(lagMs);
  });

  await runScenario('cold-mirror', 120, 'present', true, async (trials, lagMs) => {
    const prefix = trials[0].relativePrefix;
    link.hold(prefix, Infinity);
    await createAll(trials);
    await delay(200);
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
    link.release(prefix);
  });

  await runScenario('link-down', 70, 'present', true, async (trials, lagMs) => {
    link.hold(trials[0].relativePrefix, Infinity);
    await createAll(trials);
    await delay(100);
    await link.kill();
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
    await reconnect();
  });

  await runScenario('mirrored-control', 70, 'present', true, async (trials, lagMs) => {
    await createAll(trials);
    await waitForMirror(trials, true);
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
  });

  await runScenario('truly-deleted', 100, 'gone', true, async (trials, lagMs) => {
    await createAll(trials);
    await waitForMirror(trials, true);
    await Promise.all(trials.map((trial) => link.rpc('deleteConversation', { path: trial.hostPath }, 20000)));
    await waitForMirror(trials, false);
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
  });

  await runScenario('deleted-link-down', 40, 'gone', true, async (trials, lagMs) => {
    await createAll(trials);
    await waitForMirror(trials, true);
    await Promise.all(trials.map((trial) => link.rpc('deleteConversation', { path: trial.hostPath }, 20000)));
    await waitForMirror(trials, false);
    await link.kill();
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
    await reconnect();
  });

  await runScenario('no-turns-reported-file-on-host', 60, 'present', false, justCreated);

  await runScenario('never-started', 20, 'gone', false, async (trials, lagMs) => {
    await Promise.all(trials.map((trial) => judge(trial, lagMs)));
  });

  await link.kill();
  await netemOff();
  process.env.USERPROFILE = childEnvironment.USERPROFILE;
  process.env.HOME = childEnvironment.HOME;

  const scenarios = {};
  for (const outcome of outcomes) {
    const entry = scenarios[outcome.scenario] ??= { truth: outcome.truth, trials: 0, helper: {}, mirror: {}, mirrorHadFile: 0 };
    entry.trials += 1;
    entry.helper[outcome.helper] = (entry.helper[outcome.helper] ?? 0) + 1;
    entry.mirror[outcome.mirror] = (entry.mirror[outcome.mirror] ?? 0) + 1;
    if (outcome.mirrorHadFile) entry.mirrorHadFile += 1;
  }
  const mainSet = outcomes.filter((outcome) => ['just-created', 'slug-renamed', 'cold-mirror', 'link-down', 'mirrored-control'].includes(outcome.scenario));
  const byLag = {};
  for (const outcome of outcomes.filter((candidate) => candidate.scenario === 'just-created')) {
    const entry = byLag[outcome.lagMs] ??= { trials: 0, mirrorFalseExpired: 0, helperFalseExpired: 0 };
    entry.trials += 1;
    if (outcome.mirror === 'expired') entry.mirrorFalseExpired += 1;
    if (outcome.helper === 'expired') entry.helperFalseExpired += 1;
  }
  saveResult('resumes', {
    mainResumes: mainSet.length,
    falseExpired: {
      helper: mainSet.filter((outcome) => outcome.helper === 'expired').length,
      mirror: mainSet.filter((outcome) => outcome.mirror === 'expired').length,
    },
    falseNeverStarted: {
      helper: outcomes.filter((outcome) => outcome.scenario === 'no-turns-reported-file-on-host' && outcome.helper === 'never-started').length,
      mirror: outcomes.filter((outcome) => outcome.scenario === 'no-turns-reported-file-on-host' && outcome.mirror === 'never-started').length,
    },
    truePositive: {
      helperExpiredOnDeletedLinkUp: outcomes.filter((outcome) => outcome.scenario === 'truly-deleted' && outcome.helper === 'expired').length,
      mirrorExpiredOnDeletedLinkUp: outcomes.filter((outcome) => outcome.scenario === 'truly-deleted' && outcome.mirror === 'expired').length,
      helperNeverStartedOnNothing: outcomes.filter((outcome) => outcome.scenario === 'never-started' && outcome.helper === 'never-started').length,
    },
    scenarios, justCreatedByLag: byLag,
    helperDecisionMs: summarize(outcomes.filter((outcome) => outcome.linkUp).map((outcome) => outcome.helperMs)),
    mirrorDecisionMs: summarize(outcomes.map((outcome) => outcome.mirrorMs)),
    helperBundleAnswered: proofOfLoad.json, linkResyncsDuringRun: allResyncs.length + link.resyncs.length,
    errors: link.errors.slice(0, 5),
  });
}

// ---------- inotify ----------

async function installNode(container) {
  await run('docker', ['exec', container, 'sh', '-c', `set -e
    if [ -x ${REMOTE_NODE} ] && [ "$(${REMOTE_NODE} --version)" = "v${NODE_VERSION}" ]; then exit 0; fi
    cd /tmp
    curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
    curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt
    grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt > one-sum.txt
    sha256sum -c one-sum.txt
    mkdir -p /home/dev/node
    tar -xJf node-v${NODE_VERSION}-linux-x64.tar.xz -C /home/dev/node --strip-components=1
    chown -R dev:dev /home/dev/node
    rm -f node-v${NODE_VERSION}-linux-x64.tar.xz`]);
}

async function copyHostScript(container) {
  await run('docker', ['exec', container, 'sh', '-c', 'mkdir -p /home/dev/probe /home/dev/project/.kangentic/sessions']);
  await run('docker', ['cp', path.join(repositoryRoot, 'scripts', 'probe-ssh-mirror-host.mjs'), `${container}:${REMOTE_SCRIPT}`]);
  const bundlePath = path.join(workDirectory, 'decision-bundle.cjs');
  if (fs.existsSync(bundlePath)) await run('docker', ['cp', bundlePath, `${container}:${REMOTE_BUNDLE}`]);
  await run('docker', ['exec', container, 'chown', '-R', 'dev:dev', '/home/dev/probe', '/home/dev/project']);
}

async function stepSetup() {
  const running = (await run('docker', ['ps', '-q', '--filter', `name=^${CONTAINER}$`])).trim();
  if (!running) {
    // rig-entry.sh makes new host keys in every new container, so the old known_hosts would be refused.
    fs.rmSync(knownHostsPath, { force: true });
    const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
    await run('docker', ['run', '-d', '--name', CONTAINER, '--cap-add', 'NET_ADMIN', '-p', `127.0.0.1:${PORT}:22`, '-e', `AUTHORIZED_KEY=${publicKey}`, 'kangentic-ssh-rig']);
    await delay(1500);
  }
  await installNode(CONTAINER);
  await buildDecisionBundle(path.join(workDirectory, 'decision-bundle.cjs'));
  await copyHostScript(CONTAINER);
  const version = (await dockerDev(`${REMOTE_NODE} --version`)).trim();
  const sshCheck = await run(sshExecutable(), sshArguments('uname -a'));
  saveResult('setup', { hostNode: version, sshUname: sshCheck.trim().split(' ').slice(0, 3).join(' '), ssh: (await run(sshExecutable(), ['-V'], { allowFailure: true })).trim() });
}

async function stepGenerate() {
  await copyHostScript(CONTAINER);
  const argumentsText = `generate --files ${options.files ?? 5000} --total-bytes ${options['total-bytes'] ?? 2147483648} --noise-share ${options['noise-share'] ?? 0.24}`;
  saveResult('generate', JSON.parse(await hostProbe(argumentsText)));
}

async function stepInotify() {
  await copyHostScript(CONTAINER);
  const perFolderCount = JSON.parse(await hostProbe('inotify-count --dirs 15000 --mode per-folder'));
  const recursiveCount = JSON.parse(await hostProbe('inotify-count --dirs 15000 --mode recursive'));
  saveResult('inotify-count', { ...perFolderCount, ...recursiveCount });
  saveResult('inotify-race', JSON.parse(await hostProbe('inotify-race --count 1000')));
  saveResult('inotify-rename', JSON.parse(await hostProbe('inotify-rename')));
  saveResult('inotify-overflow', JSON.parse(await hostProbe('inotify-overflow --events 40000')));

  // A low limit in a user namespace of a throwaway container, so the shared VM's sysctl is never touched.
  const exhaustContainer = `${CONTAINER}-exhaust`;
  await run('docker', ['rm', '-f', exhaustContainer], { allowFailure: true });
  await run('docker', ['run', '-d', '--name', exhaustContainer, '--security-opt', 'seccomp=unconfined', '--security-opt', 'systempaths=unconfined', '--entrypoint', 'sleep', 'kangentic-ssh-rig', '900']);
  try {
    await installNode(exhaustContainer);
    await copyHostScript(exhaustContainer);
    const output = await dockerDev(`unshare -U -r sh -c 'echo 500 > /proc/sys/user/max_inotify_watches; exec ${REMOTE_NODE} ${REMOTE_SCRIPT} inotify-exhaust --dirs 2000'`, exhaustContainer);
    saveResult('inotify-exhaust', JSON.parse(output));
  } finally {
    await run('docker', ['rm', '-f', exhaustContainer], { allowFailure: true });
  }
}

// ---------- paths ----------

function listNames(directory) {
  return fs.readdirSync(directory);
}

async function cmdSees(directory, name) {
  const dirOutput = await run('cmd.exe', ['/c', 'dir', '/b', directory], { allowFailure: true });
  const typeOutput = await run('cmd.exe', ['/d', '/s', '/c', `"type "${path.join(directory, name)}""`], { allowFailure: true, verbatim: true });
  return { cmdListsIt: dirOutput.split(/\r?\n/).includes(name), cmdTypeReads: typeOutput.includes('hazard-content') };
}

async function stepPaths() {
  if (process.platform !== 'win32') { console.error('the paths step measures Windows path hazards and runs only on Windows'); process.exit(2); }
  const root = path.join(workDirectory, 'path-hazards');
  await fsPromises.rm(root, { recursive: true, force: true });
  await fsPromises.mkdir(root, { recursive: true });
  const hazards = ['safe-control.txt', 'a:b', 'rollout-2026-11-01T10:30:00-id.jsonl', 'trailing.', 'trailing...', 'trailing ', 'aux', 'AUX', 'aux.jsonl', 'nul', 'con.txt', 'com1', 'lpt1.log', 'conin$', 'what?', 'star*', 'pipe|', 'less<', 'more>', 'quote"', 'back\\slash', 'ctrl\u0001', 'x'.repeat(255), 'x'.repeat(256)];
  const hazardResults = [];
  for (const [index, name] of hazards.entries()) {
    const directory = path.join(root, `case-${index}`);
    await fsPromises.mkdir(directory);
    const entry = { name: name.length > 40 ? `${name.length} characters` : name };
    try {
      fs.writeFileSync(path.join(directory, name), 'hazard-content');
      entry.write = 'ok';
      entry.listing = listNames(directory).map((listed) => (listed.length > 40 ? `${listed.length} characters` : listed));
      entry.listedSize = entry.listing.length ? fs.statSync(path.join(directory, listNames(directory)[0])).size : null;
      entry.readBack = fs.readFileSync(path.join(directory, name), 'utf8') === 'hazard-content';
      entry.nameKept = listNames(directory).includes(name);
      Object.assign(entry, await cmdSees(directory, name));
    } catch (error) { entry.write = error.code ?? error.message; }
    hazardResults.push(entry);
  }
  const caseDirectory = path.join(root, 'case-collision');
  await fsPromises.mkdir(path.join(caseDirectory, '-home-dev-Repo'), { recursive: true });
  await fsPromises.mkdir(path.join(caseDirectory, '-home-dev-repo'), { recursive: true });
  fs.writeFileSync(path.join(caseDirectory, '-home-dev-Repo', 'a.jsonl'), 'from Repo');
  fs.writeFileSync(path.join(caseDirectory, '-home-dev-repo', 'a.jsonl'), 'from repo');
  const caseCollision = { folders: listNames(caseDirectory), upperReads: fs.readFileSync(path.join(caseDirectory, '-home-dev-Repo', 'a.jsonl'), 'utf8') };

  // MAX_PATH: the mirror's real shape at Claude's longest slug.
  const appData = process.env.APPDATA ?? '';
  const slug = `${'-home-dev-work'.padEnd(200, '-')}-1a2b3c`;
  const id = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const realShapeLength = path.join(appData, 'kangentic', 'remote-homes', hostId, '.claude', 'projects', slug, id, 'subagents', `agent-${'a'.repeat(17)}.meta.json`).length;
  const longDirectory = path.join(root, 'kangentic', 'remote-homes', hostId, '.claude', 'projects', slug, id, 'subagents');
  const longFile = path.join(longDirectory, `agent-${'a'.repeat(17)}.meta.json`);
  const longResult = { realShapeLength, testedLength: longFile.length };
  const attempt = async (label, action) => {
    try { longResult[label] = await action(); } catch (error) { longResult[label] = `failed ${error.code ?? error.message}`; }
  };
  await attempt('nodeMkdir', () => { fs.mkdirSync(longDirectory, { recursive: true }); return 'ok'; });
  await attempt('nodeWrite', () => { fs.writeFileSync(longFile, 'hazard-content'); return 'ok'; });
  await attempt('nodeRead', () => fs.readFileSync(longFile, 'utf8') === 'hazard-content');
  await attempt('nodeRename', () => { fs.renameSync(longFile, `${longFile}.b`); fs.renameSync(`${longFile}.b`, longFile); return 'ok'; });
  await attempt('nodeRecursiveWatch', async () => {
    let saw = false;
    const watcher = fs.watch(path.join(root, 'kangentic'), { recursive: true }, (eventType, name) => { if (name?.endsWith('.touch')) saw = true; });
    await delay(150);
    fs.writeFileSync(path.join(longDirectory, 'x.touch'), 'x');
    await delay(400);
    watcher.close();
    return saw;
  });
  await attempt('nodeSpawnCwd', async () => { const output = await run(process.execPath, ['-p', 'process.cwd().length'], { allowFailure: true }); return output.trim().length > 0; });
  await attempt('cwdInLongFolder', () => new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'echo ok'], { cwd: longDirectory, stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => resolve(`failed ${error.code}`));
    child.on('close', (code) => resolve(`exit ${code}`));
  }));
  await attempt('cmdType', async () => (await run('cmd.exe', ['/d', '/s', '/c', `"type "${longFile}""`], { allowFailure: true, verbatim: true })).includes('hazard-content'));
  await attempt('nodeRecursiveRemove', () => { fs.rmSync(path.join(root, 'kangentic'), { recursive: true, force: true }); return !fs.existsSync(path.join(root, 'kangentic')); });
  const longPathsEnabled = (await run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], { allowFailure: true })).trim().split(/\s+/).at(-1);

  // The mapping: every adversarial name, plus random ones, written for real and read back.
  const mappedRoot = path.join(root, 'mapped');
  await fsPromises.mkdir(mappedRoot);
  const random = crypto.createHash('sha256');
  random.update('913');
  const alphabet = 'aA:.* ?"<>|%~-_\u00e9\u00c9\u00df\u4e2d\u0001bB';
  const adversarial = hazards.filter((name) => !name.includes('\\')).concat(['Repo', 'repo', 'REPO', 'CON', 'con', 'Con.Txt', 'con.txt', 'a.', 'a', 'A', '%41', 'a%2e', '\u00c9', '\u00e9', '\u0065\u0301', 'x.jsonl', 'X.JSONL',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl', '-home-dev-project', 'rollout-2026-11-01T10-30-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl']);
  for (let index = 0; index < 2000; index += 1) {
    let name = '';
    const digest = crypto.createHash('sha256').update(`name-${index}`).digest();
    for (let position = 0; position < (digest[0] % 10) + 1; position += 1) name += alphabet[digest[position + 1] % alphabet.length];
    if (name !== '.' && name !== '..' && !adversarial.includes(name)) adversarial.push(name);
  }
  const mappedNames = new Map();
  let foldedCollisions = 0;
  let failedWrites = 0;
  let readBackFailures = 0;
  let roundTripFailures = 0;
  let listedExact = 0;
  for (const name of adversarial) {
    const mapped = mirrorSegment(name);
    const folded = mapped.toUpperCase();
    if (mappedNames.has(folded) && mappedNames.get(folded) !== name) foldedCollisions += 1;
    mappedNames.set(folded, name);
    if (unmirrorSegment(mapped) !== null && unmirrorSegment(mapped) !== name) roundTripFailures += 1;
    try {
      fs.writeFileSync(path.join(mappedRoot, mapped), name);
      if (fs.readFileSync(path.join(mappedRoot, mapped), 'utf8') !== name) readBackFailures += 1;
    } catch { failedWrites += 1; }
  }
  const listed = new Set(listNames(mappedRoot));
  for (const name of adversarial) if (listed.has(mirrorSegment(name))) listedExact += 1;
  const identity = ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl', '-home-dev-project--kangentic-worktrees-12', 'subagents', 'tool-results', 'status.json', '2026', 'agent-abc.meta.json'];
  const traversal = ['../evil', 'a/../../evil', '/etc/passwd', 'a//b', '.', '..', 'a/./b', 'a\0b', ''];
  const traversalRefused = traversal.filter((candidate) => { try { mirrorPath(mappedRoot, candidate); return false; } catch { return true; } });
  saveResult('paths', {
    hazardResults, caseCollision, longPath: longResult, longPathsEnabled,
    mapping: {
      names: adversarial.length, foldedCollisions, failedWrites, readBackFailures, roundTripFailures, listedExact,
      identityKept: identity.every((name) => mirrorSegment(name) === name),
      examples: Object.fromEntries(['a:b', 'trailing.', 'aux.jsonl', '-home-dev-Repo', 'rollout-2026-11-01T10:30:00-id.jsonl'].map((name) => [name, mirrorSegment(name)])),
      traversalRefused: `${traversalRefused.length} of ${traversal.length}`,
    },
  });
  await fsPromises.rm(root, { recursive: true, force: true });
}

async function stepTeardown() {
  await run('docker', ['rm', '-f', CONTAINER], { allowFailure: true });
  fs.rmSync(knownHostsPath, { force: true });
  for (const entry of await fsPromises.readdir(workDirectory)) {
    if (entry.startsWith('mirror-') || entry === 'shell-project' || entry === 'path-hazards') {
      await fsPromises.rm(path.join(workDirectory, entry), { recursive: true, force: true });
    }
  }
}

const steps = { integrity: stepIntegrity, stall: stepStall, setup: stepSetup, generate: stepGenerate, status: stepStatus, reads: stepReads, sync: stepSync, resumes: stepResumes, inotify: stepInotify, paths: stepPaths, teardown: stepTeardown };
if (!steps[step]) { console.error(`unknown step ${step}`); process.exit(2); }
try {
  await steps[step]();
} catch (error) {
  // A step that throws mid-run leaves netem on, and the next step would measure through it.
  console.error(error);
  await netemOff();
  process.exit(1);
}
process.exit(0);
