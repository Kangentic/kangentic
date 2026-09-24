import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether the Linux GPU process's zygote was alive when Chromium gave up on
 * the GPU, plus two numbers that say whether a fork could have failed.
 *
 * On Linux, Chromium forks the GPU process from the UNSANDBOXED zygote (the
 * browser's child running with `--type=zygote --no-zygote-sandbox`). DESKTOP-W
 * is Chromium walking its GPU fallback ladder to the fatal through launch
 * failures, which means that zygote either died or could not fork. The two
 * causes need different fixes, and nothing on the Sentry event can tell them
 * apart. This module answers "which one" at the moment of the fallback, which
 * gpu-health.ts records from `gpu-info-update` just before the fatal.
 *
 * A dead zygote is also never a normal state, so it lets gpu-health.ts record
 * a fallback on a machine that never composited on the GPU. Its boot-time
 * status churn is otherwise indistinguishable from a real fallback.
 *
 * Plain `/proc` reads, synchronous and small, because the fatal follows the
 * fallback within milliseconds. Every read degrades to `unknown` or null
 * rather than throwing, because this runs inside an Electron event emit.
 */

export type ZygoteState = 'alive' | 'dead' | 'unknown';

export interface LinuxProcessSnapshot {
  zygote: ZygoteState;
  /** System-wide threads and processes in existence (the second half of
   *  `/proc/loadavg`'s fourth field). Set beside `maxUserProcesses`, it says
   *  whether a fork was near the limit. */
  schedulingEntities: number | null;
  /** The soft RLIMIT_NPROC from `/proc/self/limits`, as written there
   *  (a number, or `unlimited`). On Linux it counts every thread the user
   *  owns, and a fork past it fails with EAGAIN. */
  maxUserProcesses: string | null;
}

export interface LinuxGpuZygoteProbe {
  /** Find and remember the unsandboxed zygote's pid. Idempotent. Call it while
   *  the GPU is still healthy. Once the zygote is dead, there is nothing to
   *  find. */
  discover(): void;
  /** The state right now. Never throws. */
  snapshot(): LinuxProcessSnapshot;
}

interface StatFields {
  state: string;
  parentPid: number;
}

/** `/proc/<pid>/stat` puts the command name in parentheses, and the name can
 *  itself contain spaces and parentheses, so the fields are read after the
 *  LAST `)`. The state is the first field after it and the parent pid the
 *  second. */
export function parseProcStat(content: string): StatFields | null {
  const nameEnd = content.lastIndexOf(')');
  if (nameEnd === -1) return null;
  const fields = content.slice(nameEnd + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  if (!fields[0] || !Number.isInteger(parentPid)) return null;
  return { state: fields[0], parentPid };
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** `cmdline` is NUL-separated unless the process rewrote its own title.
 *  Chromium ships a setproctitle for that, and a rewritten title reads back
 *  as one space-joined string. Splitting on whitespace as well covers both.
 *  The two flags hold no spaces and only the browser's direct children are
 *  checked, so the wider split cannot manufacture a match. */
function isUnsandboxedZygote(procRoot: string, pid: number): boolean {
  const commandLine = readText(path.join(procRoot, String(pid), 'cmdline'));
  if (!commandLine) return false;
  const argumentList = commandLine.split(/[\0\s]+/);
  return argumentList.includes('--type=zygote') && argumentList.includes('--no-zygote-sandbox');
}

/** The browser's direct children, from each thread's `children` file. That
 *  file needs CONFIG_PROC_CHILDREN, which the mainstream distro kernels
 *  enable; without it this returns null and the caller scans instead. */
function listChildrenFromTasks(procRoot: string, browserPid: number): number[] | null {
  let taskIds: string[];
  try {
    taskIds = fs.readdirSync(path.join(procRoot, String(browserPid), 'task'));
  } catch {
    return null;
  }
  const children = new Set<number>();
  let anyReadable = false;
  for (const taskId of taskIds) {
    const content = readText(path.join(procRoot, String(browserPid), 'task', taskId, 'children'));
    if (content === null) continue;
    anyReadable = true;
    for (const token of content.trim().split(/\s+/)) {
      const childPid = Number(token);
      if (Number.isInteger(childPid) && childPid > 0) children.add(childPid);
    }
  }
  return anyReadable ? [...children] : null;
}

/** Every process whose parent is the browser. The slower route, one stat read
 *  per process on the machine, taken only when the `children` files are
 *  missing. */
function listChildrenByScan(procRoot: string, browserPid: number): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const children: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readText(path.join(procRoot, entry, 'stat'));
    const fields = stat ? parseProcStat(stat) : null;
    if (fields?.parentPid === browserPid) children.push(Number(entry));
  }
  return children;
}

export function findUnsandboxedZygotePid(procRoot: string, browserPid: number): number | null {
  const children = listChildrenFromTasks(procRoot, browserPid) ?? listChildrenByScan(procRoot, browserPid);
  return children.find((childPid) => isUnsandboxedZygote(procRoot, childPid)) ?? null;
}

/** Dead covers three readings: gone from `/proc`, a zombie the browser has
 *  not reaped yet, and a pid now owned by some other parent (the zygote died
 *  and its pid was reused). An unreadable entry that still exists is not
 *  evidence either way. */
export function readZygoteState(procRoot: string, zygotePid: number, browserPid: number): ZygoteState {
  let content: string;
  try {
    content = fs.readFileSync(path.join(procRoot, String(zygotePid), 'stat'), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
  }
  const fields = parseProcStat(content);
  if (!fields) return 'unknown';
  if (fields.state === 'Z' || fields.state === 'X') return 'dead';
  if (fields.parentPid !== browserPid) return 'dead';
  return 'alive';
}

function readSchedulingEntities(procRoot: string): number | null {
  const loadAverage = readText(path.join(procRoot, 'loadavg'));
  const total = loadAverage?.trim().split(/\s+/)[3]?.split('/')[1];
  const parsed = Number(total);
  return total !== undefined && Number.isInteger(parsed) ? parsed : null;
}

function readMaxUserProcesses(procRoot: string): string | null {
  const limits = readText(path.join(procRoot, 'self', 'limits'));
  const line = limits?.split('\n').find((candidate) => candidate.startsWith('Max processes'));
  const softLimit = line?.slice('Max processes'.length).trim().split(/\s+/)[0];
  return softLimit || null;
}

export function createLinuxGpuZygoteProbe(browserPid: number, procRoot = '/proc'): LinuxGpuZygoteProbe {
  let discovered = false;
  let zygotePid: number | null = null;
  return {
    discover(): void {
      if (discovered) return;
      discovered = true;
      try {
        zygotePid = findUnsandboxedZygotePid(procRoot, browserPid);
      } catch {
        zygotePid = null;
      }
    },
    snapshot(): LinuxProcessSnapshot {
      try {
        return {
          zygote: zygotePid === null ? 'unknown' : readZygoteState(procRoot, zygotePid, browserPid),
          schedulingEntities: readSchedulingEntities(procRoot),
          maxUserProcesses: readMaxUserProcesses(procRoot),
        };
      } catch {
        return { zygote: 'unknown', schedulingEntities: null, maxUserProcesses: null };
      }
    },
  };
}
