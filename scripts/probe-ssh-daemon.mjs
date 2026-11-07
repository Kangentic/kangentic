#!/usr/bin/env node
/**
 * #913 Phase 0 probe: can `PtyHostCore` run as a plain Node socket daemon on Linux, and do
 * its PTYs outlive every way the connection can die?
 *
 * Usage:
 *   node scripts/probe-ssh-daemon.mjs --workdir <folder> --key <ed25519 private key>
 *     [--port 2231] [--systemd-port 2331] [--runs 20] [--repeats 3]
 *     [--cases load,ssh-kill,...] [--keep]
 *
 * Needs the `kangentic-ssh-rig` image (docker build -t kangentic-ssh-rig scripts/probe-ssh-rig),
 * Docker, system ssh, and this repo's node_modules for esbuild and node-pty. The systemd image
 * is built here from scripts/probe-ssh-rig/Dockerfile.systemd. `<key>.pub` must exist, or
 * `ssh-keygen -y` must be able to read the key. Everything written goes under --workdir:
 * the stage, the Node download, runs.jsonl, summary.jsonl. Containers are removed at the
 * end unless --keep is given, and each run starts from a clean host.
 *
 * Each survival case runs --runs times. Every run kills the daemon first, so the daemon a
 * run tests was started by the very ssh session the run then destroys. One client plays
 * main: it spawns a PTY running scripts' counter, breaks the link, reconnects, rebinds to a
 * fresh ptyId, and checks the pid, the counter, the input path and the process table.
 *
 * Cases on the plain rig (sshd under a supervising loop, because the rig's own entrypoint
 * runs sshd as PID 1, where a restart stops the container):
 *   load           Bundle, node-pty, RSS, spawn worker, reap, agent registry
 *   ssh-kill       ssh.exe killed, alternating taskkill and TerminateProcess
 *   sshd-listener  Only the listening sshd restarted, as `systemctl restart ssh` does
 *   sshd-all       Every sshd killed, session processes included, then restarted
 *   netem          100% loss for 8 s, then restored. The 3 s clock starts at the restore
 *   logout-exec    The ssh session that started the daemon ends cleanly
 *   logout-tty     A login shell with a terminal started the daemon, then runs `exit`
 *   race           Eight relays at once, on a clean folder and on a stale socket
 *   longhome       Socket path lengths, absolute and relative
 *   blackhole      A flooding PTY behind an undetected drop: does it stall?
 * Cases on the systemd rig (logind owns each ssh session):
 *   logind-logout, logind-logout-tty  The same logouts with logind present
 *   systemctl-restart                 A real `systemctl restart ssh`
 *   detect                            What a user can read about KillUserProcesses
 *   matrix                            KillUserProcesses against setsid, linger, systemd-run
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each probe pins the Node it measured on, so the pins can differ between probes.
const NODE_VERSION = 'v24.22.2';
const NODE_TARBALL = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;

const HOME = '/home/dev';
const HOST_ROOT = `${HOME}/.kangentic/host`;
const APP_DIR = `${HOST_ROOT}/app`;
const REMOTE_NODE = `${HOST_ROOT}/node/bin/node`;
const RUN_DIR = `${HOST_ROOT}/run`;

const REATTACH_BAR_MS = 3000;
const DROP_MS = 8000;
// A task tag must be a uuid: the reap refuses anything else before it scans.
const REAP_TASK_ID = '11111111-2222-4333-8444-555555555555';
const RETRY_DELAY_MS = 200;
const ATTEMPT_WATCHDOG_MS = 5000;
const RECONNECT_DEADLINE_MS = 60_000;
const SETTLE_LINES = 15;
const MAX_NORMAL_LINE_GAP_MS = 500;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// By full path: under Git Bash a bare `ssh.exe` finds Git's own MSYS build, not Win32-OpenSSH.
const sshExecutable = process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  : 'ssh';
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';

const COUNTER_SOURCE = `
import os, select, sys, time
flood = len(sys.argv) > 1 and sys.argv[1] == '--flood'
seq = 0
interval = 0.01 if flood else 0.1
padding = 'x' * 10000
next_at = time.monotonic()
last_progress = 0
while True:
    timeout = max(0, next_at - time.monotonic())
    ready, _, _ = select.select([0], [], [], timeout)
    if ready:
        line = os.read(0, 1024).decode('ascii', 'replace').strip()
        if line:
            os.write(1, ('P %s\\n' % line).encode())
        continue
    seq += 1
    now_ms = int(time.time() * 1000)
    if flood:
        os.write(1, ('C %d %d %s\\n' % (seq, now_ms, padding)).encode())
        if now_ms - last_progress >= 1000:
            last_progress = now_ms
            with open('/tmp/flood-progress', 'a') as progress:
                progress.write('%d %d\\n' % (now_ms, seq))
    else:
        os.write(1, ('C %d %d\\n' % (seq, now_ms)).encode())
    next_at += interval
    if flood and next_at < time.monotonic():
        next_at = time.monotonic()
`;

function parseOptions(argv) {
  const parsed = {
    port: 2231,
    systemdPort: 2331,
    runs: 20,
    repeats: 3,
    keep: false,
    cases: null,
    workdir: null,
    key: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') parsed.keep = true;
    else if (argument === '--workdir') parsed.workdir = path.resolve(argv[++index]);
    else if (argument === '--key') parsed.key = path.resolve(argv[++index]);
    else if (argument === '--port') parsed.port = Number(argv[++index]);
    else if (argument === '--systemd-port') parsed.systemdPort = Number(argv[++index]);
    else if (argument === '--runs') parsed.runs = Number(argv[++index]);
    else if (argument === '--repeats') parsed.repeats = Number(argv[++index]);
    else if (argument === '--cases') parsed.cases = argv[++index].split(',');
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!parsed.workdir || !parsed.key) throw new Error('--workdir and --key are required, see the header');
  return parsed;
}

const options = parseOptions(process.argv.slice(2));
const runsPath = path.join(options.workdir, 'runs.jsonl');
const summaryPath = path.join(options.workdir, 'summary.jsonl');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const now = () => performance.now();

function say(line) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

function appendJson(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function docker(args, { allowFail = false, timeout = 120_000, input } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, input, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFail && result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} exited ${result.status}: ${result.stderr || result.error}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const rootShell = (context, script, dockerOptions) => docker(['exec', context.container, 'sh', '-c', script], dockerOptions);
/** For a command inside a timed window: rootShell blocks the loop that must see ssh die. */
const rootShellAsync = (context, script) => new Promise((resolve) => {
  spawn('docker', ['exec', context.container, 'sh', '-c', script], { stdio: 'ignore', windowsHide: true }).on('close', resolve).on('error', resolve);
});
const devShell = (context, script, dockerOptions) => docker(['exec', '-u', 'dev', '-e', `HOME=${HOME}`, context.container, 'sh', '-c', script], dockerOptions);

// --- Build and stage -------------------------------------------------------------------

