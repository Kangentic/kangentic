#!/usr/bin/env node
// #913 Phase 0 probe: what system ssh.exe and the ssh2 npm package can each do on Windows.
// Not shipped and not used by CI. Windows only, because every question here is about Win32-OpenSSH.
//
// Usage:
//   node scripts/probe-ssh-signin.mjs --work <dir> --rig-key <private key> --deps <dir> [--only <sections>] [--keep]
//
//   --work     Empty scratch folder. Keys, configs, logs and results.json land here.
//   --rig-key  The rig's scratch private key. Its .pub must sit beside it. The probe never copies or signs it.
//   --deps     Folder holding ssh2 in node_modules (`npm install ssh2` there, never in the repo).
//   --only     Comma list of sections: window, batch, kill, matrix, mux. Default is all five.
//   --runs     Samples per timing condition. Default 20.
//   --keep     Leave the containers and network up for inspection. The next run replaces them.
//
// The env vars KANGENTIC_PROBE_WORK, KANGENTIC_PROBE_RIG_KEY and KANGENTIC_PROBE_DEPS stand in for the flags.
//
// Needs the `kangentic-ssh-rig` image (scripts/probe-ssh-rig). It starts its own network, a target container
// on 127.0.0.1:2232 and a jump container on 127.0.0.1:2233, and removes them at the end. Everything it writes
// is under --work: scratch configs set UserKnownHostsFile, IdentitiesOnly and IdentityAgent so no ssh child
// reads the developer's real ~/.ssh, because a -J hop does not inherit command-line -o options.
//
// Sections:
//   window  Under a real windowless Electron utilityProcess: which spawn options put a console on the desktop.
//           Its two positive controls open a visible console for 5 s on purpose, closed by the probe's own timeout.
//   batch   Does BatchMode reach a -J hop and a ProxyCommand child, or does the hop's prompt hang?
//   kill    ConnectTimeout outcomes, and which processes outlive a natural exit, a plain kill and taskkill /T /F.
//   matrix  Sign-in paths, ssh against ssh2.
//   mux     ControlMaster, -O forward, ~C over a pipe and over ConPTY, then the on-demand ssh -N -L timing.

import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TARGET_CONTAINER = 'kangentic-ssh-rig-signin';
const JUMP_CONTAINER = 'kangentic-ssh-rig-signin-jump';
const NETWORK_NAME = 'kangentic-signin-net';
const TARGET_PORT = 2232;
const JUMP_PORT = 2233;
const HANG_DEADLINE_MS = 8000;
const WINDOW_CASE_DEADLINE_MS = 5000;
const ONE_BYTE_PORT = 7777;
const PASSPHRASE = 'probe-passphrase';
// By full path: a bare `ssh` resolves through PATH, and from Git Bash that finds Git's own MSYS build.
const SSH_BINARY = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
const STREAM_CLOSE_WAIT_MS = 200;
const AGENT_CLOSE_WAIT_MS = 3000;
const POLLER_HEARTBEAT = 'heartbeat';

const options = parseArguments(process.argv.slice(2));
if (process.platform !== 'win32') {
  console.error('This probe answers questions about Win32-OpenSSH and runs only on Windows.');
  process.exit(1);
}

const workDirectory = path.resolve(options.work);
const keysDirectory = path.join(workDirectory, 'keys');
const configDirectory = path.join(workDirectory, 'config');
const rigKeyPath = path.resolve(options.rigKey);
const requireFromDeps = createRequire(path.join(path.resolve(options.deps), 'package.json'));
const resultsPath = path.join(workDirectory, 'results.json');
const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};
const forwardSlash = (value) => value.replaceAll('\\', '/');

function parseArguments(argumentList) {
  const parsed = {
    work: process.env.KANGENTIC_PROBE_WORK,
    rigKey: process.env.KANGENTIC_PROBE_RIG_KEY,
    deps: process.env.KANGENTIC_PROBE_DEPS,
    only: ['window', 'batch', 'kill', 'matrix', 'mux'],
    runs: 20,
    keep: false,
  };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--work') parsed.work = argumentList[(index += 1)];
    else if (argument === '--rig-key') parsed.rigKey = argumentList[(index += 1)];
    else if (argument === '--deps') parsed.deps = argumentList[(index += 1)];
    else if (argument === '--only') parsed.only = argumentList[(index += 1)].split(',');
    else if (argument === '--runs') parsed.runs = Number(argumentList[(index += 1)]);
    else if (argument === '--keep') parsed.keep = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.work || !parsed.rigKey || !parsed.deps) {
    throw new Error('--work, --rig-key and --deps are required. See the header comment.');
  }
  return parsed;
}

function saveResults() {
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const rounded = (value) => Math.round(value * 10) / 10;
  return {
    samples: values.length,
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(Math.max(...values)),
  };
}

