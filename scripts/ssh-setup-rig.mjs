#!/usr/bin/env node
// #913 first-time setup gate: the real steps of "Add host" against a real sshd that takes a password.
// Not shipped and not used by CI. Needs Docker and the `kangentic-ssh-rig` image (scripts/probe-ssh-rig).
//
// Usage:
//   node scripts/ssh-setup-rig.mjs --work <empty scratch dir> [--port 2262] [--keep]
//
// It starts a container whose user `dev` signs in with the password `rigpass`, then runs
// scripts/ssh-setup-rig.client.ts: learn the host key and compare it with the host's own, pin it, make a
// key, add it with the password, sign in with it, and recover from a changed host key. The client uses a
// scratch ssh config (`-F`) and a scratch known_hosts, so nothing here touches your own ~/.ssh.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'kangentic-ssh-setup-rig';
const PASSWORD = 'rigpass';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(args) {
  const parsed = { work: null, port: 2262, keep: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--work') parsed.work = args[(index += 1)];
    else if (args[index] === '--port') parsed.port = Number(args[(index += 1)]);
    else if (args[index] === '--keep') parsed.keep = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!parsed.work) throw new Error('--work is required. See the header comment.');
  return parsed;
}

const options = parse(process.argv.slice(2));
const work = path.resolve(options.work);
const sshPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
const sshKeygenPath = process.platform === 'win32' ? path.join(path.dirname(sshPath), 'ssh-keygen.exe') : 'ssh-keygen';

const say = (line) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true });

function bannerOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => finish(false));
    socket.on('data', (chunk) => finish(chunk.toString().startsWith('SSH-')));
    for (const event of ['error', 'close', 'end']) socket.on(event, () => finish(false));
  });
}

async function waitForSshd() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await bannerOpen(options.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sshd banner on port ${options.port}`);
}

async function main() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'home'), { recursive: true });

  try { docker('rm', '-f', CONTAINER); } catch { /* none running */ }
  say('starting a password-enabled sshd');
  docker('run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${options.port}:22`, '--entrypoint', 'sh', 'kangentic-ssh-rig', '-c',
    `echo 'dev:${PASSWORD}' | chpasswd && ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=no -o PermitRootLogin=no`);
  await waitForSshd();

  const hostFingerprint = docker('exec', CONTAINER, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub').split(/\s+/)[1];
  const knownHostsFile = path.join(work, 'known_hosts');
  const configFile = path.join(work, 'ssh_config');
  fs.writeFileSync(configFile, `Host *\n  UserKnownHostsFile ${knownHostsFile.replaceAll('\\', '/')}\n  GlobalKnownHostsFile ${process.platform === 'win32' ? 'NUL' : '/dev/null'}\n  IdentityFile none\n  IdentitiesOnly yes\n`);

  const esbuild = createRequire(path.join(repoRoot, 'package.json'))('esbuild');
  const clientDirectory = path.join(repoRoot, '.kangentic', 'rig');
  fs.mkdirSync(clientDirectory, { recursive: true });
  const clientPath = path.join(clientDirectory, 'ssh-setup-rig-client.js');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'scripts/ssh-setup-rig.client.ts')],
    outfile: clientPath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
    conditions: ['require'],
    define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''), MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'), __KANGENTIC_DEV__: 'false' },
    logLevel: 'warning',
  });

  say('running the setup steps');
  const clientOptions = {
    sshPath,
    sshKeygenPath,
    work,
    destination: `ssh://dev@127.0.0.1:${options.port}`,
    password: PASSWORD,
    hostFingerprint,
    knownHostsFile,
    configFile,
  };
  const code = await new Promise((resolve) => {
    const child = execFile(process.execPath, [clientPath, JSON.stringify(clientOptions)], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('close', resolve);
  });
  if (!options.keep) { try { docker('rm', '-f', CONTAINER); } catch { /* already gone */ } }
  process.exit(code === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  try { if (!options.keep) docker('rm', '-f', CONTAINER); } catch { /* already gone */ }
  process.exit(2);
});
