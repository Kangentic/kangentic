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
 * A process is spared the same way, with everything under it, when other
 * Kangentic work holds a loopback TCP connection to a port it listens on
 * (`connections`, read by the reader after each scan). A shared server is not
 * always a parent: an adb server keeps the cwd of the client that started it,
 * has no children, and every other client reaches it over TCP. The client
 * counts when it runs under a live session's PTY (another task's agent, the
 * user's Command Terminal), or carries a tag no task of this reap owns
 * (another task's, or a cleared one), or is itself spared as shared: the adb
 * server another task is using holds a connection to the emulator's adb port,
 * so a headless emulator is spared through it. The reaped tasks' own
 * processes are no evidence (the agent's own browser on its dev server), and
 * neither are Kangentic's other processes (the network service behind a
 * Browser pane), found by walking up to main without passing a live PTY, nor
 * an untagged process outside Kangentic. The connection spares only the
 * listener, never the process above it: a tagged shell that started the
 * server still goes, unless the server is its only child and the next rule
 * keeps it.
 *
 * A process whose every child is kept is kept too (`keptAncestorPids`), unless
 * it listens on a TCP port itself: an emulator launcher, which holds no socket
 * (measured on Windows), whose only child is the emulator's window. Killing it
 * frees nothing while the child runs, and the report would call a running app
 * stopped. A dev server that opened a window listens on its port, so it is
 * still stopped and the window kept. Only the ancestor's own pid is kept;
 * everything under it already is. Without a connection read nothing tells the
 * two apart, so the rule applies only with one, and never to a process an
 * earlier pass of the same reap already signalled (`signalledIdentities`).
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

import type { LocalConnectionRead, ScannedProcess } from './process-scan';

const LOWEST_KILLABLE_PID = 4;
const LAUNCHD_PID = 1;
const MAX_TREE_DEPTH = 64;

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
  /**
   * Loopback TCP connections among the processes `connectionQueryOf` names,
   * and which of them listen, read after the same scan. Absent: no
   * connection is evidence, and no process is kept for its children alone.
   */
  connections?: LocalConnectionRead;
  /**
   * Identities (`processIdentity`) an earlier plan of the same reap left
   * running on purpose (`ReapPlan.keptIdentities`). They stay running, with
   * everything under them, however this scan reads: a client's command can
   * end inside the grace, and the force pass must not kill a server the first
   * pass kept and never signalled.
   */
  keepIdentities?: ReadonlySet<string>;
  /**
   * Identities an earlier plan of the same reap asked to exit. One is never
   * kept for its children alone: a shell that ignored SIGTERM, whose only
   * child left is a spared server, still gets the force kill.
   */
  signalledIdentities?: ReadonlySet<string>;
}

/** A process's identity across scans: its pid and the start key that pid had. */
export function processIdentity(scanned: ScannedProcess): string {
  return `${scanned.pid}:${scanned.startKey}`;
}

/**
 * Forward slashes, no device prefix (`\\?\` or `\\.\`, so `\\.\UNC\host\share`
 * reads as `//host/share`, as `process-label.ts` reads it), no trailing
 * separator, and lowercase where the file system ignores case.
 * `task-directories.ts` refuses roots in this same form, so a root check and a
 * containment check cannot disagree.
 */
