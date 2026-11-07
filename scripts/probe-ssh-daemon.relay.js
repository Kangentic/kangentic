#!/usr/bin/env node
/**
 * Spike relay for the #913 daemon probe, copied to the rig as `relay.js`. Pipes stdio to
 * the daemon's socket, starting the daemon when none answers.
 *
 *   node relay.js --dir <folder> --daemon <daemon.js> [--start-mode setsid|plain|scope|unit]
 *                 [--ensure-only] [--socket-relative] [--sample-ms <n>]
 *
 * --start-mode names how the daemon leaves this session, which is what the probe's
 * KillUserProcesses matrix varies:
 *   setsid  child_process detached, which calls setsid
 *   plain   no setsid, so the daemon stays in this relay's session
 *   scope   systemd-run --user --scope
 *   unit    systemd-run --user as a transient service
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const CONNECT_RETRY_MS = 20;
const CONNECT_DEADLINE_MS = 5000;

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const hostDir = path.resolve(argumentValue('--dir', ''));
const daemonPath = argumentValue('--daemon', '');
const startMode = argumentValue('--start-mode', 'setsid');
const sampleMs = argumentValue('--sample-ms', '0');
const socketRelative = process.argv.includes('--socket-relative');
const ensureOnly = process.argv.includes('--ensure-only');

function fail(exitCode, message) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(exitCode);
}

function daemonArguments() {
  const args = [daemonPath, '--dir', hostDir, '--sample-ms', sampleMs];
  if (socketRelative) args.push('--socket-relative');
  return args;
}

function startDaemon() {
  const args = daemonArguments();
  if (startMode === 'setsid' || startMode === 'plain') {
    const daemon = childProcess.spawn(process.execPath, args, {
      detached: startMode === 'setsid',
      stdio: 'ignore',
      cwd: socketRelative ? hostDir : process.env.HOME,
    });
    daemon.unref();
    return;
  }
  if (startMode === 'scope') {
    const errorFile = fs.openSync(path.join(hostDir, 'start.err'), 'a');
    const scope = childProcess.spawn('systemd-run', ['--user', '--scope', '--collect', '--quiet', '--', process.execPath, ...args], {
      detached: true,
      stdio: ['ignore', 'ignore', errorFile],
    });
    scope.unref();
    return;
  }
  if (startMode === 'unit') {
    const unit = childProcess.spawnSync('systemd-run', ['--user', '--collect', '--quiet', '--unit=kangentic-host-spike', process.execPath, ...args], {
      encoding: 'utf8',
    });
    if (unit.status !== 0) fail(4, `systemd-run exited ${unit.status}: ${unit.stderr || unit.error}`);
    return;
  }
  fail(2, `unknown start mode ${startMode}`);
}

function bridge(socket) {
  if (ensureOnly) {
    process.stdout.write('ENSURED\n');
    socket.destroy();
    process.exit(0);
  }
  socket.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}

function connect(startedDaemon, deadline) {
  const socket = net.connect(socketRelative ? 's' : path.join(hostDir, 's'));
  socket.once('connect', () => {
    socket.removeAllListeners('error');
    socket.on('error', () => process.exit(0));
    bridge(socket);
  });
  socket.once('error', (error) => {
    const retryable = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
    if (!retryable) fail(3, `connect failed: ${error.code} ${error.message}`);
    if (!startedDaemon) startDaemon();
    if (Date.now() > deadline) fail(3, `no daemon answered within ${CONNECT_DEADLINE_MS} ms: ${error.code}`);
    setTimeout(() => connect(true, deadline), CONNECT_RETRY_MS);
  });
}

fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
fs.chmodSync(hostDir, 0o700);
if (socketRelative) process.chdir(hostDir);
connect(false, Date.now() + CONNECT_DEADLINE_MS);
