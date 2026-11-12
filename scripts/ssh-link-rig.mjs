#!/usr/bin/env node
// #913 Phase 1 rig gate: the real link and helper over a real ssh, with the connection killed again and again.
// Not shipped and not used by CI. Needs Docker and the `kangentic-ssh-rig` image (scripts/probe-ssh-rig).
//
// Usage:
//   node scripts/ssh-link-rig.mjs --work <empty scratch dir> [--drops 20] [--port 2252] [--keep]
//   node scripts/ssh-link-rig.mjs --client removal --work <empty scratch dir> [--port 2252] [--keep]
//   node scripts/ssh-link-rig.mjs --client mcp --work <empty scratch dir> [--port 2252] [--keep]
//
// `--image <name>` runs the host in another Docker image than `kangentic-ssh-rig` (an older glibc, see the Dockerfile).
// `--jump` puts the host behind a second container that is the only way in, reached with `ssh -J` (ProxyJump).
//
// `--client removal` runs ssh-removal-rig.client.ts on the same stage instead: what removing a host and
// editing its sign-in do on a real host. `--client mcp` runs ssh-mcp-rig.client.ts: what an agent's Kangentic
// tool calls do while the link drops and the app is away, with the real bridge script run by the host's sh.
// `--client quit` runs ssh-quit-rig.client.ts: an agent left running by a quit, taken back by a new boot.
//
// It builds the host bundle and the rig client with esbuild, stages them with node-pty's Linux prebuild and a
// pinned Node onto a fresh rig container, then runs the client. The client starts a PTY that prints a counter
// on the host and kills its `ssh` --drops times (the whole tree, by pid). After every drop it demands what the
// gate asks: the same PTY is still alive, the owner epoch moved on by one, and the counter in the PTY's
// scrollback has no gap. Everything it writes is under --work, plus the client bundle under .kangentic/rig so
// its Node modules resolve. The downloaded Node is read, never run, on this machine.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The release build's pin, so the rig tests the helper on the Node a host actually gets.
import { NODE_VERSION } from './build-host.mjs';
const NODE_TARBALL = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;
const CONTAINER = 'kangentic-ssh-rig-link';
// With --jump: CONTAINER is the jump host and this one is the target behind it, on a network of their own.
const TARGET_CONTAINER = 'kangentic-ssh-rig-target';
const NETWORK = 'kangentic-ssh-rig-net';
const REMOTE_RUN_DIR = '/home/dev/.kangentic/host/run';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const workDirectory = path.resolve(options.work);
const sshPath = process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  : 'ssh';
const sshKeygenPath = process.platform === 'win32' ? path.join(path.dirname(sshPath), 'ssh-keygen.exe') : 'ssh-keygen';
// By full path on Windows: a bare `tar` can find Git's GNU tar, which reads "C:" as a remote host.
const tarPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
const forwardSlash = (value) => value.replaceAll('\\', '/');

function parseArguments(argumentList) {
  const parsed = { work: null, drops: 20, port: 2252, keep: false, client: 'link', image: 'kangentic-ssh-rig', jump: false };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--work') parsed.work = argumentList[(index += 1)];
    else if (argument === '--drops') parsed.drops = Number(argumentList[(index += 1)]);
    else if (argument === '--port') parsed.port = Number(argumentList[(index += 1)]);
    else if (argument === '--keep') parsed.keep = true;
    else if (argument === '--client') parsed.client = argumentList[(index += 1)];
    else if (argument === '--image') parsed.image = argumentList[(index += 1)];
    else if (argument === '--jump') parsed.jump = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.work) throw new Error('--work is required. See the header comment.');
  return parsed;
}

function say(line) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

function execute(command, args, { timeout = 120_000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function docker(...args) {
  const result = await execute('docker', args, { timeout: 180_000 });
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

function bannerOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => finish(false));
    socket.on('data', (chunk) => finish(chunk.toString().startsWith('SSH-')));
    for (const event of ['error', 'close', 'end']) socket.on(event, () => finish(false));
  });
}

async function waitForSshd(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await bannerOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sshd banner on port ${port}`);
}

/** The target behind the jump host starts after the jump host's banner is up: wait until a login through it works. */
async function waitForTarget(connection) {
  const args = [...connection.options, ...connection.identity, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', connection.destination, 'true'];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await execute(sshPath, args, { timeout: 15_000 })).code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the target behind the jump host did not accept a login: ${connection.destination}`);
}