function execute(command, argumentList, { input, timeout = 60000, allowFailure = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      argumentList,
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          reject(new Error(`${command} ${argumentList.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
    if (input !== undefined) {
      // A command that exits before reading its input surfaces as EPIPE here and as its exit code above.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function docker(...argumentList) {
  return execute('docker', argumentList);
}

function dockerStrict(...argumentList) {
  return execute('docker', argumentList, { allowFailure: false });
}

function dockerExecInput(container, user, script, input) {
  return execute('docker', ['exec', '-i', '-u', user, container, 'sh', '-c', script], {
    input,
    allowFailure: false,
  });
}

// Snapshot of every process, keyed by pid. Pids are matched with their creation date, so a reused pid
// never reads as a process that survived.
async function processSnapshot() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; ' +
    'name=$_.Name; created=$_.CreationDate.ToFileTimeUtc().ToString(); commandLine=$_.CommandLine } } | ConvertTo-Json -Compress';
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    allowFailure: false,
  });
  return new Map(JSON.parse(stdout).map((entry) => [entry.pid, entry]));
}

function descendantsOf(snapshot, rootProcessId) {
  const tree = [];
  const pending = [rootProcessId];
  const seen = new Set();
  while (pending.length > 0) {
    const currentProcessId = pending.pop();
    if (seen.has(currentProcessId)) continue;
    seen.add(currentProcessId);
    const entry = snapshot.get(currentProcessId);
    if (entry) tree.push(entry);
    for (const candidate of snapshot.values()) {
      if (candidate.parent === currentProcessId) pending.push(candidate.pid);
    }
  }
  return tree;
}

function survivorsOf(tree, snapshot) {
  return tree.filter((entry) => snapshot.get(entry.pid)?.created === entry.created);
}

function describeProcess(entry) {
  const commandLine = (entry.commandLine ?? '').replaceAll(workDirectory, '<work>').replaceAll(forwardSlash(workDirectory), '<work>');
  return `${entry.pid} (parent ${entry.parent}) ${entry.name}: ${commandLine.slice(0, 150)}`;
}

async function treeKill(processId) {
  const startedAt = performance.now();
  const outcome = await execute('taskkill', ['/T', '/F', '/PID', String(processId)]);
  return { code: outcome.code, milliseconds: Math.round(performance.now() - startedAt), output: outcome.stdout.trim() };
}

// Runs ssh the way a utility process would: piped stdio and no visible console, with stdin left open.
function startSsh(argumentList, { environment = {} } = {}) {
  const child = spawn(SSH_BINARY, argumentList, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  const state = { child, stdout: '', stderr: '', exitCode: undefined, exited: false, startedAt: performance.now() };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString();
  });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve) => child.on('close', resolve));
  state.exit = new Promise((resolve) => {
    child.on('exit', (code) => {
      state.exitCode = code;
      state.exited = true;
      state.exitedAt = performance.now();
      // `exit` can beat the last stderr write. The wait is capped because a hop grandchild can hold the pipe.
      void Promise.race([closed, delay(STREAM_CLOSE_WAIT_MS)]).then(resolve);
    });
    child.on('error', (error) => {
      state.stderr += `spawn error: ${error.message}`;
      state.exited = true;
      resolve();
    });
  });
  return state;
}

// Runs ssh to completion. A run still alive at the deadline is a hang: its tree is recorded, tree killed and
// checked again.
async function runSsh(argumentList, { environment, deadlineMs = HANG_DEADLINE_MS } = {}) {
  const state = startSsh(argumentList, { environment });
  const finished = await Promise.race([state.exit.then(() => true), delay(deadlineMs).then(() => false)]);
  if (finished) {
    return {
      outcome: state.exitCode === 0 ? 'signed in' : 'failed',
      exitCode: state.exitCode,
      milliseconds: Math.round(state.exitedAt - state.startedAt),
      stderr: state.stderr.trim(),
      stdout: state.stdout.trim(),
    };
  }
  const tree = descendantsOf(await processSnapshot(), state.child.pid);
  const kill = await treeKill(state.child.pid);
  await state.exit;
  await delay(500);
  const survivors = survivorsOf(tree, await processSnapshot());
  for (const survivor of survivors) await treeKill(survivor.pid);
  return {
    outcome: 'HUNG',
    milliseconds: deadlineMs,
    stderr: state.stderr.trim(),
    tree: tree.map(describeProcess),
    killMs: kill.milliseconds,
    survivors: survivors.map(describeProcess),
  };
}

function lastLine(text) {
  return text.split(/\r?\n/).filter(Boolean).pop() ?? '';
}

async function waitForBanner(port) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const banner = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(1000);
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve('');
      });
      socket.once('error', () => resolve(''));
    });
    if (banner.startsWith('SSH-')) return;
    await delay(200);
  }
  throw new Error(`No ssh banner on port ${port}`);
}

async function removeRig() {
  await docker('rm', '-f', TARGET_CONTAINER, JUMP_CONTAINER);
  await docker('network', 'rm', NETWORK_NAME);
}

async function generateKey(name, passphrase = '') {
  const keyPath = path.join(keysDirectory, name);
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', `probe-${name}`, '-f', keyPath], {
    allowFailure: false,
  });
  await execute('icacls', [keyPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { allowFailure: false });
  return keyPath;
}

async function setupRig() {
  await removeRig();
  fs.mkdirSync(keysDirectory, { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  const rigPublicKey = fs.readFileSync(`${rigKeyPath}.pub`, 'utf8').trim();

  await dockerStrict('network', 'create', NETWORK_NAME);
  for (const [name, port] of [[TARGET_CONTAINER, TARGET_PORT], [JUMP_CONTAINER, JUMP_PORT]]) {
    await dockerStrict('run', '-d', '--name', name, '--network', NETWORK_NAME, '--cap-add', 'NET_ADMIN',
      '-p', `127.0.0.1:${port}:22`, '-e', `AUTHORIZED_KEY=${rigPublicKey}`, 'kangentic-ssh-rig');
    await waitForBanner(port);
  }

  // Keys are regenerated on every setup so a run starts clean. The rig key is never signed: ssh auto-loads
  // a -cert.pub beside a key, which would change sign-in for the other spikes.
  fs.rmSync(keysDirectory, { recursive: true, force: true });
  fs.mkdirSync(keysDirectory, { recursive: true });
  const hostCaKey = await generateKey('host_ca');
  const otherHostCaKey = await generateKey('other_host_ca');
  const userCaKey = await generateKey('user_ca');
  const certificateUserKey = await generateKey('cert_user');
  const passphraseKey = await generateKey('passphrase_user', PASSPHRASE);

  await execute('ssh-keygen', ['-q', '-s', userCaKey, '-I', 'probe-user', '-n', 'dev', '-V', '+1d', `${certificateUserKey}.pub`], {
    allowFailure: false,
  });

  const passphrasePublicKey = fs.readFileSync(`${passphraseKey}.pub`, 'utf8').trim();
  for (const container of [TARGET_CONTAINER, JUMP_CONTAINER]) {
    await dockerExecInput(container, 'dev', 'cat >> /home/dev/.ssh/authorized_keys', `${passphrasePublicKey}\n`);
  }

  const targetHostPublicKey = (await dockerStrict('exec', TARGET_CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim();
  const jumpHostPublicKey = (await dockerStrict('exec', JUMP_CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim();
  const hostKeyBody = (publicKeyLine) => publicKeyLine.split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(path.join(keysDirectory, 'target_host.pub'), `${targetHostPublicKey}\n`);
  await execute('ssh-keygen', ['-q', '-s', hostCaKey, '-I', 'probe-target', '-h',
    '-n', `127.0.0.1,${TARGET_CONTAINER}`, '-V', '+1d', path.join(keysDirectory, 'target_host.pub')], { allowFailure: false });
  const hostCertificate = fs.readFileSync(path.join(keysDirectory, 'target_host-cert.pub'), 'utf8');

  await dockerExecInput(TARGET_CONTAINER, 'root', 'cat > /etc/ssh/ssh_host_ed25519_key-cert.pub', hostCertificate);
  await dockerExecInput(TARGET_CONTAINER, 'root', 'cat > /etc/ssh/trusted_user_ca.pub', fs.readFileSync(`${userCaKey}.pub`, 'utf8'));
  await dockerExecInput(TARGET_CONTAINER, 'root', 'cat > /etc/ssh/sshd_config.d/10-probe.conf',
    'HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub\nTrustedUserCAKeys /etc/ssh/trusted_user_ca.pub\n');
  await dockerStrict('exec', TARGET_CONTAINER, 'sh', '-c', 'kill -HUP 1');
  await delay(1000);
  await waitForBanner(TARGET_PORT);

  const fullKnownHosts = [
    `[127.0.0.1]:${TARGET_PORT} ${hostKeyBody(targetHostPublicKey)}`,
    `[127.0.0.1]:${JUMP_PORT} ${hostKeyBody(jumpHostPublicKey)}`,
    `${TARGET_CONTAINER} ${hostKeyBody(targetHostPublicKey)}`,
  ];
  writeFile('known_hosts-full', fullKnownHosts);
  writeFile('known_hosts-target-only', [fullKnownHosts[0], fullKnownHosts[2]]);
  writeFile('known_hosts-ca', [
    `@cert-authority [127.0.0.1]:${TARGET_PORT} ${fs.readFileSync(`${hostCaKey}.pub`, 'utf8').trim()}`,
  ]);
  writeFile('known_hosts-wrong-ca', [
    `@cert-authority [127.0.0.1]:${TARGET_PORT} ${fs.readFileSync(`${otherHostCaKey}.pub`, 'utf8').trim()}`,
  ]);

  fs.writeFileSync(path.join(configDirectory, 'askpass-fail.cmd'), '@exit /b 1\r\n');
  await dockerStrict('exec', '-d', TARGET_CONTAINER, 'python3', '-c',
    'import socket,sys\nserver=socket.socket()\nserver.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n' +
    `server.bind(("127.0.0.1",${ONE_BYTE_PORT}))\nserver.listen(64)\n` +
    'while True:\n  connection,_=server.accept()\n  connection.sendall(b"K")\n  connection.close()\n',
    '--kangentic-no-activity-hold');
}

function writeFile(name, lines) {
  const filePath = path.join(configDirectory, name);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

// A stand-in for a user's own ~/.ssh/config. Nothing here sets BatchMode.
function writeUserConfig(name, { hopKey = rigKeyPath, knownHosts = 'known_hosts-full', strict = 'ask', targetKey = rigKeyPath } = {}) {
  const configPath = path.join(configDirectory, name);
  const proxyCommand = `ssh -F ${forwardSlash(configPath)} -W %h:%p rig-jump`;
  writeFile(name, [
    'Host rig-jump',
    '  HostName 127.0.0.1',
    `  Port ${JUMP_PORT}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(hopKey)}`,
    'Host rig-target',
    `  HostName ${TARGET_CONTAINER}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(targetKey)}`,
    'Host rig-target-configured-jump',
    `  HostName ${TARGET_CONTAINER}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(targetKey)}`,
    '  ProxyJump rig-jump',
    'Host rig-target-configured-command',
    `  HostName ${TARGET_CONTAINER}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(targetKey)}`,
    `  ProxyCommand ${proxyCommand}`,
    'Host rig-direct',
    '  HostName 127.0.0.1',
    `  Port ${TARGET_PORT}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(targetKey)}`,
    'Host *',
    `  UserKnownHostsFile ${forwardSlash(path.join(configDirectory, knownHosts))}`,
    '  GlobalKnownHostsFile NUL',
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  StrictHostKeyChecking ${strict}`,
  ]);
  return configPath;
}

