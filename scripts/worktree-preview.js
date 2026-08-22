#!/usr/bin/env node

/**
 * worktree-preview.js -- Opens an OS-native terminal running a Kangentic dev
 * server for the current worktree.
 *
 * Creates a filesystem junction (Windows) or symlink (Unix) from
 * <worktree>/node_modules → <root>/node_modules so the worktree's dev server
 * gets instant access to properly-built dependencies -- no install or rebuild.
 *
 * Must be run from inside a .kangentic/worktrees/ directory.
 *
 * Usage: node scripts/worktree-preview.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { readExitRecord, clearExitRecord, classifyPreviewExit, exitRecordPath } = require('./preview-exit-record');

// ---------------------------------------------------------------------------
// Worktree / root detection
// ---------------------------------------------------------------------------

const WORKTREE_MARKER = '.kangentic/worktrees/';

// Tells Kangentic's activity engine that the watcher background shell must NOT
// hold its session ACTIVE. Without it the board reads the task as working for
// the preview's whole lifetime (hours) and never goes idle, which destroys the
// one signal that says which agent needs the user.
//
// This script does not parse the flag - argv is matched by membership tests, so
// unknown flags are ignored. It exists only to be READ out of `tool_input.command`
// by the PreToolUse hook. It must appear in the printed `Watch:` command below,
// because the /preview skill instructs the agent to run what was printed.
//
// Hand-duplicated from `src/shared/background-shell-hold.ts`, which this
// CommonJS script cannot import (same as WORKTREE_MARKER above vs
// `src/shared/git-utils.ts`). `tests/unit/no-activity-hold-sentinel-parity.test.ts`
// pins the copies together.
const NO_ACTIVITY_HOLD_FLAG = '--kangentic-no-activity-hold';

function findRootProject(worktreeDir) {
  const normalized = worktreeDir.replace(/\\/g, '/');
  const idx = normalized.indexOf(WORKTREE_MARKER);
  if (idx === -1) {
    return null;
  }
  return path.resolve(normalized.slice(0, idx));
}

// ---------------------------------------------------------------------------
// node_modules junction / symlink
// ---------------------------------------------------------------------------

function ensureNodeModulesLink(worktreeDir, rootDir) {
  const rootModules = path.join(rootDir, 'node_modules');
  const wtModules = path.join(worktreeDir, 'node_modules');

  if (!fs.existsSync(rootModules)) {
    throw new Error(
      `Root project has no node_modules -- run "npm install" in ${rootDir} first.`
    );
  }

  // Check if the link already exists and points to the right place
  try {
    const stat = fs.lstatSync(wtModules);
    const isLink = stat.isSymbolicLink() || (process.platform === 'win32' && stat.isDirectory() && isJunction(wtModules));

    if (isLink) {
      const target = fs.realpathSync(wtModules);
      const rootReal = fs.realpathSync(rootModules);
      if (target === rootReal) {
        console.log('[preview] node_modules junction already correct');
        return;
      }
      // Points elsewhere -- remove and recreate
      console.log('[preview] node_modules junction points elsewhere, recreating...');
      fs.rmSync(wtModules, { recursive: true, force: true });
    } else {
      // Real directory (from a previous npm install) -- remove it
      console.log('[preview] Removing existing node_modules directory...');
      fs.rmSync(wtModules, { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Doesn't exist yet -- will create below
  }

  // Create the junction/symlink
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(rootModules, wtModules, linkType);
  console.log(`[preview] Created ${linkType}: ${wtModules} -> ${rootModules}`);
}

function isJunction(p) {
  try {
    // Junctions on Windows: lstat reports directory, but readlink succeeds
    fs.readlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Port finder
//
// This deliberately does NOT read Kangentic's dev-port ledger
// (src/main/dev-ports/dev-port-allocator.ts), even though that ledger exists
// precisely to stop two things picking the same number.
//
// Two reasons, and the first is the load-bearing one. The scan window here
// (5174-5273) and the reservation range (7300-7499) are disjoint by design, so
// a preview and an agent's reserved port cannot collide at all. And where a
// user hand-widens the reserve range in config to overlap this window, the
// allocator's own bind probe refuses any port a running preview holds - the
// probe is the protection, not the ledger.
//
// The alternative was real cost for that non-collision: this is a plain
// CommonJS script outside Electron, so reading the global database would mean
// node:sqlite access to a file better-sqlite3 has open, and registering a lease
// would mean an ephemeral preview owning one with no release path on a hard
// close. Not worth it. If the two ranges are ever made to overlap on purpose,
// revisit this comment first.
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    // Connect as a client to catch listeners on both IPv4 and IPv6
    const socket = net.createConnection({ port, host: 'localhost' }, () => {
      socket.end();
      resolve(false); // something is listening
    });
    socket.once('error', () => resolve(true)); // nothing listening
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  while (port < startPort + 100) {
    if (await isPortFree(port)) return port;
    port++;
  }
  throw new Error(`No available port found in range ${startPort}-${port - 1}`);
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

function buildCommand(worktreeDir, port, { fresh = false } = {}) {
  const devScript = path.join(worktreeDir, 'scripts', 'dev.js');
  const flags = [`--port=${port}`, '--ephemeral'];
  if (fresh) flags.push('--fresh');
  return `node "${devScript}" ${flags.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Terminal launchers (platform-specific)
// ---------------------------------------------------------------------------

function openTerminalWindows(cwd, command) {
  // Try Windows Terminal first
  try {
    execSync('where wt.exe', { stdio: 'ignore' });
    const proc = spawn('wt.exe', ['-d', cwd, 'cmd', '/c', command], {
      detached: true,
      stdio: 'ignore',
      cwd,
    });
    proc.unref();
    return true;
  } catch {
    // Fall back to cmd.exe
  }

  const proc = spawn('cmd.exe', ['/c', 'start', 'cmd', '/c', command], {
    detached: true,
    stdio: 'ignore',
    cwd,
  });
  proc.unref();
  return true;
}

function openTerminalMac(cwd, command) {
  const script = `tell application "Terminal"
  activate
  do script "cd '${cwd.replace(/'/g, "'\\''")}' && ${command.replace(/"/g, '\\"')}; exit"
end tell`;
  const proc = spawn('osascript', ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return true;
}

function openTerminalLinux(cwd, command) {
  const terminals = [
    { bin: 'gnome-terminal', args: ['--working-directory', cwd, '--', 'bash', '-c', command] },
    { bin: 'konsole', args: ['--workdir', cwd, '-e', 'bash', '-c', command] },
    { bin: 'xfce4-terminal', args: ['--working-directory', cwd, '-e', `bash -c '${command}'`] },
    { bin: 'xterm', args: ['-e', `bash -c 'cd "${cwd}" && ${command}'`] },
  ];

  for (const { bin, args } of terminals) {
    try {
      execSync(`which ${bin}`, { stdio: 'ignore' });
      const proc = spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        cwd,
      });
      proc.unref();
      return true;
    } catch {
      // Try next terminal
    }
  }
  return false;
}

function openTerminal(cwd, command) {
  switch (process.platform) {
    case 'win32': return openTerminalWindows(cwd, command);
    case 'darwin': return openTerminalMac(cwd, command);
    default: return openTerminalLinux(cwd, command);
  }
}

// ---------------------------------------------------------------------------
// PID discovery
// ---------------------------------------------------------------------------

/**
 * Poll for the PID file dev.js writes for itself (see scripts/dev.js) at the
 * start of its own process, keyed by port. The terminal this script opens is
 * several process-tree hops away from the actual dev-server process (through
 * wt.exe / cmd.exe /c start), so there is no reliable way to derive that PID
 * from spawn() here - dev.js reporting its own process.pid is the only
 * trustworthy source. Written near-instantly on dev.js startup (well before
 * the Vite/esbuild build finishes), so this resolves in well under a second
 * in the common case; the timeout is just a generous safety net.
 */
