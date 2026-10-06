/**
 * Linux reader: `/proc/<pid>/stat` for the parent and start time,
 * `/proc/<pid>/environ` for the tag, `/proc/<pid>/cwd` for the working
 * directory. No process is spawned.
 *
 * `environ` is the environment the process was exec'd with, which is what its
 * children inherited, and the kernel lets a same-user reader open it (a
 * `PTRACE_MODE_READ` check, which Yama's `ptrace_scope` does not gate). A
 * non-dumpable process (setuid, or one that called `prctl(PR_SET_DUMPABLE, 0)`,
 * as `ssh-agent` does) refuses the read; when `status` says it is the caller's
 * own, it is counted as unreadable and left alone. Another user's process is
 * not counted. A zombie is skipped: it has already exited.
 *
 * The roles (`process-scan.ts`) are read only for tagged processes and their
 * descendants, the only ones a reap could touch: `maps` for a GUI toolkit
 * (`visible-app`), and the executable for a tmux server (`multiplexer`). Not
 * for their ancestors, on purpose: a desktop shell or a terminal emulator maps
 * a GUI toolkit, and reading one as a window would protect everything under
 * it. An app or tmux server the agent started carries the tag and is read.
 * `describe` reads `cmdline` and `exe` for the few processes a reap reports and
 * returns only the label `process-label.ts` derives.
 *
 * Reads are async and batched, so a scan never holds the pty host's event loop,
 * which carries every terminal byte.
 *
 * `connections` reads `net/tcp` and `net/tcp6` (the table for this network
 * namespace, with each socket's inode) and maps inodes to processes through
 * their `fd` links (`socket:[inode]`), which a same-user reader can read. It
 * reads the listeners' links first and stops when none of them has a
 * connected local peer; it reads clients' links only until every peer has an
 * owner. The pairing is `local-connections.ts`; no address or port leaves
 * this file.
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TASK_PROCESS_TAG_ENV } from './task-process-tag';
import { isFileFrom, labelProcess } from './process-label';
import { connectionsToListeners, ipv4FromBytes, ipv6FromBytes, listeningPidsOf, pairLocalConnections, type SocketRow } from './local-connections';
import {
  ScanStepError,
  seedsAndDescendants,
  type KillStrength,
  type LocalConnectionRead,
  type ProcessScan,
  type ScannedProcess,
  type TaggedProcessReader,
} from './process-scan';

const READ_BATCH_SIZE = 64;
/** Processes whose fd links are read at once. A browser can hold hundreds of links. */
const FD_BATCH_SIZE = 16;
const SOCKET_LINK_PATTERN = /^socket:\[(\d+)\]$/;
const TCP_STATE_ESTABLISHED = '01';
const TCP_STATE_LISTEN = '0A';
const TAG_PREFIX = Buffer.from(`${TASK_PROCESS_TAG_ENV}=`);
/** Libraries a process maps when it draws a window (X11, Wayland, GTK, Qt). */
const GUI_LIBRARY_PATTERN = /\/lib(?:X11\.so|xcb\.so|wayland-client\.so|gtk-[34]|Qt[56]Gui)/;
const DELETED_SUFFIX = ' (deleted)';

/**
 * A `/proc` link target without the mark the kernel adds when its file was
 * removed or replaced (a package upgrade swaps a running binary's file). The
 * path before the mark is still the one the process runs or works in.
 */
function withoutDeletedSuffix(linkTarget: string): string {
  return linkTarget.endsWith(DELETED_SUFFIX) ? linkTarget.slice(0, -DELETED_SUFFIX.length) : linkTarget;
}

/**
 * The tag's value inside a NUL-separated environment block, or null. Only the
 * value is ever copied out of the buffer.
 */
export function findTagInEnviron(environ: Buffer): string | null {
  let entryStart = 0;
  while (entryStart < environ.length) {
    let entryEnd = environ.indexOf(0, entryStart);
    if (entryEnd < 0) entryEnd = environ.length;
    if (
      entryEnd - entryStart >= TAG_PREFIX.length
      && environ.compare(TAG_PREFIX, 0, TAG_PREFIX.length, entryStart, entryStart + TAG_PREFIX.length) === 0
    ) {
      return environ.toString('utf8', entryStart + TAG_PREFIX.length, entryEnd);
    }
    entryStart = entryEnd + 1;
  }
  return null;
}