/** An ssh config that reaches the target only through the jump host: the settings for each hop live here. */
function writeJumpConfig(keyPath, knownHosts) {
  const shared = [
    '  User dev',
    `  IdentityFile "${forwardSlash(keyPath)}"`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile "${forwardSlash(knownHosts)}"`,
    '  StrictHostKeyChecking accept-new',
  ];
  const lines = [
    'Host rig-jump', '  HostName 127.0.0.1', `  Port ${options.port}`, ...shared,
    'Host rig-target', `  HostName ${TARGET_CONTAINER}`, '  ProxyJump rig-jump', ...shared,
  ];
  const configPath = path.join(workDirectory, 'ssh_config');
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
  return configPath;
}

async function buildBundles() {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const esbuild = require('esbuild');
  const stage = path.join(workDirectory, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers', 'font-list', 'koffi'],
    conditions: ['require'],
    define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''), MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'), __KANGENTIC_DEV__: 'false' },
    logLevel: 'warning',
  };
  await esbuild.build({ ...common, entryPoints: [path.join(repoRoot, 'src/main/remote/helper/host-main.ts')], outfile: path.join(stage, 'host.js'), minify: true });
  // Under .kangentic/ so the client's externals (electron's path stub) resolve from the repo's node_modules.
  const clientDirectory = path.join(repoRoot, '.kangentic', 'rig');
  fs.mkdirSync(clientDirectory, { recursive: true });
  const clientPath = path.join(clientDirectory, 'ssh-link-rig-client.js');
  const clientSource = { removal: 'scripts/ssh-removal-rig.client.ts', mcp: 'scripts/ssh-mcp-rig.client.ts', quit: 'scripts/ssh-quit-rig.client.ts' }[options.client] ?? 'scripts/ssh-link-rig.client.ts';
  await esbuild.build({ ...common, entryPoints: [path.join(repoRoot, clientSource)], outfile: clientPath });

  const nodePtySource = fs.realpathSync(path.join(repoRoot, 'node_modules/node-pty'));
  const nodePtyTarget = path.join(stage, 'node_modules/node-pty');
  fs.mkdirSync(nodePtyTarget, { recursive: true });
  fs.copyFileSync(path.join(nodePtySource, 'package.json'), path.join(nodePtyTarget, 'package.json'));
  fs.cpSync(path.join(nodePtySource, 'lib'), path.join(nodePtyTarget, 'lib'), { recursive: true });
  fs.cpSync(path.join(nodePtySource, 'prebuilds/linux-x64'), path.join(nodePtyTarget, 'prebuilds/linux-x64'), { recursive: true });
  say(`built host.js (${fs.statSync(path.join(stage, 'host.js')).size} bytes) and the client`);
  return { stage, clientPath };
}

function fetchNode() {
  const downloadDirectory = path.join(workDirectory, 'download');
  fs.mkdirSync(downloadDirectory, { recursive: true });
  const tarball = path.join(downloadDirectory, NODE_TARBALL);
  const sums = path.join(downloadDirectory, 'SHASUMS256.txt');
  execFileSync('curl', ['-sSfL', '--max-time', '60', `${NODE_BASE_URL}/SHASUMS256.txt`, '-o', sums]);
  if (!fs.existsSync(tarball)) {
    const partial = `${tarball}.part`;
    execFileSync('curl', ['-sSfL', '--max-time', '300', `${NODE_BASE_URL}/${NODE_TARBALL}`, '-o', partial]);
    fs.renameSync(partial, tarball);
  }
  const expected = fs.readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${NODE_TARBALL}`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (!expected || expected !== actual) throw new Error(`SHA-256 mismatch for ${NODE_TARBALL}: published ${expected}, got ${actual}`);
  say(`verified ${NODE_TARBALL}`);
  return tarball;
}

async function makeKey() {
  const keysDirectory = path.join(workDirectory, 'keys');
  fs.rmSync(keysDirectory, { recursive: true, force: true });
  fs.mkdirSync(keysDirectory, { recursive: true });
  const keyPath = path.join(keysDirectory, 'rig_key');
  const generated = await execute(sshKeygenPath, ['-q', '-t', 'ed25519', '-N', '', '-C', 'ssh-link-rig', '-f', keyPath]);
  if (generated.code !== 0) throw new Error(`ssh-keygen failed: ${generated.stderr}`);
  // ssh refuses a private key readable by anyone else, and the scratch folder inherits wider permissions on Windows.
  if (process.platform === 'win32') await execute('icacls', [keyPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]);
  else fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

async function startRig(keyPath) {
  await execute('docker', ['rm', '-f', CONTAINER, TARGET_CONTAINER]);
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  if (options.jump) {
    // The target has no published port: the only way in is through the jump host, as a ProxyJump setup has it.
    await execute('docker', ['network', 'rm', NETWORK]);
    await docker('network', 'create', NETWORK);
    await docker('run', '-d', '--name', TARGET_CONTAINER, '--network', NETWORK, '--init', '-e', `AUTHORIZED_KEY=${publicKey}`, options.image);
    await docker('run', '-d', '--name', CONTAINER, '--network', NETWORK, '--init', '-p', `127.0.0.1:${options.port}:22`, '-e', `AUTHORIZED_KEY=${publicKey}`, options.image);
  } else {
    await docker('run', '-d', '--name', CONTAINER, '--init', '-p', `127.0.0.1:${options.port}:22`, '-e', `AUTHORIZED_KEY=${publicKey}`, options.image);
  }
  await waitForSshd(options.port);
  say(options.jump ? `rig up: a jump host on ${options.port}, and a target behind it, nothing installed on it yet` : `rig up on ${options.port}, nothing installed on it yet`);
}

/**
 * The host asset as the release build will make it: a pinned Node, the helper bundle and node-pty's Linux
 * prebuild in one tarball. Built here without Node's npm, headers or docs, and without its symlinks (an NTFS
 * checkout cannot make them). The installer sets the execute bits, so the archive need not carry them.
 */
async function buildAsset(stage, nodeTarball) {
  const assetRoot = path.join(workDirectory, 'asset-root');
  fs.rmSync(assetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(assetRoot, 'node'), { recursive: true });
  const excludes = ['*/lib/node_modules', '*/bin/npm', '*/bin/npx', '*/bin/corepack', '*/include', '*/share'].flatMap((pattern) => ['--exclude', pattern]);
  const extracted = await execute(tarPath, ['-xJf', nodeTarball, '-C', path.join(assetRoot, 'node'), '--strip-components=1', ...excludes], { timeout: 300_000 });
  if (extracted.code !== 0) throw new Error(`could not unpack the Node tarball: ${extracted.stderr}`);
  fs.cpSync(stage, path.join(assetRoot, 'app'), { recursive: true });
  const filePath = path.join(workDirectory, 'kangentic-host-rig-linux-x64.tar.gz');
  fs.rmSync(filePath, { force: true });
  const packed = await execute(tarPath, ['-czf', filePath, '-C', assetRoot, '.'], { timeout: 300_000 });
  if (packed.code !== 0) throw new Error(`could not pack the host asset: ${packed.stderr}`);
  const sha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  say(`built the host asset: ${(fs.statSync(filePath).size / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}`);
  return { version: '0.0.0-rig', sha256, arch: 'x64', filePath };
}

async function main() {
  fs.mkdirSync(workDirectory, { recursive: true });
  const { stage, clientPath } = await buildBundles();
  const nodeTarball = fetchNode();
  const keyPath = await makeKey();
  const knownHosts = path.join(workDirectory, 'known_hosts');
  fs.rmSync(knownHosts, { force: true });
  try {
    const asset = await buildAsset(stage, nodeTarball);
    await startRig(keyPath);
    // Straight to the container's published port, or through a jump host to a target that has none. OpenSSH
    // applies a command-line option to the destination only, never to a jump host, so a jump goes by a config
    // file, as a user's own ProxyJump does.
    let connection;
    if (options.jump) {
      const configPath = writeJumpConfig(keyPath, knownHosts);
      connection = { destination: 'rig-target', options: ['-F', forwardSlash(configPath)], identity: [] };
      await waitForTarget(connection);
    } else {
      connection = {
        destination: 'dev@127.0.0.1',
        options: ['-p', String(options.port), '-o', `UserKnownHostsFile=${forwardSlash(knownHosts)}`, '-o', 'StrictHostKeyChecking=accept-new', '-F', nullConfig],
        identity: ['-i', forwardSlash(keyPath), '-o', 'IdentitiesOnly=yes'],
      };
    }
    const clientOptions = {
      sshPath,
      sshArgs: [
        ...connection.options, ...connection.identity,
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=2', '-o', 'ServerAliveCountMax=3',
        '-T', connection.destination,
      ],
      asset,
      drops: options.drops,
      // What the removal client needs on top: the same connection with no key or destination in it.
      sshKeygenPath,
      sshOptions: connection.options,
      destination: connection.destination,
      rigKeyPath: keyPath,
      workDirectory: path.join(workDirectory, 'client'),
    };
    say(options.client === 'link' ? `running the client: ${options.drops} drops` : `running the ${options.client} client`);
    const outcome = await new Promise((resolve) => {
      const child = spawn(process.execPath, [clientPath, JSON.stringify(clientOptions)], { cwd: repoRoot, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const daemonLog = (await execute('docker', ['exec', '-u', 'dev', options.jump ? TARGET_CONTAINER : CONTAINER, 'cat', `${REMOTE_RUN_DIR}/daemon.log`])).stdout;
    fs.writeFileSync(path.join(workDirectory, 'results.json'), JSON.stringify({ exitCode: outcome.code, stdout: outcome.stdout, stderrTail: outcome.stderr.slice(-4000), daemonLogTail: daemonLog.split('\n').slice(-30) }, null, 2));
    process.stdout.write(outcome.stdout);
    if (outcome.code !== 0) process.stderr.write(`client exited ${outcome.code}\n${outcome.stderr.slice(-3000)}\n`);
    process.exitCode = outcome.code === 0 ? 0 : 1;
  } finally {
    if (!options.keep) {
      await execute('docker', ['rm', '-f', CONTAINER, TARGET_CONTAINER]);
      if (options.jump) await execute('docker', ['network', 'rm', NETWORK]);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
