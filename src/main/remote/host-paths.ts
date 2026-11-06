/**
 * The one map between what this computer records about a project and what an agent on its host sees (#913).
 *
 * A remote project's `project.path`, `task.worktree_path` and `sessions.cwd` are an empty stand-in folder on this
 * computer, and the same folder on the host is under `remote.path`. A tool that answers an agent, or a prompt that
 * tells it where it works, hands over the host's path (`toAgent`). A path the agent typed is mapped back (`fromAgent`)
 * before it meets anything recorded here. No caller compares paths or calls `localPathToHost` itself.
 *
 * `toAgent` only maps a string. It says what a stand-in is called on the host, not that a file is there: a path this
 * computer wrote under the shell folder (an attachment, a capture) exists on the host only once it was copied there.
 *
 * A local project is the identity, so a caller reads the same on both.
 *
 * No network and no electron: everything here is read from the project row and the session row.
 */

import {
  hostPathToLocal,
  isSshPlace,
  isUnderHostRoot,
  isUnderLocalRoot,
  localPathToHost,
  mirrorPathToHost,
  placeOfRecord,
  type SshCliPlace,
} from '../agent/shared/cli-target';
import type { Project, ProjectRemote, ValueLocation } from '../../shared/types';

export interface AgentPaths {
  /** Which machine the project's agent works on, so which one a mapped path is on. */
  location: ValueLocation;
  /** The project's host, or null for a project on this computer. */
  hostId: string | null;
  /** This computer's folder for the project, which is the project's own folder for a local one. */
  shellFolder: string;
  /** The project's folder as the agent sees it. */
  projectFolder: string;
  roots: SshCliPlace['roots'];
  /** A path this computer records, as the agent names it. A path the host already names, or under no root, is unchanged. */
  toAgent: <Value extends string | null | undefined>(localPath: Value) => Value;
  /** A path the agent named, as this computer records it. A path this computer already names, or under no root, is unchanged. */
  fromAgent: <Value extends string | null | undefined>(agentPath: Value) => Value;
  /** Whether a path names the project's folder or something in it, as the host names them. False for a local project. */
  isHostPath: (candidate: string) => boolean;
  /**
   * A path in this computer's mirror of the host's home, as the host names the original. Read off the session row
   * that made the copy, so it needs no network. Null for a path outside the mirror, and for a session not on a host.
   */
  mirrorToAgent: (localPath: string, record: { cli_target?: string | null } | null | undefined) => string | null;
  /**
   * A file a session keeps, wherever this computer reads it from, as the agent names the original: a mirror copy
   * through the session row, anything else through the project's folder. The path itself for a local project.
   */
  sessionFileToAgent: (localPath: string, record: { cli_target?: string | null } | null | undefined) => string;
}

const LOCAL_ROOTS: SshCliPlace['roots'] = [];

function localAgentPaths(projectPath: string): AgentPaths {
  return {
    location: 'local',
    hostId: null,
    shellFolder: projectPath,
    projectFolder: projectPath,
    roots: LOCAL_ROOTS,
    toAgent: (localPath) => localPath,
    fromAgent: (agentPath) => agentPath,
    isHostPath: () => false,
    mirrorToAgent: () => null,
    sessionFileToAgent: (localPath) => localPath,
  };
}

/** The map for one project, from its row. */
export function agentPathsForProject(project: Pick<Project, 'path' | 'remote'>): AgentPaths {
  const { remote } = project;
  if (!remote) return localAgentPaths(project.path);
  const roots: SshCliPlace['roots'] = [{ local: project.path, host: remote.path }];
  const mirrorToAgent: AgentPaths['mirrorToAgent'] = (localPath, record) => {
    const place = placeOfRecord(record);
    return isSshPlace(place) ? mirrorPathToHost(localPath, place) : null;
  };
  const toAgent = <Value extends string | null | undefined>(localPath: Value): Value => {
    if (!localPath || !isUnderLocalRoot(localPath, roots)) return localPath;
    return localPathToHost(localPath, roots) as Value;
  };
  return {
    location: 'host',
    hostId: remote.hostId,
    shellFolder: project.path,
    projectFolder: remote.path,
    roots,
    toAgent,
    fromAgent: <Value extends string | null | undefined>(agentPath: Value): Value => {
      if (!agentPath || !isUnderHostRoot(agentPath, roots)) return agentPath;
      return hostPathToLocal(agentPath, roots) as Value;
    },
    isHostPath: (candidate) => isUnderHostRoot(candidate, roots),
    mirrorToAgent,
    sessionFileToAgent: (localPath, record) => mirrorToAgent(localPath, record) ?? toAgent(localPath),
  };
}

/** What a tool holds: its context's map, or the identity for a context built without one (a test's, or a caller with no project row). */
export function agentPathsOf(context: { agentPaths?: () => AgentPaths; getProjectPath?: () => string }): AgentPaths {
  return context.agentPaths?.() ?? localAgentPaths(context.getProjectPath?.() ?? '');
}

/** The project a shell folder belongs to, or null for a folder of a project on this computer. */
export type RemoteProjectLookup = (projectPath: string) => ProjectRemote | null;

let remoteProjectLookup: RemoteProjectLookup | null = null;

/** Set once at startup, as the other remote resolvers are, so a caller holding only a path needs no new dependency. */
export function setRemoteProjectLookup(lookup: RemoteProjectLookup | null): void {
  remoteProjectLookup = lookup;
}

/** The map for a project known only by its path on this computer. The identity when the SSH feature never started. */
export function agentPathsForProjectPath(projectPath: string): AgentPaths {
  return agentPathsForProject({ path: projectPath, remote: remoteProjectLookup?.(projectPath) ?? null });
}
