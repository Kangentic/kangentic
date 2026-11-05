import { simpleGit, type SimpleGit } from 'simple-git';
import { stackCallerLabel, withSpawnCaller } from '../diagnostics/spawn-caller';
import { runRemoteGitCommand } from './git-client';
import { remoteGitRunnerFor, RemoteGitUnavailableError, type RemoteGitRunner } from './remote-git';

/**
 * The ambient git variables simple-git 4 is told to keep. It removes every
 * inherited `GIT_*` key, plus `EDITOR`, `VISUAL`, `PAGER`, `PREFIX` and
 * `SSH_ASKPASS`, unless `allowEnvironment` names it.
 *
 * `GIT_CEILING_DIRECTORIES` stays because a dev preview sets it
 * (scripts/dev.js, scripts/preview-isolation.js): the preview's projects live
 * inside the worktree, and without the ceiling a git command run in one whose
 * `.git` is missing acts on the worktree above it. That once wiped a worktree's
 * uncommitted changes, and `writeWorktreeBaseBranch` writes config through this
 * client. `gitAt` and `spawnWithAbort` keep the variable, so these calls must
 * too. It is not an unsafe key, so allowing it needs no `unsafe` flag. A value
 * a user exports themselves passes the same way.
 */
export const SIMPLE_GIT_ALLOWED_ENVIRONMENT: readonly string[] = ['GIT_CEILING_DIRECTORIES'];

/**
 * A simple-git client for `directory`. Every simple-git call in the app opens
 * its client here, so the allowance above applies to all of them.
 *
 * In a dev build each method call also records its Kangentic caller for the
 * lag report's `spawn:git:<caller>` span: simple-git starts the process from
 * its own scheduler, behind an `await`, where the spawn's stack no longer
 * reaches the caller (`spawn-caller.ts`).
 */
export function openSimpleGit(directory: string): SimpleGit {
  const remote = remoteGitRunnerFor(directory);
  if (remote) return openRemoteGit(directory, remote);
  const client = simpleGit(directory, { allowEnvironment: SIMPLE_GIT_ALLOWED_ENVIRONMENT });
  return __KANGENTIC_DEV__ ? withCallerAttribution(client) : client;
}

/** What a client for a project on a host runs there. Anything else is refused, never run on this computer. */
const REMOTE_GIT_METHODS: ReadonlySet<string> = new Set(['raw', 'revparse', 'show', 'diff']);

/**
 * A client for a repository on an SSH host (#913). The call sites that read a project's git (the Changes panel,
 * the branch summary, blame, history, the commit graph) use `raw`, so those run on the host through the same
 * runner `gitAt` uses. Every other method throws `RemoteGitUnavailableError` when called, so a caller that
 * would have run this computer's git in the empty stand-in fails with a sentence, never with another
 * repository's answer or a quiet empty result.
 */
function openRemoteGit(directory: string, remote: RemoteGitRunner): SimpleGit {
  // Not a client that spawns on its own: a local client is only the shape the proxy answers for.
  const shape = simpleGit(directory, { allowEnvironment: SIMPLE_GIT_ALLOWED_ENVIRONMENT });
  const facade: Record<string, unknown> = {
    raw: (commands: string[]) => runRemoteGitCommand(remote, commands),
    revparse: async (options: string[]) => (await runRemoteGitCommand(remote, ['rev-parse', ...options])).trim(),
    show: (options: string[]) => runRemoteGitCommand(remote, ['show', ...options]),
    diff: (options: string[]) => runRemoteGitCommand(remote, ['diff', ...options]),
  };
  return new Proxy(shape, {
    get(target, property, receiver) {
      if (typeof property === 'string' && REMOTE_GIT_METHODS.has(property)) return facade[property];
      // The client is a thenable; `await`ing it must not call a method that throws.
      if (property === 'then') return undefined;
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return () => {
        throw new RemoteGitUnavailableError(`git ${String(property)} is not available for a project on a host yet.`);
      };
    },
  });
}

function withCallerAttribution(client: SimpleGit): SimpleGit {
  const proxy: SimpleGit = new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return function tracedGitMethod(...args: unknown[]): unknown {
        const result: unknown = withSpawnCaller(stackCallerLabel(), () => Reflect.apply(value, target, args));
        // A method that returns the client itself (`outputHandler`) stays behind the
        // proxy. `cwd(x)` and the command methods return a new chain object, which
        // does not: a spawn made through one runs without a caller label.
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}
