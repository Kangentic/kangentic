/**
 * Every Kangentic tree stop on Windows is `taskkill /T`, and rests on one fact
 * about it: it adds a process to the tree only when that process was created
 * after the parent it names. A Windows process keeps its parent's pid after
 * the parent exits, and Windows hands that pid to new processes, so a tree
 * kill without that check takes a stranger's whole tree (the header of
 * src/main/shared/child-tree-stop.ts has the measurement).
 *
 * This reruns the measurement against the real taskkill: it plants an orphan
 * whose parent exited, starts throwaway pings until Windows hands one the dead
 * parent's pid, tree-kills that new owner, and checks the older orphan lived
 * (scripts/probe-taskkill-stale-parent.mjs). It creates and ends only pings it
 * started.
 *
 * Windows only, and only when `KANGENTIC_PID_REUSE_PROBE=1` asks for it: the
 * collision takes seconds to minutes of process churn. The
 * `task-reap-real-processes.yml` workflow runs it on windows-latest. A run that
 * gets no collision within its budget, or whose guard finds another process
 * naming the pid, skips with the reason. It never passes without an answer.
 */

import { describe, expect, it } from 'vitest';
import { runStaleParentProbe } from '../../scripts/probe-taskkill-stale-parent.mjs';

const BUDGET_MS = Number(process.env.KANGENTIC_PID_REUSE_PROBE_BUDGET_MS ?? 240_000);

describe.runIf(process.platform === 'win32' && process.env.KANGENTIC_PID_REUSE_PROBE === '1')('taskkill /T and a parent pid Windows reused (real)', () => {
  it('kills the pid\'s new owner and spares the older process that names that pid as its parent', async (context) => {
    const result = await runStaleParentProbe({ budgetMs: BUDGET_MS, log: (line: string) => console.log(`[probe] ${line}`) });
    console.log(`[probe] RESULT ${JSON.stringify(result)}`);
    if (result.outcome === 'aborted') {
      context.skip(`no answer from this run: ${result.reason}`);
      return;
    }
    if (result.outcome === 'no-collision') {
      context.skip(`no answer from this run: the pid did not come back within ${BUDGET_MS} ms (${result.spawns} starts)`);
      return;
    }
    expect(result.newOwnerEnded).toBe(true);
    expect(result.orphanSurvived).toBe(true);
  }, BUDGET_MS + 120_000);
});
