/**
 * macOS reader.
 *
 * - `ps -A -o pid=,ppid=,uid=,lstart=` lists the processes, their parents and
 *   start times (the kill's identity check).
 * - The tag comes from each same-user process's `KERN_PROCARGS2` record, read
 *   directly through koffi and searched for an exact `KANGENTIC_TASK_ID=`
 *   entry. Not `ps -E`: a process that sets its title (npm, Next's
 *   `next-server`, pm2) rewrites its argument area, `ps` stops reading at the
 *   first double NUL, and the environment vanishes from its output while the
 *   kernel record still holds it intact (measured on macOS 15 and 26).
 * - XNU's `sysctl_procargsx` leaves the environment out of that record when
 *   the target is `CS_RESTRICT` and System Integrity Protection is on, unless
 *   the caller holds an Apple-private entitlement. Apple's own `/bin` and
 *   `/usr/bin` tools are `CS_RESTRICT`; Node, Python and anything a developer
 *   builds are not. A record with nothing after its arguments is flagged
 *   `environmentWithheld` and counted as unreadable, never passed as clean.
 * - For tagged and withheld processes and their descendants only: `lsof -d
 *   cwd` for the working directory (XNU gates it on the uid alone, with no
 *   code-signing or SIP check), and the role (`process-scan.ts`): a tmux
 *   server by its executable, a visible app by LaunchServices (`lsappinfo
 *   list`, Foreground or UIElement) or by being the main executable of an app
 *   in an Applications folder (`lsappinfo` can miss an app still starting).
 *   Not "any app bundle": `/usr/bin/python3` runs from inside `Python.app`.
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
import type { KillStrength, ProcessScan, ScannedProcess, TaggedProcessReader } from './process-scan';

const TOOL_TIMEOUT_MS = 5000;
const LAUNCHD_PID = 1;
const LSOF_PATH = '/usr/sbin/lsof';
const LSAPPINFO_PATH = '/usr/bin/lsappinfo';
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
/** `kern.argmax` on macOS: the most a `KERN_PROCARGS2` record can hold. */
const PROCARGS_BUFFER_BYTES = 1024 * 1024;
const YIELD_EVERY_PROCESSES = 32;

const LIST_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/;
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

/** `pid ppid uid lstart` rows. Exported for fixture tests. */
export function parseDarwinProcessList(output: string): Array<{ pid: number; ppid: number; uid: number; startKey: string }> {
  const rows: Array<{ pid: number; ppid: number; uid: number; startKey: string }> = [];
  for (const line of output.split('\n')) {
    const match = LIST_LINE_PATTERN.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startKey: match[4].replace(/\s+/g, ' ') });
  }
  return rows;
}

/**
 * Working directories from `lsof -a -d cwd -F pn -p <pids>`: a `p<pid>` line
 * opens each process, and its `n<path>` line is the directory. Exported for
 * fixture tests.
 */
export function parseLsofWorkingDirectories(output: string): Map<number, string> {
  const directories = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    } else if (line.startsWith('n') && currentPid !== null && line.length > 1) {
      directories.set(currentPid, line.slice(1));
    }
  }
  return directories;
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
 * Run a tool and resolve its stdout. `requireSuccess` resolves '' on a
 * non-zero exit; `lsof` exits 1 when one of several pids has already gone,
 * and its output for the rest is still good.
 */
function runTool(command: string, args: string[], requireSuccess: boolean): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: string) => {
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
      finish('');
    }, TOOL_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => finish(''));
    child.on('close', (code) => finish(code === 0 || !requireSuccess ? output : ''));
  });
}

type ProcArgsReader = (pid: number) => Buffer | null;

let procArgsReaderPromise: Promise<ProcArgsReader> | null = null;

