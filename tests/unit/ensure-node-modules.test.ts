/**
 * scripts/ensure-node-modules.js: `npm start` installs when node_modules no
 * longer matches package-lock.json, and only when that is safe.
 *
 * The decision table is the part that protects the dogfood tree. A launch that
 * runs `npm ci` through a worktree's junction, or under a running preview's
 * Electron, breaks every instance running from the root's node_modules. So
 * each row is pinned here: the check, the link, the holder scan, a failed scan,
 * the install and its re-check. The scan parsers run on fixture text so Linux
 * CI covers the Windows and macOS shapes.
 *
 * The last block scans scripts/dev.js, which cannot be required into a test
 * (it writes its PID file at load). It pins the ordering that makes the check
 * worth anything: nothing loads from node_modules before it runs.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteCmdExecutable } from '../../src/shared/shell-quote';
import {
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
} from '../../scripts/ensure-node-modules.js';

interface CheckResult {
  exitCode: number;
  report: string[];
  checked: number;
}

interface ProcessRow {
  pid: number;
  executablePath: string;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  // Retries: on Windows a binary the live test just ended can stay locked for a moment.
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeTemporaryDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-ensure-modules-'));
  temporaryRoots.push(directory);
  return directory;
}

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** A checkout whose node_modules is a real folder, a link to another folder, or absent. */
function makeCheckout(kind: 'real' | 'linked' | 'none'): { checkout: string; linkTarget: string | null } {
  const base = makeTemporaryDir();
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(checkout);
  if (kind === 'real') fs.mkdirSync(path.join(checkout, 'node_modules'));
  if (kind !== 'linked') return { checkout, linkTarget: null };
  const linkTarget = path.join(base, 'root', 'node_modules');
  fs.mkdirSync(linkTarget, { recursive: true });
  fs.symlinkSync(linkTarget, path.join(checkout, 'node_modules'), LINK_TYPE);
  return { checkout, linkTarget };
}

/** Creates an empty file at `filePath`, so realpath resolves it on every platform. */
function makeFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  return filePath;
}

const STALE: CheckResult = {
  exitCode: 1,
  report: ['node_modules does not match package-lock.json.', '  1 missing:', '    node_modules/left-pad'],
  checked: 1,
};
const NEVER_INSTALLED: CheckResult = { exitCode: 2, report: ['node_modules has never been installed in this checkout.'], checked: 0 };
const CURRENT: CheckResult = { exitCode: 0, report: [], checked: 1 };

function makeDependencies(options: {
  checkResults?: CheckResult[];
  check?: () => CheckResult;
  executables?: () => Promise<ProcessRow[]>;
  installExitCode?: number;
} = {}) {
  const checkResults = [...(options.checkResults ?? [STALE, CURRENT])];
  const fallbackResult = checkResults[checkResults.length - 1];
  const check = vi.fn(options.check ?? (() => checkResults.shift() ?? fallbackResult));
  const listExecutables = vi.fn(options.executables ?? (async (): Promise<ProcessRow[]> => []));
  const runInstall = vi.fn(async () => options.installExitCode ?? 0);
  const log = { log: vi.fn(), warn: vi.fn() };
  return { check, listExecutables, runInstall, log };
}

