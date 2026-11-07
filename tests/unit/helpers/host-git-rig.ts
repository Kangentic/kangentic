/**
 * Shared by the tests that run the host's git scripts for real (POSIX only): a git command in a repository, and
 * the helper's own command runner over a fake home, so `HostGit` reaches a real `sh` and a real `git` (#913).
 */
import { spawnSync } from 'node:child_process';
import { runHostCommand } from '../../../src/main/remote/helper/host-command';
import type { HostCommandRequest, HostCommandResult } from '../../../src/main/remote/protocol/messages';

/** `git <args>` in `directory`, with a committer, throwing git's stderr when it fails. Returns stdout. */
export function gitIn(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** Runs a host command through the helper's real runner, with `home` as the host's home and `fallbackCwd` for a request with no folder. */
export function runHostCommandAt(request: HostCommandRequest, home: string, fallbackCwd: string): Promise<HostCommandResult> {
  return runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? fallbackCwd, baseEnv: { ...process.env, HOME: home } });
}