// The candidate fix: an app-owned config that sets BatchMode first and includes the user's file. First value
// wins in ssh_config, and -J hands -F to the hop.
async function writeWrapperConfig(name, userConfigPath) {
  // ssh forces the permission check on an Included file, unlike the file named by -F.
  await execute('icacls', [userConfigPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { allowFailure: false });
  return writeFile(name, ['BatchMode yes', `Include ${forwardSlash(userConfigPath)}`]);
}

const hostName = (transport) =>
  transport === 'jump flag' ? 'rig-target' : transport === 'ProxyJump in config' ? 'rig-target-configured-jump' : 'rig-target-configured-command';

// Every spawn here is windowsHide with piped stdio. Detached ssh opens a console on the desktop for its -J hop,
// so the window section measures that once, with its own short deadline.
async function sectionBatch() {
  const section = { spawn: 'windowsHide, piped stdio' };
  results.batch = section;

  const hopCommand = writeUserConfig('user-hop-probe.conf');
  const verbose = await runSsh(['-v', '-F', hopCommand, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=7', '-J', 'rig-jump', 'rig-target', 'true']);
  section.implicitProxyCommand = verbose.stderr.split(/\r?\n/).filter((line) => /implicit ProxyCommand|Executing proxy/.test(line));
  section.jumpVerboseOutcome = { outcome: verbose.outcome, milliseconds: verbose.milliseconds, last: lastLine(verbose.stderr) };

  section.baseline = {};
  for (const transport of ['jump flag', 'ProxyJump in config', 'ProxyCommand in config']) {
    const args = ['-F', hopCommand, '-o', 'BatchMode=yes', ...(transport === 'jump flag' ? ['-J', 'rig-jump'] : []), hostName(transport), 'true'];
    const outcome = await runSsh(args);
    section.baseline[transport] = { outcome: outcome.outcome, milliseconds: outcome.milliseconds, last: lastLine(outcome.stderr) };
  }

  const prompts = {
    'unknown host key on hop': { knownHosts: 'known_hosts-target-only' },
    'passphrase key on hop': { hopKey: path.join(keysDirectory, 'passphrase_user') },
  };
  const askpassEnvironment = {
    SSH_ASKPASS: path.join(configDirectory, 'askpass-fail.cmd'),
    SSH_ASKPASS_REQUIRE: 'force',
  };
  section.prompts = [];
  for (const [promptName, promptConfig] of Object.entries(prompts)) {
    const safeName = promptName.replaceAll(' ', '-');
    const userConfig = writeUserConfig(`user-${safeName}.conf`, promptConfig);
    const wrapperConfig = await writeWrapperConfig(`wrapper-${safeName}.conf`, userConfig);
    for (const transport of ['jump flag', 'ProxyJump in config', 'ProxyCommand in config']) {
      const transportArguments = transport === 'jump flag' ? ['-J', 'rig-jump'] : [];
      const treatments = {
        'none (control)': { configPath: userConfig, extra: [] },
        'BatchMode=yes on command line': { configPath: userConfig, extra: ['-o', 'BatchMode=yes'] },
        'wrapper -F with BatchMode first': { configPath: wrapperConfig, extra: [] },
        'SSH_ASKPASS failing program, REQUIRE=force': { configPath: userConfig, extra: [], environment: askpassEnvironment },
        'BatchMode=yes plus ConnectTimeout=5': { configPath: userConfig, extra: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'] },
        'app-built ProxyCommand carrying BatchMode=yes': {
          configPath: userConfig,
          extra: ['-o', 'BatchMode=yes', '-o', `ProxyCommand=${forwardSlash(SSH_BINARY)} -F ${forwardSlash(userConfig)} -o BatchMode=yes -W %h:%p rig-jump`],
          dropJump: true,
        },
      };
      for (const [treatmentName, treatment] of Object.entries(treatments)) {
        const outcome = await runSsh(
          ['-F', treatment.configPath, ...treatment.extra, ...(treatment.dropJump ? [] : transportArguments), hostName(transport), 'true'],
          { environment: treatment.environment },
        );
        const record = {
          prompt: promptName,
          transport,
          treatment: treatmentName,
          outcome: outcome.outcome,
          exitCode: outcome.exitCode,
          milliseconds: outcome.milliseconds,
          last: lastLine(outcome.stderr),
          tree: outcome.tree,
          survivors: outcome.survivors,
        };
        section.prompts.push(record);
        console.log(`batch: ${promptName} / ${transport} / ${treatmentName}: ${record.outcome} ${record.milliseconds} ms ${record.last}`);
        saveResults();
      }
    }
  }

  // Direct target with a passphrase key, as the control that command-line BatchMode does work without a hop.
  const directConfig = writeUserConfig('user-direct-passphrase.conf', { targetKey: path.join(keysDirectory, 'passphrase_user') });
  section.direct = {};
  for (const [name, extra] of Object.entries({ 'none (control)': [], 'BatchMode=yes on command line': ['-o', 'BatchMode=yes'] })) {
    const outcome = await runSsh(['-F', directConfig, ...extra, 'rig-direct', 'true']);
    section.direct[name] = { outcome: outcome.outcome, milliseconds: outcome.milliseconds, last: lastLine(outcome.stderr) };
  }
  results.batch = section;
  saveResults();
}

// netem loss also drops ARP replies, so once the hop's neighbour entry expires its connect fails fast with
// "No route to host" and nothing is blackholed. A permanent entry keeps the loss a true SYN blackhole.
async function pinTargetNeighbourOnHop() {
  const inspect = await dockerStrict('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.MacAddress}}{{end}}', TARGET_CONTAINER);
  const [address, hardwareAddress] = inspect.stdout.trim().split(' ');
  await dockerStrict('exec', JUMP_CONTAINER, 'ip', 'neigh', 'replace', address, 'lladdr', hardwareAddress, 'nud', 'permanent', 'dev', 'eth0');
}

// Strict: a qdisc that never went on would leave the kill section measuring a healthy network.
async function dropAllPackets() {
  await dockerStrict('exec', TARGET_CONTAINER, 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'loss', '100%');
}

function clearShaping() {
  return docker('exec', TARGET_CONTAINER, 'tc', 'qdisc', 'del', 'dev', 'eth0', 'root');
}

// Kills the process whenever ending the run needs it, then reports what is left of the tree captured while
// the run was alive.
async function observeTree(argumentList, { captureAtMs, endWith, deadlineMs = 30000 }) {
  const state = startSsh(argumentList);
  await delay(captureAtMs);
  const snapshotStartedAt = performance.now();
  const treeBefore = descendantsOf(await processSnapshot(), state.child.pid);
  // ConnectTimeout is 5 s here and a snapshot can take seconds, so a kill can arrive after ssh gave up.
  // rootAliveAtEnd false says it had already gone; endedByTimeout also catches a kill that lost the race.
  const record = { before: treeBefore.map(describeProcess), snapshotMs: Math.round(performance.now() - snapshotStartedAt), rootAliveAtEnd: !state.exited };

  if (endWith === 'tree kill') {
    record.kill = await treeKill(state.child.pid);
  } else if (endWith === 'plain kill') {
    state.child.kill();
    record.kill = 'TerminateProcess on the ssh pid only';
  }
  const finished = await Promise.race([state.exit.then(() => true), delay(deadlineMs).then(() => false)]);
  record.exited = finished;
  record.exitCode = state.exitCode;
  record.exitMs = finished ? Math.round(state.exitedAt - state.startedAt) : undefined;
  record.last = lastLine(state.stderr);
  record.stderr = state.stderr.trim().slice(-300);
  record.endedByTimeout = state.exitCode === 255 && /timed out/.test(record.last);

  await delay(1000);
  const afterOneSecond = survivorsOf(treeBefore, await processSnapshot());
  record.afterOneSecond = afterOneSecond.map(describeProcess);
  await delay(5000);
  const afterSixSeconds = survivorsOf(treeBefore, await processSnapshot());
  record.afterSixSeconds = afterSixSeconds.map(describeProcess);

  if (afterSixSeconds.length > 0) {
    record.treeKillOnDeadRoot = await treeKill(state.child.pid);
    await delay(500);
    record.afterRootTreeKill = survivorsOf(treeBefore, await processSnapshot()).map(describeProcess);
    for (const survivor of afterSixSeconds) await treeKill(survivor.pid);
  }
  if (!state.exited) await treeKill(state.child.pid);
  return record;
}

async function sectionKill() {
  const section = {};
  results.kill = section;
  const userConfig = writeUserConfig('user-kill.conf');
  const promptingConfig = writeUserConfig('user-kill-prompting.conf', { knownHosts: 'known_hosts-target-only' });
  const stubbornScript = path.join(configDirectory, 'stubborn-proxy.mjs');
  fs.writeFileSync(stubbornScript, 'setInterval(() => {}, 1000); process.stdin.on("end", () => {}); process.stdin.resume();\n');
  const stubbornCommand = `node ${forwardSlash(stubbornScript)}`;
  const timeoutArguments = ['-F', userConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];

  section.unroutableDirect = await runSsh(['-F', userConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'dev@192.0.2.1', 'true'], { deadlineMs: 25000 });

  await pinTargetNeighbourOnHop();
  await dropAllPackets();
  try {
    const shapes = {
      'direct, banner wait (Docker proxy accepts TCP, netem drops the rest)': [...timeoutArguments, 'rig-direct', 'true'],
      'jump flag, SYN blackhole on the hop leg': [...timeoutArguments, '-J', 'rig-jump', 'rig-target', 'true'],
      'ProxyCommand ssh -W, SYN blackhole on the hop leg': [...timeoutArguments, 'rig-target-configured-command', 'true'],
      'ProxyCommand that ignores stdin EOF': [...timeoutArguments, '-o', `ProxyCommand=${stubbornCommand}`, 'rig-target', 'true'],
      'jump flag, hop stuck on a prompt in its hidden console': ['-F', promptingConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-J', 'rig-jump', 'rig-target', 'true'],
    };
    for (const [shapeName, argumentList] of Object.entries(shapes)) {
      section[shapeName] = {};
      for (const endWith of ['natural timeout', 'tree kill', 'plain kill']) {
        const record = await observeTree(argumentList, { captureAtMs: 2500, endWith });
        section[shapeName][endWith] = record;
        console.log(`kill: ${shapeName} / ${endWith}: before ${record.before.length}, after ${record.afterSixSeconds.length}, ${record.last}`);
        saveResults();
      }
    }
  } finally {
    await clearShaping();
  }
  results.kill = section;
  saveResults();
}

function hostVerifierRecorder(store) {
  return (key) => {
    const typeLength = key.readUInt32BE(0);
    store.hostKeyType = key.subarray(4, 4 + typeLength).toString();
    return true;
  };
}

function ssh2Connect(connectConfig) {
  const { Client } = requireFromDeps('ssh2');
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const client = new Client();
    const finish = (record) => {
      client.removeAllListeners('error');
      client.on('error', () => {});
      client.end();
      resolve({ ...record, milliseconds: Math.round(performance.now() - startedAt) });
    };
    client.on('ready', () => {
      client.exec('true', (error, stream) => {
        if (error) {
          finish({ outcome: 'failed', error: error.message });
          return;
        }
        stream.on('close', (code) => finish({ outcome: code === 0 ? 'signed in' : 'failed', exitCode: code }));
        stream.resume();
      });
    });
    client.on('error', (error) => finish({ outcome: 'failed', error: `${error.level ?? ''} ${error.code ?? ''} ${error.message}`.trim() }));
    try {
      client.connect({ readyTimeout: 8000, ...connectConfig });
    } catch (error) {
      finish({ outcome: 'threw', error: error.message });
    }
  });
}

function ssh2JumpChain(jumpConfig, targetConfig, targetHost) {
  const { Client } = requireFromDeps('ssh2');
  return new Promise((resolve) => {
    const hop = new Client();
    hop.on('error', (error) => resolve({ outcome: 'failed', error: error.message }));
    hop.on('ready', () => {
      hop.forwardOut('127.0.0.1', 0, targetHost, 22, async (error, stream) => {
        if (error) {
          hop.end();
          resolve({ outcome: 'failed', error: error.message });
          return;
        }
        const outcome = await ssh2Connect({ ...targetConfig, sock: stream });
        hop.end();
        resolve(outcome);
      });
    });
    try {
      hop.connect({ readyTimeout: 8000, ...jumpConfig });
    } catch (error) {
      resolve({ outcome: 'threw', error: error.message });
    }
  });
}

function sshString(value) {
  const body = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

// Only an in-memory ssh-agent stand-in on a scratch pipe name: it proves the pipe transport and how a client
// treats a key type it cannot parse. It is not the Windows OpenSSH Authentication Agent service.
function startStandInAgent(pipePath, signingKey, extraBlobs) {
  const signingBlob = signingKey.getPublicSSH();
  const identities = [...extraBlobs, signingBlob];
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const messageLength = pending.readUInt32BE(0);
        const message = pending.subarray(4, 4 + messageLength);
        pending = pending.subarray(4 + messageLength);
        socket.write(answerAgentMessage(message, signingKey, signingBlob, identities));
      }
    });
  });
  return new Promise((resolve) => server.listen(pipePath, () => resolve(server)));
}

