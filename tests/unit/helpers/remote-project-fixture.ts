/**
 * One remote project as the tools see it: a shell folder here, a folder on the host, and a task whose worktree row
 * holds the stand-in. The paths are never written to disk.
 */
import * as path from 'node:path';
import { agentPathsForProject } from '../../../src/main/remote/host-paths';

export const SHELL_FOLDER = path.resolve('/mock/config/remote-projects/project-1');
export const HOST_PROJECT = '/home/dev/proj';
export const HOST_ID = 'host-1';
export const STAND_IN_WORKTREE = path.join(SHELL_FOLDER, '.kangentic', 'worktrees', '12');
export const HOST_WORKTREE = `${HOST_PROJECT}/.kangentic/worktrees/12`;

export const remoteProject = { path: SHELL_FOLDER, remote: { hostId: HOST_ID, path: HOST_PROJECT } };
export const remoteAgentPaths = agentPathsForProject(remoteProject);

/** The two fields a remote project's context carries beside what a local one does. */
export const remoteContextFields = {
  getProjectPath: () => SHELL_FOLDER,
  agentPaths: () => remoteAgentPaths,
};
