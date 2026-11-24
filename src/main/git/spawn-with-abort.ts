import { spawn, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveShellLaunch } from '../pty/spawn/shell-launch';
import { withoutCrashpadPipeName } from '../shared/child-env';
import { childHasExited, killChildTreeByPid, killChildTreeNow } from '../shared/child-tree-stop';
import { spawnOffMainCli, type CliChildProcess } from '../utility-process/off-main-cli';

/**
 * Per-stream cap on captured stdout/stderr. A verbose child (e.g. an
 * `npm install` Post-Worktree Script) can emit tens of megabytes; without a
 * bound the whole stream is held in memory and embedded in the rejection
 * Error that crosses IPC to the renderer. 1MB keeps enough context for a
 * useful error without the pathological case.
 */
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;

/**
 * How long an aborted shell command (the post-worktree init script) may take to
 * close after its tree is killed before the call settles anyway. The settle
 * waits for the close because a creation that has settled is what lets a
 * removal or a new creation at the same worktree path go ahead
 * (`worktree-creation-registry.ts`), and `taskkill /T` is itself a process that
 * takes a moment. The bound covers a descendant that escaped the tree kill and
 * still holds the output pipes.
 */
export const TREE_EXIT_WAIT_MS = 5_000;

export interface SpawnWithAbortOptions {
  /** Wall-clock cap. On expiry the child is killed via the internal AbortController. */
  timeoutMs: number;
  /** External cancellation, race-combined with the internal timeout. */
  signal?: AbortSignal;
  /**
   * The child's environment. Omitted, the child gets `process.env`. Either way
   * without Crashpad's pipe name (child-env.ts). A caller that must not be able
   * to prompt (a fetch on a timer) passes a copy with the prompt-suppressing
   * variables set; see `nonInteractiveGitEnv` in fetch-throttle.ts.
   */
  env?: NodeJS.ProcessEnv;
  /** Which end of output past the cap is kept: the start (default), or the end, where a hook says why it failed. */
  keepOutput?: 'head' | 'tail';
}

export interface SpawnWithAbortTarget {
  /** A binary path (with `args`) or a full shell command string (without `args`). */
  command: string;
  /**
   * Args for a binary spawn. Omit to run `command` through the platform shell
   * as a single string (`shell: true`, no args array, which avoids the Node
   * DEP0190 deprecation). Present (even empty) means a binary spawn.
   */
  args?: readonly string[];
  cwd: string;
  /** Human label prefixing every error message, e.g. `git fetch ...` or `init script`. */
  label: string;
  /**
   * When the child is killed by a signal, whether the message asserts the
   * timeout as the cause. The git caller asserts it; the init-script caller
   * does not, since an external or OS signal is not necessarily a timeout.
   */
  signalKillAssertsTimeout: boolean;
}

/**
 * How a child ended, as fixed fields on the error `spawnWithAbort` rejects with.
 * Its message is free text (stderr rides on it), so a report reads these
 * instead: Sentry DESKTOP-3D, a Post-Worktree Script failure, could not tell a
 * non-zero exit from a timeout or a kill. Not `code`, which callers of a spawn
 * error read as an errno.
 */
interface SpawnExitFields {
  /** The exit code of a child that exited non-zero on its own. */
  exitCode?: number;
  /** The signal that ended a child nobody here asked to stop. */
  signal?: NodeJS.Signals;
  /** True when the wall-clock timeout, not the caller, stopped the child. */
  timedOut?: boolean;
}

function withExitFields(error: Error, fields: SpawnExitFields): Error & SpawnExitFields {
  return Object.assign(error, fields);
}

