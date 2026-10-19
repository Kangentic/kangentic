import { spawnWithAbort, type SpawnWithAbortOptions } from './spawn-with-abort';

/**
 * Run a `git` subcommand with kill-on-timeout and optional external
 * cancellation. The git client (`git-client.ts`) has no abort primitive, so
 * any operation that can hang (network fetch, worktree remove on locked file
 * handles) needs this path.
 *
 * The lifecycle (internal timeout, external-signal forwarding, drained
 * stdio, single-settle) lives in spawnWithAbort, which starts the child in
 * the pty host when one is registered; this wrapper supplies the git binary,
 * args, and the git-flavored error labels.
 */
export interface GitSpawnOptions {
  /** Wall-clock cap. On expiry the child is killed via internal AbortController. */
  timeoutMs: number;
  /** External cancellation. Race-combined with the internal timeout. */
  signal?: AbortSignal;
  /** The child's environment; omitted is main's, without Crashpad's pipe name (see spawn-with-abort.ts). */
  env?: NodeJS.ProcessEnv;
}

export function runGitWithTimeout(
  cwd: string,
  args: readonly string[],
  options: GitSpawnOptions,
): Promise<{ stdout: string; stderr: string }> {
  return spawnWithAbort(
    {
      command: 'git',
      args,
      cwd,
      label: `git ${args.join(' ')}`,
      signalKillAssertsTimeout: true,
    },
    options satisfies SpawnWithAbortOptions,
  );
}

/**
 * Returns true if the error message indicates the timeout fired (vs a
 * normal git error like "no such branch"). Used by callers that want to
 * log the timeout case distinctly.
 */
export function isGitTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('aborted (timeout after');
}
