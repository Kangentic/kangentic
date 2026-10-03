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
 * (`visible-app`), and the executable for a tmux server (`multiplexer`).
 * `describe` reads `cmdline` and `exe` for the few processes a reap reports and
 * returns only the label `process-label.ts` derives.
 *
 * Reads are async and batched, so a scan never holds the pty host's event loop,
 * which carries every terminal byte.
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { TASK_PROCESS_TAG_ENV } from './task-process-tag';
import { isFileFrom, labelProcess } from './process-label';
import type { KillStrength, ProcessScan, ScannedProcess, TaggedProcessReader } from './process-scan';

const READ_BATCH_SIZE = 64;
const TAG_PREFIX = Buffer.from(`${TASK_PROCESS_TAG_ENV}=`);
/** Libraries a process maps when it draws a window (X11, Wayland, GTK, Qt). */
const GUI_LIBRARY_PATTERN = /\/lib(?:X11\.so|xcb\.so|wayland-client\.so|gtk-[34]|Qt[56]Gui)/;
const DELETED_SUFFIX = ' (deleted)';

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

export interface LinuxReaderOptions {
  /** `/proc`, or a fixture directory in tests. */
  procRoot?: string;
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
  /** The caller's uid. Defaults to `process.getuid()`. */
  uid?: number;
}

export class LinuxTaggedProcessReader implements TaggedProcessReader {
  private readonly procRoot: string;
  private readonly sendSignal: (pid: number, signalName: NodeJS.Signals) => void;
  private readonly ownUid: number | null;

  constructor(options: LinuxReaderOptions = {}) {
    this.procRoot = options.procRoot ?? '/proc';
    this.sendSignal = options.signal ?? ((pid, signalName) => process.kill(pid, signalName));
    this.ownUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
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
          executablePath: executablePath?.endsWith(DELETED_SUFFIX) ? executablePath.slice(0, -DELETED_SUFFIX.length) : executablePath,
          argv,
          isFile: (candidate) => isFileFrom(workingDirectory, candidate),
        }));
      } catch { /* not ours, or gone */ }
    }));
    return labels;
  }

  private procPath(pid: number, entry: string): string {
    return path.join(this.procRoot, String(pid), entry);
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
      workingDirectory = await fsPromises.readlink(this.procPath(pid, 'cwd'));
      // A directory removed while the process sits in it reads with this
      // suffix; the path before it is still where the process was working.
      if (workingDirectory.endsWith(DELETED_SUFFIX)) workingDirectory = workingDirectory.slice(0, -DELETED_SUFFIX.length);
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
    const children = new Map<number, ScannedProcess[]>();
    for (const scanned of processes) {
      const bucket = children.get(scanned.ppid);
      if (bucket) bucket.push(scanned);
      else children.set(scanned.ppid, [scanned]);
    }
    const relevant = new Set<ScannedProcess>();
    const queue = processes.filter((scanned) => scanned.tagValue !== null && scanned.tagValue !== '');
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (relevant.has(next)) continue;
      relevant.add(next);
      for (const child of children.get(next.pid) ?? []) if (child.pid !== next.pid) queue.push(child);
    }
    const list = [...relevant];
    for (let offset = 0; offset < list.length; offset += READ_BATCH_SIZE) {
      await Promise.all(list.slice(offset, offset + READ_BATCH_SIZE).map(async (scanned) => {
        try {
          if (path.basename(await fsPromises.readlink(this.procPath(scanned.pid, 'exe'))) === 'tmux') {
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
