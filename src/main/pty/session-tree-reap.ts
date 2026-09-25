/**
 * Kill what a session leaves running in its worktree, at the moment the task's
 * work ends.
 *
 * ## The bug this exists for
 *
 * An agent ran a dev server from inside its worktree
 * (`bash run-functions.sh` -> `func.exe start --port 5003`). The session ended;
 * both processes kept running. Six hours later they still held the worktree
 * directory, so its removal left a husk with no git admin entry, which then hung
 * a later worktree creation. They also squatted the port the task existed to
 * configure.
 *
 * ## Why the existing path could not catch them
 *
 * `zombie-reaper.ts` selects candidates by matching the worktree path against a
 * process's COMMAND LINE. Neither process carried it: `func.exe start --port
 * 5003 --useHttps` holds no path at all, and the wrapper script lived outside
 * the worktree. Both referenced the worktree only through their CWD, and
 * `Win32_Process` exposes `CommandLine`, `ExecutablePath` and `ParentProcessId`
 * but no current-directory property whatsoever. So on Windows there is no scan
 * that can find this process after the fact.
 *
 * What CAN find it is the parent chain, while it still exists. The incident
 * proves it was intact: killing `func.exe` made its parent shell exit, so a walk
 * from the session's PTY would have found both.
 *
 * ## Why this module does not enumerate
 *
 * Teardown runs on the drag-to-Done path, which has a real jitter budget.
 * Measured on a 505-process Windows host: a cold `powershell -NoProfile` spawn
 * costs ~670ms even for a pid/ppid-only projection, because the cost is process
 * startup rather than the query. So this module never scans. It consumes a
 * snapshot the bg-shell watcher already computed for its own purposes and threw
 * away (`BgShellWatcher.getCapturedDescendants`), which makes the capture free.
 *
 * When no snapshot is available the reap is a no-op by design. The backstop is
 * `reapProcessesForWorktree`, which runs only after a worktree removal has
 * already failed, where a scan costs nothing anyone can feel.
 *
 * ## Blind spots
 *
 * A WSL agent presents an empty `Win32_Process` descendant set (see
 * `SessionManager.isAgentAbsenceCandidate`), so there is nothing for the watcher
 * to publish and this reap no-ops for those sessions. The removal-failure
 * backstop cannot cover them either: it scans the same Windows process table,
 * which does not see inside the WSL VM's own pid namespace.
 *
 * A pid can also be stale. The watcher prunes a pid on the first cycle that
 * observes it dead, so a descendant that exits and has its pid reassigned inside
 * one cycle gap (2s base, up to 6s under the adaptive backoff) survives the
 * prune and this function would kill whatever now holds that pid. Ruling that
 * out needs a per-pid identity check (start time, or a retained handle) the
 * snapshot does not carry. It is a known residual risk.
 */

import { killProcess } from '../git/zombie-reaper';
import { isProcessAlive } from '../shared/process-liveness';
import type { CapturedSessionTree } from '../activity-engine/background-shell/process-tree';

/**
 * PIDs at or below this are init / System / csrss on every platform (1 on Unix,
 * 0 and 4 on Windows). Never kill one. Mirrors the `ppid > 4` floor the
 * zombie-reaper's orphan gate uses.
 */
const LOWEST_KILLABLE_PID = 4;

/**
 * Kill every process in `captured` that is still alive.
 *
 * Never throws: a teardown must proceed even when the reap fails outright.
 * Returns the pids it issued a kill for, which the caller can log.
 *
 * ## Self-kill safety
 *
 * The captured set is the DESCENDANTS of a session's PTY, and Kangentic spawned
 * that PTY, so Kangentic is one of its ancestors. A process cannot be both an
 * ancestor and a descendant of the same node, so our own pid and our own parent
 * chain are structurally absent from the set. That is why this does not walk a
 * parent chain the way `zombie-reaper.buildSelfSkipSet` does: doing so would
 * need a full process scan, which is the one thing this module refuses to pay
 * for. The explicit `process.pid` guard below is belt-and-braces.
 */
export async function reapCapturedTree(
  captured: CapturedSessionTree | null,
): Promise<number[]> {
  const candidates = new Set<number>(captured?.pids ?? []);

  const targets = [...candidates].filter((pid) => {
    if (!Number.isInteger(pid) || pid <= LOWEST_KILLABLE_PID) return false;
    if (pid === process.pid) return false;
    // A native signal-0 probe, no spawn. Most captured pids exited with the
    // agent, so this keeps the common case down to zero taskkill invocations.
    return isProcessAlive(pid);
  });
  if (targets.length === 0) return [];

  // In parallel, not the sequential `for await` the zombie-reaper's sweeps use:
  // each Windows `taskkill` carries a 2000ms timeout, and a teardown that is
  // holding the per-task lock cannot afford to stack them.
  await Promise.all(targets.map(async (pid) => {
    try {
      await killProcess(pid);
    } catch (error) {
      // killProcess already swallows the expected failures; this only catches a
      // spawn that could not start at all.
      console.warn(`[SESSION-REAP] kill failed for pid=${pid}:`, error);
    }
  }));

  console.log(`[SESSION-REAP] killed ${targets.length} leftover process(es): ${targets.join(', ')}`);
  return targets;
}
