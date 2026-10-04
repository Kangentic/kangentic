/**
 * Which processes a reap may kill, decided from one scan. Pure, so every rule
 * here is pinned by unit tests without a real process table.
 *
 * A process is killed only on TWO independent signals: it carries a reaped
 * task's tag, AND its working directory is inside that task's own directories
 * (its project, which holds its worktree). The tag alone over-reaches: a
 * shared, long-lived process the task's agent happened to start first inherits
 * it too (a tmux server, pm2's daemon, `gpg-agent`, a browser or editor that
 * was not already open), and it goes on to serve the user's other work. The
 * directory is what a dev server, a watcher or a test run has and a daemon
 * does not: a daemon moves to `/` or home when it detaches, and anything
 * systemd, launchd, D-Bus or a Windows service starts begins elsewhere. A
 * process whose directory cannot be read is never killed.
 *
 * A tagged process is also spared, with everything under it, when anything
 * under it shows the process is shared: a descendant whose environment reads
 * without this task's tag (untagged, cleared, another task's), or whose
 * directory lies outside the task's. pm2's daemon running an app the user
 * started later is the measured case. Two kinds of descendant are no
 * evidence: a Windows console host (every console process has one, in the
 * Windows directory) and one whose directory could not be read (a zombie, a
 * setuid helper). So a child that cleared the tag (the documented opt-out) is
 * never killed through its parent; it saves the parent instead.
 *
 * Protected, never killed, with everything under them:
 * - pids 0 to 4 (System, Idle, init),
 * - Kangentic's main process (and its ancestors, which are protected alone),
 * - every PTY root the pty host still holds,
 * - a visible app: a browser, editor or window the agent opened. The user can
 *   see it and closes it themselves.
 * - a tmux server: it copies the environment it started with into every later
 *   session, so a pane the user opens next week carries this task's tag.
 *
 * The last arm is what keeps a still-running session of the SAME task safe: it
 * carries the same tag, and force-killing a young agent outside its exit grace
 * is what `.claude/rules/pty-teardown-grace.md` forbids. The host computes
 * that list itself, so it includes a PTY parked on its deferred kill, whose
 * main-side handle is already gone, and a spawn that landed after the request.
 * Excluding main's descendants loses nothing real: once a task's sessions have
 * exited, nothing they left running is reachable from main by parent links.
 *
 * On Windows a dead parent's pid stays in its children's ppid field and can be
 * reused by an unrelated process, so a parent link counts only when the child
 * started after the parent. A recycled ppid therefore never links a stranger.
 *
 * One more root, for macOS, where SIP hides the environment of Apple's own
 * tools (`docs/worktree-strategy.md`): a process whose environment was
 * withheld, whose parent is `launchd` (it was orphaned), and whose working
 * directory is inside one of the reaped tasks' worktrees (the worktree, not the
 * project: with no tag to go on, the directory must be the task's alone). A
 * readable environment always wins over the directory: an untagged or
 * cleared-tag process in the worktree is left alone. A withheld process that
 * still has a live parent is left alone too (the user's own terminal shell
 * `cd`'d into the worktree is one). Under such a root the descendants in the
 * worktree go too, a reaped task's tag or none: Apple's `/bin/sh` keeps the
 * `cd X && cmd &` subshell alive as `cmd`'s parent, and on a machine with SIP
 * off `cmd` reads as untagged. A descendant that cleared the tag still saves
 * the root, as it does under a tagged one.
 */

import type { ScannedProcess } from './process-scan';

const LOWEST_KILLABLE_PID = 4;
const LAUNCHD_PID = 1;

/** Where one reaped task's processes work. */
export interface ReapTaskScope {
  /**
   * The task's directories: its project and its worktree, each as stored and
   * as its real path. A tagged process outside every one is never killed.
   */
  directories: readonly string[];
  /** The worktree alone, for the macOS withheld-orphan root. Null without one. */
  worktreePath: string | null;
}

export interface ReapPlanInput {
  processes: readonly ScannedProcess[];
  /** The reaped tasks, by id. */
  tasks: ReadonlyMap<string, ReapTaskScope>;
  mainPid: number;
  liveRootPids: readonly number[];
  /** Compare paths without regard to case. True on Windows and macOS. */
  caseInsensitivePaths?: boolean;
}

/**
 * Forward slashes, no long-path prefix, no trailing separator, and lowercase
 * where the file system ignores case. `task-directories.ts` refuses roots in
 * this same form, so a root check and a containment check cannot disagree.
 */