/**
 * Parse the state, ppid and starttime out of `/proc/<pid>/stat`. The command
 * name (field 2) is in parentheses and may itself contain spaces and `)`, so
 * the fixed fields are read after the LAST `)`.
 */
export function parseProcStat(stat: string): { state: string; ppid: number; startTicks: string } | null {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  // Fields from 3 (state) on. ppid is field 4, starttime field 22.
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? '', 10);
  const startTicks = fields[19];
  if (!Number.isInteger(ppid) || !startTicks || !/^\d+$/.test(startTicks)) return null;
  return { state: fields[0] ?? '', ppid, startTicks };
}

/**
 * An address as `net/tcp` and `net/tcp6` print it: hex 32-bit words, each in
 * the kernel's byte order, one word for IPv4 and four for IPv6. Exported for
 * fixture tests.
 */
export function addressFromProcHex(hex: string, littleEndian: boolean): string | null {
  if (hex.length !== 8 && hex.length !== 32) return null;
  const bytes = Buffer.alloc(hex.length / 2);
  for (let word = 0; word < hex.length / 8; word += 1) {
    const value = Number.parseInt(hex.slice(word * 8, word * 8 + 8), 16);
    if (!Number.isFinite(value)) return null;
    if (littleEndian) bytes.writeUInt32LE(value, word * 4);
    else bytes.writeUInt32BE(value, word * 4);
  }
  return hex.length === 8 ? ipv4FromBytes(bytes) : ipv6FromBytes(bytes);
}

/** The rows of a `net/tcp` or `net/tcp6` file, owners not yet known. Exported for fixture tests. */
export function parseProcNetTcp(text: string, littleEndian: boolean): SocketRow[] {
  const rows: SocketRow[] = [];
  // The first line is the header.
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [localHex, localPortHex] = fields[1].split(':');
    const [remoteHex, remotePortHex] = fields[2].split(':');
    const localAddress = addressFromProcHex(localHex ?? '', littleEndian);
    const remoteAddress = addressFromProcHex(remoteHex ?? '', littleEndian);
    const localPort = Number.parseInt(localPortHex ?? '', 16);
    const remotePort = Number.parseInt(remotePortHex ?? '', 16);
    if (localAddress === null || remoteAddress === null || !Number.isInteger(localPort) || !Number.isInteger(remotePort)) continue;
    const state = fields[3].toUpperCase();
    rows.push({
      state: state === TCP_STATE_LISTEN ? 'listen' : state === TCP_STATE_ESTABLISHED ? 'established' : 'other',
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      ownerPids: [],
      inode: fields[9],
    });
  }
  return rows;
}

export interface LinuxReaderOptions {
  /** `/proc`, or a fixture directory in tests. */
  procRoot?: string;
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
  /** The caller's uid. Defaults to `process.getuid()`. */
  uid?: number;
  /** The byte order `net/tcp` prints addresses in. Defaults to this machine's. */
  littleEndian?: boolean;
}

export class LinuxTaggedProcessReader implements TaggedProcessReader {
  private readonly procRoot: string;
  private readonly sendSignal: (pid: number, signalName: NodeJS.Signals) => void;
  private readonly ownUid: number | null;
  private readonly littleEndian: boolean;

  constructor(options: LinuxReaderOptions = {}) {
    this.procRoot = options.procRoot ?? '/proc';
    this.sendSignal = options.signal ?? ((pid, signalName) => process.kill(pid, signalName));
    this.ownUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
    this.littleEndian = options.littleEndian ?? os.endianness() === 'LE';
  }

