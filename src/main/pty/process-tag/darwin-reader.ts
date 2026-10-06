/**
 * macOS reader. Everything but the visible-app check comes straight from the
 * kernel through koffi (libproc and `sysctl` in libSystem); before, every scan
 * spawned `ps`, a reap with anything to look at spawned `lsof`, and every kill
 * spawned `ps` again for its identity check.
 *
 * - `proc_listallpids` lists the processes, and `proc_pidinfo` with
 *   `PROC_PIDTBSDINFO` gives each one's parent, uid and start time, to the
 *   microsecond (the kill's identity check). XNU answers that flavor only for
 *   the caller's own processes, so another user's process is listed through
 *   `PROC_PIDT_SHORTBSDINFO`, which carries the parent and uid but no start
 *   time: it stays in the table with an unknown start key, which the kill
 *   refuses, as the Windows reader does for another session's process.
 * - The tag comes from each same-user process's `KERN_PROCARGS2` record,
 *   searched for an exact `KANGENTIC_TASK_ID=` entry. Not `ps -E`: a process
 *   that sets its title (npm, Next's `next-server`, pm2) rewrites its argument
 *   area, `ps` stops reading at the first double NUL, and the environment
 *   vanishes from its output while the kernel record still holds it intact
 *   (measured on macOS 15 and 26).
 * - XNU's `sysctl_procargsx` leaves the environment out of that record when
 *   the target is `CS_RESTRICT` and System Integrity Protection is on, unless
 *   the caller holds an Apple-private entitlement. Apple's own `/bin` and
 *   `/usr/bin` tools are `CS_RESTRICT`; Node, Python and anything a developer
 *   builds are not. A record with nothing after its arguments is flagged
 *   `environmentWithheld` and counted as unreadable, never passed as clean.
 * - For tagged and withheld processes and their descendants only: the working
 *   directory from `proc_pidinfo` with `PROC_PIDVNODEPATHINFO`, the call
 *   `lsof -d cwd` makes (XNU gates it on the uid alone, with no code-signing or
 *   SIP check), and the role (`process-scan.ts`): a tmux server by its
 *   executable, a visible app by LaunchServices (`lsappinfo list`, Foreground
 *   or UIElement, the one tool still spawned, once per scan and only when such
 *   a process exists) or by being the main executable of an app in an
 *   Applications folder (`lsappinfo` can miss an app still starting). Not "any
 *   app bundle": `/usr/bin/python3` runs from inside `Python.app`.
 *
 * The struct offsets below are XNU's (`bsd/sys/proc_info.h`), unchanged since
 * macOS 10.5. `tests/unit/task-process-readers.test.ts` checks them against
 * `ps` and `lsof` on real processes on every macOS runner the reap workflow
 * covers, so a wrong one fails there rather than reaping wrongly.
 *
 * Privacy: a `KERN_PROCARGS2` record is another application's environment. It
 * is searched in place, and only the tag value, a string count, and the
 * executable path (for the role, never returned) leave the read. `describe`
 * reads the same record's arguments for the few processes a reap reports and
 * returns only the label `process-label.ts` derives.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { TASK_PROCESS_TAG_ENV } from './task-process-tag';
import { isFileFrom, labelProcess } from './process-label';
import { ScanStepError, seedsAndDescendants, type KillStrength, type ProcessScan, type ScannedProcess, type TaggedProcessReader } from './process-scan';

const TOOL_TIMEOUT_MS = 5000;
const LAUNCHD_PID = 1;
const LSAPPINFO_PATH = '/usr/bin/lsappinfo';
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
/** `kern.argmax` on macOS: the most a `KERN_PROCARGS2` record can hold. */
const PROCARGS_BUFFER_BYTES = 1024 * 1024;
const YIELD_EVERY_PROCESSES = 32;
/** Room for this many pids on the first `proc_listallpids` call; doubled while it fills. */
const INITIAL_PID_CAPACITY = 4096;

/** `proc_pidinfo` flavors and the sizes of the structs they fill. */
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_VNODEPATHINFO_SIZE = 2352;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_BSDSHORTINFO_SIZE = 64;
/** `pvi_cdir.vip_path`: after a 136-byte `vinfo_stat`, `vi_type`, `vi_pad` and an 8-byte `fsid_t`. */
const CURRENT_DIRECTORY_PATH_OFFSET = 152;
const MAXPATHLEN = 1024;