/** What a child printed before it failed, both streams. */
export interface CapturedOutput {
  /** Null when the child did not exit on its own (a timeout or a kill). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const capturedOutputs = new WeakMap<Error, CapturedOutput>();

/**
 * Both streams of a run `spawnWithAbort` rejected, or null for any other error.
 * Kept beside the error rather than on it: a hook's output is the user's own
 * text, and a field on the error could ride a report.
 */
export function capturedOutputOf(error: unknown): CapturedOutput | null {
  return error instanceof Error ? capturedOutputs.get(error) ?? null : null;
}

/**
 * Shared `child_process.spawn` lifecycle behind runGitWithTimeout and
 * runInitScript: an internal AbortController on a wall-clock timeout, optional
 * external-signal forwarding (removed on settle so the signal isn't held
 * referenced after the call resolves), stdout/stderr drained to capped utf8
 * strings so Windows conpty buffers can't block the child on write, and a
 * single resolve on clean exit or reject on non-zero exit, kill-by-signal,
 * abort, or timeout.
 *
 * Both callers previously carried this machinery verbatim. Keeping it in one
 * place means a fix to the abort-vs-close ordering or the ABORT_ERR guard lands
 * once, not twice. Each caller keeps its own error wording via `label` and
 * `signalKillAssertsTimeout`.
 *
 * Every child starts in the pty host when one is registered
 * (`spawnOffMainCli`), because on Windows the spawn is CreateProcess on the
 * calling thread, 15 to 30 ms each. The lifecycle around it stays here: the
 * timeout and the external signal stop the host's run (`stopTree`) and settle
 * with the same "aborted (...)" wording the local spawn's abort produces, which
 * `isGitTimeoutError` and `classifyFetchFailure` read. A shell command (a
 * project's script) is resolved here first, so on macOS it still goes through
 * the spawn-helper, and starts there as a run the app does not stop at a quit.
 * With no host (unit tests, startup before the host) the child starts here.
 */
export function spawnWithAbort(
  target: SpawnWithAbortTarget,
  options: SpawnWithAbortOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, label, signalKillAssertsTimeout } = target;
  const { timeoutMs, signal: externalSignal, keepOutput = 'head' } = options;
  // Always passed, never inherited: git runs repository hooks and the init
  // script can start anything, so neither gets Crashpad's pipe name
  // (child-env.ts).
  const env = withoutCrashpadPipeName(options.env ?? process.env);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    // Who stopped the child, decided when it was stopped: a tree kill settles
    // only once the tree exits, and a caller's abort can land in that wait.
    let abortCause: 'timeout' | 'external' | null = null;
    const abortFor = (cause: 'timeout' | 'external'): void => {
      if (abortCause === null) abortCause = cause;
      controller.abort();
    };
    const timeoutHandle = setTimeout(() => abortFor('timeout'), timeoutMs);

    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutHandle);
        reject(new Error(`${label} aborted before spawn`));
        return;
      }
      externalAbortHandler = () => abortFor('external');
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    };

    // Node guarantees a single settle, but `error` and `close` can both fire on
    // an aborted child; this makes the first-wins outcome explicit and ensures
    // cleanup runs exactly once.
    let settled = false;
    const settleResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const { exitCode, timedOut, signal: exitSignal } = error as Error & SpawnExitFields;
      if (exitCode !== undefined || timedOut || exitSignal) {
        capturedOutputs.set(error, { exitCode: exitCode ?? null, stdout, stderr });
      }
      reject(error);
    };

    const abortedError = (): Error => {
      const timedOut = abortCause !== 'external';
      const reason = timedOut ? `timeout after ${timeoutMs}ms` : 'external abort';
      return withExitFields(new Error(`${label} aborted (${reason}) (child process killed)`), { timedOut });
    };

    let stdout = '';
    let stderr = '';
    // A decoder per stream: a chunk can end inside a multi-byte character.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const appendCapped = (captured: string, text: string): string => {
      if (keepOutput === 'head') return captured.length < MAX_CAPTURED_OUTPUT_CHARS ? captured + text : captured;
      const joined = captured + text;
      return joined.length > 2 * MAX_CAPTURED_OUTPUT_CHARS ? joined.slice(-MAX_CAPTURED_OUTPUT_CHARS) : joined;
    };
    const onStdout = (chunk: Buffer): void => { stdout = appendCapped(stdout, stdoutDecoder.write(chunk)); };
    const onStderr = (chunk: Buffer): void => { stderr = appendCapped(stderr, stderrDecoder.write(chunk)); };
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        settleReject(abortedError());
        return;
      }
      settleReject(error);
    };
    const onClose = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (signalName) {
        // `error` and `close` race on an aborted child (first settle wins).
        // When `close` wins for an EXTERNAL abort, use the same wording the
        // `error` path produces: asserting the timeout here would classify a
        // deliberate cancellation (a superseding move's AbortController) as a
        // 'timeout' failure downstream (classifyFetchFailure), turning a
        // clean cancel into a spurious staleness toast.
        if (abortCause === 'external') {
          settleReject(abortedError());
          return;
        }
        const timeoutSuffix = signalKillAssertsTimeout ? ` after ${timeoutMs}ms timeout` : '';
        // A binary's timeout kills it through Node's `signal` option, and its
        // close can win the race with the `error` the abort raises.
        const timedOut = abortCause === 'timeout';
        settleReject(withExitFields(new Error(`${label} killed by signal ${signalName}${timeoutSuffix}`), { signal: signalName, timedOut }));
        return;
      }
      if (code !== 0) {
        const exitFields: SpawnExitFields = { timedOut: false, ...(typeof code === 'number' ? { exitCode: code } : {}) };
        settleReject(withExitFields(new Error(`${label} exited with code ${code}: ${stderr.trim() || stdout.trim()}`), exitFields));
        return;
      }
      settleResolve({ stdout, stderr });
    };

    // A command string is a project's script (the Post-Worktree Script, the
    // Stop script), which can start anything, so on macOS it runs through the
    // spawn-helper and keeps nothing it starts on Crashpad's exception port
    // (see shell-launch.ts). A binary spawn (git) is left alone.
    const launch = args === undefined
      ? resolveShellLaunch({ command })
      : { file: command, args: [...args], shell: false };
    // A shell command can start children of its own: cmd.exe always runs the
    // script as one, and `sh -c` forks for a compound script. Killing the shell
    // only left whatever the script started (an `npm install`) running in a
    // worktree about to be removed, and on Windows holding it open: a
    // superseded move's leftover script stalled the next creation at that path
    // by 12 s until it exited. So a shell command leads its own process group
    // on POSIX and loses its whole tree on abort or timeout, the way the
    // run-script automation's script does. A binary (git) is stopped alone.
    const killsTree = args === undefined;
    // Set once an abort has killed the tree: from then on the close settles
    // with the abort's wording, whatever exit code the kill left, and clears
    // the bound on that wait.
    let treeKilled = false;
    let treeExitWait: ReturnType<typeof setTimeout> | undefined;
    // Settle when the killed shell closes (every holder of its output pipes is
    // gone), or at TREE_EXIT_WAIT_MS, so an aborted call returns only once
    // nothing it started is still running in its directory.
    const awaitKilledTree = (): void => {
      treeKilled = true;
      treeExitWait = setTimeout(() => settleReject(abortedError()), TREE_EXIT_WAIT_MS);
      treeExitWait.unref?.();
    };
    const onCloseAfterKill = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (treeKilled) {
        clearTimeout(treeExitWait);
        settleReject(abortedError());
        return;
      }
      onClose(code, signalName);
    };

    // Either starts in the pty host when one is registered, so the start never
    // runs on this thread. A script is a run the app leaves alone at a quit
    // (`outlivesApp`), as it was while main started it: nothing here stopped a
    // script because the app was closing, and the host must not start to.
    const hostedChild: CliChildProcess | null = spawnOffMainCli(launch.file, launch.args, {
      cwd,
      shell: launch.shell,
      env,
      // Windows has no process groups; there `taskkill /T` walks the tree.
      detached: killsTree && process.platform !== 'win32',
      ...(killsTree ? { outlivesApp: true } : {}),
    });
    if (hostedChild) {
      controller.signal.addEventListener('abort', () => {
        if (killsTree) {
          // The whole tree at once, in the host, and on POSIX even when the
          // shell has exited and something it started still holds its output.
          // The stop is sent whether or not the start has been acknowledged:
          // the host holds it until the run has a pid.
          awaitKilledTree();
          if (hostedChild.stopTree) hostedChild.stopTree('treeNow');
          else hostedChild.kill();
          return;
        }
        // The host's stop ends git's tree with no exit signal to report on
        // Windows, so the abort settles here at once, with a local abort's wording.
        if (hostedChild.stopTree) hostedChild.stopTree();
        else hostedChild.kill();
        settleReject(abortedError());
      }, { once: true });
      hostedChild.stdout.on('data', onStdout);
      hostedChild.stderr.on('data', onStderr);
      hostedChild.on('error', (error: NodeJS.ErrnoException) => {
        // An error after the start is the pty host, or its spawn worker, lost
        // with the script running. Nothing can stop the script there any more,
        // and this call settles as failed, so what it started is ended by pid:
        // left running, it would be in the worktree when the creation is tried
        // again. A start that failed has no pid, and nothing to end.
        if (killsTree && hostedChild.pid !== undefined && !childHasExited(hostedChild)) killChildTreeByPid(hostedChild.pid);
        if (treeKilled) {
          clearTimeout(treeExitWait);
          settleReject(abortedError());
          return;
        }
        onError(error);
      });
      hostedChild.on('close', onCloseAfterKill);
      // The local spawn's stdin is 'ignore'; an ended pipe reads the same.
      hostedChild.stdin.end();
      return;
    }

    const spawnOptions: SpawnOptions = {
      cwd,
      shell: launch.shell,
      windowsHide: true,
      // Windows has no process groups; there `taskkill /T` walks the tree.
      ...(killsTree ? { detached: process.platform !== 'win32' } : { signal: controller.signal }),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    };
    // A shell-string launch keeps its args-free form (no DEP0190).
    const child = launch.shell
      ? spawn(launch.file, spawnOptions)
      : spawn(launch.file, launch.args, spawnOptions);

    if (killsTree) {
      // Kill the tree instead of the shell, never after it: `taskkill /T` finds
      // the children through their parent, which a dead shell no longer is.
      // On Windows a shell that already exited, its pipes still held open by
      // something it started, is not tree-killed: Node no longer pins its pid,
      // which may name a stranger by then (`child-tree-stop.ts`).
      controller.signal.addEventListener('abort', () => {
        if (child.pid === undefined) {
          settleReject(abortedError());
          return;
        }
        awaitKilledTree();
        killChildTreeNow(child, { leadsGroup: true });
      }, { once: true });
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onCloseAfterKill);
  });
}
