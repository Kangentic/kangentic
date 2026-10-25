/**
 * Dev-only: time every child-process spawn on the main thread.
 *
 * On Windows, libuv's spawn runs CreateProcess synchronously on the calling
 * thread, so each `spawn` / `execFile` holds main for its whole duration (the
 * stall profiler caught 217 ms of agent version probes and 230 ms for the
 * process-tree sampler's start). This wraps `ChildProcess.prototype.spawn`,
 * the one place every spawn API ends up, and records each call as a span
 * labelled `spawn:<program>:<callers>`, so the lag report counts them by
 * caller with their maxima. The caller is the one `openSimpleGit` stored for a
 * simple-git call, whose own stack names only simple-git's scheduler, else the
 * stack's (`spawn-caller.ts`). Installed only from `src/devtools/install.ts`.
 */

import { ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { recordSyncSpan } from '../../main/diagnostics/event-loop-lag';
import { describeSpawnCaller } from '../../main/diagnostics/spawn-caller';

let installed = false;

function programName(options: SpawnOptions & { file?: string }): string {
  const file = typeof options.file === 'string' ? options.file : '';
  return path.basename(file).replace(/\.(exe|cmd|bat)$/i, '') || 'unknown';
}

export function installSpawnTracer(): void {
  if (installed) return;
  installed = true;
  const prototype = ChildProcess.prototype as ChildProcess & { spawn: (options: SpawnOptions & { file?: string }) => unknown };
  const originalSpawn = prototype.spawn;
  prototype.spawn = function spawnTraced(this: ChildProcess, options: SpawnOptions & { file?: string }) {
    const startedAt = performance.now();
    try {
      return originalSpawn.call(this, options);
    } finally {
      recordSyncSpan(`spawn:${programName(options)}:${describeSpawnCaller()}`, performance.now() - startedAt);
    }
  };
}