  async scan(): Promise<ProcessScan> {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.procRoot);
    } catch {
      return { processes: [], unreadableCount: 0 };
    }
    const pids = entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => Number(entry));
    const processes: ScannedProcess[] = [];
    let unreadableCount = 0;
    for (let offset = 0; offset < pids.length; offset += READ_BATCH_SIZE) {
      const batch = pids.slice(offset, offset + READ_BATCH_SIZE);
      const results = await Promise.all(batch.map((pid) => this.readOne(pid)));
      for (const result of results) {
        if (result === null) continue;
        if (result.unreadable) unreadableCount += 1;
        processes.push(result.process);
      }
    }
    await this.readRoles(processes);
    return { processes, unreadableCount };
  }

  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    // The scan that chose this target ran moments ago, and Linux allocates
    // pids sequentially, so the identity check is the start time re-read here.
    const current = await this.readStat(target.pid);
    if (!current || current.startTicks !== target.startKey) return false;
    try {
      this.sendSignal(target.pid, strength === 'force' ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    const labels = new Map<number, string>();
    await Promise.all(targets.map(async (target) => {
      try {
        const current = await this.readStat(target.pid);
        if (!current || current.startTicks !== target.startKey) return;
        const commandLine = await fsPromises.readFile(this.procPath(target.pid, 'cmdline'));
        const argv = commandLine.toString('utf8').split('\0');
        if (argv.length > 0 && argv[argv.length - 1] === '') argv.pop();
        const executablePath = await fsPromises.readlink(this.procPath(target.pid, 'exe')).catch(() => null);
        const workingDirectory = target.workingDirectory ?? null;
        labels.set(target.pid, await labelProcess({
          executablePath: executablePath === null ? null : withoutDeletedSuffix(executablePath),
          argv,
          isFile: (candidate) => isFileFrom(workingDirectory, candidate),
        }));
      } catch { /* not ours, or gone */ }
    }));
    return labels;
  }

  async connections(listeners: readonly ScannedProcess[], clients: readonly ScannedProcess[]): Promise<LocalConnectionRead> {
    let rows: SocketRow[];
    try {
      rows = [...await this.readTcpTable('tcp', true), ...await this.readTcpTable('tcp6', false)];
    } catch (error) {
      throw new ScanStepError('connection_list', error instanceof Error ? error.message : String(error));
    }
    const listenerPids = new Set(listeners.map((scanned) => scanned.pid));
    const clientPids = new Set(clients.map((scanned) => scanned.pid));
    const ownersByInode = new Map<string, Set<number>>();
    const walked = new Set<number>();
    const withOwners = (): SocketRow[] => rows.map((row) => ({ ...row, ownerPids: [...(row.inode ? ownersByInode.get(row.inode) ?? [] : [])] }));

    await this.readSocketLinks([...listenerPids], ownersByInode, walked);
    let current = withOwners();
    const listeningPids = listeningPidsOf(current, listenerPids);
    const found = connectionsToListeners(current, listenerPids);
    if (found.length === 0) return { pairs: [], listeningPids };
    // Peers whose owner is not yet known: their inodes are what the clients' links must name.
    const unowned = new Set(found.flatMap(({ peer }) => (peer && peer.ownerPids.length === 0 && peer.inode ? [peer.inode] : [])));
    const remaining = [...clientPids].filter((pid) => !walked.has(pid));
    for (let offset = 0; unowned.size > 0 && offset < remaining.length; offset += FD_BATCH_SIZE) {
      await this.readSocketLinks(remaining.slice(offset, offset + FD_BATCH_SIZE), ownersByInode, walked);
      for (const inode of [...unowned]) if (ownersByInode.has(inode)) unowned.delete(inode);
    }
    current = withOwners();
    return { pairs: pairLocalConnections(current, listenerPids, clientPids), listeningPids };
  }

  private procPath(pid: number, entry: string): string {
    return path.join(this.procRoot, String(pid), entry);
  }

  /** `net/tcp` or `net/tcp6`. A missing `tcp6` is a kernel without IPv6, not a failure. */
  private async readTcpTable(name: 'tcp' | 'tcp6', required: boolean): Promise<SocketRow[]> {
    try {
      return parseProcNetTcp(await fsPromises.readFile(path.join(this.procRoot, 'net', name), 'utf8'), this.littleEndian);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Add each pid's socket inodes to `ownersByInode`, a few processes at a time. */
  private async readSocketLinks(pids: readonly number[], ownersByInode: Map<string, Set<number>>, walked: Set<number>): Promise<void> {
    for (let offset = 0; offset < pids.length; offset += FD_BATCH_SIZE) {
      await Promise.all(pids.slice(offset, offset + FD_BATCH_SIZE).map(async (pid) => {
        if (walked.has(pid)) return;
        walked.add(pid);
        const fdDirectory = this.procPath(pid, 'fd');
        let entries: string[];
        try {
          entries = await fsPromises.readdir(fdDirectory);
        } catch {
          return; // not ours, or gone
        }
        await Promise.all(entries.map(async (entry) => {
          try {
            const match = SOCKET_LINK_PATTERN.exec(await fsPromises.readlink(path.join(fdDirectory, entry)));
            if (!match) return;
            let owners = ownersByInode.get(match[1]);
            if (!owners) {
              owners = new Set();
              ownersByInode.set(match[1], owners);
            }
            owners.add(pid);
          } catch { /* closed mid-read */ }
        }));
      }));
    }
  }

  private async readStat(pid: number): Promise<{ state: string; ppid: number; startTicks: string } | null> {
    try {
      return parseProcStat(await fsPromises.readFile(this.procPath(pid, 'stat'), 'utf8'));
    } catch {
      return null;
    }
  }

  private async readOne(pid: number): Promise<{ process: ScannedProcess; unreadable: boolean } | null> {
    const stat = await this.readStat(pid);
    // Gone between the readdir and the read, or already exited: nothing to report.
    if (!stat || stat.state === 'Z' || stat.state === 'X') return null;
    let tagValue: string | null = null;
    let unreadable = false;
    let environmentUnreadable = false;
    try {
      tagValue = findTagInEnviron(await fsPromises.readFile(this.procPath(pid, 'environ')));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      environmentUnreadable = true;
      // ENOENT and ESRCH mean it exited mid-scan. Anything else is a refusal.
      if (code !== 'ENOENT' && code !== 'ESRCH') unreadable = await this.isOwnProcess(pid);
    }
    let workingDirectory: string | null = null;
    try {
      // A directory removed while the process sits in it reads with the
      // deleted mark; the path before it is still where the process was working.
      workingDirectory = withoutDeletedSuffix(await fsPromises.readlink(this.procPath(pid, 'cwd')));
    } catch { /* not ours, or gone */ }
    return {
      process: {
        pid,
        ppid: stat.ppid,
        startKey: stat.startTicks,
        startedAtMs: null,
        tagValue,
        workingDirectory,
        ...(environmentUnreadable ? { environmentUnreadable: true } : {}),
      },
      unreadable,
    };
  }

  /** Roles for tagged processes and their descendants only (see the module comment). */
  private async readRoles(processes: ScannedProcess[]): Promise<void> {
    const relevant = seedsAndDescendants(processes, (scanned) => scanned.tagValue !== null && scanned.tagValue !== '');
    const list = [...relevant];
    for (let offset = 0; offset < list.length; offset += READ_BATCH_SIZE) {
      await Promise.all(list.slice(offset, offset + READ_BATCH_SIZE).map(async (scanned) => {
        try {
          // A tmux server outlives the upgrade that replaced its binary.
          if (path.basename(withoutDeletedSuffix(await fsPromises.readlink(this.procPath(scanned.pid, 'exe')))) === 'tmux') {
            scanned.role = 'multiplexer';
            return;
          }
        } catch { /* not ours, or gone */ }
        try {
          if (GUI_LIBRARY_PATTERN.test(await fsPromises.readFile(this.procPath(scanned.pid, 'maps'), 'utf8'))) {
            scanned.role = 'visible-app';
          }
        } catch { /* not ours, or gone */ }
      }));
    }
  }

  /** Whether `status`'s real uid is the caller's. Readable for any process. */
  private async isOwnProcess(pid: number): Promise<boolean> {
    if (this.ownUid === null) return true;
    try {
      const status = await fsPromises.readFile(this.procPath(pid, 'status'), 'utf8');
      const match = /^Uid:\s+(\d+)/m.exec(status);
      return match !== null && Number(match[1]) === this.ownUid;
    } catch {
      return false;
    }
  }
}