function pidFilePathFor(worktreeDir, port) {
  return path.join(worktreeDir, '.kangentic', `preview-${port}.pid`);
}

/**
 * Remove a leftover PID file for this port BEFORE launching. dev.js removes
 * its own file only on a clean exit; a hard kill (taskkill, crash) leaves it
 * behind, and the post-launch poll below would then instantly read the STALE
 * pid and report a process that is not the new instance - which is exactly
 * how kill-and-restart tooling ends up chasing ghosts while the real server
 * stays alive. The port was just verified free, so any file here is stale by
 * definition.
 */
function removeStalePidFile(worktreeDir, port) {
  try {
    fs.rmSync(pidFilePathFor(worktreeDir, port), { force: true });
    fs.rmSync(stopFilePathFor(worktreeDir, port), { force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Graceful stop (--stop [--port=N])
// ---------------------------------------------------------------------------

/**
 * Companion to the stop-file watcher in scripts/dev.js. Creating
 * `.kangentic/preview-<port>.stop` asks that dev server to run its normal
 * cleanup and exit 0, which lets the hosting terminal tab close itself
 * (Windows Terminal keeps a dead tab open after a non-zero exit, so a
 * `taskkill /F` restart used to leave one "[process exited with code 1]"
 * tab behind per restart). Falls back to a force kill only if the server
 * does not exit within the grace window (e.g. an older dev.js without the
 * watcher).
 */
function stopFilePathFor(worktreeDir, port) {
  return path.join(worktreeDir, '.kangentic', `preview-${port}.stop`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      // SIGKILL, not SIGTERM: this fallback only runs AFTER the 10s graceful
      // window already elapsed, i.e. the process is hung/blocked and a
      // catchable SIGTERM is likely ignored. Unconditional kill matches the
      // Windows `/F` branch and the zombie-reaper / shutdown escalation.
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // best-effort: the process may have exited between the check and the kill
  }
}

function listRunningPreviewPorts(worktreeDir) {
  const kanDir = path.join(worktreeDir, '.kangentic');
  let entries = [];
  try {
    entries = fs.readdirSync(kanDir);
  } catch {
    return [];
  }
  return entries
    .map((entry) => /^preview-(\d+)\.pid$/.exec(entry))
    .filter(Boolean)
    .map((match) => parseInt(match[1], 10));
}

async function stopPreview(worktreeDir, requestedPort) {
  const ports = requestedPort ? [requestedPort] : listRunningPreviewPorts(worktreeDir);
  if (ports.length === 0) {
    console.log('[preview] No running preview found (no PID file in .kangentic/)');
    return;
  }

  for (const port of ports) {
    const pidFilePath = pidFilePathFor(worktreeDir, port);
    let pid = null;
    try {
      pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10);
    } catch {
      // no PID file for this port
    }

    if (!pid || !isProcessAlive(pid)) {
      console.log(`[preview] Port ${port}: not running (stale files cleaned up)`);
      removeStalePidFile(worktreeDir, port);
      continue;
    }

    console.log(`[preview] Port ${port}: requesting graceful stop of PID ${pid}...`);
    fs.writeFileSync(stopFilePathFor(worktreeDir, port), String(Date.now()));

    // dev.js polls for the stop file every 500ms; give it a generous window
    // to close Vite/Electron and clean up before falling back to force.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (isProcessAlive(pid)) {
      console.log(`[preview] Port ${port}: no graceful exit within 10s, force-killing PID ${pid}`);
      forceKill(pid);
      removeStalePidFile(worktreeDir, port);
    } else {
      console.log(`[preview] Port ${port}: stopped cleanly (terminal tab closes itself)`);
    }
  }
}

function waitForPidFile(worktreeDir, port, timeoutMs = 30000) {
  const pidFilePath = pidFilePathFor(worktreeDir, port);
  const pollIntervalMs = 200;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (fs.existsSync(pidFilePath)) {
        const raw = fs.readFileSync(pidFilePath, 'utf-8').trim();
        const pid = parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0) {
          resolve(pid);
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, pollIntervalMs);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Blocking watch (--wait --port=N)
// ---------------------------------------------------------------------------

// How recent an exit record must be for --wait to adopt it when no live PID
// file exists. Comfortably wider than waitForPidFile's 5s attach timeout, and
// far narrower than the "leftover from an earlier session" case it rules out.
const STALE_ATTACH_WINDOW_MS = 60000;

const EXIT_MESSAGES = {
  clean: (port) => `[preview] Port ${port}: exited cleanly.`,
  crashed: (port) => `[preview] Port ${port}: crashed (non-zero exit). Check the preview terminal for details.`,
  vanished: (port) => `[preview] Port ${port}: vanished (force-killed or the terminal was hard-closed) with no recorded exit.`,
};

/**
 * Blocks until the preview on `port` exits, then exits this process with a
 * reason-carrying code: 0 clean, 2 crashed, 3 vanished (see EXIT_MESSAGES).
 * Companion to writeExitRecord in scripts/dev.js's cleanup(); that record
 * is the only way to distinguish a crash from a clean exit once ephemeral
 * cleanup has already removed the worktree's .kangentic/ directory.
 *
 * NOTE: a hard-killed PID can in principle be recycled by the OS for an
 * unrelated process before this watcher notices; that would read back as
 * "still running" indefinitely. Not mitigated: narrow and not worth the
 * complexity of a start-time / argv fingerprint check here.
 */
async function waitForPreviewExit(worktreeDir, port) {
  const pidFilePath = pidFilePathFor(worktreeDir, port);
  const stopFilePath = stopFilePathFor(worktreeDir, port);

  let watchedPid = await waitForPidFile(worktreeDir, port, 5000);
  if (!watchedPid) {
    // No live PID file. The ONLY legitimate reason to still proceed is that
    // the preview exited during the few seconds between its launch and this
    // watcher attaching, so its record is seconds old. An older record is a
    // leftover from a previous session that nothing has cleared (only a
    // launch or a watcher clears one), and adopting its pid as watchedPid
    // would make the very next loop iteration match record.pid === watchedPid
    // and report that ancient verdict instantly, instead of blocking as
    // documented. Age-gate it rather than trusting any record we find.
    const record = readExitRecord(worktreeDir, port);
    let recordAgeMs = Infinity;
    try {
      recordAgeMs = Date.now() - fs.statSync(exitRecordPath(worktreeDir, port)).mtimeMs;
    } catch {
      // no record file: recordAgeMs stays Infinity and the guard below fires
    }
    if (!record || recordAgeMs > STALE_ATTACH_WINDOW_MS) {
      console.error(`[preview] No preview running on port ${port} in this worktree.`);
      process.exit(1);
    }
    watchedPid = record.pid;
  }

  console.log(`[preview] Watching port ${port} (PID ${watchedPid})...`);

  let stopRequested = false;
  let vanishedSince = null;

  for (;;) {
    const record = readExitRecord(worktreeDir, port);
    if (fs.existsSync(stopFilePath)) stopRequested = true;

    let pidFileMatches = false;
    try {
      pidFileMatches = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10) === watchedPid;
    } catch {
      pidFileMatches = false;
    }
    const processAlive = pidFileMatches && isProcessAlive(watchedPid);

    const verdict = classifyPreviewExit({ record, watchedPid, processAlive, stopRequested });

    if (verdict && verdict.status === 'vanished') {
      // Give a late-arriving exit record (Windows fs-write latency) a ~1s
      // grace window to turn this into 'clean' or 'crashed' before we
      // commit. Classification runs fresh every iteration of this loop.
      if (vanishedSince === null) {
        vanishedSince = Date.now();
      } else if (Date.now() - vanishedSince >= 1000) {
        clearExitRecord(worktreeDir, port);
        console.log(EXIT_MESSAGES.vanished(port));
        process.exit(verdict.code);
      }
    } else if (verdict) {
      clearExitRecord(worktreeDir, port);
      console.log(EXIT_MESSAGES[verdict.status](port));
      process.exit(verdict.code);
    } else {
      vanishedSince = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const worktreeDir = process.cwd();
  const isFresh = process.argv.includes('--fresh');
  const isStop = process.argv.includes('--stop');
  const isWait = process.argv.includes('--wait');
  const portFlag = process.argv.find((arg) => arg.startsWith('--port='));
  const requestedPort = portFlag ? parseInt(portFlag.split('=')[1], 10) : null;

  const rootDir = findRootProject(worktreeDir);
  if (!rootDir) {
    console.error(
      'Error: This script must be run from inside a .kangentic/worktrees/ directory.\n' +
      `  Current directory: ${worktreeDir}`
    );
    process.exit(1);
  }

  if (isStop) {
    await stopPreview(worktreeDir, requestedPort);
    return;
  }

  if (isWait) {
    if (!requestedPort) {
      const ports = listRunningPreviewPorts(worktreeDir);
      console.error(
        '[preview] --wait requires --port=<port>.' +
        (ports.length
          ? ` Running previews in this worktree: ${ports.join(', ')}`
          : ' No previews are currently running in this worktree.')
      );
      process.exit(1);
    }
    await waitForPreviewExit(worktreeDir, requestedPort);
    return;
  }

  console.log(`[preview] Root project: ${rootDir}`);
  console.log(`[preview] Worktree:     ${worktreeDir}`);
  if (isFresh) console.log('[preview] Fresh mode: launching without --cwd (Welcome Screen)');

  ensureNodeModulesLink(worktreeDir, rootDir);

  const port = await findAvailablePort(5174);
  removeStalePidFile(worktreeDir, port);
  clearExitRecord(worktreeDir, port);
  const command = buildCommand(worktreeDir, port, { fresh: isFresh });

  console.log(`[preview] Opening preview terminal...`);
  console.log(`[preview]   Port:    ${port}`);
  console.log(`[preview]   Command: ${command}`);

  const ok = openTerminal(worktreeDir, command);
  if (!ok) {
    console.error('Could not find a supported terminal emulator');
    process.exit(1);
  }

  console.log(`[preview] Preview terminal opened on port ${port}`);

  const pid = await waitForPidFile(worktreeDir, port);
  if (pid) {
    console.log(`[preview]   PID:     ${pid}`);
  } else {
    console.log('[preview]   PID:     unknown (dev server did not report one within 30s - check the terminal window)');
  }
  console.log(`[preview]   Watch:   node scripts/worktree-preview.js --wait --port=${port} ${NO_ACTIVITY_HOLD_FLAG}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
