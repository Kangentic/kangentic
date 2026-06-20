import { spawn } from 'node:child_process';

/**
 * Generous wall-clock cap for a Post-Worktree init script (e.g. `npm install`).
 * Long enough for a cold dependency install, but bounded so a hung script
 * cannot hold the per-project git queue (WorktreeManager.withLock) forever.
 */
export const INIT_SCRIPT_TIMEOUT_MS = 600_000;

/**
 * Run a user-provided init script (the `git.initScript` "Post-Worktree
 * Script") in a freshly created worktree. Modeled on runGitWithTimeout: a
 * child_process.spawn with kill-on-timeout and optional external cancellation,
 * with stdout/stderr drained so Windows conpty buffers can't block the child.
 *
 * Cross-platform shell handling: the script is passed as a single command
 * STRING with `shell: true` and NO args array. Node then runs it through the
 * platform's shell -- `process.env.ComSpec` (cmd.exe) on Windows, `/bin/sh`
 * on POSIX -- so the user's script is parsed by the native shell on every OS
 * without us hardcoding a shell path or path separator. Omitting an args array
 * avoids the Node DEP0190 deprecation that fires when an args array is combined
 * with `shell: true` (the same reasoning documented in agent/shared/exec-version.ts).
 * `windowsHide: true` prevents a console window from flashing on Windows.
 *
 * The internal AbortController fires on the wall-clock deadline. An external
 * `signal` (superseding move, app shutdown) is forwarded to the same controller
 * and the forwarder is removed on settle so the external signal isn't held
 * referenced after the call resolves.
 *
 * Rejects on non-zero exit, kill-by-signal, or timeout/abort so the caller can
 * treat a failed init script as fatal.
 */
export function runInitScript(
  script: string,
  cwd: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const { timeoutMs, signal: externalSignal } = options;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutHandle);
        reject(new Error('init script aborted before spawn'));
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

    const child = spawn(script, {
      cwd,
      shell: true,
      windowsHide: true,
      signal: controller.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        const reason = externalSignal?.aborted ? 'external abort' : `timeout after ${timeoutMs}ms`;
        reject(new Error(`init script aborted (${reason}) (child process killed)`));
        return;
      }
      reject(error);
    });

    child.on('close', (code, signalName) => {
      cleanup();
      if (signalName) {
        // The error handler above already reports the abort/timeout case with the
        // correct reason; this branch covers a child killed by an external signal
        // (e.g. the OS), so it states the signal without asserting a timeout cause.
        reject(new Error(`init script killed by signal ${signalName}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`init script exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
