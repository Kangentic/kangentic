import { childProcessEnv } from '../shared/child-env';
import { capturedOutputOf, spawnWithAbort } from '../git/spawn-with-abort';
import { remoteGitRunnerFor, RemoteGitUnavailableError } from '../git/remote-git';
import { stripAnsiControlCodes } from '../../shared/ansi-strip';

/** How a git run that mutates ended, with both streams whatever its exit code. */
export interface CapturedGitRun {
  /** Null when git never exited on its own: a timeout, a kill, or a host that did not answer. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why there is no exit code. */
  unfinished: 'timeout' | 'unavailable' | null;
}

/** Hooks run inside a commit and a push, so a run gets as long as a slow test suite. */
export const GIT_ACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Run git and keep both streams for every exit. `runGitWithTimeout` keeps one of
 * them on a failure, and a hook prints its reason on either.
 *
 * `GIT_TERMINAL_PROMPT=0`: stdin is closed, so a prompt there could only hang.
 * A credential helper's own dialog is left alone, since the run follows a click.
 * `LANGUAGE=en`: failure.ts reads git's own words, which git translates. It picks
 * the language of messages only, so a hook keeps the user's locale and encoding.
 * The label names the subcommand only, never the arguments: they carry what the
 * user wrote.
 */
export async function runGitCaptured(
  directory: string,
  args: readonly string[],
  options: { timeoutMs?: number; keepOutput?: 'head' | 'tail' } = {},
): Promise<CapturedGitRun> {
  const timeoutMs = options.timeoutMs ?? GIT_ACTION_TIMEOUT_MS;
  const remote = remoteGitRunnerFor(directory);
  if (remote) {
    try {
      const result = await remote.run(args, { timeoutMs });
      return { exitCode: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr, unfinished: null };
    } catch (error) { // report-ok: a host that did not answer is an expected outcome, shown to the user
      if (!(error instanceof RemoteGitUnavailableError)) throw error;
      return { exitCode: null, stdout: '', stderr: error.message, unfinished: 'unavailable' };
    }
  }
  try {
    const { stdout, stderr } = await spawnWithAbort(
      { command: 'git', args, cwd: directory, label: `git ${args[0] ?? ''}`, signalKillAssertsTimeout: true },
      { timeoutMs, env: childProcessEnv({ GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'en' }), keepOutput: options.keepOutput ?? 'tail' },
    );
    return { exitCode: 0, stdout, stderr, unfinished: null };
  } catch (error) { // report-ok: a git exit code is an expected outcome; anything else is rethrown
    const captured = capturedOutputOf(error);
    if (captured === null) throw error;
    return {
      exitCode: captured.exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
      unfinished: captured.exitCode === null ? 'timeout' : null,
    };
  }
}

/** What an agent reads about a run: stderr then stdout, ANSI and blank ends removed, at most `maxChars` from the end. */
export function outputTail(run: Pick<CapturedGitRun, 'stdout' | 'stderr'>, maxChars: number): string {
  const joined = [run.stderr, run.stdout].map((text) => stripAnsiControlCodes(text).trim()).filter(Boolean).join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
