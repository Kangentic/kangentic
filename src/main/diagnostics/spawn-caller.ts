/**
 * Who asked for a child process, for the lag report's spawn spans (dev builds).
 *
 * A spawn's own stack names only the code right above it. For a simple-git
 * call that is simple-git's scheduler (`Pn.gitResponse<Pn.attemptRemoteTask<
 * Pn.attemptTask`), because the Kangentic caller is behind an `await` the
 * scheduler starts afresh; for a pty host spawn the stack is the host's, and
 * the caller is in main. So the caller is captured where Kangentic code makes
 * the call and carried with it: an AsyncLocalStorage run around each
 * simple-git method (`openSimpleGit`), and a `caller` field on the host's
 * exec and CLI requests. `describeSpawnCaller` prefers the stored caller and
 * falls back to the current stack, async frames included.
 *
 * Every call site gates on `__KANGENTIC_DEV__`, so a production build captures
 * no stacks and never enters the storage. The storage is created on first use,
 * so a production bundle that keeps this module still allocates nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** How many named frames identify a caller. */
const CALLER_FRAMES = 3;

/**
 * Frames that only pass a spawn along. Skipped so the label names the code
 * that wanted the process, not the plumbing between it and the spawn.
 */
const WRAPPER_FRAME = /\b(stackCallerLabel|describeSpawnCaller|withSpawnCaller|tracedGitMethod|spawnTraced|callerLabel|execAsync|execFileAsync|runRemote|spawnOffMainCli|spawnWithAbort|runGitCommand|gitAt|spawnCli|localExec|localExecFile)\b/;

let spawnCallerStorage: AsyncLocalStorage<string> | null = null;

/** The caller a surrounding `withSpawnCaller` recorded, or undefined. */
export function storedSpawnCaller(): string | undefined {
  return spawnCallerStorage?.getStore();
}

/** Run `work` with `caller` as the spawn caller for everything it starts,
 *  across its awaits. */
export function withSpawnCaller<Result>(caller: string, work: () => Result): Result {
  spawnCallerStorage ??= new AsyncLocalStorage<string>();
  return spawnCallerStorage.run(caller, work);
}

/**
 * The first few named frames of the app's own bundle on the current stack,
 * joined with `<` (innermost first), skipping wrapper frames. V8 keeps the
 * awaiting callers as `at async name (...)` frames, so a caller behind an
 * `await` still shows. `bundleFrame` picks the app's frames from the rest
 * (node internals, a dependency's dist): main's and the host's bundles live
 * under `.vite/build`.
 */
export function stackCallerLabel(bundleFrame: RegExp = /[\\/]\.vite[\\/]build[\\/]/): string {
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
  return names.length > 0 ? names.join('<') : 'unknown';
}

/** The stored caller when one is set, else the current stack's. */
export function describeSpawnCaller(): string {
  return storedSpawnCaller() ?? stackCallerLabel();
}