async function buildBundles() {
  const projectRequire = createRequire(path.join(repoRoot, 'package.json'));
  const esbuild = projectRequire('esbuild');
  const stageDir = path.join(options.workdir, 'stage');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers', 'font-list', 'koffi'],
    conditions: ['require'],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''),
      MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      __KANGENTIC_DEV__: 'false',
    },
    minify: true,
    metafile: true,
    logLevel: 'warning',
  };
  const entries = {
    'daemon.js': 'scripts/probe-ssh-daemon.entry.ts',
    'spawn-worker.js': 'src/main/pty/host/spawn-worker/spawn-worker-entry.ts',
    'agent-check.js': 'scripts/probe-ssh-daemon.agent-check.ts',
  };
  const report = {};
  for (const [outputName, entry] of Object.entries(entries)) {
    const outfile = path.join(stageDir, outputName);
    const result = await esbuild.build({ ...common, entryPoints: [path.join(repoRoot, entry)], outfile });
    const externals = new Set();
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (imported.external && !imported.path.startsWith('node:')) externals.add(imported.path);
      }
    }
    report[outputName] = {
      bytes: fs.statSync(outfile).size,
      inputs: Object.keys(result.metafile.inputs).length,
      externalsInGraph: [...externals].sort(),
    };
  }
  fs.copyFileSync(path.join(repoRoot, 'scripts/probe-ssh-daemon.relay.js'), path.join(stageDir, 'relay.js'));
  fs.writeFileSync(path.join(stageDir, 'counter.py'), COUNTER_SOURCE);
  const nodePtySource = fs.realpathSync(path.join(repoRoot, 'node_modules/node-pty'));
  const nodePtyTarget = path.join(stageDir, 'node_modules/node-pty');
  fs.mkdirSync(nodePtyTarget, { recursive: true });
  fs.copyFileSync(path.join(nodePtySource, 'package.json'), path.join(nodePtyTarget, 'package.json'));
  fs.cpSync(path.join(nodePtySource, 'lib'), path.join(nodePtyTarget, 'lib'), { recursive: true });
  fs.cpSync(path.join(nodePtySource, 'prebuilds/linux-x64'), path.join(nodePtyTarget, 'prebuilds/linux-x64'), { recursive: true });
  report.nodePtyVersion = JSON.parse(fs.readFileSync(path.join(nodePtySource, 'package.json'), 'utf8')).version;
  report.nodePtyPrebuild = Object.fromEntries(fs.readdirSync(path.join(nodePtyTarget, 'prebuilds/linux-x64'))
    .map((name) => [name, fs.statSync(path.join(nodePtyTarget, 'prebuilds/linux-x64', name)).size]));
  return { stageDir, report };
}

/** The download sits in its own folder and is read, never run, on this machine. */
function fetchNode() {
  const downloadDir = path.join(options.workdir, 'download');
  fs.mkdirSync(downloadDir, { recursive: true });
  const tarball = path.join(downloadDir, NODE_TARBALL);
  const sums = path.join(downloadDir, 'SHASUMS256.txt');
  execFileSync('curl', ['-sSfL', '--max-time', '60', `${NODE_BASE_URL}/SHASUMS256.txt`, '-o', sums]);
  if (!fs.existsSync(tarball)) {
    // Renamed only when complete, so an interrupted download cannot fail every later run's checksum.
    const partial = `${tarball}.part`;
    execFileSync('curl', ['-sSfL', '--max-time', '300', `${NODE_BASE_URL}/${NODE_TARBALL}`, '-o', partial]);
    fs.renameSync(partial, tarball);
  }
  const expected = fs.readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${NODE_TARBALL}`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (!expected || expected !== actual) throw new Error(`SHA-256 mismatch for ${NODE_TARBALL}: published ${expected}, got ${actual}`);
  say(`verified ${NODE_TARBALL} sha256 ${actual}`);
  return { tarball, sha256: actual, bytes: fs.statSync(tarball).size };
}

function publicKey() {
  const publicKeyPath = `${options.key}.pub`;
  if (fs.existsSync(publicKeyPath)) return fs.readFileSync(publicKeyPath, 'utf8').trim();
  return execFileSync('ssh-keygen', ['-y', '-f', options.key], { encoding: 'utf8' }).trim();
}

// --- Containers ------------------------------------------------------------------------

function contextFor(kind) {
  const suffix = kind === 'systemd' ? 'daemon-systemd' : 'daemon';
  return {
    kind,
    container: `kangentic-ssh-rig-${suffix}`,
    port: kind === 'systemd' ? options.systemdPort : options.port,
    knownHosts: path.join(path.dirname(options.key), `known_hosts-${suffix}`),
  };
}

function sshArguments(context, { tty = false } = {}) {
  return [
    '-p', String(context.port),
    '-i', options.key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${context.knownHosts}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=2',
    '-o', 'ServerAliveInterval=1',
    '-o', 'ServerAliveCountMax=3',
    '-F', nullConfig,
    tty ? '-tt' : '-T',
    'dev@127.0.0.1',
  ];
}

function sshRun(context, remoteCommand, timeout = 15_000) {
  const result = spawnSync(sshExecutable, [...sshArguments(context), remoteCommand], { encoding: 'utf8', timeout, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function waitForSsh(context, timeoutMs = 90_000) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = sshRun(context, 'true');
    if (last.status === 0) return;
    await sleep(300);
  }
  throw new Error(`ssh to ${context.container} never came up: ${last?.stderr}`);
}

async function startContainer(context, stage, nodeDownload) {
  docker(['rm', '-f', context.container], { allowFail: true });
  fs.rmSync(context.knownHosts, { force: true });
  const authorizedKey = `AUTHORIZED_KEY=${publicKey()}`;
  const publishedPort = `127.0.0.1:${context.port}:22`;
  if (context.kind === 'plain') {
    docker(['run', '-d', '--name', context.container, '--init', '--cap-add', 'NET_ADMIN', '-p', publishedPort,
      '-e', authorizedKey, '--entrypoint', '/bin/sh', 'kangentic-ssh-rig',
      '-c', 'while :; do /usr/local/bin/rig-entry.sh; sleep 0.05; done']);
  } else {
    const rigFolder = path.join(repoRoot, 'scripts/probe-ssh-rig');
    docker(['build', '-t', 'kangentic-ssh-rig-systemd', '-f', path.join(rigFolder, 'Dockerfile.systemd'), rigFolder], { timeout: 600_000 });
    docker(['run', '-d', '--name', context.container, '--privileged', '--cgroupns=host',
      '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock',
      '-p', publishedPort, '-e', authorizedKey, 'kangentic-ssh-rig-systemd']);
  }
  await waitForSsh(context);
  rootShell(context, `mkdir -p ${APP_DIR} ${HOST_ROOT}/node ${RUN_DIR}`);
  docker(['cp', `${stage.stageDir}${path.sep}.`, `${context.container}:${APP_DIR}`]);
  docker(['cp', nodeDownload.tarball, `${context.container}:/tmp/${NODE_TARBALL}`]);
  rootShell(context, [
    `tar -xJf /tmp/${NODE_TARBALL} -C ${HOST_ROOT}/node --strip-components=1`,
    `rm -f /tmp/${NODE_TARBALL}`,
    `chown -R dev:dev ${HOME}/.kangentic`,
    `chmod 700 ${HOME}/.kangentic ${HOST_ROOT} ${RUN_DIR}`,
  ].join(' && '));
  say(`${context.container} ready on ${publishedPort}`);
}

function hostProcesses(context) {
  const { stdout } = rootShell(context, 'ps -eo pid=,ppid=,sid=,stat=,args=');
  const rows = stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), sid: Number(match[3]), stat: match[4], args: match[5] } : null;
  }).filter((row) => row && !row.stat.startsWith('Z'));
  return {
    counters: rows.filter((row) => row.args.includes('counter.py')),
    // A relay names daemon.js in its own arguments.
    daemons: rows.filter((row) => row.args.includes('daemon.js') && !row.args.includes('relay.js')),
    relays: rows.filter((row) => row.args.includes('relay.js')),
  };
}

function waitUntil(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    const check = () => {
      const value = predicate();
      if (value) resolve(value);
      else if (now() > deadline) reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`));
      else setTimeout(check, 10);
    };
    check();
  });
}

