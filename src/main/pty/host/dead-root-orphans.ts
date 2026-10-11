/**
 * Ends what a session PTY's shell left running when the shell exited on its
 * own, on Windows, letting the agent exit by itself first.
 *
 * Kangentic spawns a shell and types the agent command into it, so the agent
 * is the shell's child. When the shell exits on its own (it crashed, or
 * something outside Kangentic killed it), node-pty reports the exit but never
 * closes the pseudoconsole (microsoft/node-pty#965): the agent stays attached
 * to a console nobody reads, with no parent, no terminal and no session row.
 * Measured in a preview: a killed shell's `claude.exe` was still running a
 * minute later.
 *
 * What each way of ending such an agent does, measured with Claude Code
 * 2.1.294 on Windows 11 build 26200 through node-pty 1.1.0:
 * - The exit sequence written to the still-open console input
 *   (`writeToExitedConsole`) ends it gracefully: its SessionEnd hook runs
 *   (`prompt_input_exit`), it exits about 600 ms after the write, and its
 *   transcript gains its exit records with every line whole. This is step one.
 * - `IPty.write()` after the exit never arrives, `kill()` after the exit does
 *   nothing (the native side has already dropped the pseudoconsole's record),
 *   and terminating the console host leaves the agent running. None of them is
 *   a way to ask.
 * - TerminateProcess ends it with no SessionEnd hook and no exit records. Its
 *   transcript up to the last finished message is intact. That is the last
 *   resort, for whatever is still alive after `DEAD_ROOT_ORPHAN_EXIT_GRACE_MS`.
 *
 * The processes are found by identity. Windows never rewrites a parent pid, so
 * the dead shell's children still name it. A process names it by accident only
 * when the pid was reused, so a direct child counts only if it was created
 * inside the shell's lifetime, and a deeper one only if it was created after
 * its own parent. A terminate re-checks the creation time on the handle, and
 * only processes in the caller's own Windows session and user are ever opened
 * (`loadWin32OrphanApi`). Nothing here reads an environment, a command line or
 * a working directory.
 *
 * POSIX does not run this. When a terminal's session leader exits the kernel
 * hangs up the terminal's foreground process group, which ends a foreground
 * agent. That has not been observed on a real PTY in this repo.
 */

/** One process as the listing names it. */
export interface OrphanProcessRow {
  pid: number;
  ppid: number;
  /** Image file name (`claude.exe`). The only thing about a process that is logged. */
  image: string;
}

/** A process's creation time: `startKey` is what a terminate re-checks. */
export interface OrphanIdentity {
  startKey: string;
  startedAtMs: number;
}

export interface DeadRootOrphanTarget extends OrphanProcessRow, OrphanIdentity {}

export interface DeadRootOrphanApi {
  listProcesses(): Promise<OrphanProcessRow[]>;
  /** Creation time of a process in the caller's own session and user, else null (gone, another user's, unreadable). */
  identityOf(pid: number): OrphanIdentity | null;
  /** Terminates the process only while its creation time still matches. */
  terminate(target: DeadRootOrphanTarget): boolean;
}

export interface DeadRootOrphanParams {
  rootPid: number;
  /** Wall clock just before the shell was spawned. */
  spawnedAtMs: number;
  /** Wall clock when the shell's exit was observed. Every real child was created before it. */
  exitedAtMs: number;
  /** Never touched: this process, main, and every PTY root the host still holds. */
  protectedPids: ReadonlySet<number>;
}