function answerAgentMessage(message, signingKey, signingBlob, identities) {
  const frame = (body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
  };
  const SSH_AGENTC_REQUEST_IDENTITIES = 11;
  const SSH_AGENTC_SIGN_REQUEST = 13;
  if (message[0] === SSH_AGENTC_REQUEST_IDENTITIES) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(identities.length);
    const entries = identities.map((blob) => Buffer.concat([sshString(blob), sshString('probe')]));
    return frame(Buffer.concat([Buffer.from([12]), count, ...entries]));
  }
  if (message[0] === SSH_AGENTC_SIGN_REQUEST) {
    const blobLength = message.readUInt32BE(1);
    const blob = message.subarray(5, 5 + blobLength);
    const dataLength = message.readUInt32BE(5 + blobLength);
    const data = message.subarray(9 + blobLength, 9 + blobLength + dataLength);
    if (blob.equals(signingBlob)) {
      const signature = Buffer.concat([sshString('ssh-ed25519'), sshString(signingKey.sign(data))]);
      return frame(Buffer.concat([Buffer.from([14]), sshString(signature)]));
    }
  }
  return frame(Buffer.from([5]));
}

// Builds an OpenSSH private key container of a security key type with made-up contents, which is enough to
// exercise ssh2's parser with no hardware.
function syntheticSecurityKey() {
  const keyType = 'sk-ssh-ed25519@openssh.com';
  const publicBytes = Buffer.alloc(32, 7);
  const application = 'ssh:';
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicBytes), sshString(application)]);
  const checkValue = Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]);
  const privateSection = Buffer.concat([
    checkValue,
    sshString(keyType),
    sshString(publicBytes),
    sshString(application),
    Buffer.from([1]),
    sshString(Buffer.alloc(32, 9)),
    sshString(''),
    sshString('probe'),
  ]);
  const padded = Buffer.concat([privateSection, Buffer.from([1, 2, 3, 4, 5, 6, 7].slice(0, 8 - (privateSection.length % 8)))]);
  const keyCount = Buffer.alloc(4);
  keyCount.writeUInt32BE(1);
  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    keyCount,
    sshString(publicBlob),
    sshString(padded),
  ]);
  const body = container.toString('base64').match(/.{1,70}/g).join('\n');
  return {
    publicLine: `${keyType} ${publicBlob.toString('base64')} probe`,
    publicBlob,
    privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}