const TAG_PREFIX = `${TASK_PROCESS_TAG_ENV}=`;
/**
 * Keys of the kernel's own "apple" strings, which follow the environment in a
 * `KERN_PROCARGS2` record. Measured on macOS 26: `ptr_munge=` comes first,
 * then `main_stack=`, `executable_file=`, `dyld_file=`, `executable_cdhash=`,
 * `executable_boothash=`, `th_port=`, `security_config=`, and on some images
 * `ptrauth_disabled=`. The rest are other names XNU's `exec_add_apple_strings`
 * uses.
 */
const APPLE_STRING_KEYS = new Set([
  'ptr_munge', 'main_stack', 'executable_file', 'dyld_file', 'executable_cdhash', 'executable_boothash',
  'th_port', 'security_config', 'ptrauth_disabled', 'executable_path', 'stack_guard', 'malloc_entropy',
  'arm64e_abi', 'has_sec_transition', 'dyld_flags', 'subsystem_root_path', 'vm_force_4k_pages', 'pfz',
]);
/** The main executable of an app in an Applications folder. */
const TOP_LEVEL_APP_PATTERN = /^(?:\/System)?(?:\/Users\/[^/]+)?\/Applications\/(?:[^/]+\/)?[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

/** What one `KERN_PROCARGS2` record says, without its contents. */
export interface ProcArgsSummary {
  executablePath: string;
  tagValue: string | null;
  environmentWithheld: boolean;
}

/** One process as the kernel lists it. `startKey` is '' for another user's process. */
export interface DarwinProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  startKey: string;
}

/** The kernel calls the reader makes. */
export interface DarwinKernel {
  /** Every pid. Throws when the kernel refuses the list. */
  listPids(): number[];
  /** The pid's parent, uid and start key, or null when it is gone (or a zombie). */
  processRow(pid: number): DarwinProcessRow | null;
  /** The pid's working directory, or null when it is gone or another user's. */
  workingDirectory(pid: number): string | null;
  /** The pid's `KERN_PROCARGS2` record, a view the next call overwrites, or null. */
  procArgs(pid: number): Buffer | null;
}

/**
 * Read a `KERN_PROCARGS2` record: `[int argc][exec path][NUL padding][argv x
 * argc][env ...][NUL padding][apple strings ...]`. The kernel's own "apple"
 * strings (`APPLE_STRING_KEYS`) are not the environment; `ps` stops before
 * them at the double NUL. When SIP withholds the environment the record ends
 * after the arguments, apple strings and all.
 *
 * The tag is an exact `KANGENTIC_TASK_ID=` string anywhere between the
 * executable path and the apple strings, which survives a process rewriting
 * its argument area for a title (the title, then NULs, then the untouched
 * environment). With no strings there beyond the arguments, the environment
 * was withheld (or is empty, as under `env -i`). Exported for fixture tests.
 */
export function summarizeProcArgs(record: Buffer): ProcArgsSummary | null {
  if (record.length < 4) return null;
  const argc = record.readInt32LE(0);
  const nonEmpty = record.toString('latin1', 4).split('\0').filter((entry) => entry.length > 0);
  if (nonEmpty.length === 0) return null;
  // The first apple string after the arguments. Searching past argv keeps an
  // argument that happens to look like one from ending the environment early.
  let appleStart = nonEmpty.length;
  for (let index = 1 + Math.max(argc, 0); index < nonEmpty.length; index += 1) {
    const equalsAt = nonEmpty[index].indexOf('=');
    if (equalsAt > 0 && APPLE_STRING_KEYS.has(nonEmpty[index].slice(0, equalsAt))) {
      appleStart = index;
      break;
    }
  }
  let tagValue: string | null = null;
  for (let index = 1; index < appleStart; index += 1) {
    if (nonEmpty[index].startsWith(TAG_PREFIX)) {
      tagValue = nonEmpty[index].slice(TAG_PREFIX.length);
      break;
    }
  }
  // Strings between the executable path and the apple strings, past argv. A
  // title that zeroed some arguments makes this an undercount, which errs
  // only for a titled process with almost no environment.
  const environmentStrings = appleStart - 1 - Math.max(argc, 0);
  return {
    executablePath: nonEmpty[0],
    tagValue,
    environmentWithheld: tagValue === null && environmentStrings <= 0,
  };
}