export interface DeadRootOrphanSteps {
  /** Writes the agent's exit sequence to the dead shell's console. False when it could not be written. */
  askToExit(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** True once the host is quitting: stop waiting and terminate nothing. */
  isStopping(): boolean;
}

export interface DeadRootOrphanResult {
  /** Image names of the processes found when the shell exited, parents first. */
  found: string[];
  /** Whether the exit sequence was written. */
  asked: boolean;
  /** Image names of the processes that exited within the grace. */
  exitedByThemselves: string[];
  /** Image names of the processes terminated after the grace, parents first. */
  terminated: string[];
  /** Still alive after the grace but not terminated: gone meanwhile, or the identity changed. */
  notTerminated: number;
}

/**
 * How long an asked agent gets to exit by itself. Claude Code's SessionEnd
 * hooks run on a 1.5 s budget by default (raised to the longest hook timeout a
 * settings file sets), and it exited about 600 ms after `/exit` when measured.
 */
export const DEAD_ROOT_ORPHAN_EXIT_GRACE_MS = 10_000;
export const DEAD_ROOT_ORPHAN_POLL_MS = 250;

/**
 * The clock reading is taken before the spawn call, and Windows records the
 * creation time a little later, so a real child is never earlier than this. The
 * slack covers clock granularity only.
 */
const SPAWN_CLOCK_SLACK_MS = 1000;

/** The dead shell's children created inside its lifetime, then their descendants, parents first. */
export function planDeadRootOrphans(
  rows: readonly OrphanProcessRow[],
  params: DeadRootOrphanParams,
  identityOf: (pid: number) => OrphanIdentity | null,
): DeadRootOrphanTarget[] {
  const childrenByParent = new Map<number, OrphanProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const targets: DeadRootOrphanTarget[] = [];
  const visited = new Set<number>([params.rootPid]);
  const pending: DeadRootOrphanTarget[] = [];
  const consider = (row: OrphanProcessRow, accepts: (identity: OrphanIdentity) => boolean): void => {
    if (visited.has(row.pid) || params.protectedPids.has(row.pid)) return;
    const identity = identityOf(row.pid);
    if (!identity || !accepts(identity)) return;
    visited.add(row.pid);
    const target: DeadRootOrphanTarget = { ...row, ...identity };
    targets.push(target);
    pending.push(target);
  };

  const earliestChildMs = params.spawnedAtMs - SPAWN_CLOCK_SLACK_MS;
  for (const child of childrenByParent.get(params.rootPid) ?? []) {
    consider(child, (identity) => identity.startedAtMs >= earliestChildMs && identity.startedAtMs <= params.exitedAtMs);
  }
  while (pending.length > 0) {
    const parent = pending.shift() as DeadRootOrphanTarget;
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      consider(child, (identity) => identity.startedAtMs >= parent.startedAtMs);
    }
  }
  return targets;
}

/**
 * Plans against one listing, asks the agent to exit, waits up to the grace for
 * every planned process to be gone, and terminates what is left, parents first
 * so none starts another. Nothing is written or terminated when nothing was
 * left running, and nothing is terminated once the host is quitting.
 */
export async function endDeadRootOrphans(
  api: DeadRootOrphanApi,
  params: DeadRootOrphanParams,
  steps: DeadRootOrphanSteps,
): Promise<DeadRootOrphanResult> {
  const targets = planDeadRootOrphans(await api.listProcesses(), params, (pid) => api.identityOf(pid));
  const result: DeadRootOrphanResult = {
    found: targets.map((target) => target.image),
    asked: false,
    exitedByThemselves: [],
    terminated: [],
    notTerminated: 0,
  };
  if (targets.length === 0) return result;

  const stillAlive = (target: DeadRootOrphanTarget): boolean => api.identityOf(target.pid)?.startKey === target.startKey;
  result.asked = steps.askToExit();
  const deadline = steps.now() + DEAD_ROOT_ORPHAN_EXIT_GRACE_MS;
  let remaining = targets;
  while (remaining.length > 0 && steps.now() < deadline && !steps.isStopping()) {
    await steps.sleep(DEAD_ROOT_ORPHAN_POLL_MS);
    remaining = remaining.filter(stillAlive);
  }
  const remainingPids = new Set(remaining.map((target) => target.pid));
  result.exitedByThemselves = targets.filter((target) => !remainingPids.has(target.pid)).map((target) => target.image);
  if (steps.isStopping()) return result;

  for (const target of remaining) {
    if (api.terminate(target)) result.terminated.push(target.image);
    else result.notTerminated += 1;
  }
  return result;
}