export function normalizeDirectory(directory: string, caseInsensitive: boolean): string {
  const normalized = directory
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * True when `directory` is `root` or below it, never a prefix sibling. A
 * filesystem root (`/`, `C:\`) is never a root here: it would admit everything.
 */
export function isInsideDirectory(directory: string, root: string, caseInsensitive = true): boolean {
  const normalizedRoot = normalizeDirectory(root, caseInsensitive);
  if (normalizedRoot.length === 0 || /^[a-z]:$/i.test(normalizedRoot)) return false;
  const normalizedDirectory = normalizeDirectory(directory, caseInsensitive);
  return normalizedDirectory === normalizedRoot || normalizedDirectory.startsWith(`${normalizedRoot}/`);
}

function isInsideAny(directory: string | null | undefined, roots: readonly string[], caseInsensitive: boolean): boolean {
  if (!directory) return false;
  return roots.some((root) => isInsideDirectory(directory, root, caseInsensitive));
}

/** True when `child`'s ppid really names `parent` (see the module comment). */
function isRealChild(parent: ScannedProcess, child: ScannedProcess): boolean {
  if (parent.startedAtMs === null || child.startedAtMs === null) return true;
  return child.startedAtMs >= parent.startedAtMs;
}

function indexChildren(processes: readonly ScannedProcess[]): Map<number, ScannedProcess[]> {
  const children = new Map<number, ScannedProcess[]>();
  for (const candidate of processes) {
    let bucket = children.get(candidate.ppid);
    if (!bucket) {
      bucket = [];
      children.set(candidate.ppid, bucket);
    }
    bucket.push(candidate);
  }
  return children;
}

/**
 * Add `root` and every real descendant `admits` accepts to `into`. The walk
 * keeps its own visited set rather than reading `into`, so a root already
 * recorded there (main and the live PTY roots seed the protected set) still
 * has its children walked. It never enters a `blocked` pid, and never passes
 * through a child `admits` rejects.
 */
function collectSubtree(
  root: ScannedProcess,
  children: Map<number, ScannedProcess[]>,
  into: Set<number>,
  blocked: ReadonlySet<number> = new Set(),
  admits: (child: ScannedProcess) => boolean = () => true,
): void {
  const visited = new Set<number>();
  const queue: ScannedProcess[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    into.add(parent.pid);
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid === parent.pid || visited.has(child.pid) || blocked.has(child.pid)) continue;
      if (isRealChild(parent, child) && admits(child)) queue.push(child);
    }
  }
}

/**
 * The pids nothing may ever kill, not even a stop the user asks for:
 * Kangentic's main process, its ancestors, every PTY root the host holds, and
 * everything under main and those roots.
 */
export function buildSafetyProtectedPids(input: Pick<ReapPlanInput, 'processes' | 'mainPid' | 'liveRootPids'>): Set<number> {
  return protectedPidsOf(input, false);
}

/**
 * `root` and every real descendant outside `blocked`, for a stop the user
 * asked for by name. Pids 0 to 4 are never included.
 */
export function subtreeOf(root: ScannedProcess, processes: readonly ScannedProcess[], blocked: ReadonlySet<number>): ScannedProcess[] {
  const pids = new Set<number>();
  collectSubtree(root, indexChildren(processes), pids, blocked);
  return processes.filter((scanned) => pids.has(scanned.pid) && scanned.pid > LOWEST_KILLABLE_PID);
}

/** The pids a reap must never touch: the safety set, plus every visible app and tmux server with everything under them. */
export function buildProtectedPids(input: Pick<ReapPlanInput, 'processes' | 'mainPid' | 'liveRootPids'>): Set<number> {
  return protectedPidsOf(input, true);
}

function protectedPidsOf(input: Pick<ReapPlanInput, 'processes' | 'mainPid' | 'liveRootPids'>, includeRoles: boolean): Set<number> {
  const byPid = new Map<number, ScannedProcess>();
  for (const scanned of input.processes) byPid.set(scanned.pid, scanned);
  const children = indexChildren(input.processes);
  const protectedPids = new Set<number>([input.mainPid, ...input.liveRootPids]);

  // Main's ancestors: whoever launched Kangentic (a terminal, an agent running
  // /preview, the desktop shell).
  let cursor = byPid.get(input.mainPid);
  for (let depth = 0; cursor && depth < 64; depth += 1) {
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid || protectedPids.has(parent.pid)) break;
    if (!isRealChild(parent, cursor)) break;
    protectedPids.add(parent.pid);
    cursor = parent;
  }

  const protectedRoots = [
    ...[input.mainPid, ...input.liveRootPids].map((pid) => byPid.get(pid)),
    ...(includeRoles ? input.processes.filter((scanned) => scanned.role === 'visible-app' || scanned.role === 'multiplexer') : []),
  ];
  for (const root of protectedRoots) {
    if (root) collectSubtree(root, children, protectedPids);
  }
  return protectedPids;
}

/**
 * Whether anything under `root` shows it serves more than this task (see the
 * module comment). `taskId` is null for a macOS withheld root, whose
 * descendants may read untagged on a SIP-off machine; only a cleared tag,
 * another task's tag or a directory outside counts there.
 */
function isShared(
  root: ScannedProcess,
  children: Map<number, ScannedProcess[]>,
  protectedPids: ReadonlySet<number>,
  scope: readonly string[],
  taskId: string | null,
  reapedTaskIds: ReadonlySet<string>,
  caseInsensitive: boolean,
): boolean {
  const visited = new Set<number>([root.pid]);
  const queue: ScannedProcess[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent.pid) ?? []) {
      if (visited.has(child.pid) || !isRealChild(parent, child)) continue;
      visited.add(child.pid);
      // A protected process (a window the agent opened, say) is left alone by
      // the protection itself; it says nothing about its parent.
      if (protectedPids.has(child.pid)) continue;
      queue.push(child);
      if (child.role === 'console-host' || !child.workingDirectory) continue;
      if (!isInsideAny(child.workingDirectory, scope, caseInsensitive)) return true;
      const environmentKnown = !child.environmentUnreadable && !child.environmentWithheld;
      if (!environmentKnown) continue;
      if (taskId !== null && child.tagValue !== taskId) return true;
      // A cleared tag ('') is the documented opt-out, not an absent one.
      if (taskId === null && child.tagValue !== null && !reapedTaskIds.has(child.tagValue)) return true;
    }
  }
  return false;
}

/**
 * Whether a process is a kill root, and under which task and directories: a
 * tagged process inside its own task's directories, or a macOS withheld
 * orphan inside a reaped worktree (`taskId` null).
 */
function rootScope(
  scanned: ScannedProcess,
  input: ReapPlanInput,
  caseInsensitive: boolean,
): { scope: readonly string[]; taskId: string | null; ownerTaskId: string } | null {
  if (scanned.tagValue !== null) {
    const task = input.tasks.get(scanned.tagValue);
    if (!task || !isInsideAny(scanned.workingDirectory, task.directories, caseInsensitive)) return null;
    return { scope: task.directories, taskId: scanned.tagValue, ownerTaskId: scanned.tagValue };
  }
  if (!scanned.environmentWithheld || scanned.ppid !== LAUNCHD_PID) return null;
  for (const [taskId, task] of input.tasks) {
    if (task.worktreePath && isInsideAny(scanned.workingDirectory, [task.worktreePath], caseInsensitive)) {
      return { scope: [task.worktreePath], taskId: null, ownerTaskId: taskId };
    }
  }
  return null;
}

/** Why a reaped task's own process was left running. */
export type KeptReason = 'window' | 'multiplexer' | 'shared';

/** One process a plan reports, and the task it is reported under. */
export interface ReportedProcess {
  process: ScannedProcess;
  taskId: string;
}

export interface ReapPlan {
  /** Every process to kill. */
  targets: ScannedProcess[];
  /** The top of each killed subtree: what a report names as stopped. */
  roots: ReportedProcess[];
  /**
   * The task's own processes the plan left running on purpose: tagged for a
   * reaped task, working in its directories, and a visible app, a tmux server,
   * or a shared root. The top of each only, never what runs under one (a tmux
   * pane or a pm2 app can be the user's own). Kangentic's tree and the held
   * PTYs are never here.
   */
  kept: Array<ReportedProcess & { reason: KeptReason }>;
}

/** The processes a reap kills, from one scan. */
export function planReap(input: ReapPlanInput): ScannedProcess[] {
  return planReapDetailed(input).targets;
}

/** Walk `scanned`'s real ancestors, nearest first. */
function* ancestorsOf(scanned: ScannedProcess, byPid: Map<number, ScannedProcess>): Generator<ScannedProcess> {
  let cursor = scanned;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid || !isRealChild(parent, cursor)) return;
    yield parent;
    cursor = parent;
  }
}

/** What a reap kills from one scan, and what it reports as stopped and as left running. */
export function planReapDetailed(input: ReapPlanInput): ReapPlan {
  if (input.tasks.size === 0) return { targets: [], roots: [], kept: [] };
  const caseInsensitive = input.caseInsensitivePaths ?? true;
  const protectedPids = buildProtectedPids(input);
  const children = indexChildren(input.processes);
  const reapedTaskIds = new Set(input.tasks.keys());
  const roots: Array<{ scanned: ScannedProcess; scope: readonly string[]; taskId: string | null; ownerTaskId: string }> = [];
  const sharedRoots: ReportedProcess[] = [];
  // First pass: a shared root shields its whole subtree, including the task's
  // own processes under it (pm2 would restart an app killed under its daemon).
  const sparedPids = new Set<number>();
  for (const scanned of input.processes) {
    if (protectedPids.has(scanned.pid)) continue;
    const root = rootScope(scanned, input, caseInsensitive);
    if (!root) continue;
    if (isShared(scanned, children, protectedPids, root.scope, root.taskId, reapedTaskIds, caseInsensitive)) {
      collectSubtree(scanned, children, sparedPids, protectedPids);
      sharedRoots.push({ process: scanned, taskId: root.ownerTaskId });
    } else {
      roots.push({ scanned, ...root });
    }
  }
  const blockedPids = new Set([...protectedPids, ...sparedPids]);
  const collectedPids = new Set<number>();
  for (const { scanned, ...root } of roots) {
    if (sparedPids.has(scanned.pid)) continue;
    // What goes with the root: descendants inside its directories that carry
    // its tag or whose environment could not be read (a withheld Apple tool
    // between two tagged node processes). Under a withheld root, no tag or a
    // reaped task's, never a cleared one.
    collectSubtree(scanned, children, collectedPids, blockedPids, (child) => (
      isInsideAny(child.workingDirectory, root.scope, caseInsensitive)
      && (root.taskId === null
        ? child.tagValue === null || reapedTaskIds.has(child.tagValue)
        : child.tagValue === root.taskId || Boolean(child.environmentUnreadable) || Boolean(child.environmentWithheld))
    ));
  }
  const targets = input.processes.filter((scanned) => (
    collectedPids.has(scanned.pid)
    && !blockedPids.has(scanned.pid)
    && Number.isInteger(scanned.pid)
    && scanned.pid > LOWEST_KILLABLE_PID
  ));
  const targetPids = new Set(targets.map((scanned) => scanned.pid));
  const byPid = new Map<number, ScannedProcess>();
  for (const scanned of input.processes) byPid.set(scanned.pid, scanned);

  // Reported as stopped: each killed root whose parent is not killed with it.
  const reportedRoots: ReportedProcess[] = [];
  const reportedRootPids = new Set<number>();
  for (const root of roots) {
    if (!targetPids.has(root.scanned.pid) || reportedRootPids.has(root.scanned.pid)) continue;
    const parent = byPid.get(root.scanned.ppid);
    if (parent && targetPids.has(parent.pid) && isRealChild(parent, root.scanned)) continue;
    reportedRootPids.add(root.scanned.pid);
    reportedRoots.push({ process: root.scanned, taskId: root.ownerTaskId });
  }

  // Reported as left running: the task's own windows, tmux servers and shared
  // roots, never Kangentic's tree or a held PTY.
  const safetyPids = buildSafetyProtectedPids(input);
  const keptByPid = new Map<number, ReportedProcess & { reason: KeptReason }>();
  for (const scanned of input.processes) {
    if (safetyPids.has(scanned.pid) || targetPids.has(scanned.pid)) continue;
    if (scanned.role !== 'visible-app' && scanned.role !== 'multiplexer') continue;
    const task = scanned.tagValue !== null ? input.tasks.get(scanned.tagValue) : undefined;
    if (!task || !isInsideAny(scanned.workingDirectory, task.directories, caseInsensitive)) continue;
    keptByPid.set(scanned.pid, {
      process: scanned,
      taskId: scanned.tagValue as string,
      reason: scanned.role === 'visible-app' ? 'window' : 'multiplexer',
    });
  }
  for (const shared of sharedRoots) {
    if (safetyPids.has(shared.process.pid) || keptByPid.has(shared.process.pid)) continue;
    keptByPid.set(shared.process.pid, { ...shared, reason: 'shared' });
  }
  const kept = [...keptByPid.values()].filter((entry) => {
    for (const ancestor of ancestorsOf(entry.process, byPid)) {
      if (keptByPid.has(ancestor.pid)) return false;
    }
    return true;
  });

  return { targets, roots: reportedRoots, kept };
}
