/**
 * Whether a spawn runs on a remote host, and if so everything the two spawn chokepoints need to run it
 * there (#913). `spawnAgent` (the transition engine) and `prepareAgentSpawn` (startup) both call
 * `resolveRemoteLaunch` with the project's path and the folder the agent starts in. A project that is
 * not remote answers null and the chokepoints go on exactly as before.
 *
 * For a remote project the local CLI is never detected: the CLI is on the host, named by the adapter's
 * `remoteCliName` and resolved by the host's own login PATH. The answer is an `ssh` place (the path map
 * between the project's shell folder here and its folder there, the host's home and shell, and the
 * helper's file jobs) and the descriptor `performSpawn` takes.
 *
 * The resolver is set once at startup, as the off-main executors are, so neither chokepoint needs a new
 * dependency threaded through its callers.
 */

import * as path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import { cliPathForTarget, isUnderLocalRoot, resolveCliTarget, type CliTarget, type SshCliPlace } from '../agent/shared/cli-target';
import type { ProjectRemote, SpawnRemote } from '../../shared/types';
import type { HelperRequestMap, HostCommandRequest, HostCommandResult, HostFileWrite } from './protocol/messages';

export type SshCliTarget = SshCliPlace & { linuxCliPath: string };

export interface RemoteLaunch {
  place: SshCliTarget;
  remote: SpawnRemote;
}

export interface RemoteLaunchInput {
  /** The project's path on this computer: for a remote project, its shell folder. Null when none is open. */
  projectPath: string | null | undefined;
  /** The folder the agent starts in, on this computer's side of the path map. */
  cwd: string;
  adapter: Pick<AgentAdapter, 'name' | 'displayName' | 'remoteCliName'>;
}

export interface RemoteLaunchResolver {
  resolve(input: RemoteLaunchInput): Promise<RemoteLaunch | null>;
}

/** An agent that has not been made to run on a host yet. */
export class RemoteAgentUnsupportedError extends Error {
  constructor(readonly agentName: string, displayName: string) {
    // No agent is named as the alternative: which adapters run on a host is theirs to declare (`remoteCliName`).
    super(`${displayName} cannot run on a remote host yet. Choose another agent for this project, or run this task on this computer.`);
    this.name = 'RemoteAgentUnsupportedError';
  }
}

/** A folder the path map does not cover: it would name a path on this computer to the host. */
export class RemoteFolderOutsideProjectError extends Error {
  constructor(readonly folder: string, readonly projectFolder: string) {
    super(`${folder} is not inside the remote project's folder (${projectFolder}), so the host cannot open it.`);
    this.name = 'RemoteFolderOutsideProjectError';
  }
}

let current: RemoteLaunchResolver | null = null;

export function setRemoteLaunchResolver(resolver: RemoteLaunchResolver | null): void {
  current = resolver;
}

export async function resolveRemoteLaunch(input: RemoteLaunchInput): Promise<RemoteLaunch | null> {
  return current ? current.resolve(input) : null;
}

/** The CLI a spawn runs and where, or null when no local CLI was found. */
export interface SpawnCli {
  /** The CLI as it is run: a path here, or the adapter's name for it on the host. */
  cliPath: string;
  cliTarget: CliTarget | null;
  /** Set for a remote project, whose CLI is the host's own. */
  remoteLaunch: RemoteLaunch | null;
  /** The detected local CLI's version, for the log; null on a host. */
  version: string | null;
}

/**
 * The CLI a spawn runs, as both spawn chokepoints decide it: on a remote project the host's own CLI,
 * never detected here; otherwise the detected local CLI, and for a CLI installed in a WSL distro that
 * distro. One decision in one place, so the board path and startup cannot drift apart. Each caller
 * keeps its own logging and its own answer to a CLI that was not found.
 */
export async function resolveSpawnCli(input: {
  projectPath: string | null | undefined;
  cwd: string;
  adapter: Pick<AgentAdapter, 'name' | 'displayName' | 'remoteCliName' | 'detect' | 'supportsWslCli'>;
  cliPathOverride: string | null;
}): Promise<SpawnCli | null> {
  const remoteLaunch = await resolveRemoteLaunch({ projectPath: input.projectPath, cwd: input.cwd, adapter: input.adapter });
  if (remoteLaunch) return { cliPath: remoteLaunch.place.linuxCliPath, cliTarget: remoteLaunch.place, remoteLaunch, version: null };
  const detection = await input.adapter.detect(input.cliPathOverride);
  if (!detection.found || !detection.path) return null;
  const cliTarget = await resolveCliTarget(detection.path, input.adapter.supportsWslCli === true);
  return { cliPath: detection.path, cliTarget, remoteLaunch: null, version: detection.version };
}

export interface RemoteLaunchResolverDeps {
  /** The project whose shell folder is `projectPath`, with its remote half, or null for a local one. */
  remoteOfProjectPath(projectPath: string): ProjectRemote | null;
  hostInfo(hostId: string): Promise<HelperRequestMap['hostInfo']['result']>;
  readFile(hostId: string, hostPath: string): Promise<HelperRequestMap['readFile']['result']>;
  jsonPatch(hostId: string, request: HelperRequestMap['jsonPatch']['params']): Promise<HelperRequestMap['jsonPatch']['result']>;
  writeFiles(hostId: string, files: HostFileWrite[]): Promise<{ written: number; conflicts?: string[] }>;
  removeFiles(hostId: string, paths: string[]): Promise<unknown>;
  pathPresence(hostId: string, paths: string[]): Promise<Array<'present' | 'absent'>>;
  runCommand(hostId: string, request: HostCommandRequest): Promise<HostCommandResult>;
  /** This computer's mirror folder for a host's home. */
  homeMirror(hostId: string): string;
}

export function createRemoteLaunchResolver(deps: RemoteLaunchResolverDeps): RemoteLaunchResolver {
  return {
    async resolve({ projectPath, cwd, adapter }) {
      const remote = projectPath ? deps.remoteOfProjectPath(projectPath) : null;
      if (!projectPath || !remote) return null;
      if (!adapter.remoteCliName) throw new RemoteAgentUnsupportedError(adapter.name, adapter.displayName);

      const info = await deps.hostInfo(remote.hostId);
      const place: SshCliTarget = {
        kind: 'ssh',
        hostId: remote.hostId,
        home: info.home,
        shellName: info.shellName,
        localHome: deps.homeMirror(remote.hostId),
        roots: [{ local: projectPath, host: remote.path }],
        linuxCliPath: adapter.remoteCliName,
        files: {
          readFile: (hostPath) => deps.readFile(remote.hostId, hostPath),
          jsonPatch: (request) => deps.jsonPatch(remote.hostId, request),
          writeFiles: (files) => deps.writeFiles(remote.hostId, files),
          removeFiles: (paths) => deps.removeFiles(remote.hostId, paths),
          pathPresence: (paths) => deps.pathPresence(remote.hostId, paths),
          runCommand: (request) => deps.runCommand(remote.hostId, request),
        },
      };
      const resolvedCwd = path.resolve(cwd);
      if (!isUnderLocalRoot(resolvedCwd, place.roots)) throw new RemoteFolderOutsideProjectError(cwd, remote.path);
      const hostCwd = cliPathForTarget(resolvedCwd, place);
      return { place, remote: { hostId: remote.hostId, cwd: hostCwd, shellName: info.shellName } };
    },
  };
}
