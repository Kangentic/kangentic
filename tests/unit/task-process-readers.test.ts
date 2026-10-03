/**
 * The per-platform task-tag readers (src/main/pty/process-tag/*-reader.ts),
 * against fixtures, so each parser runs on every OS the suite runs on. The
 * real-process half is tests/unit/session-reap-real-processes.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LinuxTaggedProcessReader, findTagInEnviron, parseProcStat } from '../../src/main/pty/process-tag/linux-reader';
import {
  DarwinTaggedProcessReader,
  argumentsFromProcArgs,
  isTopLevelAppExecutable,
  parseBsdInfo,
  parseCurrentDirectory,
  parseLsappinfoUiPids,
  parseShortBsdInfo,
  summarizeProcArgs,
  type DarwinProcessRow,
} from '../../src/main/pty/process-tag/darwin-reader';
import { TASK_PROCESS_TAG_ENV as TASK_TAG } from '../../src/main/pty/process-tag/task-process-tag';
import { findTagInWindowsEnvironment, listWin32Processes } from '../../src/main/pty/process-tag/win32-reader';
import { toProcessInfo } from '../../src/main/pty/host/host-process-table';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function environBuffer(entries: string[]): Buffer {
  return Buffer.from(`${entries.join('\0')}\0`, 'utf8');
}

/** Whether this OS lets the test create a symlink (Windows may not). */
function canSymlink(directory: string): boolean {
  try {
    fs.symlinkSync(directory, path.join(directory, 'probe-link'));
    return true;
  } catch {
    return false;
  }
}

