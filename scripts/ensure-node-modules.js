/**
 * ensure-node-modules.js - Brings node_modules in line with package-lock.json
 * when `npm start` launches, when that is safe. scripts/dev.js calls
 * ensureNodeModules first in start().
 *
 * A pull that changes package-lock.json used to leave the dev server running on
 * the old tree with no warning. At v0.51.0 the root's tree was 17 packages short
 * and one Electron patch release behind, and only the release pre-flight
 * (scripts/verify-node-modules.js) noticed. Launch is the moment the previous
 * instance has just closed, so it is the one moment an install should find
 * nothing holding the tree.
 *
 * In order:
 *   1. Compare the tree against the lockfile (checkNodeModules). A match ends
 *      here, in milliseconds.
 *   2. node_modules is a junction or symlink: report it and never install. A
 *      worktree preview links to the root's tree (scripts/worktree-preview.js),
 *      and `npm ci` through the link either replaces it with an install of its
 *      own or empties the root's tree, which the dogfood instance and every
 *      preview run from. The checkout that owns the tree installs on its own
 *      next launch.
 *   3. A process runs an executable from inside node_modules (a preview's
 *      Electron through its junction, an esbuild service), or on Windows a node
 *      process has a native addon from it loaded (Vite's rolldown binding in a
 *      vitest run or a demo server): report it and skip. `npm ci` deletes the
 *      tree before it reaches a locked file, so on Windows it fails halfway and
 *      leaves a broken tree, and elsewhere it pulls files out from under the
 *      running process. Linux and macOS let a loaded addon be deleted, so the
 *      scan there looks at executables only.
 *   4. The process scan fails or times out: the same as 3. It fails closed,
 *      because skipping the install is what every launch did before this.
 *   5. Otherwise run `npm ci`, then compare again.
 *
 * Plain CommonJS with only Node builtins: it runs before anything loads from
 * node_modules, which may not exist yet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { checkNodeModules } = require('./verify-node-modules');

/** A cold PowerShell start alone often passes 1.5s; see src/main/git/zombie-reaper.ts. */
const PROCESS_SCAN_TIMEOUT_MS = 5000;

/**
 * Every process whose image lives under a node_modules folder, from the same
 * CIM query src/main/git/zombie-reaper.ts runs (hand-copied: scripts/ cannot
 * import TypeScript), then one row per native addon a node process has loaded
 * from under one. Windows locks a loaded `.node` file as it locks a running
 * executable, and the node process's own image lives outside node_modules. A
 * node process whose modules cannot be read fails the scan, unless it exited
 * mid-scan. The filters run in PowerShell to keep the JSON small.
 */
const WINDOWS_SCAN_COMMAND = [
  "$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\node_modules\\*' } "
    + '| Select-Object ProcessId,ExecutablePath)',
  'foreach ($nodeProcess in @(Get-Process -Name node -ErrorAction SilentlyContinue)) { '
    + 'try { $loadedModules = $nodeProcess.Modules } catch { if ($nodeProcess.HasExited) { continue }; throw }; '
    + "foreach ($loadedModule in $loadedModules) { if ($loadedModule.FileName -like '*\\node_modules\\*') { "
    + '$rows += [pscustomobject]@{ ProcessId = $nodeProcess.Id; ExecutablePath = $loadedModule.FileName } } } }',
  'ConvertTo-Json -Compress -InputObject $rows',
].join('; ');

/**
 * fs.realpathSync.native, which also expands Windows 8.3 short names, then the
 * JS implementation for a drive the native call refuses, then null.
 */
function realpathOrNull(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return null;
    }
  }
}

/**
 * Where `<projectDir>/node_modules` points when it is a junction or a symlink
 * (Node reports a junction as a symlink), or null when it is a real directory
 * or does not exist. A link whose target is gone, as the root's tree is in the
 * middle of its own `npm ci`, is still a link, so it reports the link's text.
 */
