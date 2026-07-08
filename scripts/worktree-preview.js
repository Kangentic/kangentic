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

// ---------------------------------------------------------------------------
// Worktree / root detection
// ---------------------------------------------------------------------------

const WORKTREE_MARKER = '.kangentic/worktrees/';

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
function waitForPidFile(worktreeDir, port, timeoutMs = 30000) {
  const pidFilePath = path.join(worktreeDir, '.kangentic', `preview-${port}.pid`);
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const worktreeDir = process.cwd();
  const isFresh = process.argv.includes('--fresh');

  const rootDir = findRootProject(worktreeDir);
  if (!rootDir) {
    console.error(
      'Error: This script must be run from inside a .kangentic/worktrees/ directory.\n' +
      `  Current directory: ${worktreeDir}`
    );
    process.exit(1);
  }

  console.log(`[preview] Root project: ${rootDir}`);
  console.log(`[preview] Worktree:     ${worktreeDir}`);
  if (isFresh) console.log('[preview] Fresh mode: launching without --cwd (Welcome Screen)');

  ensureNodeModulesLink(worktreeDir, rootDir);

  const port = await findAvailablePort(5174);
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
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
