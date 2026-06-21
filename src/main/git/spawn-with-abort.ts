import { spawn } from 'node:child_process';

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
 */
export function spawnWithAbort(
  target: SpawnWithAbortTarget,
  options: SpawnWithAbortOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, label, signalKillAssertsTimeout } = target;
  const { timeoutMs, signal: externalSignal } = options;
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

    const child = args === undefined
      ? spawn(command, { cwd, shell: true, windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, [...args], { cwd, windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT_CHARS) stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        const reason = externalSignal?.aborted ? 'external abort' : `timeout after ${timeoutMs}ms`;
        settleReject(new Error(`${label} aborted (${reason}) (child process killed)`));
        return;
      }
      settleReject(error);
    });

    child.on('close', (code, signalName) => {
      if (signalName) {
        const timeoutSuffix = signalKillAssertsTimeout ? ` after ${timeoutMs}ms timeout` : '';
        settleReject(new Error(`${label} killed by signal ${signalName}${timeoutSuffix}`));
        return;
      }
      if (code !== 0) {
        settleReject(new Error(`${label} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      settleResolve({ stdout, stderr });
    });
  });
}