function nodeModulesLinkTarget(projectDir) {
  const nodeModulesPath = path.join(projectDir, 'node_modules');
  try {
    if (!fs.lstatSync(nodeModulesPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const target = realpathOrNull(nodeModulesPath);
  if (target !== null) return target;
  try {
    return fs.readlinkSync(nodeModulesPath);
  } catch {
    return nodeModulesPath;
  }
}

/**
 * Rows from WINDOWS_SCAN_COMMAND's JSON, which `-InputObject` keeps an array
 * even for one row or none. A loaded addon's row carries the addon's path as
 * its executablePath. A bare object and empty output read as one row and none.
 * Throws on output that is not JSON, so a broken scan reads as failed, never
 * as "nothing running".
 */
function parseWindowsProcessRows(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.ProcessId !== 'number') continue;
    if (typeof item.ExecutablePath !== 'string' || item.ExecutablePath === '') continue;
    rows.push({ pid: item.ProcessId, executablePath: item.ExecutablePath });
  }
  return rows;
}

/**
 * Rows from macOS `ps -axo pid=,comm=`. comm is the executable as the process
 * was started, so it is a full path for anything started by one, and Electron
 * and its helpers always are: dev.js spawns node_modules/.bin/electron by
 * absolute path, and Electron spawns its helpers the same way. `command=`
 * would add the arguments without removing that dependency. Everything after
 * the pid is the path, because Electron's helper paths carry spaces
 * (`Electron Helper (GPU).app`). The live test in
 * tests/unit/ensure-node-modules.test.ts checks this on a Mac.
 */
function parsePsExecutableRows(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), executablePath: match[2] });
  }
  return rows;
}

/**
 * Linux: each process's `exe` link, which the kernel has already resolved. A
 * process this user cannot read (another user's, a kernel thread, one that
 * just exited) is skipped. A binary replaced since it started reads with a
 * ` (deleted)` suffix, and that process still runs out of the folder.
 */
function listLinuxExecutables(procRoot = '/proc') {
  const rows = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    let target;
    try {
      target = fs.readlinkSync(path.join(procRoot, entry, 'exe'));
    } catch {
      continue;
    }
    rows.push({ pid: Number(entry), executablePath: target.replace(/ \(deleted\)$/, '') });
  }
  return rows;
}

