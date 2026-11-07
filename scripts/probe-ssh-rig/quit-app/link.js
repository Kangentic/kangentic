'use strict';
/**
 * The link process of scripts/probe-ssh-quit.mjs, forked by main.js as an Electron utility process.
 * It spawns ssh to the helper's relay and carries one frame at quit. Not shipped.
 *
 * `linkExit` picks what happens after main's suspendAll arrives:
 *   ack                    write, wait for the ack or the remaining budget, exit
 *   after-write            write, exit from the write callback
 *   after-write-terminate  write, TerminateProcess this process from the write callback
 *   immediate              write, exit on the next statement
 *   hang                   block the event loop and never write, for the drain's deadline
 *
 * `sshOnExit` is what happens to the ssh child when the link exits: `leave` it, or `kill` it first.
 * `sshDetached` decides what leaving means on Windows. libuv puts every child spawned without
 * `detached` in a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so that ssh dies with the link.
 * A detached ssh outlives the link and sees EOF on stdin.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');

let config = null;
let sshChild = null;
let stdoutBuffer = '';
let sessionFinished = false;
let pendingAcks = 0;
const stamps = {};

function now() {
  return performance.timeOrigin + performance.now();
}

function flushStamps() {
  try {
    fs.appendFileSync(config.linkLogPath, `${JSON.stringify(stamps)}\n`); // sync-write-ok: probe
  } catch {
    // The driver reports a missing line as a missing record.
  }
}

function exitLink() {
  if (config.sshOnExit === 'kill' && sshChild) sshChild.kill();
  process.exit(0);
}

function finish(reason) {
  if (sessionFinished) return;
  sessionFinished = true;
  stamps.finishReason = reason;
  flushStamps();
  exitLink();
}

function writeFrame(frame) {
  return new Promise((resolve) => {
    sshChild.stdin.write(`${JSON.stringify(frame)}\n`, () => resolve());
  });
}

function handleHelperLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === 'ready') {
    stamps.readyAt = now();
    if (config.mode === 'reconcile') {
      void writeFrame({ type: 'list', run: config.runId, scope: config.reconcileScope });
      return;
    }
    process.parentPort.postMessage({ type: 'ready', sshPid: sshChild.pid });
    return;
  }
  if (frame.type === 'list') {
    stamps.listAt = now();
    stamps.listedRuns = frame.runs;
    if (frame.runs.length === 0) {
      process.parentPort.postMessage({ type: 'reconciled', suspended: 0 });
      return;
    }
    pendingAcks = frame.runs.length;
    for (const run of frame.runs) void writeFrame({ type: 'suspend', run });
    return;
  }
  if (frame.type === 'ack') {
    stamps.ackAt = now();
    if (config.mode === 'reconcile') {
      pendingAcks -= 1;
      if (pendingAcks === 0) {
        flushStamps();
        process.parentPort.postMessage({ type: 'reconciled', suspended: stamps.listedRuns.length });
      }
      return;
    }
    if (config.linkExit === 'ack') finish('ack');
  }
}

function connect() {
  stamps.spawnAt = now();
  sshChild = spawn(config.sshExecutable, config.sshArguments, {
    stdio: 'pipe',
    windowsHide: true,
    detached: config.sshDetached === true,
  });
  stamps.sshPid = sshChild.pid;
  sshChild.stdout.setEncoding('utf8');
  sshChild.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      handleHelperLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });
  sshChild.stderr.setEncoding('utf8');
  sshChild.stderr.on('data', (chunk) => {
    stamps.sshStderr = `${stamps.sshStderr ?? ''}${chunk}`.slice(-400);
  });
  sshChild.stdin.on('error', (error) => {
    stamps.stdinError = String(error.code ?? error.message);
  });
  sshChild.on('exit', () => {
    if (stamps.messageAt !== undefined) finish('ssh-exit');
  });
  const hello = { type: 'hello', run: config.linkRunId ?? config.runId };
  if (config.mode === 'reconcile') hello.register = false;
  sshChild.stdin.write(`${JSON.stringify(hello)}\n`);
}

function handleSuspendAll(message) {
  stamps.messageAt = now();
  // On disk before anything else, so a teardown that ends the link later still shows it got here.
  flushStamps();
  if (config.linkExit === 'hang') {
    const hangUntil = Date.now() + config.hangMs;
    while (Date.now() < hangUntil) {
      // Blocks the loop on purpose: a link that takes the frame and never answers.
    }
    exitLink();
  }
  if (config.linkBusyMs > 0) {
    const busyUntil = Date.now() + config.linkBusyMs;
    while (Date.now() < busyUntil) {
      // A link whose loop is held for this long when the frame arrives (a flood, a GC).
    }
  }
  const frameBase = { type: 'suspendAll', run: message.run, pad: '' };
  const padLength = Math.max(0, config.frameBytes - JSON.stringify(frameBase).length - 1);
  const frameText = `${JSON.stringify({ ...frameBase, pad: 'x'.repeat(padLength) })}\n`;

  if (config.linkExit === 'immediate') {
    sshChild.stdin.write(frameText);
    exitLink();
  }

  const wroteCallback = () => {
    stamps.writeCallbackAt = now();
    if (config.linkExit === 'after-write') {
      finish('after-write');
    } else if (config.linkExit === 'after-write-terminate') {
      flushStamps();
      process.kill(process.pid);
    }
  };
  sshChild.stdin.write(frameText, wroteCallback);

  if (config.linkExit === 'ack') {
    setTimeout(() => finish('budget'), Math.max(0, message.exitWaitMs));
  }
}

process.parentPort.on('message', (messageEvent) => {
  const message = messageEvent.data;
  if (message.type === 'start') {
    config = message.config;
    connect();
  } else if (message.type === 'suspendAll') {
    handleSuspendAll(message);
  }
});
