import { spawnWithAbort, type SpawnWithAbortOptions } from './spawn-with-abort';

/**
 * Generous wall-clock cap for a Post-Worktree init script (e.g. `npm install`).
 * Long enough for a cold dependency install, but bounded so a hung script
 * cannot hold the per-project git queue (WorktreeManager.withLock) forever.
 */
export const INIT_SCRIPT_TIMEOUT_MS = 600_000;

/**
 * Run a user-provided init script (the `git.initScript` "Post-Worktree
 * Script") in a freshly created worktree.
 *
 * Cross-platform shell handling: the script is passed as a single command
 * STRING with `shell: true` and NO args array (spawnWithAbort omits the args
 * array when `args` is undefined). Node then runs it through the platform's
 * shell (`process.env.ComSpec` / cmd.exe on Windows, `/bin/sh` on POSIX), so
 * the user's script is parsed by the native shell on every OS without us
 * hardcoding a shell path or path separator. Omitting an args array avoids the
 * Node DEP0190 deprecation that fires when an args array is combined with
 * `shell: true` (the same reasoning documented in agent/shared/exec-version.ts).
 *
 * The shared spawnWithAbort lifecycle handles the wall-clock timeout, external
 * cancellation (a superseding move or app shutdown), drained stdio, and
 * single-settle. The signal-kill message does not assert a timeout cause, since
 * an external or OS signal is not necessarily a timeout.
 *
 * Rejects on non-zero exit, kill-by-signal, or timeout/abort so the caller can
 * treat a failed init script as fatal.
 */
export function runInitScript(
  script: string,
  cwd: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return spawnWithAbort(
    {
      command: script,
      cwd,
      label: 'init script',
      signalKillAssertsTimeout: false,
    },
    options satisfies SpawnWithAbortOptions,
  );
}