function runForStdout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** `{ pid, executablePath }` for the processes the platform lets this user see. Throws on failure. */
async function listProcessExecutables(timeoutMs = PROCESS_SCAN_TIMEOUT_MS) {
  if (process.platform === 'win32') {
    const stdout = await runForStdout('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCAN_COMMAND], timeoutMs);
    return parseWindowsProcessRows(stdout);
  }
  if (process.platform === 'darwin') {
    return parsePsExecutableRows(await runForStdout('ps', ['-axo', 'pid=,comm='], timeoutMs));
  }
  if (process.platform === 'linux') {
    return listLinuxExecutables();
  }
  throw new Error(`no process scan for ${process.platform}`);
}

/**
 * `value` with every link resolved. A path that no longer exists (a binary
 * replaced since its process started) resolves its nearest existing folder and
 * keeps the rest, so it still compares against a resolved folder: macOS
 * reaches os.tmpdir() through the /var -> /private/var link.
 */
function resolvedPath(value) {
  const absolute = path.resolve(value);
  const missingSegments = [];
  for (let existing = absolute; ; existing = path.dirname(existing)) {
    const resolved = realpathOrNull(existing);
    if (resolved !== null) return path.join(resolved, ...missingSegments);
    if (path.dirname(existing) === existing) return absolute;
    missingSegments.unshift(path.basename(existing));
  }
}

/**
 * The rows whose executable lives inside `directory`. Both sides are resolved
 * first, so a process started through a worktree's junction still matches the
 * root's folder. The trailing separator keeps a sibling such as
 * `node_modules-old` out. Windows and macOS paths compare without case, as
 * their default filesystems do; on a case-sensitive Mac volume that can only
 * turn a near miss into a skipped install.
 */
function processesRunningFrom(rows, directory, platform = process.platform) {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const comparable = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const resolvedDirectory = resolvedPath(directory);
  const prefix = comparable(resolvedDirectory.endsWith(path.sep) ? resolvedDirectory : `${resolvedDirectory}${path.sep}`);
  return rows.filter((row) => comparable(resolvedPath(row.executablePath)).startsWith(prefix));
}

/** `electron.exe (pids 9624, 37684, 61084 and 4 more), esbuild.exe (pid 59760)` */
function describeHolders(holders) {
  const pidsByName = new Map();
  for (const holder of holders) {
    const name = holder.executablePath.split(/[\\/]/).pop();
    if (!pidsByName.has(name)) pidsByName.set(name, []);
    pidsByName.get(name).push(holder.pid);
  }
  return [...pidsByName].map(([name, pids]) => {
    const more = pids.length > 3 ? ` and ${pids.length - 3} more` : '';
    return `${name} (${pids.length === 1 ? 'pid' : 'pids'} ${pids.slice(0, 3).join(', ')}${more})`;
  }).join(', ');
}

/**
 * How to run `npm ci` in a checkout, given `cwd: <checkout>`. Node cannot spawn
 * Windows' `npm.cmd` without a shell, and an args array with `shell: true` is
 * deprecated (DEP0190), so Windows gets one command string. No path enters the
 * shell text: the checkout rides `cwd`, and `--prefix .` pins npm to it, since
 * npm has resolved a worktree's prefix to the root checkout before.
 */
function npmCiInvocation(platform = process.platform) {
  if (platform === 'win32') return { command: 'npm ci --prefix .', args: [], shell: true };
  return { command: 'npm', args: ['ci', '--prefix', '.'], shell: false };
}

/**
 * Ends an install a stop or a closed terminal interrupted, with everything it
 * started. On Windows the child is the cmd.exe running npm, and ending only
 * that would leave npm writing into node_modules after dev.js exits. The next
 * launch finds the half-written tree and installs again.
 */
function stopInstall(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill();
}

/**
 * Runs the steps in this file's header for `projectDir`. `runInstall` runs
 * `npm ci` there and resolves with its exit code. Resolves with what it did:
 * 'current', 'unchecked', 'linked', 'unscanned', 'in-use' or 'installed'.
 * Rejects only when `npm ci` fails, since that may have left the tree half
 * deleted and nothing should launch on it.
 */
async function ensureNodeModules(projectDir, {
  runInstall,
  check = checkNodeModules,
  listExecutables = listProcessExecutables,
  log = console,
}) {
  let result;
  try {
    result = check(projectDir);
  } catch (checkError) {
    log.warn(`[dev] Could not compare node_modules with package-lock.json, so this launch does not install: ${checkError.message}`);
    return 'unchecked';
  }
  if (result.exitCode === 0) return 'current';

  for (const line of result.report) log.warn(`[dev] ${line}`);

  const linkTarget = nodeModulesLinkTarget(projectDir);
  if (linkTarget) {
    log.warn(`[dev] Not installing through a link: node_modules is ${linkTarget}. Launching on that tree as it is.`);
    return 'linked';
  }

  const nodeModulesDir = path.join(projectDir, 'node_modules');
  if (fs.existsSync(nodeModulesDir)) {
    let holders;
    try {
      holders = processesRunningFrom(await listExecutables(), nodeModulesDir);
    } catch (scanError) {
      log.warn(`[dev] Not installing: could not check what runs out of node_modules (${scanError.message}). Launching on the current tree.`);
      return 'unscanned';
    }
    if (holders.length > 0) {
      log.warn(`[dev] Not installing while these processes hold files in node_modules: ${describeHolders(holders)}. Stop them and run npm start again to install. Launching on the current tree.`);
      return 'in-use';
    }
  }

  log.log('[dev] Running npm ci...');
  const installExitCode = await runInstall();
  if (installExitCode !== 0) {
    throw new Error(`npm ci exited ${installExitCode}, so node_modules may be incomplete. Run npm ci, then npm start.`);
  }

  let after;
  try {
    after = check(projectDir);
  } catch (checkError) {
    after = { exitCode: 1, report: [checkError.message] };
  }
  if (after.exitCode !== 0) {
    for (const line of after.report) log.warn(`[dev] ${line}`);
    log.warn('[dev] npm ci finished and node_modules still does not match package-lock.json. The comparison in scripts/verify-node-modules.js is wrong for this tree, and every launch installs again until it is fixed.');
  }
  return 'installed';
}

module.exports = {
  ensureNodeModules,
  nodeModulesLinkTarget,
  listProcessExecutables,
  listLinuxExecutables,
  parseWindowsProcessRows,
  parsePsExecutableRows,
  processesRunningFrom,
  describeHolders,
  npmCiInvocation,
  stopInstall,
};
