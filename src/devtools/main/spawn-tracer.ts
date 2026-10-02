/**
 * Dev-only: time every child-process spawn on the main thread.
 *
 * On Windows, libuv's spawn runs CreateProcess synchronously on the calling
 * thread, so each `spawn` / `execFile` holds main for its whole duration (the
 * stall profiler caught 217 ms of agent version probes and 230 ms for the
 * process-tree sampler's start). This wraps `ChildProcess.prototype.spawn`,
 * the one place every spawn API ends up, and records each call as a span
 * labelled `spawn:<program>:<callers>`, so the lag report counts them by
 * caller with their maxima. Installed only from `src/devtools/install.ts`.
 */

import { ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { recordSyncSpan } from '../../main/diagnostics/event-loop-lag';

let installed = false;

/** How many named bundle frames identify a caller. */
const CALLER_FRAMES = 3;
const TRACER_FRAME = /spawnTraced|callerLabel|spawn-tracer/;

/** The first few named frames above the spawn, from the app's own bundle. */
function callerLabel(): string {
  // child_process's own frames (exec -> execFile -> spawn) use up V8's
  // default 10 before the caller appears.
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = previousLimit;
  const names: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    if (TRACER_FRAME.test(line)) continue;
    if (!/[\\/]\.vite[\\/]build[\\/]/.test(line)) continue;
    const match = line.match(/at (?:async )?([\w$.<>]+) \(/);
    if (!match) continue;
    names.push(match[1]);
    if (names.length >= CALLER_FRAMES) break;
  }
  return names.length > 0 ? names.join('<') : 'unknown';
}

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
      recordSyncSpan(`spawn:${programName(options)}:${callerLabel()}`, performance.now() - startedAt);
    }
  };
}