/**
 * The executable path and argument list in a `KERN_PROCARGS2` record, for a
 * label only (`process-label.ts`): `argc` strings after the executable path.
 * A title the process set lands in argv[0], which `labelProcess` checks before
 * it reads any further argument. Exported for fixture tests.
 */
export function argumentsFromProcArgs(record: Buffer): { executablePath: string; argv: string[] } | null {
  if (record.length < 5) return null;
  const argc = Math.max(record.readInt32LE(0), 0);
  let offset = 4;
  const executableEnd = record.indexOf(0, offset);
  const executablePath = record.toString('utf8', offset, executableEnd < 0 ? record.length : executableEnd);
  if (executablePath.length === 0 || executableEnd < 0) return null;
  // The executable path is NUL-padded; argv starts at the next non-NUL byte.
  offset = executableEnd;
  while (offset < record.length && record[offset] === 0) offset += 1;
  // Exactly `argc` strings, empty ones included, so nothing past argv is read.
  const argv: string[] = [];
  for (let index = 0; index < argc && offset < record.length; index += 1) {
    const end = record.indexOf(0, offset);
    const stop = end < 0 ? record.length : end;
    argv.push(record.toString('utf8', offset, stop));
    offset = stop + 1;
  }
  return { executablePath, argv };
}

/**
 * `struct proc_bsdinfo`: `pbi_pid` at 12, `pbi_ppid` 16, `pbi_uid` 20,
 * `pbi_start_tvsec` 120 and `pbi_start_tvusec` 128. Exported for fixture tests.
 */
export function parseBsdInfo(record: Buffer): DarwinProcessRow | null {
  if (record.length < PROC_BSDINFO_SIZE) return null;
  const seconds = record.readBigUInt64LE(120);
  const microseconds = record.readBigUInt64LE(128);
  return {
    pid: record.readUInt32LE(12),
    ppid: record.readUInt32LE(16),
    uid: record.readUInt32LE(20),
    startKey: `${seconds}.${microseconds.toString().padStart(6, '0')}`,
  };
}

/** `struct proc_bsdshortinfo`: `pbsi_pid` at 0, `pbsi_ppid` 4, `pbsi_uid` 36; no start time. Exported for fixture tests. */
export function parseShortBsdInfo(record: Buffer): DarwinProcessRow | null {
  if (record.length < PROC_BSDSHORTINFO_SIZE) return null;
  return { pid: record.readUInt32LE(0), ppid: record.readUInt32LE(4), uid: record.readUInt32LE(36), startKey: '' };
}

/** `struct proc_vnodepathinfo`'s `pvi_cdir.vip_path`, or null when empty. Exported for fixture tests. */
export function parseCurrentDirectory(record: Buffer): string | null {
  if (record.length <= CURRENT_DIRECTORY_PATH_OFFSET) return null;
  const limit = Math.min(record.length, CURRENT_DIRECTORY_PATH_OFFSET + MAXPATHLEN);
  const end = record.indexOf(0, CURRENT_DIRECTORY_PATH_OFFSET);
  const directory = record.toString('utf8', CURRENT_DIRECTORY_PATH_OFFSET, end < 0 || end > limit ? limit : end);
  return directory.length > 0 ? directory : null;
}

/** Pids LaunchServices lists as UI apps (Foreground or UIElement). Exported for fixture tests. */
export function parseLsappinfoUiPids(output: string): Set<number> {
  const pids = new Set<number>();
  for (const match of output.matchAll(/pid = (\d+) type="(Foreground|UIElement)"/g)) pids.add(Number(match[1]));
  return pids;
}

/** Whether a path is the main executable of an app in an Applications folder. Exported for tests. */
export function isTopLevelAppExecutable(executablePath: string): boolean {
  return TOP_LEVEL_APP_PATTERN.test(executablePath);
}

/**
 * Run a tool and resolve its stdout, or null when it cannot start, exits with
 * an error or a signal, or runs past the timeout. Only a clean exit's output
 * is an answer: an empty listing from a failed run would read as "no windows".
 * Exported for tests, which pass a short `timeoutMs`.
 */
export function runTool(command: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', (code, signal) => finish(code === 0 && signal === null ? output : null));
  });
}

let kernelPromise: Promise<DarwinKernel> | null = null;

