/**
 * The per-platform task-tag readers (src/main/pty/process-tag/*-reader.ts),
 * against fixtures, so each parser runs on every OS the suite runs on. The
 * real-process half is tests/unit/session-reap-real-processes.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LinuxTaggedProcessReader, addressFromProcHex, findTagInEnviron, parseProcNetTcp, parseProcStat } from '../../src/main/pty/process-tag/linux-reader';
import {
  DarwinTaggedProcessReader,
  argumentsFromProcArgs,
  isTopLevelAppExecutable,
  parseBsdInfo,
  parseCurrentDirectory,
  parseLsappinfoUiPids,
  parseShortBsdInfo,
  parseSocketFdInfo,
  runTool as runDarwinTool,
  summarizeProcArgs,
  type DarwinKernel,
  type DarwinProcessRow,
} from '../../src/main/pty/process-tag/darwin-reader';
import { TASK_PROCESS_TAG_ENV as TASK_TAG } from '../../src/main/pty/process-tag/task-process-tag';
import { Win32TaggedProcessReader, findTagInWindowsEnvironment, listWin32Processes } from '../../src/main/pty/process-tag/win32-reader';
import { toProcessInfo } from '../../src/main/pty/host/host-process-table';
import { seedsAndDescendants, type LocalConnection, type ScannedProcess, type TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';
import type { SocketRow } from '../../src/main/pty/process-tag/local-connections';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('seedsAndDescendants', () => {
  function processWith(pid: number, ppid: number, extra: Partial<ScannedProcess> = {}): ScannedProcess {
    return { pid, ppid, startKey: String(pid), startedAtMs: null, tagValue: null, ...extra };
  }
  const pidsOf = (processes: Set<ScannedProcess>): number[] => [...processes].map((scanned) => scanned.pid).sort((left, right) => left - right);

  it('returns each seed and every process below it, and nothing beside them', () => {
    const processes = [
      processWith(1, 0),
      processWith(10, 1, { tagValue: TASK }),
      processWith(11, 10),
      processWith(12, 11),
      // A sibling of the seed and its child are outside the tree.
      processWith(20, 1),
      processWith(21, 20),
    ];
    expect(pidsOf(seedsAndDescendants(processes, (scanned) => scanned.tagValue === TASK))).toEqual([10, 11, 12]);
  });

  it('takes the seeds the caller names, such as the macOS withheld orphans beside the tagged processes', () => {
    const launchdPid = 1;
    const processes = [
      processWith(launchdPid, 0),
      processWith(30, launchdPid, { tagValue: TASK }),
      processWith(40, launchdPid, { environmentWithheld: true }),
      processWith(41, 40),
      // Withheld but not an orphan, so not a seed: it is reached as the tagged process's child.
      processWith(50, 30, { environmentWithheld: true }),
      // An untagged orphan with a readable environment is no seed.
      processWith(60, launchdPid),
    ];
    const isSeed = (scanned: ScannedProcess) => scanned.tagValue === TASK || (scanned.environmentWithheld === true && scanned.ppid === launchdPid);
    expect(pidsOf(seedsAndDescendants(processes, isSeed))).toEqual([30, 40, 41, 50]);
  });

  it('ends on a process listed as its own parent, and on a cycle of parents', () => {
    const processes = [
      processWith(70, 70, { tagValue: TASK }),
      processWith(80, 81, { tagValue: TASK }),
      processWith(81, 80),
    ];
    expect(pidsOf(seedsAndDescendants(processes, (scanned) => scanned.tagValue === TASK))).toEqual([70, 80, 81]);
  });

  it('returns nothing when no process is a seed', () => {
    expect(seedsAndDescendants([processWith(1, 0), processWith(2, 1)], () => false).size).toBe(0);
  });
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
    // A tmux server whose binary a package upgrade replaced: the kernel marks the link.
    writeProcess(16, 1, 960, [`KANGENTIC_TASK_ID=${TASK}`], { exe: '/usr/bin/tmux (deleted)', maps: '' });
    // Roles are read for a tagged process and what is below it, never for its
    // ancestors or an untagged sibling: a desktop shell or terminal emulator maps
    // a GUI toolkit, and reading one as a visible app would protect everything
    // under it. Pid 20 is an untagged parent of tagged pid 21, and pid 22 an
    // untagged sibling, and both map GTK. Pid 11 above is the positive control:
    // it sits under a tagged process and maps a toolkit, so it reads visible-app.
    const guiToolkitMaps = '7f00 r-xp /usr/lib/x86_64-linux-gnu/libgtk-3.so.0\n';
    writeProcess(20, 1, 1000, ['HOME=/home/dev'], { maps: guiToolkitMaps });
    writeProcess(21, 20, 1010, [`KANGENTIC_TASK_ID=${TASK}`], { maps: '7f00 r-xp /usr/lib/libc.so.6\n' });
    writeProcess(22, 1, 1020, ['HOME=/home/dev'], { maps: guiToolkitMaps });
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
    // Scanned, so an absent role below is the reader's choice and not a missing process.
    expect(byPid.get(20)).toMatchObject({ ppid: 1, tagValue: null });
    expect(byPid.get(21)).toMatchObject({ ppid: 20, tagValue: TASK });
    expect(byPid.get(22)).toMatchObject({ ppid: 1, tagValue: null });
    expect(byPid.get(20)?.role, 'an untagged ancestor of a tagged process reads no role').toBeUndefined();
    expect(byPid.get(21)?.role).toBeUndefined();
    expect(byPid.get(22)?.role, 'an untagged sibling of a tagged process reads no role').toBeUndefined();
    if (symlinks) {
      // The " (deleted)" suffix of a removed directory is dropped.
      expect(byPid.get(10)?.workingDirectory).toBe('/home/dev/project');
      expect(byPid.get(14)?.role).toBe('multiplexer');
      // The " (deleted)" mark on the executable does not hide a tmux server.
      expect(byPid.get(16)?.role).toBe('multiplexer');
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

  it('returns an empty scan, and does not throw, when its proc root cannot be read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-'));
    temporaryRoots.push(root);
    // A child that is never created: readdir of it rejects with ENOENT on every OS.
    const missingProcRoot = path.join(root, 'missing');
    // Positive control: the empty result is the unreadable root, not a directory that happens to be empty.
    expect(fs.existsSync(missingProcRoot)).toBe(false);
    const reader = new LinuxTaggedProcessReader({ procRoot: missingProcRoot, uid: 1000 });
    // Not a throw and not a listing: the reap turns the empty scan into an `empty_scan` failure, never "all gone".
    await expect(reader.scan()).resolves.toEqual({ processes: [], unreadableCount: 0 });
  });
});

describe('Linux reader: TCP connections from net/tcp and the fd links', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const tcpLine = (index: number, local: string, remote: string, state: string, inode: number) =>
    `  ${index}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
  // 5037 is 13AD, 52000 CB20, 8080 1F90, 52001 CB21.
  const tcp = [
    header,
    tcpLine(0, '0100007F:13AD', '00000000:0000', '0A', 1001),
    tcpLine(1, '0100007F:13AD', '0100007F:CB20', '01', 1002),
    tcpLine(2, '0100007F:CB20', '0100007F:13AD', '01', 1003),
    // The IPv4 client of the dual-stack listener below.
    tcpLine(3, '0100007F:CB21', '0100007F:1F90', '01', 2003),
    // A closed connection: no inode, and no state that pairs.
    tcpLine(4, '0100007F:CB22', '0100007F:13AD', '06', 0),
  ].join('\n');
  // `::` and `::ffff:127.0.0.1`, each 32-bit word in little-endian order.
  const tcp6 = [
    header,
    tcpLine(0, '00000000000000000000000000000000:1F90', '00000000000000000000000000000000:0000', '0A', 2001),
    tcpLine(1, '0000000000000000FFFF00000100007F:1F90', '0000000000000000FFFF00000100007F:CB21', '01', 2002),
  ].join('\n');

  it('reads addresses word by word in the kernel\'s byte order, and a v4-mapped address as its IPv4 form', () => {
    expect(addressFromProcHex('0100007F', true)).toBe('127.0.0.1');
    expect(addressFromProcHex('7F000001', false)).toBe('127.0.0.1');
    expect(addressFromProcHex('0000000000000000FFFF00000100007F', true)).toBe('127.0.0.1');
    expect(addressFromProcHex('00000000000000000000000001000000', true)).toBe('0:0:0:0:0:0:0:1');
    expect(addressFromProcHex('0100', true)).toBeNull();
  });

  it('parses rows with state, ports and inode, and skips the header and short lines', () => {
    const rows = parseProcNetTcp(`${tcp}\n  9: garbage\n`, true);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ state: 'listen', localAddress: '127.0.0.1', localPort: 5037, remoteAddress: '0.0.0.0', remotePort: 0, ownerPids: [], inode: '1001' });
    expect(rows[1]).toMatchObject({ state: 'established', localPort: 5037, remotePort: 52000, inode: '1002' });
    expect(rows[4].state).toBe('other');
  });

  function procWithSockets(links: Record<number, number[]>, options: { withTcp6?: boolean; withTcp?: boolean } = {}): string {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-net-'));
    temporaryRoots.push(procRoot);
    fs.mkdirSync(path.join(procRoot, 'net'));
    if (options.withTcp !== false) fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), tcp);
    if (options.withTcp6 !== false) fs.writeFileSync(path.join(procRoot, 'net', 'tcp6'), tcp6);
    for (const [pid, inodes] of Object.entries(links)) {
      const fdDirectory = path.join(procRoot, pid, 'fd');
      fs.mkdirSync(fdDirectory, { recursive: true });
      inodes.forEach((inode, index) => fs.symlinkSync(`socket:[${inode}]`, path.join(fdDirectory, String(index + 3))));
      // A plain file link beside the sockets.
      fs.symlinkSync('/dev/null', path.join(fdDirectory, '0'));
    }
    return procRoot;
  }

  const asProcess = (pid: number): ScannedProcess => ({ pid, ppid: 1, startKey: String(pid), startedAtMs: null, tagValue: TASK });
  // A Windows symlink cannot name `socket:[1001]`, so the fd walk runs on POSIX.
  const posixLinks = process.platform !== 'win32';

  it.runIf(posixLinks)('pairs through the inodes the fd links name, across tcp and tcp6, and reports which listeners listen', async () => {
    // 50 listens on 5037 and accepted 3001's connection; 51 listens dual-stack on 8080; 52 listens on nothing.
    const procRoot = procWithSockets({ 50: [1001, 1002], 60: [1003], 51: [2001, 2002], 61: [2003], 52: [] });
    const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
    const read = await reader.connections([asProcess(50), asProcess(51), asProcess(52)], [asProcess(60), asProcess(61)]);
    expect(read.pairs).toEqual([{ listenerPid: 50, clientPid: 60 }, { listenerPid: 51, clientPid: 61 }]);
    expect(read.listeningPids.sort()).toEqual([50, 51]);
  });

  it.runIf(posixLinks)('reads no client when no listener has a connected peer, and a missing tcp6 is a kernel without IPv6', async () => {
    const procRoot = procWithSockets({ 52: [] }, { withTcp6: false });
    const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
    // 60 has no fd directory at all: a read of it would find nothing, and none is made.
    expect(await reader.connections([asProcess(52)], [asProcess(60)])).toEqual({ pairs: [], listeningPids: [] });
  });

  it('fails as connection_list when net/tcp cannot be read', async () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-net-'));
    temporaryRoots.push(procRoot);
    const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
    await expect(reader.connections([asProcess(50)], [])).rejects.toMatchObject({ code: 'connection_list' });
  });

  describe('clients\' fd links are read only until every peer has an owner', () => {
    // Mirrors FD_BATCH_SIZE in linux-reader.ts: the clients are listed this many at a time.
    const fdBatchSize = 16;
    const restorableSpies: Array<{ mockRestore: () => void }> = [];

    afterEach(() => {
      for (const spy of restorableSpies.splice(0)) spy.mockRestore();
    });

    /**
     * A proc root whose fd tables are plain files holding each link's target.
     * A Windows symlink cannot name `socket:[1003]`, so a `readlink` spy reads
     * the target back from the file and the walk runs on every OS. The returned
     * function lists the pids whose fd directory the reader listed.
     */
    function procWithSocketFiles(links: Record<number, number[]>): { procRoot: string; fdDirectoriesRead: () => number[] } {
      const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-proc-net-'));
      temporaryRoots.push(procRoot);
      fs.mkdirSync(path.join(procRoot, 'net'));
      // No tcp6 file: a kernel without IPv6 is a normal read.
      fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), tcp);
      for (const [pid, inodes] of Object.entries(links)) {
        const fdDirectory = path.join(procRoot, pid, 'fd');
        fs.mkdirSync(fdDirectory, { recursive: true });
        inodes.forEach((inode, index) => fs.writeFileSync(path.join(fdDirectory, String(index + 3)), `socket:[${inode}]`));
        // A plain file link beside the sockets.
        fs.writeFileSync(path.join(fdDirectory, '0'), '/dev/null');
      }
      const readlinkSpy = vi.spyOn(fs.promises, 'readlink').mockImplementation(async (linkPath) => fs.readFileSync(linkPath, 'utf8'));
      const readdirSpy = vi.spyOn(fs.promises, 'readdir');
      restorableSpies.push(readlinkSpy, readdirSpy);
      const fdDirectoriesRead = (): number[] => readdirSpy.mock.calls.flatMap(([target]) => {
        const [pid, entry, ...rest] = path.relative(procRoot, String(target)).split(path.sep);
        return entry === 'fd' && rest.length === 0 ? [Number(pid)] : [];
      });
      return { procRoot, fdDirectoriesRead };
    }

    const clientsFrom = (firstPid: number, count: number): number[] => Array.from({ length: count }, (_, index) => firstPid + index);
    // A readable fd directory for each client, so a read of it would be recorded and not fail quietly.
    const clientLinks = (pids: number[]): Record<number, number[]> => Object.fromEntries(pids.map((pid) => [pid, [9000 + pid]]));

    it('lists no client in a later batch once the first batch holds the peer\'s owner', async () => {
      const clientPids = clientsFrom(100, fdBatchSize + 4);
      const ownerPid = clientPids[3];
      // 50 listens on 5037 and holds the accepted socket 1002; the owner holds the client end, 1003.
      const { procRoot, fdDirectoriesRead } = procWithSocketFiles({ 50: [1001, 1002], ...clientLinks(clientPids), [ownerPid]: [1003] });
      const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
      const read = await reader.connections([asProcess(50)], clientPids.map(asProcess));
      expect(read.pairs).toEqual([{ listenerPid: 50, clientPid: ownerPid }]);
      expect(read.listeningPids).toEqual([50]);
      const listed = fdDirectoriesRead();
      // Positive controls: the spy sees the listener's walk and the batch that found the owner.
      expect(listed).toContain(50);
      expect(listed).toContain(ownerPid);
      // The owner was found, so the clients after the first batch were never needed.
      expect(listed.filter((pid) => clientPids.slice(fdBatchSize).includes(pid))).toEqual([]);
    });

    it('reads the next batch when the owner is not in the first, then stops before the batch after it', async () => {
      const clientPids = clientsFrom(100, 2 * fdBatchSize + 8);
      const ownerPid = clientPids[fdBatchSize + 4];
      const { procRoot, fdDirectoriesRead } = procWithSocketFiles({ 50: [1001, 1002], ...clientLinks(clientPids), [ownerPid]: [1003] });
      const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
      const read = await reader.connections([asProcess(50)], clientPids.map(asProcess));
      // The owner is in the second batch, so the loop did not stop too early.
      expect(read.pairs).toEqual([{ listenerPid: 50, clientPid: ownerPid }]);
      const listed = fdDirectoriesRead();
      expect(listed).toContain(ownerPid);
      expect(listed.filter((pid) => clientPids.slice(2 * fdBatchSize).includes(pid))).toEqual([]);
    });

    it('lists no client when a process on the listener side already holds the peer socket', async () => {
      // 50 listens and holds the accepted socket; 60 listens too, and holds the client end, 1003.
      const { procRoot, fdDirectoriesRead } = procWithSocketFiles({ 50: [1001, 1002], 60: [1003], 70: [9070], 71: [9071] });
      const reader = new LinuxTaggedProcessReader({ procRoot, uid: 1000, littleEndian: true });
      const read = await reader.connections([asProcess(50), asProcess(60)], [asProcess(60), asProcess(70), asProcess(71)]);
      expect(read.pairs).toEqual([{ listenerPid: 50, clientPid: 60 }]);
      // Only the two listeners' tables, each once: not the clients 70 and 71, and not 60 again as a client.
      expect(fdDirectoriesRead().sort((left, right) => left - right)).toEqual([50, 60]);
    });
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

  describe('the window list and the label identity check', () => {
    /** One tagged process of the caller's own: the scan needs the window list for it. */
    function kernelWithOneTaggedProcess(): DarwinKernel {
      return {
        listPids: () => [501],
        processRow: () => ({ pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' }),
        workingDirectory: () => '/Users/dev/project',
        procArgs: () => procArgs('/usr/local/bin/node', ['node', 'server.js'], [`KANGENTIC_TASK_ID=${TASK}`]),
      };
    }

    it('fails the scan when lsappinfo could not run: the window list is the only protection a dev-built app has', async () => {
      const runLsappinfo = vi.fn(async (): Promise<string | null> => null);
      const reader = new DarwinTaggedProcessReader({ uid: 501, loadKernel: async () => kernelWithOneTaggedProcess(), runLsappinfo });
      await expect(reader.scan()).rejects.toThrow(/lsappinfo/);
      expect(runLsappinfo).toHaveBeenCalledTimes(1);
    });

    it('lets the scan resolve when lsappinfo ran and listed no window', async () => {
      const runLsappinfo = vi.fn(async (): Promise<string | null> => '');
      const reader = new DarwinTaggedProcessReader({ uid: 501, loadKernel: async () => kernelWithOneTaggedProcess(), runLsappinfo });
      const scan = await reader.scan();
      expect(runLsappinfo).toHaveBeenCalledTimes(1);
      const scanned = scan.processes.find((entry) => entry.pid === 501);
      expect(scanned).toMatchObject({ tagValue: TASK, workingDirectory: '/Users/dev/project' });
      expect(scanned?.role).toBeUndefined();
    });

    it('labels only a target whose start key still matches, and never reads a reused pid\'s command line', async () => {
      const rows = new Map<number, DarwinProcessRow>([
        [501, { pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' }],
        // 502 was reused by another program since the scan: same pid, another start.
        [502, { pid: 502, ppid: 1, uid: 501, startKey: '1790000099.000000' }],
      ]);
      const commandLineReads: number[] = [];
      const reader = new DarwinTaggedProcessReader({
        uid: 501,
        loadKernel: async () => ({
          listPids: () => [...rows.keys()],
          processRow: (pid) => rows.get(pid) ?? null,
          workingDirectory: () => null,
          procArgs: (pid) => {
            commandLineReads.push(pid);
            return procArgs('/usr/local/bin/node', ['node', 'server.js'], ['HOME=/Users/dev']);
          },
        }),
      });
      const target = (pid: number, startKey: string) => ({ pid, ppid: 1, startKey, startedAtMs: null, tagValue: TASK });
      const labels = await reader.describe([
        target(501, '1790000001.000000'),
        target(502, '1790000002.000000'),
        // Gone since the scan.
        target(503, '1790000003.000000'),
      ]);
      expect([...labels.keys()]).toEqual([501]);
      expect(commandLineReads).toEqual([501]);
    });

    it('never reads the command line of a target with an empty start key: another user\'s process, which the scan never read', async () => {
      const commandLineReads: number[] = [];
      const reader = new DarwinTaggedProcessReader({
        uid: 501,
        loadKernel: async () => ({
          listPids: () => [501, 600],
          processRow: (pid) => {
            if (pid === 501) return { pid: 501, ppid: 1, uid: 501, startKey: '1790000001.000000' };
            // The short struct: another user's process, listed with no start time.
            if (pid === 600) return { pid: 600, ppid: 1, uid: 0, startKey: '' };
            return null;
          },
          workingDirectory: () => null,
          // A readable record for every pid, so a read that wrongly happens shows up as a label.
          procArgs: (pid) => {
            commandLineReads.push(pid);
            return procArgs('/usr/local/bin/node', ['node', 'server.js'], ['HOME=/Users/dev']);
          },
        }),
      });
      const labels = await reader.describe([
        // An empty start key would otherwise pass the identity check: '' === ''.
        { pid: 600, ppid: 1, startKey: '', startedAtMs: null, tagValue: null },
        { pid: 501, ppid: 1, startKey: '1790000001.000000', startedAtMs: null, tagValue: TASK },
      ]);
      expect(commandLineReads).not.toContain(600);
      expect(labels.has(600)).toBe(false);
      // The skip is per target: the target after it is still labelled.
      expect(commandLineReads).toEqual([501]);
      expect([...labels.keys()]).toEqual([501]);
    });
  });

  describe('runTool', () => {
    /** Run a one-line node program as the tool, so the cases behave the same on every OS. */
    function runNodeProgram(source: string): Promise<string | null> {
      return runDarwinTool(process.execPath, ['-e', source]);
    }

    it('resolves the output of a tool that exits cleanly', async () => {
      expect(await runNodeProgram("process.stdout.write('listed')")).toBe('listed');
    });

    it('resolves null for a tool that wrote output and then exited with an error: a failed run is no answer', async () => {
      expect(await runNodeProgram("process.stdout.write('partial listing', () => process.exit(1))")).toBeNull();
    });

    it('resolves null, not an empty string, for a tool that exited with an error and no output', async () => {
      expect(await runNodeProgram('process.exit(1)')).toBeNull();
    });

    it('resolves null for a tool that cannot start', async () => {
      // Under os.tmpdir() and never created.
      const missingTool = path.join(os.tmpdir(), 'kangentic-missing-tool-that-does-not-exist');
      expect(await runDarwinTool(missingTool, [])).toBeNull();
    });

    it('resolves null soon after a short timeout for a tool that outlives it, long before the tool would have exited', async () => {
      const startedAt = Date.now();
      // The tool would run for 10 s. Run to completion it would exit cleanly and resolve '', not null.
      const output = await runDarwinTool(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 300);
      expect(output).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it('kills the tool it gave up on, so a timed-out run leaves nothing running', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-runtool-'));
      temporaryRoots.push(directory);
      const pidFile = path.join(directory, 'tool.pid');
      // The tool records its own pid as its first statement, then would run for 20 s.
      const source = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 20000)";
      // A real timer, captured before the fake clock replaces the global one.
      const realSetTimeout = globalThis.setTimeout;
      const pause = (milliseconds: number) => new Promise<void>((resolve) => { realSetTimeout(resolve, milliseconds); });
      const isRunning = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      };
      let toolPid = 0;
      // Only the tool's timeout is on the fake clock, so the run cannot give up before the tool has started: the
      // test fires the timeout itself, once the tool has written its pid. A real short timeout would race its startup.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const run = runDarwinTool(process.execPath, ['-e', source, pidFile], 60_000);
        const pidDeadline = Date.now() + 15_000;
        while (toolPid === 0 && Date.now() < pidDeadline) {
          await pause(25);
          toolPid = fs.existsSync(pidFile) ? Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10) || 0 : 0;
        }
        // Positive control: the tool is up and running before the timeout fires.
        expect(toolPid).toBeGreaterThan(0);
        expect(isRunning(toolPid)).toBe(true);

        vi.advanceTimersByTime(60_000);
        expect(await run).toBeNull();

        const deathDeadline = Date.now() + 5000;
        while (isRunning(toolPid) && Date.now() < deathDeadline) await pause(25);
        expect(isRunning(toolPid)).toBe(false);
      } finally {
        vi.useRealTimers();
        // Never leave the tool running when an assertion above failed.
        if (toolPid > 0 && isRunning(toolPid)) {
          try { process.kill(toolPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }, 30_000);
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

describe('macOS reader: TCP connections from libproc socket info', () => {
  /**
   * A `struct socket_fdinfo` laid out from XNU's `proc_info.h`: a 24-byte
   * `proc_fileinfo`, `socket_info` with `soi_kind` 232 bytes in and
   * `soi_proto` at 240, whose `tcp_sockinfo` holds `in_sockinfo`
   * (`insi_fport` 0, `insi_lport` 4, `insi_vflag` 24, `insi_faddr` 32,
   * `insi_laddr` 48) and then `tcpsi_state` at 80. 792 bytes in all.
   */
  function socketFdInfo(options: { kind?: number; ipv4: boolean; local: number[]; localPort: number; remote: number[]; remotePort: number; state: number }): Buffer {
    const record = Buffer.alloc(792);
    const proto = 24 + 240;
    record.writeInt32LE(options.kind ?? 2, 24 + 232);
    record.writeUInt16BE(options.remotePort, proto);
    record.writeUInt16BE(options.localPort, proto + 4);
    record[proto + 24] = options.ipv4 ? 0x1 : 0x2;
    // An IPv4 address sits in the last four bytes of its 16-byte `in4in6_addr`.
    Buffer.from(options.remote).copy(record, proto + 32 + (options.ipv4 ? 12 : 0));
    Buffer.from(options.local).copy(record, proto + 48 + (options.ipv4 ? 12 : 0));
    record.writeInt32LE(options.state, proto + 80);
    return record;
  }

  const loopback6 = [...new Array<number>(15).fill(0), 1];

  it('parses a TCP socket\'s state, ports and addresses for both families, and nothing else', () => {
    expect(parseSocketFdInfo(socketFdInfo({ ipv4: true, local: [127, 0, 0, 1], localPort: 5037, remote: [0, 0, 0, 0], remotePort: 0, state: 1 }), 2001))
      .toEqual({ state: 'listen', localAddress: '127.0.0.1', localPort: 5037, remoteAddress: '0.0.0.0', remotePort: 0, ownerPids: [2001] });
    expect(parseSocketFdInfo(socketFdInfo({ ipv4: false, local: loopback6, localPort: 52000, remote: loopback6, remotePort: 5037, state: 4 }), 3001))
      .toEqual({ state: 'established', localAddress: '0:0:0:0:0:0:0:1', localPort: 52000, remoteAddress: '0:0:0:0:0:0:0:1', remotePort: 5037, ownerPids: [3001] });
    // A Unix-domain socket (`SOCKINFO_UN`, 3) is no TCP row; a short record is none either.
    expect(parseSocketFdInfo(socketFdInfo({ kind: 3, ipv4: true, local: [0, 0, 0, 0], localPort: 0, remote: [0, 0, 0, 0], remotePort: 0, state: 0 }), 1)).toBeNull();
    expect(parseSocketFdInfo(Buffer.alloc(300), 1)).toBeNull();
  });

  it('reads every state but LISTEN and ESTABLISHED as no connection: a socket winding down is no evidence', () => {
    // XNU's TSI_S_* values: CLOSED 0, SYN_SENT 2, SYN_RECEIVED 3, CLOSE_WAIT 5,
    // FIN_WAIT_1 6, CLOSING 7, LAST_ACK 8, FIN_WAIT_2 9, TIME_WAIT 10.
    for (const state of [0, 2, 3, 5, 6, 7, 8, 9, 10]) {
      const row = parseSocketFdInfo(socketFdInfo({ ipv4: true, local: [127, 0, 0, 1], localPort: 5037, remote: [127, 0, 0, 1], remotePort: 52000, state }), 2001);
      expect(row?.state, `TSI_S state ${state}`).toBe('other');
    }
  });

  function socketRow(state: SocketRow['state'], localPort: number, remotePort: number, pid: number): SocketRow {
    return { state, localAddress: '127.0.0.1', localPort, remoteAddress: state === 'listen' ? '0.0.0.0' : '127.0.0.1', remotePort, ownerPids: [pid] };
  }

  function kernelWithSockets(sockets: Map<number, SocketRow[]>, socketReads: number[], fault?: Error): DarwinKernel {
    return {
      listPids: () => [],
      processRow: () => null,
      workingDirectory: () => null,
      procArgs: () => null,
      tcpSockets: (pid) => {
        socketReads.push(pid);
        if (fault) throw fault;
        return sockets.get(pid) ?? null;
      },
    };
  }

  const asProcess = (pid: number, startKey = `${pid}.000000`): ScannedProcess => ({ pid, ppid: 1, startKey, startedAtMs: null, tagValue: TASK });

  it('reads clients only until every connection has its peer, never another user\'s process, and pairs them', async () => {
    const sockets = new Map<number, SocketRow[]>([
      [2001, [socketRow('listen', 5037, 0, 2001), socketRow('established', 5037, 52000, 2001)]],
      [3001, [socketRow('established', 52000, 5037, 3001)]],
      [3002, [socketRow('established', 52500, 443, 3002)]],
    ]);
    const socketReads: number[] = [];
    const reader = new DarwinTaggedProcessReader({ loadKernel: async () => kernelWithSockets(sockets, socketReads) });
    const read = await reader.connections([asProcess(2001), asProcess(4001, '')], [asProcess(3001), asProcess(3002)]);
    expect(read).toEqual({ pairs: [{ listenerPid: 2001, clientPid: 3001 }], listeningPids: [2001] });
    // 4001 is another user's process (no start key) and is never read, and
    // 3002 is not read once 3001's socket was the last peer missing.
    expect(socketReads).toEqual([2001, 3001]);
  });

  it('keeps reading clients, past one with no peer to find, until the last connection has its peer, and no further', async () => {
    const sockets = new Map<number, SocketRow[]>([
      // 2001 accepted two connections, from 52000 and from 52001.
      [2001, [socketRow('listen', 5037, 0, 2001), socketRow('established', 5037, 52000, 2001), socketRow('established', 5037, 52001, 2001)]],
      [3001, [socketRow('established', 52000, 5037, 3001)]],
      // Connected elsewhere: its read finds neither peer.
      [3002, [socketRow('established', 52500, 443, 3002)]],
      [3003, [socketRow('established', 52001, 5037, 3003)]],
      [3004, [socketRow('established', 52600, 443, 3004)]],
    ]);
    const socketReads: number[] = [];
    const reader = new DarwinTaggedProcessReader({ loadKernel: async () => kernelWithSockets(sockets, socketReads) });
    const read = await reader.connections([asProcess(2001)], [asProcess(3001), asProcess(3002), asProcess(3003), asProcess(3004)]);
    expect(read.pairs).toEqual([{ listenerPid: 2001, clientPid: 3001 }, { listenerPid: 2001, clientPid: 3003 }]);
    // 3001 holds the first peer, but the second is still missing, so 3002 and 3003 are read; 3004 never is.
    expect(socketReads).toEqual([2001, 3001, 3002, 3003]);
  });

  it('reads no client when no listener has a connection', async () => {
    const socketReads: number[] = [];
    const reader = new DarwinTaggedProcessReader({ loadKernel: async () => kernelWithSockets(new Map([[2001, [socketRow('listen', 5037, 0, 2001)]]]), socketReads) });
    expect(await reader.connections([asProcess(2001)], [asProcess(3001)])).toEqual({ pairs: [], listeningPids: [2001] });
    expect(socketReads).toEqual([2001]);
  });

  it('fails as connection_list when libproc\'s call throws', async () => {
    const reader = new DarwinTaggedProcessReader({ loadKernel: async () => kernelWithSockets(new Map(), [], new Error('symbol not found')) });
    await expect(reader.connections([asProcess(2001)], [])).rejects.toMatchObject({ code: 'connection_list', message: 'symbol not found' });
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

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))('local TCP connections (real)', () => {
  function platformReader(): TaggedProcessReader {
    if (process.platform === 'win32') return new Win32TaggedProcessReader();
    if (process.platform === 'darwin') return new DarwinTaggedProcessReader();
    return new LinuxTaggedProcessReader();
  }

  /** A node child running `script`, and its first line of output. */
  function startNode(script: string, children: ChildProcess[]): Promise<{ pid: number; line: string }> {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`no output from: ${script}`)), 10000);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        resolve({ pid: child.pid!, line: output.slice(0, newline).trim() });
      });
      child.on('error', reject);
    });
  }

  const listenerScript = (host: string | null) => `const server = require('net').createServer(() => {}); server.listen(0${host ? `, '${host}'` : ''}, () => console.log(server.address().port)); setInterval(() => {}, 1000);`;
  const clientScript = (port: string, host: string) => `require('net').connect(${port}, '${host}', () => console.log('connected')); setInterval(() => {}, 1000);`;
  const sortPairs = (pairs: LocalConnection[]) => [...pairs].sort((left, right) => left.listenerPid - right.listenerPid || left.clientPid - right.clientPid);

  function hasCommand(command: string): boolean {
    try {
      execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  // `netstat` and `lsof` ship with Windows and macOS; `ss` comes with iproute2,
  // which a minimal Linux image can lack. Without it only the cross-check skips.
  const hasConnectionTool = process.platform !== 'linux' || hasCommand('ss');

  // task-reap-real-processes.yml sets this flag, so a cross-check that would
  // skip there fails the job instead of reading as a pass.
  it.runIf(process.env.KANGENTIC_REAP_REQUIRE_ALL_CASES === '1')('has the OS tool the cross-check reads', () => {
    expect(hasConnectionTool, 'ss is not installed, so the cross-check against it skipped').toBe(true);
  });

  /** The OS tool's own view: whether `clientPid` holds an established connection to `port`. */
  function toolSeesConnection(clientPid: number, port: string): boolean {
    if (process.platform === 'win32') {
      return execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split('\n')
        .some((line) => /ESTABLISHED/.test(line) && line.trim().split(/\s+/)[2]?.endsWith(`:${port}`) && line.trim().endsWith(` ${clientPid}`));
    }
    if (process.platform === 'darwin') {
      return execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED', '-Fn', '-p', String(clientPid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
        .split('\n').some((line) => line.startsWith('n') && line.endsWith(`:${port}`));
    }
    return execFileSync('ss', ['-tnpH', 'state', 'established'], { encoding: 'utf8' }).split('\n')
      .some((line) => line.includes(`:${port} `) && line.includes(`pid=${clientPid},`));
  }

  it('pairs each client with the listener it is connected to, a dual-stack one included, and nothing with an idle one, as the OS tool sees it', async () => {
    const children: ChildProcess[] = [];
    try {
      const dualStack = await startNode(listenerScript(null), children);
      const ipv4Only = await startNode(listenerScript('127.0.0.1'), children);
      const idle = await startNode(listenerScript('127.0.0.1'), children);
      // An explicit IPv4 client of a default listener, which binds `::` dual-stack.
      const dualStackClient = await startNode(clientScript(dualStack.line, '127.0.0.1'), children);
      const ipv4Client = await startNode(clientScript(ipv4Only.line, '127.0.0.1'), children);
      if (hasConnectionTool) {
        expect(toolSeesConnection(dualStackClient.pid, dualStack.line)).toBe(true);
        expect(toolSeesConnection(ipv4Client.pid, ipv4Only.line)).toBe(true);
      }

      const reader = platformReader();
      const scan = await reader.scan();
      const pick = (pid: number): ScannedProcess => {
        const scanned = scan.processes.find((entry) => entry.pid === pid);
        expect(scanned, `pid ${pid} in the scan`).toBeDefined();
        return scanned!;
      };
      const listeners = [dualStack, ipv4Only, idle].map((started) => pick(started.pid));
      const clients = [dualStackClient, ipv4Client].map((started) => pick(started.pid));
      const startedAt = performance.now();
      const read = await reader.connections!(listeners, clients);
      // The measurement the reap's cost note records; printed, never asserted.
      console.log(`[reap-connections] ${process.platform} connections() over ${listeners.length} listeners and ${clients.length} clients: ${(performance.now() - startedAt).toFixed(1)} ms`);
      expect(sortPairs(read.pairs)).toEqual(sortPairs([
        { listenerPid: dualStack.pid, clientPid: dualStackClient.pid },
        { listenerPid: ipv4Only.pid, clientPid: ipv4Client.pid },
      ]));
      expect([...read.listeningPids].sort((left, right) => left - right)).toEqual([dualStack.pid, ipv4Only.pid, idle.pid].sort((left, right) => left - right));
      // A client the caller did not name is never paired.
      expect((await reader.connections!(listeners, [clients[0]])).pairs).toEqual([{ listenerPid: dualStack.pid, clientPid: dualStackClient.pid }]);
      // An idle listener alone has no pair, and still reads as listening.
      expect(await reader.connections!([pick(idle.pid)], clients)).toEqual({ pairs: [], listeningPids: [idle.pid] });
      // A client is no listener: asked about as one, it listens on nothing.
      expect(await reader.connections!([clients[0]], clients)).toEqual({ pairs: [], listeningPids: [] });
    } finally {
      for (const child of children) child.kill('SIGKILL');
    }
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