/** `sysctl(KERN_PROCARGS2)` through koffi, into one reused buffer. */
async function loadProcArgsReader(): Promise<ProcArgsReader> {
  const imported = await import('koffi');
  const koffi: Pick<typeof import('koffi'), 'load'> = imported.default ?? imported;
  const libSystem = koffi.load('/usr/lib/libSystem.B.dylib');
  const sysctl = libSystem.func('int sysctl(int32 *name, uint32 namelen, _Out_ uint8_t *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)');
  const buffer = Buffer.alloc(PROCARGS_BUFFER_BYTES);
  return (pid) => {
    const length = [PROCARGS_BUFFER_BYTES];
    if (sysctl(Int32Array.from([CTL_KERN, KERN_PROCARGS2, pid]), 3, buffer, length, null, 0) !== 0) return null;
    // The caller summarizes this view before the next read reuses the buffer.
    return buffer.subarray(0, Number(length[0]));
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface DarwinReaderOptions {
  runPs?: (args: string[]) => Promise<string>;
  runLsof?: (args: string[]) => Promise<string>;
  runLsappinfo?: (args: string[]) => Promise<string>;
  readProcArgs?: () => Promise<ProcArgsReader>;
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
  /** The caller's uid. Defaults to `process.getuid()`. */
  uid?: number;
}

export class DarwinTaggedProcessReader implements TaggedProcessReader {
  private readonly run: (args: string[]) => Promise<string>;
  private readonly runLsof: (args: string[]) => Promise<string>;
  private readonly runLsappinfo: (args: string[]) => Promise<string>;
  private readonly loadProcArgs: () => Promise<ProcArgsReader>;
  private readonly sendSignal: (pid: number, signalName: NodeJS.Signals) => void;
  private readonly ownUid: number | null;

  constructor(options: DarwinReaderOptions = {}) {
    this.run = options.runPs ?? ((args) => runTool('ps', args, true));
    this.runLsof = options.runLsof ?? ((args) => runTool(LSOF_PATH, args, false));
    this.runLsappinfo = options.runLsappinfo ?? ((args) => runTool(LSAPPINFO_PATH, args, false));
    this.loadProcArgs = options.readProcArgs ?? (() => {
      procArgsReaderPromise ??= loadProcArgsReader();
      return procArgsReaderPromise;
    });
    this.sendSignal = options.signal ?? ((pid, signalName) => process.kill(pid, signalName));
    this.ownUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  }

  async scan(): Promise<ProcessScan> {
    const rows = parseDarwinProcessList(await this.run(['-A', '-o', 'pid=,ppid=,uid=,lstart=']));
    const readProcArgs = await this.loadProcArgs();
    const processes: ScannedProcess[] = [];
    const executablePaths = new Map<number, string>();
    let unreadableCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (index > 0 && index % YIELD_EVERY_PROCESSES === 0) await yieldToEventLoop();
      const row = rows[index];
      const scanned: ScannedProcess = { pid: row.pid, ppid: row.ppid, startKey: row.startKey, startedAtMs: null, tagValue: null };
      processes.push(scanned);
      if (row.uid !== this.ownUid || row.pid <= LAUNCHD_PID) continue;
      const record = readProcArgs(row.pid);
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
    await this.readDirectoriesAndRoles(processes, executablePaths);
    return { processes, unreadableCount };
  }

  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    // Identity: the start time `ps` reports for this pid right now.
    const current = parseDarwinProcessList(await this.run(['-o', 'pid=,ppid=,uid=,lstart=', '-p', String(target.pid)]))
      .find((row) => row.pid === target.pid);
    if (!current || current.startKey !== target.startKey) return false;
    try {
      this.sendSignal(target.pid, strength === 'force' ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    const labels = new Map<number, string>();
    let readProcArgs: ProcArgsReader;
    try {
      readProcArgs = await this.loadProcArgs();
    } catch {
      return labels;
    }
    for (const target of targets) {
      try {
        // Parsed before the next read reuses the buffer. No identity re-check
        // here: a label is cosmetic, and `kill` re-checks before any signal.
        const record = readProcArgs(target.pid);
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
  private async readDirectoriesAndRoles(processes: ScannedProcess[], executablePaths: Map<number, string>): Promise<void> {
    const children = new Map<number, ScannedProcess[]>();
    for (const scanned of processes) {
      const bucket = children.get(scanned.ppid);
      if (bucket) bucket.push(scanned);
      else children.set(scanned.ppid, [scanned]);
    }
    const relevant = new Set<ScannedProcess>();
    const queue = processes.filter((scanned) => (
      (scanned.tagValue !== null && scanned.tagValue !== '')
      || (scanned.environmentWithheld && scanned.ppid === LAUNCHD_PID)
    ));
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (relevant.has(next)) continue;
      relevant.add(next);
      for (const child of children.get(next.pid) ?? []) if (child.pid !== next.pid) queue.push(child);
    }
    if (relevant.size === 0) return;
    const [lsofOutput, lsappinfoOutput] = await Promise.all([
      this.runLsof(['-w', '-a', '-d', 'cwd', '-F', 'pn', '-p', [...relevant].map((scanned) => scanned.pid).join(',')]),
      this.runLsappinfo(['list']),
    ]);
    const directories = parseLsofWorkingDirectories(lsofOutput);
    const uiPids = parseLsappinfoUiPids(lsappinfoOutput);
    for (const scanned of relevant) {
      scanned.workingDirectory = directories.get(scanned.pid) ?? null;
      const executablePath = executablePaths.get(scanned.pid) ?? '';
      if (path.posix.basename(executablePath) === 'tmux') scanned.role = 'multiplexer';
      else if (uiPids.has(scanned.pid) || isTopLevelAppExecutable(executablePath)) scanned.role = 'visible-app';
    }
  }
}
