import { spawn, type SpawnOptions } from 'node:child_process';
import { resolveShellLaunch } from '../pty/spawn/shell-launch';
import { withoutCrashpadPipeName } from '../shared/child-env';
import { killChildTreeByPid } from '../shared/child-tree-stop';
import { spawnOffMainCli, type CliChildProcess } from '../utility-process/off-main-cli';

/**
 * Per-stream cap on captured stdout/stderr. A verbose child (e.g. an
 * `npm install` Post-Worktree Script) can emit tens of megabytes; without a
 * bound the whole stream is held in memory and embedded in the rejection
 * Error that crosses IPC to the renderer. 1MB keeps enough context for a
 * useful error without the pathological case.
 */
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;

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
 * A binary (git) starts in the pty host when one is registered
 * (`spawnOffMainCli`), because on Windows the spawn is CreateProcess on the
 * calling thread, 15 to 30 ms each. The lifecycle around it stays here: the
 * timeout and the external signal stop the host's run (`stopTree`) and settle
 * with the same "aborted (...)" wording the local spawn's abort produces, which
 * `isGitTimeoutError` and `classifyFetchFailure` read. A shell command (the
 * init script) always runs here: it can start anything, and on macOS it goes
 * through the spawn-helper.
 */
export function spawnWithAbort(
  target: SpawnWithAbortTarget,
  options: SpawnWithAbortOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, label, signalKillAssertsTimeout } = target;
  const { timeoutMs, signal: externalSignal } = options;
  // Always passed, never inherited: git runs repository hooks and the init
  // script can start anything, so neither gets Crashpad's pipe name
  // (child-env.ts).
  const env = withoutCrashpadPipeName(options.env ?? process.env);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutHandle);
        reject(new Error(`${label} aborted before spawn`));
        return;
      }
      externalAbortHandler = () => controller.abort();
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
      reject(error);
    };

    const abortedError = (): Error => {
      const reason = externalSignal?.aborted ? 'external abort' : `timeout after ${timeoutMs}ms`;
      return new Error(`${label} aborted (${reason}) (child process killed)`);
    };

    let stdout = '';
    let stderr = '';
    const onStdout = (chunk: Buffer): void => {
      if (stdout.length < MAX_CAPTURED_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    };
    const onStderr = (chunk: Buffer): void => {
      if (stderr.length < MAX_CAPTURED_OUTPUT_CHARS) stderr += chunk.toString('utf8');
    };
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
        if (externalSignal?.aborted) {
          settleReject(new Error(`${label} aborted (external abort) (child process killed)`));
          return;
        }
        const timeoutSuffix = signalKillAssertsTimeout ? ` after ${timeoutMs}ms timeout` : '';
        settleReject(new Error(`${label} killed by signal ${signalName}${timeoutSuffix}`));
        return;
      }
      if (code !== 0) {
        settleReject(new Error(`${label} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      settleResolve({ stdout, stderr });
    };

    // A binary starts in the pty host when one is registered. The host's stop
    // ends the child's tree with no exit signal to report on Windows, so an
    // abort settles here at once, with the wording a local abort gives.
    const remoteChild: CliChildProcess | null = args === undefined
      ? null
      : spawnOffMainCli(command, [...args], {
        cwd,
        shell: false,
        env,
        detached: false,
      });
    if (remoteChild) {
      controller.signal.addEventListener('abort', () => {
        if (remoteChild.stopTree) remoteChild.stopTree();
        else remoteChild.kill();
        settleReject(abortedError());
      }, { once: true });
      remoteChild.stdout.on('data', onStdout);
      remoteChild.stderr.on('data', onStderr);
      remoteChild.on('error', onError);
      remoteChild.on('close', onClose);
      // The local spawn's stdin is 'ignore'; an ended pipe reads the same.
      remoteChild.stdin.end();
      return;
    }

    // A command string is the post-worktree init script, which can start
    // anything, so on macOS it runs through the spawn-helper and keeps nothing
    // it starts on Crashpad's exception port (see shell-launch.ts). A binary
    // spawn (git) is left alone.
    const launch = args === undefined
      ? resolveShellLaunch({ command })
      : { file: command, args: [...args], shell: false };
    // A shell command can start children of its own: cmd.exe always runs the
    // script as one, and `sh -c` forks for a compound script. Node's `signal`
    // option kills the shell only, which left whatever the script started (an
    // `npm install`) running in a worktree about to be removed, and on Windows
    // holding it open: a superseded move's leftover script stalled the next
    // creation at that path by 12 s until it exited. So a shell command leads
    // its own process group on POSIX and loses its whole tree on abort or
    // timeout, the way the run-script automation's script does. A binary (git)
    // keeps Node's own kill.
    const killsTree = args === undefined;
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
      controller.signal.addEventListener('abort', () => {
        if (child.pid !== undefined) killChildTreeByPid(child.pid);
        settleReject(abortedError());
      }, { once: true });
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
  });
}