/** Every run starts here: no dev process, no socket, no shaping. */
async function resetHost(context) {
  if (context.kind === 'systemd') {
    rootShell(context, 'loginctl disable-linger dev; loginctl terminate-user dev; true', { allowFail: true });
    await sleep(150);
  }
  rootShell(context, `pkill -9 -u dev; rm -f ${RUN_DIR}/* /tmp/flood-progress; true`, { allowFail: true });
  if (context.kind === 'plain') rootShell(context, 'tc qdisc del dev eth0 root 2>/dev/null; true', { allowFail: true });
  const deadline = now() + 15_000;
  while (now() < deadline) {
    const { counters, daemons, relays } = hostProcesses(context);
    // A logind restart can leave a session "closing" with nothing in it, so only an
    // active one holds the reset up. The runs themselves check the daemon's own cgroup.
    const openSessions = context.kind === 'systemd'
      ? rootShell(context, 'loginctl list-sessions --no-legend', { allowFail: true }).stdout.split('\n')
        .filter((line) => line.trim() !== '' && !line.includes('closing'))
      : [];
    const devProcesses = rootShell(context, 'ps -u dev --no-headers -o pid', { allowFail: true }).stdout.trim();
    if (counters.length + daemons.length + relays.length === 0 && openSessions.length === 0 && devProcesses === '') return;
    await sleep(100);
  }
  throw new Error('the host did not go clean');
}

// --- The client that plays main --------------------------------------------------------

/** What the client has seen of the counter, across every connection. */
class CounterTracker {
  constructor() {
    this.timestampBySequence = new Map();
    this.liveBuffer = '';
    this.highestLive = 0;
    this.pings = new Set();
  }

  resetLive() {
    this.liveBuffer = '';
  }

  note(line, isLive) {
    const counter = /C (\d+) (\d+)/.exec(line);
    if (counter) {
      const sequence = Number(counter[1]);
      this.timestampBySequence.set(sequence, Number(counter[2]));
      if (isLive) this.highestLive = Math.max(this.highestLive, sequence);
    }
    const ping = /P (ping-\d+)/.exec(line);
    if (ping) this.pings.add(ping[1]);
  }

  ingestLive(text) {
    this.liveBuffer += text;
    const lines = this.liveBuffer.split('\n');
    this.liveBuffer = lines.pop();
    for (const line of lines) this.note(line, true);
  }

  ingestSnapshot(text) {
    for (const line of text.split('\n')) this.note(line, false);
  }

  highest() {
    return Math.max(0, ...this.timestampBySequence.keys());
  }

  analysis() {
    const highest = this.highest();
    const missing = [];
    let largestGapMs = 0;
    for (let sequence = 1; sequence <= highest; sequence += 1) {
      const stamp = this.timestampBySequence.get(sequence);
      const previousStamp = this.timestampBySequence.get(sequence - 1);
      if (stamp === undefined) missing.push(sequence);
      else if (previousStamp !== undefined) largestGapMs = Math.max(largestGapMs, stamp - previousStamp);
    }
    return { highest, missingCount: missing.length, missingFirst: missing.slice(0, 10), largestLineGapMs: largestGapMs };
  }
}

function relayCommand({ startMode = 'setsid', extra = [], ensureOnly = false } = {}) {
  const parts = [REMOTE_NODE, `${APP_DIR}/relay.js`, '--dir', RUN_DIR, '--daemon', `${APP_DIR}/daemon.js`, '--start-mode', startMode, ...extra];
  if (ensureOnly) parts.push('--ensure-only');
  return parts.join(' ');
}

class Link {
  constructor(context, tracker, relayOptions) {
    this.tracker = tracker;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.scrollbackWaiters = new Map();
    this.events = [];
    this.stderr = '';
    this.buffered = '';
    this.closedReason = null;
    this.exitInfo = null;
    this.child = spawn(sshExecutable, [...sshArguments(context), relayCommand(relayOptions)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    tracker.resetLive();
    this.child.stdin.on('error', () => undefined);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.exited = new Promise((resolve) => {
      this.child.on('error', (error) => { this.stderr += String(error); });
      this.child.on('close', (code, signal) => {
        this.exitInfo = { code, signal };
        for (const [, waiter] of this.pending) waiter.reject(new Error('the link closed'));
        this.pending.clear();
        resolve(this.exitInfo);
      });
    });
    this.hello = new Promise((resolve) => { this.resolveHello = resolve; });
    this.send({ t: 'hello' });
  }

  send(frame) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  onData(chunk) {
    this.buffered += chunk;
    let newline = this.buffered.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      newline = this.buffered.indexOf('\n');
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        // A stray banner line: the run reports it as ssh's text instead of ending the whole matrix.
        this.stderr += `not a frame: ${line.slice(0, 200)}\n`;
        continue;
      }
      this.onFrame(frame);
    }
  }

  onFrame(frame) {
    if (frame.t === 'hello') this.resolveHello(frame);
    else if (frame.t === 'closed') this.closedReason = frame.reason;
    else if (frame.t === 'event') this.events.push(frame.event);
    else if (frame.t === 'reply') {
      const waiter = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      if (frame.ok) waiter?.resolve(frame.result);
      else waiter?.reject(new Error(frame.error?.message ?? 'request failed'));
    } else if (frame.t === 'port') {
      const message = frame.message;
      if (message.type === 'data') {
        this.tracker.ingestLive(message.data);
        this.send({ t: 'port', data: { type: 'ack', sessionId: message.sessionId, bytes: message.data.length } });
      } else if (message.type === 'scrollback') {
        this.scrollbackWaiters.get(message.requestId)?.(message.data);
      }
    }
  }

