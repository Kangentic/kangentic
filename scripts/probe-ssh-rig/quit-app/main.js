'use strict';
/**
 * Electron main process of scripts/probe-ssh-quit.mjs. No repo app code. Not shipped.
 *
 * Config arrives as JSON in QUIT_PROBE_CONFIG. `mode` is:
 *   quit       one quit, on the `go` file or a driver action
 *   reconcile  the next launch: the link connects, lists what still runs, suspends it, then quit
 *   crash      fork a link, report it, wait for the driver to kill it, time the `exit` event, repeat
 *
 * `arm` picks the before-quit behavior for `quit` mode:
 *   no-handler       no before-quit listener at all, the control
 *   handler-no-link  the listener, no link exists, returns at once
 *   idle-link        the listener, a link is up, no remote session is open, returns at once
 *   drain            post suspendAll, preventDefault, bounded drain on the link pid, then re-enter
 *   no-drain         post suspendAll and return, so the quit goes straight on
 *
 * The drain copies the shape of src/main/pty/shutdown/exit-callback-drain.ts: a 25 ms poll with
 * process.kill(pid, 0), settle ticks after the pid is gone, a deadline, and the same state machine
 * as before-quit-handler.ts.
 */
const { app, BrowserWindow, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(process.env.QUIT_PROBE_CONFIG);
app.setPath('userData', config.userDataPath);

const HARD_FAILSAFE_MS = 6000;
const stamps = { runId: config.runId, arm: config.arm, beforeQuitPasses: 0 };
let mainWindow = null;
let linkProcess = null;
let goTimer = null;
let drainState = 'idle';

function now() {
  return performance.timeOrigin + performance.now();
}

// Rewrites the whole log each time, so `hardFailsafe` still lands after `will-quit` has flushed.
function flushLog() {
  try {
    fs.writeFileSync(config.mainLogPath, JSON.stringify(stamps)); // sync-write-ok: probe
  } catch {
    // The driver reports a missing file as a missing record.
  }
}

function announce(line) {
  process.stdout.write(`${line}\n`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function forkLink(linkConfig) {
  const child = utilityProcess.fork(path.join(__dirname, 'link.js'), [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'kangentic-probe-link',
  });
  child.stderr?.on('data', () => {});
  child.postMessage({ type: 'start', config: linkConfig });
  return child;
}

function linkConfigFor(mode) {
  return {
    mode,
    runId: config.runId,
    linkRunId: config.linkRunId,
    linkLogPath: config.linkLogPath,
    sshExecutable: config.sshExecutable,
    sshArguments: config.sshArguments,
    frameBytes: config.frameBytes,
    linkExit: config.linkExit,
    sshOnExit: config.sshOnExit,
    sshDetached: config.sshDetached,
    linkBusyMs: config.linkBusyMs,
    hangMs: config.hangMs,
    reconcileScope: config.reconcileScope,
  };
}

function reenterQuit() {
  drainState = 'complete';
  if (config.reenter === 'exit') {
    flushLog();
    app.exit(0);
  } else {
    app.quit();
  }
}

function drainLink(pid) {
  const startedAt = now();
  const deadlineMs = config.deadlineMs;
  let settleTicksRemaining = -1;
  let finished = false;
  let pollTimer = null;

  const finish = (timedOut) => {
    if (finished) return;
    finished = true;
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    stamps.drainMs = now() - startedAt;
    stamps.drainTimedOut = timedOut;
    reenterQuit();
  };

  const tick = () => {
    if (finished) return;
    if (settleTicksRemaining < 0) {
      if (!isProcessAlive(pid)) settleTicksRemaining = config.settleTicks;
    } else {
      settleTicksRemaining -= 1;
    }
    if (settleTicksRemaining === 0) {
      finish(false);
      return;
    }
    pollTimer = setTimeout(tick, config.pollMs);
  };

  const deadlineTimer = setTimeout(() => finish(true), deadlineMs);
  pollTimer = setTimeout(tick, config.pollMs);
}

function postSuspendAll() {
  stamps.postAt = now();
  linkProcess.postMessage({
    type: 'suspendAll',
    run: config.runId,
    exitWaitMs: config.deadlineMs - config.exitMarginMs,
  });
}

function onBeforeQuit(event) {
  const enteredAt = process.hrtime.bigint();
  stamps.beforeQuitPasses += 1;

  if (drainState === 'complete') return;
  if (drainState === 'draining') {
    event.preventDefault();
    return;
  }

  const remoteSessionCount = config.arm === 'drain' || config.arm === 'no-drain' ? 1 : 0;
  if (linkProcess === null || remoteSessionCount === 0) {
    drainState = 'complete';
    stamps.beforeQuitSyncMicroseconds = Number(process.hrtime.bigint() - enteredAt) / 1000;
    return;
  }

  postSuspendAll();
  if (config.arm === 'no-drain') {
    drainState = 'complete';
    stamps.beforeQuitSyncMicroseconds = Number(process.hrtime.bigint() - enteredAt) / 1000;
    return;
  }

  drainState = 'draining';
  event.preventDefault();
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.hide();
    }
  } catch {
    // Cosmetic in the real path too.
  }
  if (linkProcess.pid === undefined) {
    reenterQuit();
  } else {
    drainLink(linkProcess.pid);
  }
  stamps.beforeQuitSyncMicroseconds = Number(process.hrtime.bigint() - enteredAt) / 1000;
}

function armHardFailsafe() {
  // Same bound as HARD_SHUTDOWN_DEADLINE_MS, not unref'd, so a stalled quit ends.
  setTimeout(() => {
    stamps.hardFailsafe = true;
    flushLog();
    process.exit(1);
  }, HARD_FAILSAFE_MS);
}

function triggerQuit() {
  clearInterval(goTimer);
  armHardFailsafe();
  stamps.triggerAt = now();
  if (config.trigger === 'app-quit') {
    app.quit();
  } else if (config.trigger === 'window-close') {
    mainWindow.close();
  } else if (config.trigger === 'signal-handler-standin') {
    process.emit('SIGTERM', 'SIGTERM');
  }
}

function waitForGo() {
  if (!config.goFilePath) return;
  goTimer = setInterval(() => {
    if (fs.existsSync(config.goFilePath)) triggerQuit();
  }, 5);
}

function reportReady() {
  stamps.readyAt = now();
  announce(`ready ${JSON.stringify({ pid: process.pid, linkPid: stamps.linkPid ?? null, sshPid: stamps.sshPid ?? null })}`);
  waitForGo();
}

function startQuitMode() {
  if (config.arm === 'no-handler' || config.arm === 'handler-no-link') {
    reportReady();
    return;
  }
  linkProcess = forkLink(linkConfigFor('quit'));
  linkProcess.on('spawn', () => {
    stamps.linkPid = linkProcess.pid;
  });
  linkProcess.on('message', (message) => {
    if (message.type === 'ready') {
      stamps.sshPid = message.sshPid;
      stamps.linkPid = linkProcess.pid;
      reportReady();
    }
  });
}

function startReconcileMode() {
  linkProcess = forkLink(linkConfigFor('reconcile'));
  linkProcess.on('message', (message) => {
    if (message.type === 'reconciled') {
      stamps.reconciledAt = now();
      stamps.reconciledCount = message.suspended;
      flushLog();
      app.exit(0);
    }
  });
}

function startCrashMode() {
  let iteration = 0;
  const forkNext = () => {
    if (iteration >= config.crashIterations) {
      flushLog();
      app.exit(0);
      return;
    }
    iteration += 1;
    const child = forkLink({ ...linkConfigFor('quit'), linkRunId: `${config.runId}-${iteration}` });
    child.on('message', (message) => {
      if (message.type === 'ready') {
        announce(`link ${JSON.stringify({ iteration, linkPid: child.pid, sshPid: message.sshPid })}`);
      }
    });
    child.on('exit', (code) => {
      announce(`exited ${JSON.stringify({ iteration, exitEventAt: now(), code })}`);
      setImmediate(forkNext);
    });
  };
  forkNext();
}

// The real route on POSIX: performShutdown(), then process.exit(0), with no drain. On Windows
// Node never delivers this to a GUI process, so `signal-handler-standin` raises it in process.
process.on('SIGTERM', () => {
  if (linkProcess !== null) postSuspendAll();
  flushLog();
  process.exit(0);
});

if (config.arm !== 'no-handler') app.on('before-quit', onBeforeQuit);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  flushLog();
});

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 200,
    x: -3000,
    y: -3000,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  await mainWindow.loadURL('data:text/html,<title>probe</title><p>quit probe</p>');
  mainWindow.showInactive();

  if (config.mode === 'reconcile') startReconcileMode();
  else if (config.mode === 'crash') startCrashMode();
  else startQuitMode();
});
