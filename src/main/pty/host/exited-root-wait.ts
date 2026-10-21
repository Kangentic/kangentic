/**
 * Lets the agent a session's shell left running finish exiting before a task
 * reap kills what the task left behind.
 *
 * A task reap waits for the session's PTY to report its exit, and that is the
 * SHELL's exit. A kill closes the console and terminates the shell at once,
 * while the agent the shell started gets the console's close and shuts down
 * on its own: Claude Code 2.1.302 ran its SessionEnd hooks and exited tens of
 * milliseconds after its shell, and 0.9 s after it with an answer streaming
 * (`scripts/probe-claude-exit-paths.js`). A Claude that did not take the
 * keys it was sent lives on longer still. Tagged with its task and working in
 * its directory, it is a leftover to the reap. Two young Claudes moved back
 * to To Do while busy were followed 1.6 to 3.2 s after their force-kill by a
 * reap that killed one process each, and the next launch counted both as
 * failed fullscreen starts.
 *
 * So the host keeps a short ledger of task PTY roots, recorded the moment a
 * kill is sent (so a reap that follows the kill at once already finds it) or
 * when a shell exits on its own, and the reap first waits for the agent each of
 * its tasks' roots left running. That is the shell's children, looking through
 * a shell or launcher among them (`cmd.exe` under a `.cmd` shim, a Git Bash
 * stub) to what it started, and nothing the agent itself started: a dev server
 * it left running never exits by itself and is the reap's to end.
 * - A root main killed, on Windows: found by parentage and creation time
 *   exactly as the orphan cleanup finds its processes (`planDeadRootOrphans`);
 *   Windows never rewrites a parent pid. The shell's own creation time, from
 *   its pin, bounds the window below and the kill bounds it above. A root
 *   with no pin falls back to the clock read before its spawn, less
 *   `SPAWN_CLOCK_SLACK_MS`: that window could admit an earlier owner of the
 *   pid's child, which only lengthens a wait that terminates nothing, where
 *   skipping it would let the reap cut an agent's exit short.
 * - A root main killed, on POSIX: listed by the host just before it sent the
 *   kill, because the shell's death re-parents them and no parentage is left
 *   to read afterwards. They are watched by pid alone: the wait only waits, so
 *   a pid reused meanwhile, or a zombie no reaper collects, can at most hold
 *   it to its bound.
 *   Either kind is polled until it is gone or `AGENT_EXIT_WAIT_MS` runs out.
 *   Nothing is asked and nothing is terminated here; what is still running at
 *   the bound is the reap's, as before.
 * - A root whose shell exited on its own (Windows): the orphan cleanup is
 *   already asking its agent to exit and will terminate it after its own
 *   grace, so the wait lasts until that cleanup ends. A shorter wait would let
 *   the reap cut that ask short. On POSIX the kernel hangs up the terminal's
 *   foreground group instead, and nothing names what is left.
 */

import type { ProcessInfo } from '../../activity-engine/background-shell/process-tree';
import {
  DEAD_ROOT_ORPHAN_EXIT_GRACE_MS,
  DEAD_ROOT_ORPHAN_POLL_MS,
  planDeadRootOrphans,
  type DeadRootOrphanApi,
} from './dead-root-orphans';

/**
 * The longest a reap waits for what a killed shell left running. At least
 * Claude Code's SessionEnd budget (1.5 s by default), with room for the exit
 * that follows its hooks: with a real session's hooks and MCP server, Claude
 * 2.1.303 exited up to 4.0 s after its console was closed (3 s after its
 * shell), and usually under 2 s. The wait ends as soon as it is gone.
 */
export const AGENT_EXIT_WAIT_MS = 8000;

/**
 * How long main's reap waits for the host to answer `awaitAgentExit`: this
 * wait's bound for a killed shell, or the orphan cleanup's grace for a shell
 * that exited on its own, plus room for the listing.
 */
export const AGENT_EXIT_REQUEST_TIMEOUT_MS = Math.max(AGENT_EXIT_WAIT_MS, DEAD_ROOT_ORPHAN_EXIT_GRACE_MS) + 5000;

/** How long an exited root stays in the ledger: longer than any wait on it. */
export const EXITED_ROOT_LEDGER_MS = 30_000;

/**
 * How long a POSIX kill waits for the host's process listing before it lands
 * anyway. `ps` answers in about 10 ms; this only bounds a stuck one.
 */
export const KILL_SNAPSHOT_CAP_MS = 250;

/**
 * A root without a pinned creation time: the clock reading is taken before the
 * spawn call and Windows records the creation a little later, so a real child
 * is never earlier than the reading less this. It covers clock granularity. It
 * is also the floor `pinRoot` accepts for a shell's own creation time
 * (`pty-host-core.ts`).
 */
export const SPAWN_CLOCK_SLACK_MS = 1000;

/** A process the host listed under a root before killing it (POSIX). */
export interface RootDescendant {
  pid: number;
  /** Its command name, for the log line only. */
  image: string;
}

export interface ExitedRoot {
  /** The task the PTY ran for: the value of its `KANGENTIC_TASK_ID` tag. */
  taskId: string;
  rootPid: number;
  /** Wall clock just before the shell was spawned. */
  spawnedAtMs: number;
  /** The shell's creation time from its pin (`PinnedRoot`), or null when it was never pinned. */
  rootStartedAtMs: number | null;
  /** Wall clock when the kill was sent, or when the shell's exit was observed. */
  exitedAtMs: number;
  /** The orphan cleanup still running for a shell that exited on its own; null for a kill. */
  orphanCleanup: Promise<void> | null;
  /** A POSIX kill's pre-kill listing of the shell's agent (`agentDescendantsOf`); null where parentage is read instead. */
  descendants: Promise<readonly RootDescendant[]> | null;
}