async function sectionMatrix() {
  const { utils } = requireFromDeps('ssh2');
  const section = { ssh2Version: requireFromDeps('ssh2/package.json').version };
  results.matrix = section;
  const userConfig = writeUserConfig('user-matrix.conf');
  const rigKey = fs.readFileSync(rigKeyPath);
  const summarizeSsh = (outcome) => ({ outcome: outcome.outcome, milliseconds: outcome.milliseconds, last: lastLine(outcome.stderr) });
  const direct = { host: '127.0.0.1', port: TARGET_PORT, username: 'dev' };
  const ssh = async (...argumentList) => summarizeSsh(await runSsh(['-o', 'BatchMode=yes', ...argumentList]));

  section.capabilities = {
    keyTypes: (await execute(SSH_BINARY, ['-Q', 'key'])).stdout.split(/\r?\n/).filter(Boolean),
    helpers: ['ssh-sk-helper.exe', 'ssh-pkcs11-helper.exe', 'ssh-agent.exe'].filter((helper) =>
      fs.existsSync(path.join(path.dirname(SSH_BINARY), helper))),
  };

  section.alias = {
    ssh: await ssh('-F', userConfig, 'rig-direct', 'true'),
    ssh2: await ssh2Connect({ host: 'rig-direct', username: 'dev', privateKey: rigKey }),
  };
  section.identityFile = {
    ssh: await ssh('-F', userConfig, 'rig-direct', 'true'),
    ssh2NoKeyArgument: await ssh2Connect(direct),
    ssh2KeyBytesFromApp: await ssh2Connect({ ...direct, privateKey: rigKey }),
  };
  section.proxyJump = {
    sshFlag: await ssh('-F', userConfig, '-J', 'rig-jump', 'rig-target', 'true'),
    sshConfig: await ssh('-F', userConfig, 'rig-target-configured-jump', 'true'),
    sshProxyCommand: await ssh('-F', userConfig, 'rig-target-configured-command', 'true'),
    ssh2ConfigKey: await ssh2Connect({ ...direct, proxyJump: 'rig-jump', privateKey: rigKey }),
    ssh2ChainedByApp: await ssh2JumpChain(
      { host: '127.0.0.1', port: JUMP_PORT, username: 'dev', privateKey: rigKey },
      { host: TARGET_CONTAINER, username: 'dev', privateKey: rigKey },
      TARGET_CONTAINER,
    ),
  };

  const realPipe = '\\\\.\\pipe\\openssh-ssh-agent';
  const serviceState = (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Service ssh-agent).Status.ToString()'])).stdout.trim();
  const standInPipe = `\\\\.\\pipe\\kangentic-probe-agent-${process.pid}`;
  const signingKey = utils.parseKey(rigKey);
  const securityKey = syntheticSecurityKey();
  const certificateText = fs.readFileSync(path.join(keysDirectory, 'cert_user-cert.pub'), 'utf8').trim();
  const certificateBlob = Buffer.from(certificateText.split(' ')[1], 'base64');
  const standIn = await startStandInAgent(standInPipe, signingKey, [securityKey.publicBlob, certificateBlob]);
  const agentConfig = writeFile('agent.conf', [
    'Host rig-agent',
    '  HostName 127.0.0.1',
    `  Port ${TARGET_PORT}`,
    '  User dev',
    // Without this, ssh would also offer the default keys under the developer's real ~/.ssh.
    '  IdentityFile none',
    'Host *',
    `  UserKnownHostsFile ${forwardSlash(path.join(configDirectory, 'known_hosts-full'))}`,
    '  GlobalKnownHostsFile NUL',
  ]);
  const agentLines = (run) => run.stderr.split(/\r?\n/).filter((line) => /agent|Offering|Authentications that|sign_and_send|signing|pipe/i.test(line)).slice(0, 14);
  const sshOptionRun = await runSsh(['-v', '-F', agentConfig, '-o', 'BatchMode=yes', '-o', `IdentityAgent=${standInPipe}`, 'rig-agent', 'true']);
  const sshForwardSlashRun = await runSsh(['-v', '-F', agentConfig, '-o', 'BatchMode=yes', '-o', `IdentityAgent=${forwardSlash(standInPipe)}`, 'rig-agent', 'true']);
  const sshEnvironmentRun = await runSsh(['-v', '-F', agentConfig, '-o', 'BatchMode=yes', 'rig-agent', 'true'], {
    environment: { SSH_AUTH_SOCK: standInPipe },
  });
  section.agent = {
    serviceState,
    realPipePresent: fs.existsSync(realPipe),
    ssh2AgainstRealPipe: await ssh2Connect({ ...direct, agent: realPipe }),
    standInPipeIsNotTheService: true,
    ssh2AgainstStandIn: await ssh2Connect({ ...direct, agent: standInPipe }),
    sshIdentityAgentAgainstStandIn: { ...summarizeSsh(sshOptionRun), lines: agentLines(sshOptionRun) },
    sshIdentityAgentForwardSlashes: { ...summarizeSsh(sshForwardSlashRun), lines: agentLines(sshForwardSlashRun) },
    sshAuthSockAgainstStandIn: { ...summarizeSsh(sshEnvironmentRun), lines: agentLines(sshEnvironmentRun) },
  };
  // close() waits for every client, and one that left its agent socket open must not lose the rest of the matrix.
  await Promise.race([new Promise((resolve) => standIn.close(resolve)), delay(AGENT_CLOSE_WAIT_MS)]);

  section.fido = {
    ssh: 'NOT RUN: no hardware',
    ssh2PublicText: String(utils.parseKey(securityKey.publicLine)),
    ssh2PrivateContainer: String(utils.parseKey(securityKey.privatePem)),
  };

  const caConfig = (knownHostsName) => writeFile(`ca-${knownHostsName}.conf`, [
    'Host rig-ca',
    '  HostName 127.0.0.1',
    `  Port ${TARGET_PORT}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(rigKeyPath)}`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  UserKnownHostsFile ${forwardSlash(path.join(configDirectory, knownHostsName))}`,
    '  GlobalKnownHostsFile NUL',
    '  StrictHostKeyChecking yes',
  ]);
  const caRun = await runSsh(['-v', '-F', caConfig('known_hosts-ca'), '-o', 'BatchMode=yes', 'rig-ca', 'true']);
  const hostKeySeen = {};
  section.caHostKey = {
    ssh: summarizeSsh(caRun),
    sshCertificateLine: caRun.stderr.split(/\r?\n/).filter((line) => /Server host certificate|Host '.*' is known/.test(line)),
    sshWrongCa: await ssh('-F', caConfig('known_hosts-wrong-ca'), 'rig-ca', 'true'),
    ssh2Default: await ssh2Connect({ ...direct, privateKey: rigKey, hostVerifier: hostVerifierRecorder(hostKeySeen) }),
    ssh2HostKeyTypeSeen: hostKeySeen,
    ssh2AskedForCertificateAlgorithm: await ssh2Connect({
      ...direct,
      privateKey: rigKey,
      algorithms: { serverHostKey: ['ssh-ed25519-cert-v01@openssh.com'] },
    }),
  };

  const certificateKey = path.join(keysDirectory, 'cert_user');
  const certificateConfig = (withCertificate) => writeFile(`cert-${withCertificate}.conf`, [
    'Host rig-cert',
    '  HostName 127.0.0.1',
    `  Port ${TARGET_PORT}`,
    '  User dev',
    `  IdentityFile ${forwardSlash(certificateKey)}`,
    withCertificate ? `  CertificateFile ${forwardSlash(certificateKey)}-cert.pub` : '  # no certificate',
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  UserKnownHostsFile ${forwardSlash(path.join(configDirectory, 'known_hosts-full'))}`,
    '  GlobalKnownHostsFile NUL',
  ]);
  // `ssh` would auto-load cert_user-cert.pub, so the no-certificate control copies the bare key elsewhere.
  const bareKeyDirectory = path.join(keysDirectory, 'bare');
  fs.mkdirSync(bareKeyDirectory, { recursive: true });
  const bareKey = path.join(bareKeyDirectory, 'cert_user');
  fs.copyFileSync(certificateKey, bareKey);
  await execute('icacls', [bareKey, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { allowFailure: false });
  const bareConfig = fs.readFileSync(certificateConfig(false), 'utf8').replace(forwardSlash(certificateKey), forwardSlash(bareKey));
  const bareConfigPath = path.join(configDirectory, 'cert-bare.conf');
  fs.writeFileSync(bareConfigPath, bareConfig);

  section.userCertificate = {
    ssh: await ssh('-F', certificateConfig(true), 'rig-cert', 'true'),
    sshSameKeyNoCertificate: await ssh('-F', bareConfigPath, 'rig-cert', 'true'),
    ssh2PrivateKeyOnly: await ssh2Connect({ ...direct, privateKey: fs.readFileSync(certificateKey) }),
    ssh2CertificateAsPrivateKey: await ssh2Connect({ ...direct, privateKey: certificateText }),
    ssh2ParsedCertificateType: (() => {
      const parsed = utils.parseKey(certificateText);
      return parsed instanceof Error ? parsed.message : { type: parsed.type, isPrivate: parsed.isPrivateKey() };
    })(),
  };

  results.matrix = section;
  saveResults();
}

function loadNodePty() {
  const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    return createRequire(path.join(worktreeRoot, 'package.json'))('node-pty');
  } catch (error) {
    return { loadError: error.message };
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Resolves with timings when one byte arrives through the local port, or with an error text.
function firstByteThrough(port, timeoutMs = 4000) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ error: 'timeout', milliseconds: performance.now() - startedAt });
    }, timeoutMs);
    socket.once('data', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ milliseconds: performance.now() - startedAt });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.code, milliseconds: performance.now() - startedAt });
    });
  });
}