  /** Resolves with the daemon's hello, or throws what ssh said. */
  async ready(timeoutMs) {
    const failed = this.exited.then((info) => {
      throw new Error(`ssh exited ${info.code ?? info.signal} before hello: ${this.stderr.trim()}`);
    });
    const timer = sleep(timeoutMs).then(() => {
      throw new Error(`no hello within ${timeoutMs} ms: ${this.stderr.trim()}`);
    });
    return Promise.race([this.hello, failed, timer]);
  }

  request(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: 'request', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }

  command(command) {
    this.send({ t: 'command', command });
  }

  async scrollback(sessionId) {
    const requestId = this.nextRequestId++;
    const answer = new Promise((resolve) => this.scrollbackWaiters.set(requestId, resolve));
    await this.request('getScrollbackForRenderer', { sessionId, settle: false, rendererId: 1, requestId });
    return Promise.race([answer, sleep(3000).then(() => { throw new Error('no scrollback answer on the port'); })]);
  }

  destroy() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function connectWithRetry(context, tracker, record, relayOptions) {
  const deadline = now() + RECONNECT_DEADLINE_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const link = new Link(context, tracker, relayOptions);
    try {
      const hello = await link.ready(ATTEMPT_WATCHDOG_MS);
      record.attempts = attempts;
      return { link, hello };
    } catch (error) {
      link.destroy();
      const text = String(error.message);
      if (!record.attemptErrors.includes(text)) record.attemptErrors.push(text);
      if (now() > deadline) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function spawnParams({ sessionId, taskId, wirePtyId, flood = false }) {
  return {
    ptyId: wirePtyId,
    sessionId,
    projectId: 'spike',
    agentName: null,
    transient: false,
    file: '/usr/bin/python3',
    args: [`${APP_DIR}/counter.py`, ...(flood ? ['--flood'] : [])],
    cwd: HOME,
    env: { PATH: '/usr/bin:/bin', HOME, TERM: 'xterm-256color', KANGENTIC_TASK_ID: taskId },
    cols: 80,
    rows: 24,
    carryoverFromSessionId: null,
    agentSessionIdKnown: true,
    taskId,
    sentAtMs: Date.now(),
  };
}

/** A login shell with a terminal, for the logout that sends a real hangup. */
async function openTtySession(context, relayOptions = {}) {
  const child = spawn(sshExecutable, sshArguments(context, { tty: true }), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  child.stdin.write(`${relayCommand({ ...relayOptions, ensureOnly: true })}\n`);
  await waitUntil(() => output.includes('ENSURED\r\n') || output.includes('ENSURED\n'), 10_000, 'the tty relay');
  return {
    logout: async () => {
      child.stdin.write('exit\n');
      await Promise.race([exited, sleep(5000)]);
      child.kill('SIGKILL');
    },
    destroy: () => child.kill('SIGKILL'),
    output: () => output,
  };
}

/** Async, because its tree walk takes seconds on a busy machine and the client must keep reading. */
function taskkill(pid) {
  return new Promise((resolve) => {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on('close', resolve).on('error', resolve);
  });
}

/** Breaks the link the way the case names. Sets the clock the reattach is measured from. */
async function injectFailure(caseName, runIndex, context, link, tracker, record, clock, ttySession) {
  const reconnect = () => connectWithRetry(context, tracker, record);
  switch (caseName) {
    case 'ssh-kill': {
      // The clock starts when ssh is gone, since taskkill's own tree walk is not the link's cost.
      const killedAt = now();
      if (runIndex % 2 === 0 && process.platform === 'win32') {
        record.killedBy = 'taskkill';
        void taskkill(link.child.pid);
      } else {
        record.killedBy = 'TerminateProcess';
        link.child.kill('SIGKILL');
      }
      await link.exited;
      clock.startMs = now();
      record.killTookMs = Math.round(clock.startMs - killedAt);
      return reconnect();
    }
    case 'sshd-listener':
    case 'systemctl-restart': {
      // sshd rewrites its title to `sshd: /usr/sbin/sshd -D ... [listener]`.
      if (caseName === 'sshd-listener') rootShell(context, "pkill -TERM -f '^sshd: /usr/sbin/sshd'");
      else rootShell(context, 'systemctl restart ssh');
      await sleep(500);
      record.linkSurvived = link.exitInfo === null;
      const highestBefore = tracker.highestLive;
      await sleep(400);
      record.outputAfterRestart = tracker.highestLive > highestBefore;
      clock.startMs = now();
      return reconnect();
    }
    case 'sshd-all': {
      // As ssh-kill: the clock starts when ssh is gone, since docker exec's own latency is not the link's cost.
      const killedAt = now();
      void rootShellAsync(context, 'pkill -TERM -x sshd');
      await link.exited;
      clock.startMs = now();
      record.killTookMs = Math.round(clock.startMs - killedAt);
      return reconnect();
    }
    case 'netem': {
      const dropAt = now();
      let reconnecting;
      rootShell(context, 'tc qdisc add dev eth0 root netem loss 100%');
      try {
        const info = await Promise.race([link.exited, sleep(DROP_MS).then(() => null)]);
        record.linkDetectMs = info ? Math.round(now() - dropAt) : null;
        record.sshExit = info;
        record.sshDropStderr = link.stderr.trim();
        // ServerAlive gives up in about 4 s of a real drop, so an ssh alive at 8 s never lost its link.
        record.vacuous = info === null;
        reconnecting = reconnect();
        await sleep(Math.max(0, dropAt + DROP_MS - now()));
      } finally {
        rootShell(context, 'tc qdisc del dev eth0 root');
        clock.startMs = now();
      }
      return reconnecting;
    }
    case 'logout-exec':
    case 'logind-logout': {
      clock.startMs = now();
      link.child.stdin.end();
      await link.exited;
      record.sshExit = link.exitInfo;
      return reconnect();
    }
    case 'logout-tty':
    case 'logind-logout-tty': {
      link.child.stdin.end();
      await link.exited;
      clock.startMs = now();
      await ttySession.logout();
      return reconnect();
    }
    default:
      throw new Error(`no failure named ${caseName}`);
  }
}

async function survivalRun(caseName, runIndex, context) {
  const record = { case: caseName, run: runIndex, attemptErrors: [], attempts: 0 };
  const tracker = new CounterTracker();
  const clock = { startMs: 0 };
  const sessionId = `session-${caseName}-${runIndex}`;
  const taskId = `task-${caseName}-${runIndex}`;
  let liveLink = null;
  let ttySession = null;
  await resetHost(context);
  try {
    const usesTty = caseName === 'logout-tty' || caseName === 'logind-logout-tty';
    if (usesTty) ttySession = await openTtySession(context);
    const first = new Link(context, tracker);
    liveLink = first;
    const firstHello = await first.ready(10_000);
    const spawned = await first.request('spawn', spawnParams({ sessionId, taskId, wirePtyId: 1 }));
    if (!spawned.ok) throw new Error(`spawn failed: ${spawned.error?.message}`);
    first.command({ type: 'setRendererFocus', rendererId: 1, sessionIds: [sessionId] });
    await waitUntil(() => tracker.highestLive >= SETTLE_LINES, 10_000, 'the first counter lines');

    const before = hostProcesses(context);
    record.daemonCgroup = firstHello.cgroup;
    if (context.kind === 'systemd') {
      record.logindSessions = rootShell(context, 'loginctl list-sessions --no-legend').stdout.trim();
      record.vacuous = record.logindSessions === '' || !firstHello.cgroup.includes('session-');
    }

    const { link, hello } = await injectFailure(caseName, runIndex, context, first, tracker, record, clock, ttySession);
    liveLink = link;
    const session = hello.sessions.find((candidate) => candidate.sessionId === sessionId);
    record.helloMs = Math.round(now() - clock.startMs);
    record.sessionCount = hello.sessions.length;
    record.samePtyAlive = Boolean(session?.alive) && session.pid === spawned.pid;
    record.sameDaemon = hello.daemonPid === firstHello.daemonPid;
    record.epoch = hello.epoch;
    record.droppedEvents = hello.droppedEventCounts;

    const wirePtyId = 2;
    await link.request('rebind', { sessionId, ptyId: wirePtyId });
    link.command({ type: 'setRendererFocus', rendererId: 1, sessionIds: [sessionId] });
    const snapshot = await link.scrollback(sessionId);
    tracker.ingestSnapshot(snapshot);
    tracker.ingestSnapshot(await link.request('getRawScrollback', { sessionId }));
    const snapshotHighest = tracker.highest();
    record.snapshotHighest = snapshotHighest;
    await waitUntil(() => tracker.highestLive > snapshotHighest, 3000, 'live output after the snapshot');
    record.reattachMs = Math.round(now() - clock.startMs);

    const ping = `ping-${runIndex}`;
    link.send({ t: 'port', data: { type: 'write', sessionId, data: `${ping}\n` } });
    await waitUntil(() => tracker.pings.has(ping), 3000, 'the rebound input path');
    record.inputWorks = true;

    const duplicate = await link.request('spawn', spawnParams({ sessionId: `${sessionId}-second`, taskId, wirePtyId: 3 }));
    record.duplicateRefused = duplicate.ok === false && duplicate.error?.code === 'SPAWN_REFUSED_LIVE';

    await sleep(500);
    const after = hostProcesses(context);
    record.counters = after.counters.length;
    record.daemons = after.daemons.length;
    record.relays = after.relays.length;
    record.counterPidUnchanged = before.counters.length === 1 && after.counters[0]?.pid === before.counters[0].pid;
    record.daemonParent = after.daemons[0]?.ppid;
    record.daemonIsSessionLeader = after.daemons[0]?.sid === after.daemons[0]?.pid;

    link.command({ type: 'kill', ptyId: wirePtyId });
    await waitUntil(() => link.events.some((event) => event.type === 'exit' && event.ptyId === wirePtyId), 3000, 'the exit on the fresh ptyId');
    record.exitOnFreshPtyId = true;
    Object.assign(record, tracker.analysis());
    record.pass = record.samePtyAlive && record.sameDaemon
      && record.reattachMs <= REATTACH_BAR_MS
      && record.counters === 1 && record.daemons === 1 && record.sessionCount === 1
      && record.duplicateRefused
      && record.missingCount === 0
      && !(caseName === 'netem' && record.vacuous);
  } catch (error) {
    record.pass = false;
    record.failure = String(error.stack ?? error);
    Object.assign(record, tracker.analysis());
  } finally {
    liveLink?.destroy();
    ttySession?.destroy();
  }
  appendJson(runsPath, record);
  return record;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function survivalCase(caseName, context) {
  const records = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const record = await survivalRun(caseName, runIndex, context);
    records.push(record);
    say(`${caseName} ${runIndex + 1}/${options.runs} ${record.pass ? 'pass' : 'FAIL'} reattach ${record.reattachMs ?? '-'} ms, missing ${record.missingCount}, line gap ${record.largestLineGapMs} ms${record.failure ? `, ${record.failure.split('\n')[0]}` : ''}`);
  }
  const reattach = records.map((record) => record.reattachMs).filter((value) => typeof value === 'number');
  const detect = records.map((record) => record.linkDetectMs).filter((value) => typeof value === 'number');
  const summary = {
    case: caseName,
    runs: records.length,
    passed: records.filter((record) => record.pass).length,
    alive: records.filter((record) => record.samePtyAlive).length,
    reattachP50Ms: percentile(reattach, 0.5),
    reattachMaxMs: reattach.length ? Math.max(...reattach) : null,
    linkDetectMaxMs: detect.length ? Math.max(...detect) : null,
    linkSurvived: records.filter((record) => record.linkSurvived).length,
    maxAttempts: Math.max(...records.map((record) => record.attempts)),
    totalMissing: records.reduce((sum, record) => sum + (record.missingCount ?? 0), 0),
    largestLineGapMs: Math.max(...records.map((record) => record.largestLineGapMs ?? 0)),
    lineGapsOverNormal: records.filter((record) => (record.largestLineGapMs ?? 0) > MAX_NORMAL_LINE_GAP_MS).length,
    leftoverRelays: Math.max(...records.map((record) => record.relays ?? 0)),
    vacuous: records.filter((record) => record.vacuous).length,
    attemptErrors: [...new Set(records.flatMap((record) => record.attemptErrors))].slice(0, 6),
    failures: records.filter((record) => record.failure).map((record) => record.failure.split('\n')[0]).slice(0, 5),
  };
  appendJson(summaryPath, summary);
  say(JSON.stringify(summary));
}

// --- One-shot cases --------------------------------------------------------------------

function vmRss(context, pid) {
  const { stdout } = rootShell(context, `grep -E '^(VmRSS|VmHWM)' /proc/${pid}/status`, { allowFail: true });
  return stdout.trim().replace(/\s+/g, ' ');
}

async function loadCase(context, stage, nodeDownload) {
  await resetHost(context);
  const result = { case: 'load', bundles: stage.report, nodeTarballBytes: nodeDownload.bytes, nodeSha256: nodeDownload.sha256 };
  result.nodeVersion = devShell(context, `${REMOTE_NODE} -p process.version`).stdout.trim();
  result.glibc = rootShell(context, 'ldd --version | head -1').stdout.trim();
  result.installedKilobytes = rootShell(context, `du -sk ${APP_DIR} ${HOST_ROOT}/node`).stdout.trim().replace(/\s+/g, ' ');
  const ptySmoke = docker(['exec', '-u', 'dev', '-e', `HOME=${HOME}`, '-w', APP_DIR, context.container, REMOTE_NODE, '-e',
    "const p=require('node-pty').spawn('/bin/sh',['-c','echo pty-ok'],{});p.onData(d=>process.stdout.write(d));p.onExit(()=>process.exit(0));"], { allowFail: true });
  result.nodePtySmoke = { status: ptySmoke.status, stdout: ptySmoke.stdout.trim(), stderr: ptySmoke.stderr.trim() };
  const agentCheck = docker(['exec', '-u', 'dev', '-e', `HOME=${HOME}`, '-w', APP_DIR, context.container, REMOTE_NODE, `${APP_DIR}/agent-check.js`], { allowFail: true, timeout: 30_000 });
  result.agentCheck = { status: agentCheck.status, stdout: agentCheck.stdout.trim(), stderr: agentCheck.stderr.trim().slice(0, 2000) };

  const tracker = new CounterTracker();
  const link = new Link(context, tracker);
  try {
    const hello = await link.ready(10_000);
    await sleep(5000);
    const relayPid = hostProcesses(context).relays[0]?.pid;
    result.daemonRssZeroSessions = vmRss(context, hello.daemonPid);
    result.relayRss = vmRss(context, relayPid);
    const sessions = ['load-0', 'load-1', 'load-2', 'load-3', 'load-4'];
    const first = await link.request('spawn', spawnParams({ sessionId: sessions[0], taskId: sessions[0], wirePtyId: 1 }));
    await sleep(5000);
    result.daemonRssOneSession = vmRss(context, hello.daemonPid);
    for (const [index, sessionId] of sessions.slice(1).entries()) {
      await link.request('spawn', spawnParams({ sessionId, taskId: sessionId, wirePtyId: index + 2 }));
    }
    await sleep(5000);
    result.daemonRssFiveSessions = vmRss(context, hello.daemonPid);
    result.firstSpawn = first.ok;

    const execResult = await link.request('exec', { kind: 'execFile', file: '/bin/uname', args: ['-sr'], options: {} });
    result.spawnWorkerExec = execResult;
    result.listProcessesCount = (await link.request('listProcesses')).length;
    devShell(context, `mkdir -p ${HOME}/reap`);
    await link.request('spawn', {
      ...spawnParams({ sessionId: 'load-leftover', taskId: REAP_TASK_ID, wirePtyId: 8 }),
      file: '/bin/sh',
      // The trailing sleep holds the PTY open until the setsid child has left its session.
      args: ['-c', 'setsid sleep 300 </dev/null >/dev/null 2>&1 & sleep 1'],
      cwd: `${HOME}/reap`,
    });
    await sleep(1800);
    result.reapSleepBefore = rootShell(context, 'pgrep -c -u dev -x sleep', { allowFail: true }).stdout.trim();
    const reapTask = { taskId: REAP_TASK_ID, directories: [`${HOME}/reap`], worktreePath: null };
    result.probeTaskProcesses = await link.request('probeTaskProcesses', { tasks: [reapTask], mainPid: hello.daemonPid, readConnections: true }, 20_000);
    const reap = await link.request('reapTaggedProcesses', { tasks: [reapTask], mainPid: hello.daemonPid, stop: true }, 20_000);
    result.reap = { killedPids: reap.killedPids, failureReason: reap.failureReason, unreadableCount: reap.unreadableCount };
    result.reapSleepLeft = rootShell(context, 'pgrep -c -u dev -x sleep', { allowFail: true }).stdout.trim();

    const refused = await link.request('spawn', { ...spawnParams({ sessionId: 'load-refused', taskId: 'load-refused', wirePtyId: 9 }), file: REMOTE_NODE, args: ['-v'] });
    result.ownExecutableRefused = { ok: refused.ok, message: refused.error?.message };
    result.socketFolderMode = rootShell(context, `stat -c '%a %U' ${RUN_DIR} ${RUN_DIR}/s ${HOST_ROOT}`).stdout.trim().replace(/\n/g, '; ');
  } finally {
    link.destroy();
  }
  appendJson(summaryPath, result);
  say(JSON.stringify(result));
}

async function raceCase(context) {
  const rounds = 10;
  const results = { case: 'race', relaysPerRound: 8, clean: [], stale: [] };
  const eightRelays = `for i in 1 2 3 4 5 6 7 8; do ${relayCommand({ ensureOnly: true })} & done; wait`;
  for (let round = 0; round < rounds; round += 1) {
    await resetHost(context);
    devShell(context, eightRelays, { allowFail: true });
    await sleep(300);
    results.clean.push(hostProcesses(context).daemons.length);

    await resetHost(context);
    devShell(context, relayCommand({ ensureOnly: true }));
    await sleep(300);
    // Anchored, or the pattern matches the `sh -c` running this very pkill.
    rootShell(context, `pkill -9 -f '^${REMOTE_NODE} ${APP_DIR}/daemon.js'`);
    await sleep(100);
    const staleSocket = rootShell(context, `test -S ${RUN_DIR}/s; echo $?`).stdout.trim() === '0';
    devShell(context, eightRelays, { allowFail: true });
    await sleep(300);
    results.stale.push({ staleSocket, daemons: hostProcesses(context).daemons.length });
  }
  appendJson(summaryPath, results);
  say(JSON.stringify(results));
}

async function longHomeCase(context) {
  await resetHost(context);
  const results = { case: 'longhome', limit: 'sun_path is 108 bytes, 107 usable', rows: [] };
  for (const socketPathLength of [100, 107, 108, 109, 120, 200]) {
    for (const relative of [false, true]) {
      await resetHost(context);
      const suffixLength = 2;
      const parent = '/home/dev/h';
      let folder = parent;
      while (folder.length + suffixLength < socketPathLength) {
        const remaining = socketPathLength - suffixLength - folder.length - 1;
        folder += `/${'d'.repeat(Math.min(50, Math.max(1, remaining)))}`;
      }
      folder = folder.slice(0, socketPathLength - suffixLength);
      devShell(context, `rm -rf ${parent}; mkdir -p ${folder}`);
      const extra = relative ? ' --socket-relative' : '';
      const ran = devShell(context, `timeout 8 ${REMOTE_NODE} ${APP_DIR}/relay.js --dir ${folder} --daemon ${APP_DIR}/daemon.js --ensure-only${extra}`, { allowFail: true });
      const daemonLog = devShell(context, `tail -n 2 ${folder}/daemon.log`, { allowFail: true }).stdout.trim();
      results.rows.push({
        socketPathLength: `${folder}/s`.length,
        relative,
        exit: ran.status,
        stdout: ran.stdout.trim(),
        stderr: ran.stderr.trim().slice(0, 300),
        daemonLog: daemonLog.slice(0, 400),
        daemons: hostProcesses(context).daemons.length,
      });
    }
  }
  appendJson(summaryPath, results);
  say(JSON.stringify(results));
}

/** The daemon cannot see this drop, so its focus stays set and nothing acks. */
async function blackholeCase(context) {
  await resetHost(context);
  const holdMs = 45_000;
  const result = { case: 'blackhole', holdMs };
  const tracker = new CounterTracker();
  const sampleArguments = ['--sample-ms', '1000'];
  const link = new Link(context, tracker, { extra: sampleArguments });
  let second = null;
  try {
    await link.ready(10_000);
    const sessionId = 'session-blackhole';
    await link.request('spawn', spawnParams({ sessionId, taskId: 'task-blackhole', wirePtyId: 1, flood: true }));
    link.command({ type: 'setRendererFocus', rendererId: 1, sessionIds: [sessionId] });
    await sleep(3000);
    const dropAt = Date.now();
    rootShell(context, 'tc qdisc add dev eth0 root netem loss 100%');
    try {
      await sleep(holdMs);
    } finally {
      rootShell(context, 'tc qdisc del dev eth0 root');
    }
    const restoredAt = Date.now();
    const record = { attemptErrors: [], attempts: 0 };
    const reconnected = await connectWithRetry(context, tracker, record, { extra: sampleArguments });
    second = reconnected.link;
    result.sessionAlive = reconnected.hello.sessions.length === 1 && reconnected.hello.sessions[0].alive;
    await sleep(1500);
    const samples = rootShell(context, `cat ${RUN_DIR}/samples.jsonl`).stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const progress = rootShell(context, 'cat /tmp/flood-progress').stdout.split('\n').filter(Boolean).map((line) => line.split(' ').map(Number));
    result.samples = samples.filter((sample) => sample.at >= dropAt - 2000 && sample.at <= restoredAt + 2000).map((sample) => ({
      secondsAfterDrop: Math.round((sample.at - dropAt) / 1000),
      rssMegabytes: Math.round(sample.rssBytes / 1048576),
      socketQueuedKilobytes: sample.socketQueuedBytes === null ? null : Math.round(sample.socketQueuedBytes / 1024),
      hasOwner: sample.hasOwner,
      paused: sample.pipeline[0]?.paused,
      inFlightKilobytes: Math.round((sample.pipeline[0]?.inFlightBytes ?? 0) / 1024),
    }));
    result.linesPerSecond = progress.filter(([stamp]) => stamp >= dropAt - 2000 && stamp <= restoredAt + 2000)
      .map(([stamp, sequence], index, rows) => {
        if (index === 0) return null;
        const [previousStamp, previousSequence] = rows[index - 1];
        return { secondsAfterDrop: Math.round((stamp - dropAt) / 1000), linesPerSecond: Math.round((sequence - previousSequence) * 1000 / (stamp - previousStamp)) };
      }).filter(Boolean);
  } finally {
    second?.destroy();
    link.destroy();
  }
  appendJson(summaryPath, result);
  say(JSON.stringify({ case: 'blackhole', samples: result.samples.length }));
}

function detectCommand(context, label, command) {
  const ran = sshRun(context, command);
  return { label, command, exit: ran.status, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
}

const detectCommandNamed = (label) => DETECT_COMMANDS.find(([name]) => name === label)[1];

function setKillUserProcesses(context, value) {
  rootShell(context, `mkdir -p /etc/systemd/logind.conf.d && printf '[Login]\\nKillUserProcesses=${value}\\n' > /etc/systemd/logind.conf.d/50-spike.conf && systemctl restart systemd-logind`);
}

const DETECT_COMMANDS = [
  ['manager property', 'loginctl show-session --property=KillUserProcesses'],
  ['manager property by bus', 'busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses'],
  ['linger', 'loginctl show-user "$USER" --property=Linger'],
  ['session id', 'echo "XDG_SESSION_ID=$XDG_SESSION_ID XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"'],
  ['own cgroup', 'cat /proc/self/cgroup'],
  ['user manager', 'systemctl --user is-system-running'],
  ['enable-linger as the user', 'loginctl enable-linger "$USER"'],
  ['linger after', 'loginctl show-user "$USER" --property=Linger'],
  ['disable-linger as the user', 'loginctl disable-linger "$USER"'],
  ['scope', 'systemd-run --user --scope --collect --quiet true'],
];

async function detectCase(plainContext, context) {
  const result = { case: 'detect', plainRig: [], systemdRig: {} };
  await resetHost(plainContext);
  for (const label of ['manager property', 'session id', 'own cgroup']) {
    result.plainRig.push(detectCommand(plainContext, label, detectCommandNamed(label)));
  }
  for (const value of ['no', 'yes']) {
    setKillUserProcesses(context, value);
    await resetHost(context);
    result.systemdRig[value] = DETECT_COMMANDS.map(([label, command]) => detectCommand(context, label, command));
  }
  rootShell(context, 'systemctl stop polkit.service; systemctl mask polkit.service', { allowFail: true });
  await resetHost(context);
  result.systemdRig.withoutPolkit = [detectCommand(context, 'enable-linger with no polkit', detectCommandNamed('enable-linger as the user'))];
  rootShell(context, 'systemctl unmask polkit.service; systemctl start polkit.service', { allowFail: true });
  setKillUserProcesses(context, 'no');
  appendJson(summaryPath, result);
  say(JSON.stringify(result));
}

const MATRIX_CELLS = [
  ...['no', 'yes'].flatMap((kill) => [
    { kill, mode: 'plain', linger: false, shape: 'exec' },
    { kill, mode: 'setsid', linger: false, shape: 'exec' },
    { kill, mode: 'setsid', linger: true, shape: 'exec' },
    { kill, mode: 'scope', linger: false, shape: 'exec' },
    { kill, mode: 'scope', linger: true, shape: 'exec' },
    { kill, mode: 'unit', linger: false, shape: 'exec' },
    { kill, mode: 'unit', linger: true, shape: 'exec' },
  ]),
  { kill: 'no', mode: 'plain', linger: false, shape: 'tty' },
  { kill: 'no', mode: 'setsid', linger: false, shape: 'tty' },
  { kill: 'yes', mode: 'setsid', linger: false, shape: 'tty' },
  { kill: 'yes', mode: 'setsid', linger: false, shape: 'exec', secondSession: true },
  { kill: 'yes', mode: 'unit', linger: true, shape: 'exec', secondSession: true },
];

async function matrixCell(context, cell, repeat) {
  const record = { case: 'matrix', ...cell, repeat };
  await resetHost(context);
  rootShell(context, `loginctl ${cell.linger ? 'enable' : 'disable'}-linger dev`);
  await sleep(cell.linger ? 700 : 100);
  const tracker = new CounterTracker();
  let keepOpen = null;
  let ttySession = null;
  let link = null;
  try {
    if (cell.secondSession) {
      keepOpen = spawn(sshExecutable, [...sshArguments(context), 'sleep 600'], { stdio: 'ignore', windowsHide: true });
      await sleep(700);
    }
    if (cell.shape === 'tty') ttySession = await openTtySession(context, { startMode: cell.mode });
    link = new Link(context, tracker, { startMode: cell.mode });
    const hello = await link.ready(10_000);
    const sessionId = 'session-matrix';
    const spawned = await link.request('spawn', spawnParams({ sessionId, taskId: 'task-matrix', wirePtyId: 1 }));
    link.command({ type: 'setRendererFocus', rendererId: 1, sessionIds: [sessionId] });
    await waitUntil(() => tracker.highestLive >= 5, 10_000, 'counter lines');
    record.relayStderr = link.stderr.trim();
    record.daemonPid = hello.daemonPid;
    record.ptyPid = spawned.pid;
    record.cgroupDuring = hello.cgroup;
    record.sessionsDuring = rootShell(context, 'loginctl list-sessions --no-legend').stdout.trim();
    const birth = hostProcesses(context).daemons[0];
    record.daemonIsSessionLeader = birth?.sid === birth?.pid;
    record.runtimeDirDuring = rootShell(context, 'ls -d /run/user/* 2>/dev/null', { allowFail: true }).stdout.trim();

    link.child.stdin.end();
    await Promise.race([link.exited, sleep(5000)]);
    if (ttySession) await ttySession.logout();
    const endedAt = now();
    let aliveAtEnd = true;
    // logind holds a user manager for UserStopDelaySec, 10 s by default, after the last
    // session. A helper under that manager dies only then, so the watch outlasts it.
    const deadline = endedAt + 14_000;
    while (now() < deadline) {
      const { daemons, counters } = hostProcesses(context);
      aliveAtEnd = daemons.some((daemon) => daemon.pid === hello.daemonPid) && counters.some((counter) => counter.pid === spawned.pid);
      if (!aliveAtEnd) {
        record.diedAfterMs = Math.round(now() - endedAt);
        break;
      }
      await sleep(150);
    }
    record.survived = aliveAtEnd;
    record.sessionsAfter = rootShell(context, 'loginctl list-sessions --no-legend').stdout.trim();
    record.runtimeDirAfter = rootShell(context, 'ls -d /run/user/* 2>/dev/null', { allowFail: true }).stdout.trim();
    const lastExit = rootShell(context, `cat ${RUN_DIR}/last-exit.json`, { allowFail: true }).stdout.trim();
    record.lastExit = lastExit ? JSON.parse(lastExit) : null;
    record.logindJournal = rootShell(context, "journalctl -u systemd-logind -n 4 --no-pager -o cat", { allowFail: true }).stdout.trim();

    const second = new Link(context, tracker, { startMode: cell.mode });
    try {
      const nextHello = await second.ready(10_000);
      record.nextHello = {
        sameDaemon: nextHello.daemonPid === hello.daemonPid,
        sessions: nextHello.sessions.length,
        previousExit: nextHello.previousExit,
        cgroup: nextHello.cgroup,
      };
    } catch (error) {
      record.nextConnectError = String(error.message);
    }
    second.destroy();
    if (keepOpen) {
      keepOpen.kill('SIGKILL');
      keepOpen = null;
    }
  } catch (error) {
    record.failure = String(error.stack ?? error);
    if (link) record.relayStderr = link.stderr.trim();
    if (ttySession) record.ttyOutput = ttySession.output().slice(-800);
  } finally {
    link?.destroy();
    ttySession?.destroy();
    if (keepOpen) keepOpen.kill('SIGKILL');
  }
  appendJson(runsPath, record);
  return record;
}

async function matrixCase(context) {
  let currentKill = null;
  const rows = [];
  for (const cell of MATRIX_CELLS) {
    if (cell.kill !== currentKill) {
      setKillUserProcesses(context, cell.kill);
      currentKill = cell.kill;
    }
    const records = [];
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      records.push(await matrixCell(context, cell, repeat));
    }
    const row = {
      ...cell,
      survived: `${records.filter((record) => record.survived).length}/${records.length}`,
      sessionReal: records.every((record) => (record.sessionsDuring ?? '') !== ''),
      cgroup: records[0].cgroupDuring,
      diedAfterMs: records.map((record) => record.diedAfterMs ?? null),
      lastExitReason: records[0].lastExit?.reason ?? null,
      nextHello: records[0].nextHello ?? null,
      nextConnectError: records[0].nextConnectError ?? null,
      relayStderr: records[0].relayStderr || null,
      failure: records.find((record) => record.failure)?.failure.split('\n')[0] ?? null,
      journal: records[0].logindJournal,
      runtimeDirAfter: records[0].runtimeDirAfter,
    };
    rows.push(row);
    say(`matrix kill=${cell.kill} ${cell.mode} linger=${cell.linger} ${cell.shape}${cell.secondSession ? ' second-session' : ''}: survived ${row.survived}, ${row.lastExitReason ?? 'no exit record'}${row.failure ? `, ${row.failure}` : ''}`);
  }
  setKillUserProcesses(context, 'no');
  appendJson(summaryPath, { case: 'matrix', rows });
}

// --- Main ------------------------------------------------------------------------------

const PLAIN_CASES = ['load', 'ssh-kill', 'sshd-listener', 'sshd-all', 'netem', 'logout-exec', 'logout-tty', 'race', 'longhome', 'blackhole'];
const SYSTEMD_CASES = ['logind-logout', 'logind-logout-tty', 'systemctl-restart', 'detect', 'matrix'];
const SURVIVAL_CASES = new Set(['ssh-kill', 'sshd-listener', 'sshd-all', 'netem', 'logout-exec', 'logout-tty', 'logind-logout', 'logind-logout-tty', 'systemctl-restart']);

async function main() {
  fs.mkdirSync(options.workdir, { recursive: true });
  const selected = options.cases ?? [...PLAIN_CASES, ...SYSTEMD_CASES];
  const stage = await buildBundles();
  say(`bundles: ${JSON.stringify(stage.report)}`);
  const nodeDownload = fetchNode();
  const plain = contextFor('plain');
  const systemd = contextFor('systemd');
  const needsPlain = selected.some((name) => PLAIN_CASES.includes(name) || name === 'detect');
  const needsSystemd = selected.some((name) => SYSTEMD_CASES.includes(name));
  const removeContainers = () => {
    if (options.keep) return;
    if (needsPlain) docker(['rm', '-f', plain.container], { allowFail: true });
    if (needsSystemd) docker(['rm', '-f', systemd.container], { allowFail: true });
  };
  process.once('SIGINT', () => {
    removeContainers();
    process.exit(130);
  });
  try {
    if (needsPlain) await startContainer(plain, stage, nodeDownload);
    if (needsSystemd) await startContainer(systemd, stage, nodeDownload);
    for (const caseName of selected) {
      say(`case ${caseName}`);
      if (SURVIVAL_CASES.has(caseName)) await survivalCase(caseName, SYSTEMD_CASES.includes(caseName) ? systemd : plain);
      else if (caseName === 'load') await loadCase(plain, stage, nodeDownload);
      else if (caseName === 'race') await raceCase(plain);
      else if (caseName === 'longhome') await longHomeCase(plain);
      else if (caseName === 'blackhole') await blackholeCase(plain);
      else if (caseName === 'detect') await detectCase(plain, systemd);
      else if (caseName === 'matrix') await matrixCase(systemd);
      else throw new Error(`no case named ${caseName}`);
    }
  } finally {
    removeContainers();
  }
}

main().then(() => process.exit(0), (error) => {
  say(`failed: ${error.stack ?? error}`);
  process.exit(1);
});