function warnings(log: { warn: ReturnType<typeof vi.fn> }): string {
  return log.warn.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('ensureNodeModules', () => {
  it('does nothing else when the tree matches the lockfile', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({ checkResults: [CURRENT] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('current');

    expect(dependencies.listExecutables).not.toHaveBeenCalled();
    expect(dependencies.runInstall).not.toHaveBeenCalled();
    expect(dependencies.log.warn).not.toHaveBeenCalled();
  });

  it('installs a stale real tree when nothing runs out of it, then checks again', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({ checkResults: [STALE, CURRENT] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('installed');

    expect(dependencies.listExecutables).toHaveBeenCalledTimes(1);
    expect(dependencies.runInstall).toHaveBeenCalledTimes(1);
    expect(dependencies.check).toHaveBeenCalledTimes(2);
    expect(dependencies.check).toHaveBeenCalledWith(checkout);
    expect(warnings(dependencies.log)).toContain('node_modules/left-pad');
    expect(warnings(dependencies.log)).not.toContain('still does not match');
  });

  it('installs a checkout that has no node_modules at all, with nothing to scan', async () => {
    const { checkout } = makeCheckout('none');
    const dependencies = makeDependencies({ checkResults: [NEVER_INSTALLED, CURRENT] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('installed');

    expect(dependencies.listExecutables).not.toHaveBeenCalled();
    expect(dependencies.runInstall).toHaveBeenCalledTimes(1);
  });

  it('never installs through a linked node_modules, and says what differs', async () => {
    const { checkout, linkTarget } = makeCheckout('linked');
    const dependencies = makeDependencies({ checkResults: [STALE] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('linked');

    expect(dependencies.listExecutables).not.toHaveBeenCalled();
    expect(dependencies.runInstall).not.toHaveBeenCalled();
    const output = warnings(dependencies.log);
    expect(output).toContain('node_modules/left-pad');
    expect(output).toContain('Not installing through a link');
    expect(output).toContain(fs.realpathSync.native(linkTarget as string));
  });

  it('never installs through a link whose target is gone, as mid-install in the root', async () => {
    const { checkout, linkTarget } = makeCheckout('linked');
    fs.rmSync(linkTarget as string, { recursive: true, force: true });
    const dependencies = makeDependencies({ checkResults: [NEVER_INSTALLED] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('linked');

    expect(dependencies.runInstall).not.toHaveBeenCalled();
  });

  it('does not install while a process runs out of the tree, and names it', async () => {
    const { checkout } = makeCheckout('real');
    const electron = makeFile(path.join(checkout, 'node_modules', 'electron', 'dist', 'electron.exe'));
    const dependencies = makeDependencies({
      checkResults: [STALE],
      executables: async () => [{ pid: 4242, executablePath: electron }],
    });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('in-use');

    expect(dependencies.runInstall).not.toHaveBeenCalled();
    expect(warnings(dependencies.log)).toContain('electron.exe (pid 4242)');
  });

  it('does not install when the process scan fails', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({
      checkResults: [STALE],
      executables: async () => {
        throw new Error('powershell timed out');
      },
    });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('unscanned');

    expect(dependencies.runInstall).not.toHaveBeenCalled();
    expect(warnings(dependencies.log)).toContain('powershell timed out');
  });

  it('launches without installing when the lockfile cannot be read', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({
      check: () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('unchecked');

    expect(dependencies.listExecutables).not.toHaveBeenCalled();
    expect(dependencies.runInstall).not.toHaveBeenCalled();
  });

  it('rejects when npm ci fails, so dev.js stops the launch', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({ checkResults: [STALE], installExitCode: 1 });

    await expect(ensureNodeModules(checkout, dependencies)).rejects.toThrow(/npm ci exited 1/);
  });

  it('warns when the tree still differs after a successful install', async () => {
    const { checkout } = makeCheckout('real');
    const dependencies = makeDependencies({ checkResults: [STALE, STALE] });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('installed');

    expect(warnings(dependencies.log)).toContain('still does not match');
  });

  it('warns the same way when the re-check after a successful install throws', async () => {
    const { checkout } = makeCheckout('real');
    let checkCallCount = 0;
    const dependencies = makeDependencies({
      check: () => {
        checkCallCount += 1;
        if (checkCallCount === 1) return STALE;
        throw new SyntaxError('package-lock.json changed under the re-check');
      },
    });

    await expect(ensureNodeModules(checkout, dependencies)).resolves.toBe('installed');

    expect(dependencies.runInstall).toHaveBeenCalledTimes(1);
    expect(dependencies.check).toHaveBeenCalledTimes(2);
    expect(warnings(dependencies.log)).toContain('package-lock.json changed under the re-check');
    expect(warnings(dependencies.log)).toContain('still does not match');
  });
});

describe('nodeModulesLinkTarget', () => {
  it('is null for a real node_modules folder', () => {
    expect(nodeModulesLinkTarget(makeCheckout('real').checkout)).toBeNull();
  });

  it('is null when there is no node_modules', () => {
    expect(nodeModulesLinkTarget(makeCheckout('none').checkout)).toBeNull();
  });

  it('is the real folder behind a junction or symlink', () => {
    const { checkout, linkTarget } = makeCheckout('linked');
    expect(nodeModulesLinkTarget(checkout)).toBe(fs.realpathSync.native(linkTarget as string));
  });

  it('is still a link when the folder behind it is gone', () => {
    const { checkout, linkTarget } = makeCheckout('linked');
    fs.rmSync(linkTarget as string, { recursive: true, force: true });
    expect(nodeModulesLinkTarget(checkout)).not.toBeNull();
  });
});

describe('processesRunningFrom', () => {
  it('matches an executable inside the folder', () => {
    const nodeModules = path.join(makeTemporaryDir(), 'node_modules');
    const electron = makeFile(path.join(nodeModules, 'electron', 'dist', 'electron.exe'));
    const rows = [{ pid: 1, executablePath: electron }, { pid: 2, executablePath: makeFile(path.join(makeTemporaryDir(), 'node.exe')) }];

    expect(processesRunningFrom(rows, nodeModules).map((row: ProcessRow) => row.pid)).toEqual([1]);
  });

  it('matches across a link in either direction, as a worktree junction reports it', () => {
    const base = makeTemporaryDir();
    const realNodeModules = path.join(base, 'root', 'node_modules');
    const electron = makeFile(path.join(realNodeModules, 'electron', 'dist', 'electron.exe'));
    const linkedNodeModules = path.join(base, 'worktree-node_modules');
    fs.symlinkSync(realNodeModules, linkedNodeModules, LINK_TYPE);
    const throughLink = path.join(linkedNodeModules, 'electron', 'dist', 'electron.exe');

    expect(processesRunningFrom([{ pid: 1, executablePath: throughLink }], realNodeModules)).toHaveLength(1);
    expect(processesRunningFrom([{ pid: 1, executablePath: electron }], linkedNodeModules)).toHaveLength(1);
  });

  it('does not match a sibling folder that shares the prefix', () => {
    const base = makeTemporaryDir();
    const nodeModules = path.join(base, 'node_modules');
    fs.mkdirSync(nodeModules);
    const sibling = makeFile(path.join(base, 'node_modules-old', 'electron.exe'));

    expect(processesRunningFrom([{ pid: 1, executablePath: sibling }], nodeModules)).toEqual([]);
  });

  it('still matches an executable that no longer exists on disk', () => {
    const nodeModules = path.join(makeTemporaryDir(), 'node_modules');
    fs.mkdirSync(nodeModules);
    const replaced = path.join(nodeModules, 'electron', 'dist', 'electron.exe');

    expect(processesRunningFrom([{ pid: 1, executablePath: replaced }], nodeModules)).toHaveLength(1);
  });

  it('matches an executable that no longer exists, reached through a link', () => {
    const base = makeTemporaryDir();
    const realNodeModules = path.join(base, 'root', 'node_modules');
    fs.mkdirSync(realNodeModules, { recursive: true });
    const linkedNodeModules = path.join(base, 'worktree-node_modules');
    fs.symlinkSync(realNodeModules, linkedNodeModules, LINK_TYPE);
    const replacedThroughLink = path.join(linkedNodeModules, 'electron', 'dist', 'electron.exe');

    expect(processesRunningFrom([{ pid: 1, executablePath: replacedThroughLink }], realNodeModules)).toHaveLength(1);
  });

  it.each(['win32', 'darwin'])('compares %s paths without case', (platform) => {
    const nodeModules = path.join(makeTemporaryDir(), 'node_modules');
    const electron = makeFile(path.join(nodeModules, 'electron', 'dist', 'electron.exe'));

    expect(processesRunningFrom([{ pid: 1, executablePath: electron.toUpperCase() }], nodeModules, platform)).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'linux')('compares Linux paths with case', () => {
    const nodeModules = path.join(makeTemporaryDir(), 'node_modules');
    const electron = makeFile(path.join(nodeModules, 'electron', 'dist', 'electron'));

    expect(processesRunningFrom([{ pid: 1, executablePath: electron.toUpperCase() }], nodeModules, 'linux')).toEqual([]);
  });
});

/**
 * WINDOWS_SCAN_COMMAND's stdout as captured on Windows 11 (Windows PowerShell
 * 5.1), paths sanitized and rows trimmed: two executables, then a dev server's
 * node process with two native addons loaded.
 */
const CAPTURED_WINDOWS_SCAN_STDOUT =
  '[{"ProcessId":59760,"ExecutablePath":"C:\\\\Users\\\\dev\\\\kangentic\\\\node_modules\\\\@esbuild\\\\win32-x64\\\\esbuild.exe"},'
  + '{"ProcessId":9624,"ExecutablePath":"C:\\\\Users\\\\dev\\\\kangentic\\\\node_modules\\\\electron\\\\dist\\\\electron.exe"},'
  + '{"ProcessId":56980,"ExecutablePath":"C:\\\\Users\\\\dev\\\\kangentic\\\\node_modules\\\\@rolldown\\\\binding-win32-x64-msvc\\\\rolldown-binding.win32-x64-msvc.node"},'
  + '{"ProcessId":56980,"ExecutablePath":"C:\\\\Users\\\\dev\\\\kangentic\\\\node_modules\\\\lightningcss-win32-x64-msvc\\\\lightningcss.win32-x64-msvc.node"}]\r\n';

describe('process scan parsers', () => {
  it('reads the captured Windows scan, executables and loaded addons alike', () => {
    expect(parseWindowsProcessRows(CAPTURED_WINDOWS_SCAN_STDOUT)).toEqual([
      { pid: 59760, executablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\@esbuild\\win32-x64\\esbuild.exe' },
      { pid: 9624, executablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\electron\\dist\\electron.exe' },
      { pid: 56980, executablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\@rolldown\\binding-win32-x64-msvc\\rolldown-binding.win32-x64-msvc.node' },
      { pid: 56980, executablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\lightningcss-win32-x64-msvc\\lightningcss.win32-x64-msvc.node' },
    ]);
  });

  it('reads a bare Windows object as one row', () => {
    const stdout = JSON.stringify({ ProcessId: 9624, ExecutablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\electron\\dist\\electron.exe' });

    expect(parseWindowsProcessRows(stdout)).toEqual([
      { pid: 9624, executablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\electron\\dist\\electron.exe' },
    ]);
  });

  it('reads Windows rows as an array and drops one with no executable path', () => {
    const stdout = JSON.stringify([
      { ProcessId: 9624, ExecutablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\electron\\dist\\electron.exe' },
      { ProcessId: 4, ExecutablePath: null },
      { ProcessId: 59760, ExecutablePath: 'C:\\Users\\dev\\kangentic\\node_modules\\@esbuild\\win32-x64\\esbuild.exe' },
    ]);

    expect(parseWindowsProcessRows(stdout).map((row: ProcessRow) => row.pid)).toEqual([9624, 59760]);
  });

  it('reads empty Windows output as no processes, and output that is not JSON as a failed scan', () => {
    expect(parseWindowsProcessRows('\r\n')).toEqual([]);
    expect(() => parseWindowsProcessRows('Get-CimInstance : Access denied')).toThrow();
  });

  it('keeps the spaces in a macOS helper path', () => {
    const helper = '/Users/dev/kangentic/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)';
    const stdout = `    1 /sbin/launchd\n  812 ${helper}\n\n`;

    expect(parsePsExecutableRows(stdout)).toEqual([
      { pid: 1, executablePath: '/sbin/launchd' },
      { pid: 812, executablePath: helper },
    ]);
  });

  it.skipIf(process.platform === 'win32')('reads Linux exe links, skipping what it cannot read and the deleted suffix', () => {
    const procRoot = makeTemporaryDir();
    fs.mkdirSync(path.join(procRoot, '123'));
    fs.symlinkSync('/home/dev/kangentic/node_modules/electron/dist/electron', path.join(procRoot, '123', 'exe'));
    fs.mkdirSync(path.join(procRoot, '456'));
    fs.mkdirSync(path.join(procRoot, '789'));
    fs.symlinkSync('/home/dev/kangentic/node_modules/@esbuild/linux-x64/bin/esbuild (deleted)', path.join(procRoot, '789', 'exe'));
    fs.mkdirSync(path.join(procRoot, 'self'));

    // readdir order is the filesystem's, so compare in pid order.
    const rows = (listLinuxExecutables(procRoot) as ProcessRow[]).sort((left, right) => left.pid - right.pid);
    expect(rows).toEqual([
      { pid: 123, executablePath: '/home/dev/kangentic/node_modules/electron/dist/electron' },
      { pid: 789, executablePath: '/home/dev/kangentic/node_modules/@esbuild/linux-x64/bin/esbuild' },
    ]);
  });
});

describe('listProcessExecutables against a live process', () => {
  /**
   * A small system binary that waits, per platform. Copied into a temporary
   * node_modules and started from there, it stands in for a preview's Electron.
   */
  function waitingBinary(): { source: string; args: string[] } {
    if (process.platform === 'win32') {
      return { source: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), args: ['-n', '30', '127.0.0.1'] };
    }
    return { source: '/bin/sleep', args: ['30'] };
  }

  // The real scan on each platform: the CIM query on Windows, /proc on Linux
  // (CI's runner), and `ps -o comm` on macOS, where it checks that comm carries
  // the full path of a process started by one.
  it('finds a process started from inside a node_modules folder', async () => {
    const nodeModules = path.join(makeTemporaryDir(), 'node_modules');
    const { source, args } = waitingBinary();
    const copy = path.join(nodeModules, 'holder', path.basename(source));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(source, copy);
    fs.chmodSync(copy, 0o755);

    const holder = spawn(copy, args, { stdio: 'ignore', windowsHide: true });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('spawn', () => resolve());
        holder.once('error', reject);
      });
      const rows = (await listProcessExecutables(15000)) as ProcessRow[];

      expect(processesRunningFrom(rows, nodeModules).map((row: ProcessRow) => row.pid)).toContain(holder.pid);
    } finally {
      holder.kill();
      await exited;
    }
  }, 30000);
});

describe('describeHolders', () => {
  it('groups pids by executable and shortens a long list', () => {
    const electron = 'C:\\Users\\dev\\kangentic\\node_modules\\electron\\dist\\electron.exe';
    const holders = [9624, 37684, 61084, 3492, 46036].map((pid) => ({ pid, executablePath: electron }));
    holders.push({ pid: 59760, executablePath: '/home/dev/kangentic/node_modules/@esbuild/linux-x64/bin/esbuild' });

    expect(describeHolders(holders)).toBe('electron.exe (pids 9624, 37684, 61084 and 2 more), esbuild (pid 59760)');
  });
});

describe('npmCiInvocation', () => {
  it('runs one command string through the shell on Windows, which cannot spawn npm.cmd directly', () => {
    expect(npmCiInvocation('win32')).toEqual({ command: 'npm ci --prefix .', args: [], shell: true });
  });

  it.each(['linux', 'darwin'])('runs npm directly with its arguments on %s', (platform) => {
    expect(npmCiInvocation(platform)).toEqual({ command: 'npm', args: ['ci', '--prefix', '.'], shell: false });
  });
});

describe('stopInstall against a live process tree', () => {
  // Prints its own pid, then waits longer than the test lasts. No quote, percent
  // sign or shell metacharacter, so the Windows command line reaches node as written.
  const WAITING_SCRIPT = 'console.log(process.pid);setTimeout(function(){},30000)';

  /**
   * A child shaped like the install dev.js spawns. On Windows that is cmd.exe
   * (shell: true, as npmCiInvocation asks) with the waiting node process under
   * it, so a plain kill of the child leaves the node process running. Elsewhere
   * the child is node itself, as npm is spawned directly.
   */
  function spawnWaitingInstall(): ChildProcess {
    const stdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];
    if (process.platform === 'win32') {
      return spawn(`${quoteCmdExecutable(process.execPath)} -e "${WAITING_SCRIPT}"`, { shell: true, stdio, windowsHide: true });
    }
    return spawn(process.execPath, ['-e', WAITING_SCRIPT], { stdio, windowsHide: true });
  }

  /** The integer on the first line the child prints, or a rejection if it prints none in time. */
  function readPrintedPid(child: ChildProcess, timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`no pid on stdout within ${timeoutMs} ms, saw ${JSON.stringify(output)}`)), timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        if (output.includes('\n')) return;
        clearTimeout(timer);
        reject(new Error(`the child exited with ${code} before printing a pid, saw ${JSON.stringify(output)}`));
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        const pid = Number.parseInt(output.split('\n')[0], 10);
        if (Number.isInteger(pid)) resolve(pid);
        else reject(new Error(`expected a pid on the first line, saw ${JSON.stringify(output)}`));
      });
    });
  }

  /** True once the kernel no longer knows the pid. EPERM means it exists under another user. */
  function processIsGone(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  it('ends the process an install started, not only the shell that started it', async () => {
    const child = spawnWaitingInstall();
    let waitingPid: number | undefined;
    try {
      waitingPid = await readPrintedPid(child, 10000);
      if (process.platform === 'win32') {
        // What makes the Windows case mean anything: the pid on stdout is under
        // the shell, not the shell itself, so only a tree kill can reach it.
        expect(waitingPid).not.toBe(child.pid);
      }
      expect(processIsGone(waitingPid)).toBe(false);

      stopInstall(child);

      // Polled, never slept on: the process list settles on the OS's schedule.
      await expect.poll(() => processIsGone(waitingPid as number), { timeout: 5000, interval: 100 }).toBe(true);
    } finally {
      child.stdout?.destroy();
      child.kill();
      if (waitingPid !== undefined) {
        try {
          process.kill(waitingPid);
        } catch {
          // Already gone, which is what the test wants.
        }
      }
    }
  }, 20000);
});

describe('scripts/dev.js runs the check before anything loads from node_modules', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');

  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  }

  /** Comment-only lines removed, so prose that names a call cannot satisfy a scan. */
  const DEV_JS_CODE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf-8')
    .split('\n').filter((line) => !isCommentLine(line)).join('\n');

  function extractFunctionBody(functionName: string): string {
    const declarations = [...DEV_JS_CODE.matchAll(new RegExp(`function\\s+${functionName}\\s*\\(`, 'g'))];
    expect(declarations.length, `expected exactly one 'function ${functionName}(' in scripts/dev.js`).toBe(1);
    const openBraceIndex = DEV_JS_CODE.indexOf('{', declarations[0].index);
    let braceDepth = 0;
    for (let sourceIndex = openBraceIndex; sourceIndex < DEV_JS_CODE.length; sourceIndex++) {
      const character = DEV_JS_CODE[sourceIndex];
      if (character === '{') braceDepth += 1;
      else if (character === '}') {
        braceDepth -= 1;
        if (braceDepth === 0) return DEV_JS_CODE.slice(openBraceIndex, sourceIndex + 1);
      }
    }
    throw new Error(`unbalanced braces in function '${functionName}'`);
  }

  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it('requires esbuild only inside buildMainBundles, never at load', () => {
    expect(occurrences(DEV_JS_CODE, "require('esbuild')")).toBe(1);
    expect(extractFunctionBody('buildMainBundles')).toContain("const esbuild = require('esbuild');");
  });

  it('resolves the Electron package only inside resolveElectronExecutable, never at load', () => {
    const electronRequire = "require(path.join(projectDir, 'node_modules', 'electron'))";
    expect(occurrences(DEV_JS_CODE, electronRequire)).toBe(1);
    expect(extractFunctionBody('resolveElectronExecutable')).toContain(electronRequire);
  });

  it('awaits the check first in start(), before Electron, esbuild, the catalogs and Vite', () => {
    const body = extractFunctionBody('start');
    const checkAt = body.indexOf('await ensureNodeModules(projectDir, { runInstall: runDependencyInstall });');

    expect(checkAt, 'start() awaits ensureNodeModules').toBeGreaterThan(-1);
    expect(body.indexOf('await ')).toBe(checkAt);
    for (const laterStep of ['resolveElectronExecutable()', 'buildMainBundles()', 'compileCatalogsForMainInBackground(', "import('vite')"]) {
      expect(body.indexOf(laterStep), `${laterStep} runs in start()`).toBeGreaterThan(checkAt);
    }
  });

  it('stops an install still running when cleanup() runs', () => {
    expect(extractFunctionBody('cleanup')).toContain('stopInstall(installProc);');
  });

  it('holds the npm ci child for cleanup() and reads an exit with no code as a failure', () => {
    const body = extractFunctionBody('runDependencyInstall');

    expect(body).toContain('npmCiInvocation()');
    expect(body).toContain('cwd: projectDir');
    expect(body).toContain('installProc = child;');
    expect(body).toContain('resolve(exitCode ?? 1);');
  });
});