async function waitForStderr(state, pattern, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && !state.exited) {
    if (pattern.test(state.stderr)) return true;
    await delay(2);
  }
  return pattern.test(state.stderr);
}

async function measureRoundTrip(userConfig) {
  const state = startSsh(['-T', '-F', userConfig, '-o', 'BatchMode=yes', 'rig-direct', 'cat']);
  await delay(1500);
  const samples = [];
  let failures = 0;
  for (let index = 0; index < 10; index += 1) {
    const before = state.stdout.length;
    const startedAt = performance.now();
    state.child.stdin.write('x\n');
    while (state.stdout.length === before && performance.now() - startedAt < 2000) await delay(1);
    if (state.stdout.length === before) failures += 1;
    else samples.push(performance.now() - startedAt);
    await delay(50);
  }
  await treeKill(state.child.pid);
  await state.exit;
  return { ...(samples.length ? summarize(samples) : {}), failures };
}

// Spawn to listener: stderr shows the listener line from -v, so the probe connects once. On Windows a connect
// to a closed loopback port takes about 2 s to refuse, so polling would measure the retry and not ssh.
async function measureForward(argumentList, runs) {
  const toListening = [];
  const toFirstByte = [];
  const secondConnection = [];
  const failures = [];
  for (let run = 0; run < runs; run += 1) {
    const localPort = await freePort();
    const startedAt = performance.now();
    const state = startSsh(['-v', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${ONE_BYTE_PORT}`, ...argumentList]);
    const listening = await waitForStderr(state, /Local forwarding listening on 127\.0\.0\.1 port/, 15000);
    if (!listening) {
      failures.push(lastLine(state.stderr));
      await treeKill(state.child.pid);
      await state.exit;
      continue;
    }
    toListening.push(performance.now() - startedAt);
    const first = await firstByteThrough(localPort);
    if (first.error) failures.push(first.error);
    else toFirstByte.push(performance.now() - startedAt);
    const second = await firstByteThrough(localPort);
    if (!second.error) secondConnection.push(second.milliseconds);
    await treeKill(state.child.pid);
    await state.exit;
  }
  return {
    spawnToListening: toListening.length ? summarize(toListening) : undefined,
    spawnToFirstByte: toFirstByte.length ? summarize(toFirstByte) : undefined,
    connectionThroughLiveForward: secondConnection.length ? summarize(secondConnection) : undefined,
    failures,
  };
}

async function measureNaivePolling(argumentList, runs) {
  const samples = [];
  let failures = 0;
  for (let run = 0; run < runs; run += 1) {
    const localPort = await freePort();
    const startedAt = performance.now();
    const state = startSsh(['-N', '-o', 'BatchMode=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${ONE_BYTE_PORT}`, ...argumentList]);
    let arrived = false;
    while (!arrived && !state.exited && performance.now() - startedAt <= 20000) {
      arrived = !(await firstByteThrough(localPort)).error;
    }
    if (arrived) samples.push(performance.now() - startedAt);
    else failures += 1;
    await treeKill(state.child.pid);
    await state.exit;
  }
  return { ...(samples.length ? summarize(samples) : {}), failures };
}

async function tryEscapeOverPipe(userConfig, ttyFlag) {
  const localPort = await freePort();
  const state = startSsh([ttyFlag, '-F', userConfig, '-o', 'BatchMode=yes', '-o', 'EnableEscapeCommandline=yes', '-e', '~', 'rig-direct', 'cat']);
  await delay(1500);
  state.child.stdin.write('\n~?\n');
  await delay(500);
  const helpShown = /Supported escape sequences/.test(state.stdout + state.stderr);
  state.child.stdin.write(`\n~C\n-L ${localPort}:127.0.0.1:${ONE_BYTE_PORT}\n`);
  await delay(1500);
  const through = await firstByteThrough(localPort);
  const lengthBeforeCheck = state.stdout.length;
  state.child.stdin.write('still-echoing\n');
  await delay(1000);
  const record = {
    flag: ttyFlag,
    helpShown,
    throughForward: through.error ?? 'byte arrived',
    sessionStillEchoes: state.stdout.length > lengthBeforeCheck,
    exited: state.exited,
    stderr: state.stderr.trim().slice(-400),
    stdout: state.stdout.trim().slice(-400),
  };
  await treeKill(state.child.pid);
  await state.exit;
  return record;
}

async function tryEscapeOverPty(userConfig) {
  const nodePty = loadNodePty();
  if (nodePty.loadError) return { outcome: 'NOT RUN', reason: nodePty.loadError };
  const localPort = await freePort();
  const pty = nodePty.spawn(SSH_BINARY, ['-F', userConfig, '-o', 'BatchMode=yes', '-o', 'EnableEscapeCommandline=yes', '-e', '~', 'rig-direct'], {
    cols: 100,
    rows: 30,
    env: process.env,
  });
  let output = '';
  pty.onData((data) => {
    output += data;
  });
  await delay(2500);
  pty.write('\r~C');
  await delay(700);
  pty.write(`-L ${localPort}:127.0.0.1:${ONE_BYTE_PORT}\r`);
  await delay(1500);
  const through = await firstByteThrough(localPort);
  const processId = pty.pid;
  pty.write('\r~.');
  await delay(500);
  await treeKill(processId);
  return { throughForward: through.error ?? 'byte arrived', firstByteMs: Math.round(through.milliseconds), output: output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-500) };
}