describe('Linux reader', () => {
  it('reads only the tag value out of a NUL-separated environ', () => {
    expect(findTagInEnviron(environBuffer(['PATH=/usr/bin', `KANGENTIC_TASK_ID=${TASK}`, 'API_TOKEN=secret']))).toBe(TASK);
    expect(findTagInEnviron(environBuffer(['PATH=/usr/bin', 'NOT_KANGENTIC_TASK_ID=x']))).toBeNull();
    expect(findTagInEnviron(environBuffer(['KANGENTIC_TASK_ID=']))).toBe('');
    expect(findTagInEnviron(Buffer.alloc(0))).toBeNull();
  });

  it('parses state, ppid and starttime after the last parenthesis of the command name', () => {
    const stat = '4242 (node (worker) x) S 4100 4242 4100 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 987654 0 0';
    expect(parseProcStat(stat)).toEqual({ state: 'S', ppid: 4100, startTicks: '987654' });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('scans a proc tree: tag, working directory, roles, unreadable count, zombies skipped, and an identity-checked kill', async () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-'));
    temporaryRoots.push(procRoot);
    // POSIX symlinks only: Windows reads a link's target back with a drive letter.
    const symlinks = process.platform !== 'win32' && canSymlink(procRoot);
    const writeProcess = (pid: number, ppid: number, startTicks: number, environ: string[] | null, options: { uid?: number; state?: string; cwd?: string; exe?: string; maps?: string } = {}) => {
      const directory = path.join(procRoot, String(pid));
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'stat'), `${pid} (proc) ${options.state ?? 'S'} ${ppid} ${pid} ${ppid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0`);
      const uid = options.uid ?? 1000;
      fs.writeFileSync(path.join(directory, 'status'), `Name:\tproc\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      // A directory in place of the file makes the read fail like a refused
      // environ would, on every OS the suite runs on.
      if (environ === null) fs.mkdirSync(path.join(directory, 'environ'));
      else fs.writeFileSync(path.join(directory, 'environ'), environBuffer(environ));
      if (options.maps !== undefined) fs.writeFileSync(path.join(directory, 'maps'), options.maps);
      if (symlinks && options.cwd) fs.symlinkSync(options.cwd, path.join(directory, 'cwd'));
      if (symlinks && options.exe) fs.symlinkSync(options.exe, path.join(directory, 'exe'));
    };
    writeProcess(10, 1, 500, [`KANGENTIC_TASK_ID=${TASK}`], { cwd: '/home/dev/project (deleted)', maps: '7f00 r-xp /usr/lib/libc.so.6\n' });
    writeProcess(11, 10, 600, ['HOME=/home/dev'], { cwd: '/home/dev/project', maps: '7f00 r-xp /usr/lib/x86_64-linux-gnu/libX11.so.6.4.0\n' });
    writeProcess(14, 1, 900, [`KANGENTIC_TASK_ID=${TASK}`], { exe: '/usr/bin/tmux', maps: '' });
    // Non-dumpable and the caller's own: counted. Another user's: not counted.
    writeProcess(12, 1, 700, null);
    writeProcess(13, 1, 800, null, { uid: 0 });
    // A zombie has exited: skipped entirely.
    writeProcess(15, 10, 950, [`KANGENTIC_TASK_ID=${TASK}`], { state: 'Z' });
    fs.mkdirSync(path.join(procRoot, 'self'));

    const signals: Array<[number, string]> = [];
    const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, signal: (pid, signalName) => { signals.push([pid, signalName]); } });
    const scan = await reader.scan();
    expect(scan.unreadableCount).toBe(1);
    const byPid = new Map(scan.processes.map((entry) => [entry.pid, entry]));
    expect(byPid.get(10)).toMatchObject({ ppid: 1, startKey: '500', tagValue: TASK });
    expect(byPid.get(11)).toMatchObject({ ppid: 10, tagValue: null, role: 'visible-app' });
    expect(byPid.get(12)).toMatchObject({ environmentUnreadable: true });
    expect(byPid.has(15)).toBe(false);
    expect(byPid.get(10)?.role).toBeUndefined();
    if (symlinks) {
      // The " (deleted)" suffix of a removed directory is dropped.
      expect(byPid.get(10)?.workingDirectory).toBe('/home/dev/project');
      expect(byPid.get(14)?.role).toBe('multiplexer');
    }

    expect(await reader.kill(byPid.get(10)!, 'graceful')).toBe(true);
    expect(await reader.kill({ ...byPid.get(10)!, startKey: '499' }, 'force')).toBe(false);
    expect(signals).toEqual([[10, 'SIGTERM']]);
  });

  it('describes a process from its cmdline, by program and script only, and only while its identity matches', async () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-'));
    temporaryRoots.push(procRoot);
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-cwd-'));
    temporaryRoots.push(workingDirectory);
    fs.writeFileSync(path.join(workingDirectory, 'server.js'), '');
    const directory = path.join(procRoot, '20');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'stat'), '20 (node) S 1 20 20 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0');
    fs.writeFileSync(path.join(directory, 'cmdline'), Buffer.from('node\0server.js\0--token=sk-live-secret\0'));
    const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000 });
    const target = { pid: 20, ppid: 1, startKey: '777', startedAtMs: null, tagValue: TASK, workingDirectory };

    const labels = await reader.describe([target, { ...target, startKey: '778' }]);
    expect(labels.get(20)).toBe('node (server.js)');
    expect(await reader.describe([{ ...target, startKey: '778' }])).toEqual(new Map());
  });
});

describe('macOS reader', () => {
  /**
   * A KERN_PROCARGS2 record in the layout measured on macOS 26: argc, the exec
   * path, NUL padding, argv, env, a long NUL run, and the kernel's apple
   * strings (`ptr_munge=` first, no `executable_path=`). `withheld` is the SIP
   * shape: the record ends after argv.
   */
  function procArgs(executablePath: string, argv: string[], environment: string[], options: { withheld?: boolean } = {}): Buffer {
    const argc = Buffer.alloc(4);
    argc.writeInt32LE(argv.length, 0);
    const head = `${executablePath}\0\0\0\0\0\0${argv.join('\0')}\0`;
    const apple = ['ptr_munge=', '\0'.repeat(18), 'main_stack=', '\0'.repeat(42), 'executable_file=0x1a01000009,0x2b', 'dyld_file=0x1a01000009,0x3c', 'executable_cdhash=ab12', 'th_port=0x103', 'security_config=0x2'].join('\0');
    const tail = options.withheld
      ? ''
      : `${environment.length > 0 ? `${environment.join('\0')}\0` : ''}${'\0'.repeat(100)}${apple}\0\0\0`;
    return Buffer.concat([argc, Buffer.from(head + tail, 'latin1')]);
  }

  it('finds the tag anywhere after the executable path, including past a title that zeroed the arguments', () => {
    expect(summarizeProcArgs(procArgs('/usr/local/bin/node', ['node', 'server.js'], ['PATH=/usr/bin', `KANGENTIC_TASK_ID=${TASK}`])))
      .toEqual({ executablePath: '/usr/local/bin/node', tagValue: TASK, environmentWithheld: false });
    // npm, next-server and pm2 set a title: the argument area becomes the
    // title and NULs, and `ps -E` stops there. The record still holds the tag.
    const titled = procArgs('/usr/local/bin/node', ['npm run dev', '', ''], ['PATH=/usr/bin', `KANGENTIC_TASK_ID=${TASK}`]);
    expect(summarizeProcArgs(titled)).toMatchObject({ tagValue: TASK, environmentWithheld: false });
    // An argument that merely mentions the tag is not the tag.
    expect(summarizeProcArgs(procArgs('/bin/sh', ['sh', '-c', `echo KANGENTIC_TASK_ID=${TASK}`], ['HOME=/Users/dev']))?.tagValue).toBeNull();
  });

  it('reads exactly argc arguments for a label, never the environment after them', () => {
    expect(argumentsFromProcArgs(procArgs('/usr/local/bin/node', ['node', 'server.js', '--port', '3000'], ['API_TOKEN=secret'])))
      .toEqual({ executablePath: '/usr/local/bin/node', argv: ['node', 'server.js', '--port', '3000'] });
    // A title zeroed the other arguments: they read empty, and the environment
    // after them is not taken for arguments.
    const titled = argumentsFromProcArgs(procArgs('/usr/local/bin/node', ['npm run dev', '', ''], ['API_TOKEN=secret']));
    expect(titled?.argv).toEqual(['npm run dev', '', '']);
    expect(JSON.stringify(titled)).not.toContain('secret');
  });

  it('flags a record with no environment before the apple strings as withheld: SIP on an Apple tool, or env -i', () => {
    // SIP: the record ends after argv.
    expect(summarizeProcArgs(procArgs('/bin/sleep', ['sleep', '300'], [], { withheld: true })))
      .toEqual({ executablePath: '/bin/sleep', tagValue: null, environmentWithheld: true });
    // env -i: an empty environment, then the kernel's apple strings (measured: `ps` stops before them).
    expect(summarizeProcArgs(procArgs('/bin/sleep', ['sleep', '300'], []))?.environmentWithheld).toBe(true);
    expect(summarizeProcArgs(procArgs('/bin/sleep', ['sleep', '300'], ['HOME=/Users/dev']))?.environmentWithheld).toBe(false);
    // A titled process with its environment intact is not withheld.
    expect(summarizeProcArgs(procArgs('/usr/local/bin/node', ['npm run dev', '', ''], ['PATH=/usr/bin', 'HOME=/Users/dev', 'SHELL=/bin/zsh']))?.environmentWithheld).toBe(false);
    expect(summarizeProcArgs(Buffer.alloc(2))).toBeNull();
  });

  it('parses the libproc structs at XNU\'s offsets: bsdinfo, the short bsdinfo, and the working directory', () => {
    const bsdInfo = Buffer.alloc(136);
    bsdInfo.writeUInt32LE(502, 12);
    bsdInfo.writeUInt32LE(501, 16);
    bsdInfo.writeUInt32LE(501, 20);
    Buffer.from('zsh').copy(bsdInfo, 48);
    bsdInfo.writeBigUInt64LE(1790000000n, 120);
    bsdInfo.writeBigUInt64LE(4200n, 128);
    expect(parseBsdInfo(bsdInfo)).toEqual({ pid: 502, ppid: 501, uid: 501, startKey: '1790000000.004200' });
    expect(parseBsdInfo(Buffer.alloc(100))).toBeNull();

    const shortInfo = Buffer.alloc(64);
    shortInfo.writeUInt32LE(88, 0);
    shortInfo.writeUInt32LE(1, 4);
    shortInfo.writeUInt32LE(0, 36);
    expect(parseShortBsdInfo(shortInfo)).toEqual({ pid: 88, ppid: 1, uid: 0, startKey: '' });

    const vnodePath = Buffer.alloc(2352);
    Buffer.from('/Users/dev/with space\0').copy(vnodePath, 152);
    // pvi_rdir follows at 1176; it must not be read as the working directory.
    Buffer.from('/\0').copy(vnodePath, 1176 + 152);
    expect(parseCurrentDirectory(vnodePath)).toBe('/Users/dev/with space');
    expect(parseCurrentDirectory(Buffer.alloc(2352))).toBeNull();
  });

  it('parses LaunchServices UI apps and top-level app executables', () => {
    const lsappinfo = [
      ' 1) "Google Chrome" ASN:0x0-0x1001:',
      '    pid = 3390 type="Foreground" flavor=3 Version="154.0"',
      ' 2) "SystemUIServer" ASN:0x0-0x2002:',
      '    pid = 412 type="UIElement" flavor=3',
      ' 3) "Spotlight" ASN:0x0-0x3003:',
      '    pid = 413 type="BackgroundOnly" flavor=3',
    ].join('\n');
    expect([...parseLsappinfoUiPids(lsappinfo)]).toEqual([3390, 412]);
    expect(isTopLevelAppExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(true);
    expect(isTopLevelAppExecutable('/System/Applications/TextEdit.app/Contents/MacOS/TextEdit')).toBe(true);
    expect(isTopLevelAppExecutable('/Users/dev/Applications/Visual Studio Code.app/Contents/MacOS/Electron')).toBe(true);
    // Measured: /usr/bin/python3 runs from inside a nested Python.app.
    expect(isTopLevelAppExecutable('/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python')).toBe(false);
    expect(isTopLevelAppExecutable('/Users/dev/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toBe(false);
    expect(isTopLevelAppExecutable('/usr/local/bin/node')).toBe(false);
  });

  it('reads the tag from the kernel record, and directory and role only for tagged and withheld processes and their trees', async () => {
    const records = new Map<number, Buffer>([
      [501, procArgs('/usr/local/bin/node', ['next-server (v15)', '', ''], [`KANGENTIC_TASK_ID=${TASK}`])],
      [502, procArgs('/bin/sleep', ['sleep', '300'], [], { withheld: true })],
      [503, procArgs('/bin/zsh', ['-zsh'], ['HOME=/Users/dev'])],
      [504, procArgs('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['Google Chrome'], [`KANGENTIC_TASK_ID=${TASK}`])],
      [505, procArgs('/opt/homebrew/bin/tmux', ['tmux'], [`KANGENTIC_TASK_ID=${TASK}`])],
    ]);
    const rows: DarwinProcessRow[] = [
      { pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' },
      { pid: 502, ppid: 1, uid: 501, startKey: '1790000002.000000' },
      { pid: 503, ppid: 300, uid: 501, startKey: '1790000003.000000' },
      { pid: 504, ppid: 1, uid: 501, startKey: '1790000004.000000' },
      { pid: 505, ppid: 1, uid: 501, startKey: '1790000005.000000' },
      { pid: 506, ppid: 501, uid: 501, startKey: '1790000006.000000' },
      // Another user's process: the short struct, no start time.
      { pid: 600, ppid: 1, uid: 0, startKey: '' },
    ];
    const directoryReads: number[] = [];
    const directories = new Map([[501, '/Users/dev/project'], [502, '/Users/dev/project/.kangentic/worktrees/task-1']]);
    const reader = new DarwinTaggedProcessReader({
      uid: 501,
      loadKernel: async () => ({
        // 700 vanished between the list and its read.
        listPids: () => [...rows.map((row) => row.pid), 700],
        processRow: (pid) => rows.find((row) => row.pid === pid) ?? null,
        workingDirectory: (pid) => {
          directoryReads.push(pid);
          return directories.get(pid) ?? null;
        },
        procArgs: (pid) => records.get(pid) ?? null,
      }),
      runLsappinfo: async () => '    pid = 504 type="Foreground" flavor=3\n',
    });
    const scan = await reader.scan();
    const byPid = new Map(scan.processes.map((entry) => [entry.pid, entry]));
    expect(byPid.has(700)).toBe(false);
    expect(byPid.get(501)).toMatchObject({ tagValue: TASK, workingDirectory: '/Users/dev/project', startKey: '1790000001.000000' });
    expect(byPid.get(502)).toMatchObject({ tagValue: null, environmentWithheld: true, workingDirectory: '/Users/dev/project/.kangentic/worktrees/task-1' });
    // 503 is a readable, untagged shell with a live parent: never looked at.
    expect(byPid.get(503)?.workingDirectory).toBeUndefined();
    expect(byPid.get(504)?.role).toBe('visible-app');
    expect(byPid.get(505)?.role).toBe('multiplexer');
    // 506 has no record (gone or refused): unreadable environment, but under 501.
    expect(byPid.get(506)).toMatchObject({ environmentUnreadable: true, workingDirectory: null });
    // Another user's process is listed, with an unknown start key, and never read.
    expect(byPid.get(600)).toMatchObject({ ppid: 1, startKey: '' });
    expect(byPid.get(600)?.environmentUnreadable).toBeUndefined();
    expect(scan.unreadableCount).toBe(1);
    expect(directoryReads.sort((left, right) => left - right)).toEqual([501, 502, 504, 505, 506]);
  });

  it('reads no working directory and spawns nothing when no process is tagged or withheld', async () => {
    const runLsappinfo = vi.fn(async () => '');
    const workingDirectory = vi.fn(() => null);
    const reader = new DarwinTaggedProcessReader({
      uid: 501,
      loadKernel: async () => ({
        listPids: () => [501],
        processRow: () => ({ pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' }),
        workingDirectory,
        procArgs: () => procArgs('/bin/zsh', ['-zsh'], ['HOME=/Users/dev']),
      }),
      runLsappinfo,
    });
    expect((await reader.scan()).processes).toHaveLength(1);
    expect(runLsappinfo).not.toHaveBeenCalled();
    expect(workingDirectory).not.toHaveBeenCalled();
  });

  it('kills only a pid whose start time still matches, and never one with an unknown start', async () => {
    const signals: Array<[number, string]> = [];
    const reader = new DarwinTaggedProcessReader({
      uid: 501,
      loadKernel: async () => ({
        listPids: () => [501],
        processRow: (pid) => (pid === 501 ? { pid: 501, ppid: 1, uid: 501, startKey: '1790000000.000100' } : null),
        workingDirectory: () => null,
        procArgs: () => null,
      }),
      signal: (pid, signalName) => { signals.push([pid, signalName]); },
    });
    const target = { pid: 501, ppid: 1, startKey: '1790000000.000100', startedAtMs: null, tagValue: TASK };
    expect(await reader.kill(target, 'force')).toBe(true);
    // A pid reused since the scan: same pid, another start.
    expect(await reader.kill({ ...target, startKey: '1790000000.000099' }, 'force')).toBe(false);
    expect(await reader.kill({ ...target, startKey: '' }, 'force')).toBe(false);
    expect(await reader.kill({ ...target, pid: 502 }, 'force')).toBe(false);
    expect(signals).toEqual([[501, 'SIGKILL']]);
  });
});

describe.runIf(process.platform === 'darwin')('macOS libproc against ps and lsof (real)', () => {
  /** `ps` and `lsof` read the same kernel data through their own code: the offsets must agree with them. */
  function runTool(command: string, args: string[]): string {
    return execFileSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  }

  it('reads the parent, uid, start time and working directory ps and lsof report', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-libproc-')));
    temporaryRoots.push(directory);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: directory, env: { ...process.env, [TASK_TAG]: TASK }, stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const childPid = child.pid!;
      const reader = new DarwinTaggedProcessReader();
      const scan = await reader.scan();
      const byPid = new Map(scan.processes.map((entry) => [entry.pid, entry]));
      const scanned = byPid.get(childPid);
      expect(scanned).toMatchObject({ ppid: process.pid, tagValue: TASK, workingDirectory: directory });
      expect(scanned?.startKey).toMatch(/^\d+\.\d{6}$/);

      const [psPid, psParent, psUid] = runTool('ps', ['-o', 'pid=,ppid=,uid=', '-p', String(childPid)]).trim().split(/\s+/).map(Number);
      expect([psPid, psParent]).toEqual([childPid, scanned?.ppid]);
      expect(psUid).toBe(process.getuid?.());
      const lsofDirectory = runTool('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(childPid)])
        .split('\n').find((line) => line.startsWith('n'))?.slice(1);
      expect(scanned?.workingDirectory).toBe(lsofDirectory);

      // The start key is stable across reads, and matches the start time ps reports to the second.
      const second = (await reader.scan()).processes.find((entry) => entry.pid === childPid);
      expect(second?.startKey).toBe(scanned?.startKey);
      const psStart = Date.parse(runTool('ps', ['-o', 'lstart=', '-p', String(childPid)]).trim());
      expect(Math.abs(Number(scanned!.startKey.split('.')[0]) * 1000 - psStart)).toBeLessThan(1500);

      // A root-owned process (launchd) is listed through the short struct, parent and all.
      expect(byPid.get(1)).toMatchObject({ ppid: Number(runTool('ps', ['-o', 'ppid=', '-p', '1']).trim()), startKey: '' });

      expect(await reader.kill(scanned!, 'force')).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Windows environment block', () => {
  function windowsBlock(entries: string[]): Buffer {
    return Buffer.from(`${entries.join('\0')}\0\0`, 'utf16le');
  }

  it('reads only the tag value, matching the name case-insensitively', () => {
    expect(findTagInWindowsEnvironment(windowsBlock(['=C:=C:\\', 'Path=C:\\Windows', `kangentic_task_id=${TASK}`, 'SECRET_KEY=x']))).toBe(TASK);
    expect(findTagInWindowsEnvironment(windowsBlock(['Path=C:\\Windows']))).toBeNull();
    expect(findTagInWindowsEnvironment(windowsBlock(['XKANGENTIC_TASK_ID=nope', 'Path=C:\\Windows']))).toBeNull();
  });

  it('stops at the block terminator', () => {
    const block = Buffer.concat([windowsBlock(['Path=C:\\Windows']), Buffer.from(`KANGENTIC_TASK_ID=${TASK}\0`, 'utf16le')]);
    expect(findTagInWindowsEnvironment(block)).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('Windows Toolhelp listing (real)', () => {
  it('lists this process under its parent, with its image name', async () => {
    const rows = await listWin32Processes();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.find((row) => row.pid === process.pid)).toMatchObject({ ppid: process.ppid, image: expect.stringMatching(/\.exe$/i) });
    // The watcher's shape: the image name lowercased with `.exe` dropped.
    const self = toProcessInfo(rows.find((row) => row.pid === process.pid)!);
    expect(self.comm).toBe(path.basename(process.execPath).toLowerCase().replace(/\.exe$/, ''));
  });
});