export function normalizeDirectory(directory: string, caseInsensitive: boolean): string {
  const normalized = directory
    .replace(/\\/g, '/')
    .replace(/^\/\/[?.]\/UNC\//i, '//')
    .replace(/^\/\/[?.]\//, '')
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

function indexByPid(processes: readonly ScannedProcess[]): Map<number, ScannedProcess> {
  const byPid = new Map<number, ScannedProcess>();
  for (const scanned of processes) byPid.set(scanned.pid, scanned);
  return byPid;
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
  const byPid = indexByPid(input.processes);
  const children = indexChildren(input.processes);
  const protectedPids = new Set<number>([input.mainPid, ...input.liveRootPids]);

  // Main's ancestors: whoever launched Kangentic (a terminal, an agent running
  // /preview, the desktop shell).
  let cursor = byPid.get(input.mainPid);
  for (let depth = 0; cursor && depth < MAX_TREE_DEPTH; depth += 1) {
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
  /**
   * Everything this plan left running on purpose, by `processIdentity`: what
   * it spared as shared, with everything under it, and each process kept
   * because all its children were. The next plan of the same reap takes it
   * as `keepIdentities`.
   */
  keptIdentities: ReadonlySet<string>;
}

/** The processes a reap kills, from one scan. */
export function planReap(input: ReapPlanInput): ScannedProcess[] {
  return planReapDetailed(input).targets;
}

/** Walk `scanned`'s real ancestors, nearest first. */
function* ancestorsOf(scanned: ScannedProcess, byPid: Map<number, ScannedProcess>): Generator<ScannedProcess> {
  let cursor = scanned;
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid || !isRealChild(parent, cursor)) return;
    yield parent;
    cursor = parent;
  }
}

/**
 * Kangentic's own processes that are not session work: main and everything
 * under it except what runs under a live PTY (the network service behind a
 * Browser pane, the pty host). A connection from one is no evidence, whatever
 * tag main carries.
 */
function kangenticOwnPids(
  input: Pick<ReapPlanInput, 'mainPid'>,
  byPid: Map<number, ScannedProcess>,
  children: Map<number, ScannedProcess[]>,
  liveSessionPids: ReadonlySet<number>,
): Set<number> {
  const own = new Set<number>();
  const main = byPid.get(input.mainPid);
  if (main) collectSubtree(main, children, own, liveSessionPids);
  return own;
}

/** Every live PTY root and everything under it. */
function liveSessionPidsOf(input: Pick<ReapPlanInput, 'liveRootPids'>, byPid: Map<number, ScannedProcess>, children: Map<number, ScannedProcess[]>): Set<number> {
  const live = new Set<number>();
  for (const pid of input.liveRootPids) {
    const root = byPid.get(pid);
    if (root) collectSubtree(root, children, live);
  }
  return live;
}

/**
 * Whether a client is other Kangentic work, whose connection to a reaped
 * task's listener shows the listener is shared: a process under a live PTY,
 * or one carrying another task's tag or a cleared one, never Kangentic's own
 * processes. `connectionQueryOf` asks about these clients and `planReapDetailed`
 * counts them, so the two read one rule.
 */
function otherWorkOf(
  input: Pick<ReapPlanInput, 'mainPid' | 'liveRootPids'>,
  byPid: Map<number, ScannedProcess>,
  children: Map<number, ScannedProcess[]>,
  reapedTaskIds: ReadonlySet<string>,
): (scanned: ScannedProcess) => boolean {
  const liveSessionPids = liveSessionPidsOf(input, byPid, children);
  const kangenticPids = kangenticOwnPids(input, byPid, children, liveSessionPids);
  return (scanned) => liveSessionPids.has(scanned.pid)
    || (!kangenticPids.has(scanned.pid) && scanned.tagValue !== null && !reapedTaskIds.has(scanned.tagValue));
}

/**
 * Whose sockets a reap reads after a scan (`TaggedProcessReader.connections`).
 * Listeners: every process carrying a reaped task's tag, every macOS withheld
 * orphan a reap could kill, and everything under them, never a protected one.
 * Clients: what could be evidence (a process under a live PTY, one carrying
 * another task's tag or a cleared one) and the listeners themselves, since a
 * listener spared as shared is evidence for the next. Kangentic's own
 * processes are left out: they are never evidence. No listener: no read.
 */
export function connectionQueryOf(input: ReapPlanInput): { listeners: ScannedProcess[]; clients: ScannedProcess[] } {
  if (input.tasks.size === 0) return { listeners: [], clients: [] };
  const caseInsensitive = input.caseInsensitivePaths ?? true;
  const protectedPids = buildProtectedPids(input);
  const children = indexChildren(input.processes);
  const byPid = indexByPid(input.processes);
  const reapedTaskIds = new Set(input.tasks.keys());
  const listenerPids = new Set<number>();
  for (const scanned of input.processes) {
    if (protectedPids.has(scanned.pid) || listenerPids.has(scanned.pid)) continue;
    const reapedTag = scanned.tagValue !== null && reapedTaskIds.has(scanned.tagValue);
    if (reapedTag || rootScope(scanned, input, caseInsensitive)?.taskId === null) {
      collectSubtree(scanned, children, listenerPids, protectedPids);
    }
  }
  if (listenerPids.size === 0) return { listeners: [], clients: [] };
  const isOtherWork = otherWorkOf(input, byPid, children, reapedTaskIds);
  return {
    listeners: input.processes.filter((scanned) => listenerPids.has(scanned.pid)),
    clients: input.processes.filter((scanned) => listenerPids.has(scanned.pid) || isOtherWork(scanned)),
  };
}

/** The order a kept ancestor takes its reason from its kept children in. */
const KEPT_REASON_ORDER: readonly KeptReason[] = ['window', 'multiplexer', 'shared'];

/** What a reap kills from one scan, and what it reports as stopped and as left running. */
export function planReapDetailed(input: ReapPlanInput): ReapPlan {
  if (input.tasks.size === 0) return { targets: [], roots: [], kept: [], keptIdentities: new Set() };
  const caseInsensitive = input.caseInsensitivePaths ?? true;
  const protectedPids = buildProtectedPids(input);
  const children = indexChildren(input.processes);
  const byPid = indexByPid(input.processes);
  const reapedTaskIds = new Set(input.tasks.keys());
  const roots: Array<{ scanned: ScannedProcess; scope: readonly string[]; taskId: string | null; ownerTaskId: string }> = [];
  const sharedRoots: ReportedProcess[] = [];
  // The task each kill root belongs to, shared or not, so a process under one
  // is reported under that task.
  const rootTaskByPid = new Map<number, string>();
  const sparedPids = new Set<number>();
  // What an earlier plan of this reap left running stays running.
  const keptEarlier = new Set<number>();
  if (input.keepIdentities && input.keepIdentities.size > 0) {
    for (const scanned of input.processes) {
      if (!protectedPids.has(scanned.pid) && input.keepIdentities.has(processIdentity(scanned))) {
        collectSubtree(scanned, children, keptEarlier, protectedPids);
      }
    }
    for (const pid of keptEarlier) sparedPids.add(pid);
  }
  // First: a shared root shields its whole subtree, including the task's own
  // processes under it (pm2 would restart an app killed under its daemon).
  for (const scanned of input.processes) {
    if (protectedPids.has(scanned.pid) || keptEarlier.has(scanned.pid)) continue;
    const root = rootScope(scanned, input, caseInsensitive);
    if (!root) continue;
    rootTaskByPid.set(scanned.pid, root.ownerTaskId);
    if (isShared(scanned, children, protectedPids, root.scope, root.taskId, reapedTaskIds, caseInsensitive)) {
      collectSubtree(scanned, children, sparedPids, protectedPids);
      sharedRoots.push({ process: scanned, taskId: root.ownerTaskId });
    } else {
      roots.push({ scanned, ...root });
    }
  }
  const owningTaskOf = (scanned: ScannedProcess): string | null => {
    const own = rootTaskByPid.get(scanned.pid);
    if (own !== undefined) return own;
    for (const ancestor of ancestorsOf(scanned, byPid)) {
      const taskId = rootTaskByPid.get(ancestor.pid);
      if (taskId !== undefined) return taskId;
    }
    return null;
  };

  const collectedPids = new Set<number>();
  const blockedPids = new Set([...protectedPids, ...sparedPids]);
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
  const targetPids = new Set(input.processes
    .filter((scanned) => collectedPids.has(scanned.pid) && !blockedPids.has(scanned.pid) && Number.isInteger(scanned.pid) && scanned.pid > LOWEST_KILLABLE_PID)
    .map((scanned) => scanned.pid));

  // Second: a target other Kangentic work is connected to is spared with its
  // subtree, and in turn so is a target a spared one is connected to, until
  // nothing changes. Sparing only removes targets, so a process this plan
  // would not kill is never reported here.
  const connections = input.connections?.pairs ?? [];
  if (connections.length > 0) {
    const isOtherWork = otherWorkOf(input, byPid, children, reapedTaskIds);
    // Kangentic's own processes are protected, so never spared: only other
    // work, or a listener this plan already spared, is evidence.
    const isEvidence = (client: ScannedProcess): boolean => isOtherWork(client) || sparedPids.has(client.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const connection of connections) {
        if (!targetPids.has(connection.listenerPid)) continue;
        const listener = byPid.get(connection.listenerPid);
        const client = byPid.get(connection.clientPid);
        if (!listener || !client || !isEvidence(client)) continue;
        const sparedNow = new Set<number>();
        collectSubtree(listener, children, sparedNow, protectedPids);
        for (const pid of sparedNow) {
          sparedPids.add(pid);
          targetPids.delete(pid);
        }
        const taskId = owningTaskOf(listener);
        if (taskId !== null) sharedRoots.push({ process: listener, taskId });
        changed = true;
      }
    }
  }

  // Third: a target whose every child is kept frees nothing when killed (an
  // emulator launcher whose only child is the emulator's window), so it is
  // kept too, bottom up. Not one that listens on a port: it does work of its
  // own (a dev server that opened a window). A console host is not a child
  // for this, and a child that survives for any other reason (an unreadable
  // directory) does not count as kept.
  const keptAncestorPids = new Set<number>();
  const listeningPids = input.connections ? new Set(input.connections.listeningPids) : null;
  const isKeptChild = (pid: number): boolean => protectedPids.has(pid) || sparedPids.has(pid) || keptAncestorPids.has(pid);
  const realChildrenOf = (parent: ScannedProcess): ScannedProcess[] => (children.get(parent.pid) ?? [])
    .filter((child) => child.pid !== parent.pid && isRealChild(parent, child) && child.role !== 'console-host');
  if (listeningPids) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const pid of targetPids) {
        const target = byPid.get(pid);
        if (!target || listeningPids.has(pid) || input.signalledIdentities?.has(processIdentity(target))) continue;
        const realChildren = realChildrenOf(target);
        if (realChildren.length > 0 && realChildren.every((child) => isKeptChild(child.pid))) {
          keptAncestorPids.add(pid);
          targetPids.delete(pid);
          grew = true;
        }
      }
    }
  }
  const targets = input.processes.filter((scanned) => targetPids.has(scanned.pid));

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
  // A kept ancestor is reported with the reason of what it was kept for, so
  // the list names the launcher, and its Stop takes the window with it.
  const reasonOf = (scanned: ScannedProcess, depth: number): KeptReason | null => {
    const entry = keptByPid.get(scanned.pid);
    if (entry) return entry.reason;
    if (protectedPids.has(scanned.pid) && scanned.role === 'visible-app') return 'window';
    if (protectedPids.has(scanned.pid) && scanned.role === 'multiplexer') return 'multiplexer';
    if (sparedPids.has(scanned.pid)) return 'shared';
    if (!keptAncestorPids.has(scanned.pid) || depth >= MAX_TREE_DEPTH) return null;
    const childReasons = new Set(realChildrenOf(scanned).map((child) => reasonOf(child, depth + 1)));
    return KEPT_REASON_ORDER.find((reason) => childReasons.has(reason)) ?? null;
  };
  for (const pid of keptAncestorPids) {
    const scanned = byPid.get(pid);
    const taskId = scanned ? owningTaskOf(scanned) : null;
    if (!scanned || taskId === null || safetyPids.has(pid)) continue;
    keptByPid.set(pid, { process: scanned, taskId, reason: reasonOf(scanned, 0) ?? 'shared' });
  }
  const kept = [...keptByPid.values()].filter((entry) => {
    for (const ancestor of ancestorsOf(entry.process, byPid)) {
      if (keptByPid.has(ancestor.pid)) return false;
    }
    return true;
  });

  const keptIdentities = new Set<string>();
  for (const pid of [...sparedPids, ...keptAncestorPids]) {
    const scanned = byPid.get(pid);
    if (scanned) keptIdentities.add(processIdentity(scanned));
  }
  return { targets, roots: reportedRoots, kept, keptIdentities };
}