async function sectionMux() {
  const section = {};
  results.mux = section;
  const userConfig = writeUserConfig('user-mux.conf');
  const controlPath = forwardSlash(path.join(configDirectory, 'cm-%C'));

  const autoRun = await runSsh(['-F', userConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=30', 'rig-direct', 'echo', 'mux-ok']);
  section.controlMasterAuto = { outcome: autoRun.outcome, exitCode: autoRun.exitCode, milliseconds: autoRun.milliseconds, stderr: autoRun.stderr, stdout: autoRun.stdout };

  const fixedPath = forwardSlash(path.join(configDirectory, 'cm-fixed'));
  const master = startSsh(['-v', '-N', '-M', '-S', fixedPath, '-F', userConfig, '-o', 'BatchMode=yes', 'rig-direct']);
  await delay(2500);
  section.masterExplicit = {
    alive: !master.exited,
    exitCode: master.exitCode,
    stderrLines: master.stderr.split(/\r?\n/).filter((line) => /mux|control|Control|unix|bind|socket|getsockname|listen/i.test(line)).slice(-10),
    socketFileExists: fs.existsSync(fixedPath),
    tree: descendantsOf(await processSnapshot(), master.child.pid).map(describeProcess),
  };
  const controlCommand = (...extra) => execute(SSH_BINARY, ['-S', fixedPath, '-F', userConfig, ...extra, 'rig-direct'], { timeout: 15000 });
  const check = await controlCommand('-O', 'check');
  section.controlCheck = { code: check.code, stderr: check.stderr.trim() };
  const forwardPort = await freePort();
  // With no master to talk to, this measures whether -O forward fails or carries on as a new connection.
  const forward = startSsh(['-v', '-S', fixedPath, '-F', userConfig, '-O', 'forward', '-L', `127.0.0.1:${forwardPort}:127.0.0.1:${ONE_BYTE_PORT}`, 'rig-direct']);
  await delay(3000);
  const forwardThrough = await firstByteThrough(forwardPort);
  section.controlForward = {
    exitedOnItsOwn: forward.exited,
    exitCode: forward.exitCode,
    throughForward: forwardThrough.error ?? 'byte arrived',
    authenticated: /Authenticated to/.test(forward.stderr),
    openedSession: /Welcome to|Entering interactive session/.test(forward.stdout + forward.stderr),
    last: lastLine(forward.stderr),
  };
  if (!forward.exited) await treeKill(forward.child.pid);
  await forward.exit;
  if (!master.exited) {
    await treeKill(master.child.pid);
    await master.exit;
  }

  const pipeControl = await runSsh(['-F', userConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', 'ControlPath=\\\\.\\pipe\\kangentic-probe-mux', 'rig-direct', 'true']);
  section.controlMasterNamedPipePath = { outcome: pipeControl.outcome, exitCode: pipeControl.exitCode, stderr: pipeControl.stderr };

  section.escapeOverPipe = [await tryEscapeOverPipe(userConfig, '-tt'), await tryEscapeOverPipe(userConfig, '-T')];
  section.escapeOverConPty = await tryEscapeOverPty(userConfig);
  saveResults();

  const directArguments = ['-F', userConfig, 'rig-direct'];
  const jumpArguments = ['-F', userConfig, '-J', 'rig-jump', 'rig-target'];
  section.timing = {};
  section.timing.unshaped = {
    roundTrip: await measureRoundTrip(userConfig),
    direct: await measureForward(directArguments, options.runs),
    throughJump: await measureForward(jumpArguments, options.runs),
    naiveRetryConnectDirect: await measureNaivePolling(directArguments, 5),
  };
  saveResults();
  await dockerStrict('exec', TARGET_CONTAINER, 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', '50ms');
  try {
    section.timing.netemDelay50ms = {
      roundTrip: await measureRoundTrip(userConfig),
      direct: await measureForward(directArguments, options.runs),
    };
  } finally {
    await clearShaping();
  }
  results.mux = section;
  saveResults();
}

// Emits a line whenever the set of desktop consoles changes: visible console windows, Windows Terminal tabs by
// name, and OpenConsole.exe processes. When Terminal is the default, a new console hands off to it over COM,
// so its OpenConsole.exe has svchost as parent and the inbox conhost.exe shows no window of its own.
// It samples, so a console that lives for less than one cycle goes unseen. A heartbeat every 10 cycles gives
// the cycle time the window section reports, and "no console" only holds for consoles longer than that.
function startWindowPoller() {
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ProbeWindows {
  delegate bool EnumProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int size);
  public static string[] Consoles() {
    var found = new List<string>();
    EnumWindows((handle, parameter) => {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(128); GetClassName(handle, text, 128);
      if (text.ToString() == "ConsoleWindowClass") found.Add("console:" + handle.ToInt64());
      if (text.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") found.Add("terminal:" + handle.ToInt64());
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
"@
$previous = $null
$tabCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$cycle = 0
while ($true) {
  $cycle += 1
  if ($cycle % 10 -eq 0) { [Console]::Out.WriteLine([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + " ${POLLER_HEARTBEAT}"); [Console]::Out.Flush() }
  $windows = @([ProbeWindows]::Consoles())
  $tabNames = @()
  foreach ($window in ($windows | Where-Object { $_ -like 'terminal:*' })) {
    try {
      $element = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$window.Split(':')[1])
      foreach ($tab in $element.FindAll([Windows.Automation.TreeScope]::Descendants, $tabCondition)) { $tabNames += $tab.Current.Name }
    } catch {}
  }
  $tabs = @($tabNames | Group-Object | ForEach-Object { 'tabname:' + ($_.Name -replace ',', ' ') + '#' + $_.Count })
  $hosts = @(Get-CimInstance Win32_Process -Filter "Name='OpenConsole.exe'" | ForEach-Object { 'openconsole:' + $_.ProcessId + ':' + (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue).ProcessName })
  $current = ($windows + $tabs + $hosts | Sort-Object) -join ","
  if ($current -ne $previous) { [Console]::Out.WriteLine([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + " " + $current); [Console]::Out.Flush(); $previous = $current }
  Start-Sleep -Milliseconds 100
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const heartbeats = [];
  const pollerErrors = [];
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      const separator = line.indexOf(' ');
      if (separator < 0 || !/^\d+$/.test(line.slice(0, separator))) continue;
      const time = Number(line.slice(0, separator));
      const rest = line.slice(separator + 1);
      if (rest === POLLER_HEARTBEAT) heartbeats.push(time);
      else events.push({ time, items: rest.split(',').filter(Boolean) });
    }
  });
  child.stderr.on('data', (chunk) => {
    pollerErrors.push(chunk.toString());
  });
  return { child, events, heartbeats, pollerErrors };
}

function pollerCycleMilliseconds(heartbeats) {
  const cycles = heartbeats.slice(1).map((time, index) => (time - heartbeats[index]) / 10);
  return cycles.length ? summarize(cycles) : null;
}

// Every item that appeared after startedAt and was not on the desktop just before it.
function consolesOpenedDuring(poller, startedAt, endedAt) {
  const before = poller.events.filter((event) => event.time <= startedAt).at(-1)?.items ?? [];
  const opened = new Set();
  for (const event of poller.events) {
    if (event.time <= startedAt || event.time > endedAt) continue;
    for (const item of event.items) if (!before.includes(item)) opened.add(item);
  }
  return [...opened];
}

const HARNESS_MAIN = `
const { app, utilityProcess } = require('electron');
const path = require('node:path');
const caseFile = process.argv.at(-1);
app.setPath('userData', path.join(path.dirname(caseFile), 'user-data'));
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const worker = utilityProcess.fork(path.join(__dirname, 'worker.js'), [caseFile], { stdio: 'ignore' });
  worker.on('exit', () => app.quit());
});
`;

const HARNESS_WORKER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const spec = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
const startedAt = Date.now();
const child = spawn(spec.sshBinary, spec.arguments, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: spec.windowsHide,
  detached: spec.detached,
  env: { ...process.env, ...spec.environment },
});
fs.writeFileSync(spec.pidFile, JSON.stringify({ ssh: child.pid, worker: process.pid }));
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.stdout.resume();
child.on('exit', (code) => {
  fs.writeFileSync(spec.resultFile, JSON.stringify({ code, milliseconds: Date.now() - startedAt, stderr }));
  process.exit(0);
});
`;

async function waitForFile(filePath, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
    await delay(25);
  }
  return false;
}

// One ssh spawned from a real utilityProcess of a real Electron app with no window and no console.
async function runInUtilityProcess(poller, caseName, spec) {
  const harnessDirectory = path.join(workDirectory, 'electron-harness');
  const caseDirectory = path.join(harnessDirectory, caseName.replace(/[^a-z0-9]+/gi, '-'));
  fs.rmSync(caseDirectory, { recursive: true, force: true });
  fs.mkdirSync(caseDirectory, { recursive: true });
  const pidFile = path.join(caseDirectory, 'pid.json');
  const resultFile = path.join(caseDirectory, 'result.json');
  const caseFile = path.join(caseDirectory, 'case.json');
  fs.writeFileSync(caseFile, JSON.stringify({ environment: {}, ...spec, sshBinary: SSH_BINARY, pidFile, resultFile }));

  const electronPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const startedAt = Date.now();
  const electron = spawn(electronPath, [path.join(harnessDirectory, 'main.js'), caseFile], { stdio: 'ignore', env: environment });
  const electronExit = new Promise((resolve) => electron.on('exit', resolve));

  const record = { case: caseName, windowsHide: spec.windowsHide, detached: spec.detached };
  if (!(await waitForFile(pidFile, 15000))) {
    await treeKill(electron.pid);
    return { ...record, outcome: 'NOT RUN', reason: 'the utility process never spawned ssh' };
  }
  // The deadline is ssh's own, so Electron's boot never reads as a hang.
  const sshStartedAt = Date.now();
  const processIds = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  await delay(1800);
  const snapshot = await processSnapshot();
  const tree = descendantsOf(snapshot, processIds.ssh);
  record.workerHasConsole = [...snapshot.values()].some((entry) => entry.parent === processIds.worker && entry.name === 'conhost.exe');
  // Null when ssh had already exited: the snapshot cannot say who spawned it.
  record.sshParentIsWorker = snapshot.has(processIds.ssh) ? snapshot.get(processIds.ssh).parent === processIds.worker : null;
  record.tree = tree.map(describeProcess);

  // The snapshot above can outlast the deadline, so a run that ended during it still gets its report read.
  const finished = await waitForFile(resultFile, Math.max(1000, WINDOW_CASE_DEADLINE_MS - (Date.now() - sshStartedAt)));
  if (finished) {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    record.outcome = result.code === 0 ? 'signed in' : 'failed';
    record.exitCode = result.code;
    record.milliseconds = result.milliseconds;
    record.stderr = result.stderr.trim();
  } else {
    record.outcome = 'HUNG';
    record.milliseconds = Date.now() - sshStartedAt;
    await treeKill(processIds.ssh);
  }
  await Promise.race([electronExit, delay(4000)]);
  if (electron.exitCode === null) await treeKill(electron.pid);
  await delay(300);
  record.survivors = survivorsOf(tree, await processSnapshot()).map(describeProcess);
  for (const entry of survivorsOf(tree, await processSnapshot())) await treeKill(entry.pid);
  await delay(300);
  record.consolesOpened = consolesOpenedDuring(poller, startedAt, Date.now());
  console.log(`window: ${caseName}: ${record.outcome} ${record.milliseconds} ms, consoles opened ${record.consolesOpened.length}, ${lastLine(record.stderr ?? '')}`);
  return record;
}

async function sectionWindow() {
  const section = { harness: 'electron.exe, no BrowserWindow, utilityProcess.fork, stdio ignore. Deadline 5 s.', cases: [] };
  results.window = section;
  const harnessDirectory = path.join(workDirectory, 'electron-harness');
  fs.mkdirSync(harnessDirectory, { recursive: true });
  fs.writeFileSync(path.join(harnessDirectory, 'main.js'), HARNESS_MAIN);
  fs.writeFileSync(path.join(harnessDirectory, 'worker.js'), HARNESS_WORKER);

  const unknownHop = writeUserConfig('user-window-unknown-hop.conf', { knownHosts: 'known_hosts-target-only' });
  const passphraseHop = writeUserConfig('user-window-passphrase-hop.conf', { hopKey: path.join(keysDirectory, 'passphrase_user') });
  const knownHop = writeUserConfig('user-window-known-hop.conf');
  const wrapperUnknown = await writeWrapperConfig('wrapper-window-unknown-hop.conf', unknownHop);
  const wrapperPassphrase = await writeWrapperConfig('wrapper-window-passphrase-hop.conf', passphraseHop);
  const ownProxy = (configPath) => ['-F', configPath, '-o', 'BatchMode=yes', '-o', `ProxyCommand=${forwardSlash(SSH_BINARY)} -F ${forwardSlash(configPath)} -o BatchMode=yes -W %h:%p rig-jump`, 'rig-target', 'true'];
  const askpass = { SSH_ASKPASS: path.join(configDirectory, 'askpass-fail.cmd'), SSH_ASKPASS_REQUIRE: 'force' };
  const hidden = { windowsHide: true, detached: false };
  const batchFlag = ['-o', 'BatchMode=yes'];

  const poller = startWindowPoller();
  try {
    const pollerDeadline = performance.now() + 20000;
    while (poller.events.length === 0) {
      if (performance.now() > pollerDeadline) throw new Error(`Window poller never reported: ${poller.pollerErrors.join('')}`);
      await delay(50);
    }
    await delay(500);
    const cases = {
      'windowsHide, known hop, -J signs in': { ...hidden, arguments: ['-F', knownHop, ...batchFlag, '-J', 'rig-jump', 'rig-target', 'true'] },
      'windowsHide, unknown hop, BatchMode flag only': { ...hidden, arguments: ['-F', unknownHop, ...batchFlag, '-J', 'rig-jump', 'rig-target', 'true'] },
      'windowsHide, passphrase hop, BatchMode flag only': { ...hidden, arguments: ['-F', passphraseHop, ...batchFlag, '-J', 'rig-jump', 'rig-target', 'true'] },
      'windowsHide, unknown hop, user ProxyCommand, BatchMode flag only': { ...hidden, arguments: ['-F', unknownHop, ...batchFlag, 'rig-target-configured-command', 'true'] },
      'windowsHide, unknown hop, wrapper -F': { ...hidden, arguments: ['-F', wrapperUnknown, '-J', 'rig-jump', 'rig-target', 'true'] },
      'windowsHide, passphrase hop, wrapper -F': { ...hidden, arguments: ['-F', wrapperPassphrase, '-J', 'rig-jump', 'rig-target', 'true'] },
      'windowsHide, unknown hop, app-built ProxyCommand with BatchMode': { ...hidden, arguments: ownProxy(unknownHop) },
      'windowsHide, passphrase hop, app-built ProxyCommand with BatchMode': { ...hidden, arguments: ownProxy(passphraseHop) },
      'windowsHide, unknown hop, user ProxyCommand, askpass env': { ...hidden, arguments: ['-F', unknownHop, ...batchFlag, 'rig-target-configured-command', 'true'], environment: askpass },
      'windowsHide, passphrase hop, user ProxyCommand, askpass env': { ...hidden, arguments: ['-F', passphraseHop, ...batchFlag, 'rig-target-configured-command', 'true'], environment: askpass },
      'POSITIVE CONTROL no windowsHide, unknown hop': { windowsHide: false, detached: false, arguments: ['-F', unknownHop, ...batchFlag, '-J', 'rig-jump', 'rig-target', 'true'] },
      'POSITIVE CONTROL detached, unknown hop': { windowsHide: true, detached: true, arguments: ['-F', unknownHop, ...batchFlag, '-J', 'rig-jump', 'rig-target', 'true'] },
    };
    for (const [caseName, spec] of Object.entries(cases)) {
      section.cases.push(await runInUtilityProcess(poller, caseName, spec));
      saveResults();
    }
    section.pollerCycleMs = pollerCycleMilliseconds(poller.heartbeats);
  } finally {
    await treeKill(poller.child.pid);
  }
  saveResults();
}

async function main() {
  fs.mkdirSync(workDirectory, { recursive: true });
  try {
    await setupRig();
    const sections = { window: sectionWindow, batch: sectionBatch, kill: sectionKill, matrix: sectionMatrix, mux: sectionMux };
    for (const name of options.only) {
      console.log(`section ${name}`);
      await sections[name]();
    }
  } finally {
    saveResults();
    if (!options.keep) await removeRig();
  }
}

await main();
// A stand-in or forward socket a section gave up waiting on would otherwise keep the process alive.
process.exit(0);