export interface AgentExitWaitResult {
  /** Image names of what the task's killed shells left running when the wait began. */
  found: string[];
  /** Image names of those still running when the wait ended. */
  stillRunning: string[];
  waitedMs: number;
}

export interface AgentExitWaitSteps {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** True once the host is quitting: stop waiting. */
  isStopping(): boolean;
  /** Whether a pid still names a live process (POSIX descendants). */
  isAlive(pid: number): boolean;
}

export const NO_AGENT_EXIT_WAIT: AgentExitWaitResult = { found: [], stillRunning: [], waitedMs: 0 };

/** The ledger without the roots older than `EXITED_ROOT_LEDGER_MS`. */
export function pruneExitedRoots(roots: readonly ExitedRoot[], now: number): ExitedRoot[] {
  return roots.filter((root) => now - root.exitedAtMs < EXITED_ROOT_LEDGER_MS);
}

/**
 * Shells and launchers that can stand between a PTY's shell and the agent it
 * runs, lowercased and without `.exe`. A console close can end one before the
 * agent behind it, so the wait looks through them to what they started.
 */
const LAUNCHER_IMAGES: ReadonlySet<string> = new Set(['bash', 'cmd', 'dash', 'env', 'fish', 'nu', 'powershell', 'pwsh', 'sh', 'zsh']);

function isLauncherImage(image: string): boolean {
  const name = image.split(/[\\/]/).pop() ?? image;
  return LAUNCHER_IMAGES.has(name.toLowerCase().replace(/\.exe$/, ''));
}

/**
 * The processes a root's agent runs as, in one listing, parents first: the
 * root's children, and through a shell or launcher among them what it started.
 * What a non-launcher child started is left out (see the file comment).
 */
export function agentProcessesUnder<Row extends { pid: number; ppid: number }>(
  rows: readonly Row[],
  rootPid: number,
  imageOf: (row: Row) => string,
): Row[] {
  const childrenByParent = new Map<number, Row[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }
  const found: Row[] = [];
  const seen = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift() as number;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      if (isLauncherImage(imageOf(child))) pending.push(child.pid);
    }
  }
  return found;
}

/** `agentProcessesUnder` over a `ps` listing, in the ledger's shape (POSIX). */
export function agentDescendantsOf(rows: readonly ProcessInfo[], rootPid: number): RootDescendant[] {
  return agentProcessesUnder(rows, rootPid, (row) => row.comm).map((row) => ({ pid: row.pid, image: row.comm }));
}

interface WatchedProcess {
  image: string;
  stillAlive(): boolean;
}

/**
 * Waits for what these exited roots left running to exit by itself (see the
 * file comment). `api` is the Win32 orphan API, needed only for a killed
 * root read by parentage; null off Windows.
 */
export async function waitForExitedRootTrees(
  api: DeadRootOrphanApi | null,
  roots: readonly ExitedRoot[],
  protectedPids: ReadonlySet<number>,
  steps: AgentExitWaitSteps,
  boundMs: number = AGENT_EXIT_WAIT_MS,
): Promise<AgentExitWaitResult> {
  const startedAt = steps.now();
  const watched: WatchedProcess[] = [];
  const parentageRoots = roots.filter((root) => !root.orphanCleanup && !root.descendants);
  if (api && parentageRoots.length > 0) {
    const rows = await api.listProcesses();
    for (const root of parentageRoots) {
      const shellTree = planDeadRootOrphans(
        rows,
        {
          rootPid: root.rootPid,
          rootStartedAtMs: root.rootStartedAtMs ?? root.spawnedAtMs - SPAWN_CLOCK_SLACK_MS,
          rootExitedAtMs: root.exitedAtMs,
          protectedPids,
        },
        (pid) => api.identityOf(pid),
      );
      for (const target of agentProcessesUnder(shellTree, root.rootPid, (candidate) => candidate.image)) {
        watched.push({ image: target.image, stillAlive: () => api.identityOf(target.pid)?.startKey === target.startKey });
      }
    }
  }
  for (const root of roots) {
    if (!root.descendants) continue;
    for (const descendant of await root.descendants) {
      if (protectedPids.has(descendant.pid)) continue;
      watched.push({ image: descendant.image, stillAlive: () => steps.isAlive(descendant.pid) });
    }
  }
  let remaining = watched.filter((watchedProcess) => watchedProcess.stillAlive());
  const deadline = startedAt + boundMs;
  while (remaining.length > 0 && steps.now() < deadline && !steps.isStopping()) {
    await steps.sleep(DEAD_ROOT_ORPHAN_POLL_MS);
    remaining = remaining.filter((watchedProcess) => watchedProcess.stillAlive());
  }
  // Each cleanup is bounded by its own grace and settles, never rejects.
  await Promise.all(roots.map((root) => root.orphanCleanup).filter((cleanup): cleanup is Promise<void> => cleanup !== null));
  return {
    found: watched.map((watchedProcess) => watchedProcess.image),
    stillRunning: remaining.map((watchedProcess) => watchedProcess.image),
    waitedMs: steps.now() - startedAt,
  };
}