/** libproc and `sysctl` through koffi, each into one reused buffer. */
async function loadDarwinKernel(): Promise<DarwinKernel> {
  const imported = await import('koffi');
  const koffi: Pick<typeof import('koffi'), 'load'> = imported.default ?? imported;
  const libSystem = koffi.load('/usr/lib/libSystem.B.dylib');
  const sysctl = libSystem.func('int sysctl(int32 *name, uint32 namelen, _Out_ uint8_t *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)');
  const listAllPids = libSystem.func('int proc_listallpids(_Out_ uint8_t *buffer, int buffersize)');
  const pidInfo = libSystem.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buffer, int buffersize)');
  const procArgsBuffer = Buffer.alloc(PROCARGS_BUFFER_BYTES);
  const bsdInfoBuffer = Buffer.alloc(PROC_BSDINFO_SIZE);
  const shortInfoBuffer = Buffer.alloc(PROC_BSDSHORTINFO_SIZE);
  const vnodePathBuffer = Buffer.alloc(PROC_VNODEPATHINFO_SIZE);
  let pidBuffer = Buffer.alloc(INITIAL_PID_CAPACITY * 4);
  return {
    listPids() {
      for (;;) {
        // The count of pids written; a full buffer may have cut the list short.
        const count = listAllPids(pidBuffer, pidBuffer.length);
        if (count < 0) throw new Error('proc_listallpids failed');
        if (count * 4 < pidBuffer.length) {
          const pids: number[] = [];
          for (let index = 0; index < count; index += 1) pids.push(pidBuffer.readInt32LE(index * 4));
          return pids;
        }
        pidBuffer = Buffer.alloc(pidBuffer.length * 2);
      }
    },
    processRow(pid) {
      // `proc_pidinfo` returns the bytes it filled, and 0 when it refuses.
      if (pidInfo(pid, PROC_PIDTBSDINFO, 0, bsdInfoBuffer, PROC_BSDINFO_SIZE) === PROC_BSDINFO_SIZE) return parseBsdInfo(bsdInfoBuffer);
      if (pidInfo(pid, PROC_PIDT_SHORTBSDINFO, 0, shortInfoBuffer, PROC_BSDSHORTINFO_SIZE) === PROC_BSDSHORTINFO_SIZE) return parseShortBsdInfo(shortInfoBuffer);
      return null;
    },
    workingDirectory(pid) {
      if (pidInfo(pid, PROC_PIDVNODEPATHINFO, 0, vnodePathBuffer, PROC_VNODEPATHINFO_SIZE) !== PROC_VNODEPATHINFO_SIZE) return null;
      return parseCurrentDirectory(vnodePathBuffer);
    },
    procArgs(pid) {
      const length = [PROCARGS_BUFFER_BYTES];
      if (sysctl(Int32Array.from([CTL_KERN, KERN_PROCARGS2, pid]), 3, procArgsBuffer, length, null, 0) !== 0) return null;
      // The caller reads this view before the next call reuses the buffer.
      return procArgsBuffer.subarray(0, Number(length[0]));
    },
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface DarwinReaderOptions {
  loadKernel?: () => Promise<DarwinKernel>;
  /** `lsappinfo`'s output, or null when it could not run or failed. */
  runLsappinfo?: (args: string[]) => Promise<string | null>;
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
  /** The caller's uid. Defaults to `process.getuid()`. */
  uid?: number;
}

export class DarwinTaggedProcessReader implements TaggedProcessReader {
  private readonly loadKernel: () => Promise<DarwinKernel>;
  private readonly runLsappinfo: (args: string[]) => Promise<string | null>;
  private readonly sendSignal: (pid: number, signalName: NodeJS.Signals) => void;
  private readonly ownUid: number | null;

  constructor(options: DarwinReaderOptions = {}) {
    this.loadKernel = options.loadKernel ?? (() => {
      kernelPromise ??= loadDarwinKernel();
      return kernelPromise;
    });
    this.runLsappinfo = options.runLsappinfo ?? ((args) => runTool(LSAPPINFO_PATH, args));
    this.sendSignal = options.signal ?? ((pid, signalName) => process.kill(pid, signalName));
    this.ownUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  }

  async ready(): Promise<void> {
    await this.loadKernel();
  }

  async scan(): Promise<ProcessScan> {
    const kernel = await this.loadKernel();
    let pids: number[];
    try {
      pids = kernel.listPids();
    } catch (error) {
      // A refused list or a koffi throw in the call: the reap names the step.
      throw new ScanStepError('process_list', error instanceof Error ? error.message : String(error));
    }
    const processes: ScannedProcess[] = [];
    const executablePaths = new Map<number, string>();
    let unreadableCount = 0;
    for (let index = 0; index < pids.length; index += 1) {
      if (index > 0 && index % YIELD_EVERY_PROCESSES === 0) await yieldToEventLoop();
      const row = kernel.processRow(pids[index]);
      // Gone since the list, or a zombie. A row naming another pid would be a
      // misread struct; leaving it out empties the scan, which fails loudly.
      if (!row || row.pid !== pids[index]) continue;
      const scanned: ScannedProcess = { pid: row.pid, ppid: row.ppid, startKey: row.startKey, startedAtMs: null, tagValue: null };
      processes.push(scanned);
      if (row.uid !== this.ownUid || row.pid <= LAUNCHD_PID) continue;
      const record = kernel.procArgs(row.pid);
      const summary = record ? summarizeProcArgs(record) : null;
      if (!summary) {
        scanned.environmentUnreadable = true;
        continue;
      }
      executablePaths.set(row.pid, summary.executablePath);
      scanned.tagValue = summary.tagValue;
      if (summary.environmentWithheld) {
        scanned.environmentWithheld = true;
        unreadableCount += 1;
      }
    }
    await this.readDirectoriesAndRoles(kernel, processes, executablePaths);
    return { processes, unreadableCount };
  }

  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    if (!target.startKey) return false;
    let current: DarwinProcessRow | null;
    try {
      // Identity: the start time the kernel reports for this pid right now.
      current = (await this.loadKernel()).processRow(target.pid);
    } catch {
      return false;
    }
    if (!current || current.pid !== target.pid || current.startKey !== target.startKey) return false;
    try {
      this.sendSignal(target.pid, strength === 'force' ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    const labels = new Map<number, string>();
    let kernel: DarwinKernel;
    try {
      kernel = await this.loadKernel();
    } catch {
      return labels;
    }
    for (const target of targets) {
      // As in `kill`: an empty start key is another user's process, which the
      // scan never read and a label must not read either.
      if (!target.startKey) continue;
      try {
        // The same identity check `kill` makes, so a pid reused since the scan
        // is not listed under another program's name.
        const current = kernel.processRow(target.pid);
        if (!current || current.pid !== target.pid || current.startKey !== target.startKey) continue;
        // Parsed before the next read reuses the buffer.
        const record = kernel.procArgs(target.pid);
        const parsed = record ? argumentsFromProcArgs(record) : null;
        if (!parsed) continue;
        const workingDirectory = target.workingDirectory ?? null;
        labels.set(target.pid, await labelProcess({
          executablePath: parsed.executablePath,
          argv: parsed.argv,
          isFile: (candidate) => isFileFrom(workingDirectory, candidate),
        }));
      } catch { /* gone, or not ours */ }
    }
    return labels;
  }

  /**
   * Working directory and role for the processes a reap could touch: tagged
   * ones, withheld orphans, and everything below them.
   */
  private async readDirectoriesAndRoles(kernel: DarwinKernel, processes: ScannedProcess[], executablePaths: Map<number, string>): Promise<void> {
    const relevant = seedsAndDescendants(processes, (scanned) => (
      (scanned.tagValue !== null && scanned.tagValue !== '')
      || (scanned.environmentWithheld === true && scanned.ppid === LAUNCHD_PID)
    ));
    // Nothing a reap could touch, so no `lsappinfo` run, which costs time and can fail the scan.
    if (relevant.size === 0) return;
    // The window list is the only protection a dev-built app outside an
    // Applications folder has. Without it the scan fails, so the reap stops
    // before its next kill, rather than treating every process as windowless.
    const listing = await this.runLsappinfo(['list']);
    if (listing === null) throw new ScanStepError('window_list', 'lsappinfo list did not run');
    const uiPids = parseLsappinfoUiPids(listing);
    for (const scanned of relevant) {
      scanned.workingDirectory = kernel.workingDirectory(scanned.pid);
      const executablePath = executablePaths.get(scanned.pid) ?? '';
      if (path.posix.basename(executablePath) === 'tmux') scanned.role = 'multiplexer';
      else if (uiPids.has(scanned.pid) || isTopLevelAppExecutable(executablePath)) scanned.role = 'visible-app';
    }
  }
}
