import { spawnWithAbort, type SpawnWithAbortOptions } from './spawn-with-abort';
import { remoteGitRunnerFor, type RemoteGitRunner } from './remote-git';

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
  // A project on an SSH host (#913): the fetch, the identity read and the rest run on the host, where the
  // repository is. A failed run rejects, as a local one does. The host's git never prompts (the run script sets
  // GIT_TERMINAL_PROMPT=0), so there is no interactive variant to choose; `env` is this computer's, and none of
  // it is sent.
  const remote = remoteGitRunnerFor(cwd);
  if (remote) return runOnHost(remote, args, options);
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

async function runOnHost(
  remote: RemoteGitRunner,
  args: readonly string[],
  options: GitSpawnOptions,
): Promise<{ stdout: string; stderr: string }> {
  const label = `git ${args.join(' ')}`;
  if (options.signal?.aborted) throw new Error(`${label} aborted before spawn`);
  // The signal cannot stop a run already on the host; the timeout does, there.
  const result = await remote.run(args, { timeoutMs: options.timeoutMs });
  const stdout = result.stdout.toString('utf8');
  if (result.code !== 0) throw new Error(`${label} exited with code ${result.code}: ${result.stderr.trim() || stdout.trim()}`);
  return { stdout, stderr: result.stderr };
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
