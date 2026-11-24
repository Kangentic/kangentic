/**
 * Who asked for a child process, for the lag report's spawn spans (dev builds).
 *
 * A spawn's own stack names only the code right above it, and for a pty host
 * spawn that stack is the host's while the caller is in main. So the caller is
 * read where Kangentic code makes the call and carried with it, as a `caller`
 * field on the host's exec and CLI requests. `describeSpawnCaller` reads the
 * current stack, async frames included.
 *
 * Every call site gates on `__KANGENTIC_DEV__`, so a production build captures
 * no stacks.
 */

import { isTimingSyncWork, recordSyncSpan } from './event-loop-lag';

/** How many named frames identify a caller. */
const CALLER_FRAMES = 3;
/** A stack capture is timed under this label, for the diagnostics budget. */
const CALLER_LABEL = 'diag:spawn-caller';

/**
 * Frames that only pass a spawn along. Skipped so the label names the code
 * that wanted the process, not the plumbing between it and the spawn.
 */
const WRAPPER_FRAME = /\b(stackCallerLabel|describeSpawnCaller|spawnTraced|callerLabel|execAsync|execFileAsync|runRemote|spawnOffMainCli|spawnOffMain|spawnHere|spawnWithAbort|runGitCommand|gitAt|spawnCli|localExec|localExecFile)\b/;

/**
 * The first few named frames of the app's own bundle on the current stack,
 * joined with `<` (innermost first), skipping wrapper frames. V8 keeps the
 * awaiting callers as `at async name (...)` frames, so a caller behind an
 * `await` still shows. `bundleFrame` picks the app's frames from the rest
 * (node internals, a dependency's dist): main's and the host's bundles live
 * under `.vite/build`.
 */
export function stackCallerLabel(bundleFrame: RegExp = /[\\/]\.vite[\\/]build[\\/]/): string {
  // Timed in place, so the diagnostics budget sees what a stack capture costs.
  // Not `timeSyncWork`: its frames would sit above the caller on the stack
  // being read here and become the label.
  const timed = isTimingSyncWork();
  const startedAt = timed ? performance.now() : 0;
  // child_process and the wrappers use up V8's default 10 frames before the caller appears.
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = previousLimit;
  const names: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    if (!bundleFrame.test(line)) continue;
    const match = line.match(/at (?:async )?([\w$.<>]+) \(/);
    if (!match || WRAPPER_FRAME.test(match[1])) continue;
    if (names[names.length - 1] === match[1]) continue;
    names.push(match[1]);
    if (names.length >= CALLER_FRAMES) break;
  }
  if (timed) recordSyncSpan(CALLER_LABEL, performance.now() - startedAt);
  return names.length > 0 ? names.join('<') : 'unknown';
}

/** The caller of the spawn being made, read off the current stack. */
export function describeSpawnCaller(): string {
  return stackCallerLabel();
}
