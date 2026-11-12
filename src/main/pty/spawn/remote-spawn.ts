import type { AgentParser, SpawnRemote, SpawnSessionInput } from '../../../shared/types';
import { adaptCommandForShell, buildSpawnClearPrelude } from '../../../shared/paths';
import { HOST_LOGIN_SHELL } from '../../remote/protocol/messages';
import { addTaskProcessTag } from '../process-tag/task-process-tag';

/**
 * Everything `performSpawn` decides differently for a session that runs on a remote host (#913),
 * in one place. Each local decision it replaces is tied to THIS computer: main's shell setting,
 * its folder checks, its environment, its platform. None of those describe the host, so none may
 * reach it, and a scatter of `if (remote)` checks through the flow is how one gets missed.
 *
 * - The program is the host's own login shell (`HOST_LOGIN_SHELL`); the helper resolves which, as
 *   it must: this computer cannot know whether the user's shell there is zsh, fish or nushell.
 * - The cwd is the host path, verbatim. `resolveSpawnCwd` would test it against this computer's
 *   disk, find nothing, and replace it with a local home folder.
 * - The environment is what the adapter set, the task's process tag and a TERM. Never
 *   `buildSpawnEnv`'s result, which is main's whole environment: the helper layers the spawn's
 *   variables OVER the host's, so a sent `PATH` or `HOME` would replace the host's own.
 * - The typed command is quoted for the host's shell on Linux, whatever this computer runs.
 */
export interface RemoteSpawnPlan {
  hostId: string;
  /** The program to run on the host: always the host's login shell. */
  file: typeof HOST_LOGIN_SHELL;
  args: string[];
  /** The folder on the host, as given. */
  cwd: string;
  env: Record<string, string>;
  /** The host's shell, for quoting. */
  shellName: string;
  /** The line to type into the shell to start the agent, with the shell's own clear in front. */
  typedLine(command: string): string;
  /** Whether closing the console is the agent's own graceful exit on the host's platform (Linux). */
  consoleCloseIsGraceful: boolean;
}

/** The platform a host runs. Only Linux hosts are supported. */
export const REMOTE_HOST_PLATFORM: NodeJS.Platform = 'linux';

export function planRemoteSpawn(input: Pick<SpawnSessionInput, 'taskId' | 'env' | 'agentParser'>, remote: SpawnRemote): RemoteSpawnPlan {
  const taggedEnv = addTaskProcessTag({ ...(input.env ?? {}) }, input.taskId, { wslShell: false });
  const env = taggedEnv.TERM === undefined || taggedEnv.TERM === '' ? { ...taggedEnv, TERM: 'xterm-256color' } : taggedEnv;
  return {
    hostId: remote.hostId,
    file: HOST_LOGIN_SHELL,
    args: [],
    cwd: remote.cwd,
    env,
    shellName: remote.shellName,
    typedLine: (command) => buildSpawnClearPrelude(remote.shellName) + adaptCommandForShell(command, remote.shellName, REMOTE_HOST_PLATFORM),
    consoleCloseIsGraceful: consoleCloseIsGracefulOnHost(input.agentParser),
  };
}

/** Asked for the host's platform, never this computer's: Claude's hangup is measured on Linux, not on Windows' console close. */
export function consoleCloseIsGracefulOnHost(agentParser: AgentParser | undefined): boolean {
  return agentParser?.consoleCloseIsGraceful?.(REMOTE_HOST_PLATFORM) === true;
}
