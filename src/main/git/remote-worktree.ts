/**
 * How `WorktreeManager` reaches a worktree on an SSH host (#913). A remote project's repository is on the
 * host, so its git runs there and the worktree is made there. `WorktreeManager` asks the resolver below
 * for a backend when it is built for a project, and delegates the operations that cannot run on this
 * computer's disk to it. Every caller that builds a `WorktreeManager` therefore works for a remote
 * project without knowing it is one, and a local project never meets this module's backend.
 *
 * The resolver is registered at startup (`remote-hosting.ts`) rather than imported, so this git module
 * keeps its dependency direction: it does not reach into the SSH feature.
 */

import type { EnsureWorktreeResult, WorktreeRemovalProfile } from './worktree-manager';

/** What `WorktreeManager.ensureWorktree` reads of a task. */
export interface RemoteWorktreeTask {
  id: string;
  title: string;
  display_id: number;
  worktree_path: string | null;
  worktree_folder?: string | null;
  branch_name?: string | null;
  base_branch?: string | null;
  use_worktree?: number | null;
}

export interface RemoteWorktreeBackend {
  /** Make a task's worktree on the host, or say why none is made, or that it already has one. */
  ensureWorktree(
    task: RemoteWorktreeTask,
    gitConfig: { worktreesEnabled: boolean; defaultBaseBranch: string },
    options?: { onProgress?: (phase: string) => void; signal?: AbortSignal },
  ): Promise<EnsureWorktreeResult>;
  /**
   * Remove a worktree from the host and this computer's stand-in for it. False when the host could not
   * be asked or git refused: the caller leaves the task's worktree path set and tries again later.
   */
  removeWorktree(worktreePath: string, options?: { timeoutMs?: number; removalProfile?: WorktreeRemovalProfile }): Promise<boolean>;
  /**
   * What a worktree holds that a removal would destroy: its uncommitted files, as the host's git counts
   * them, and the branch it is on. Rejects when the host cannot answer, so a caller can take the safe
   * default (assume there are changes) instead of reading silence as a clean tree.
   */
  pendingChanges(worktreePath: string): Promise<{ uncommittedFileCount: number; currentBranch: string | null }>;
}

/** The backend for a project's folder on this computer, or null when the project is not on a host. */
export type RemoteWorktreeResolver = (projectPath: string) => RemoteWorktreeBackend | null;

let resolver: RemoteWorktreeResolver | null = null;

export function setRemoteWorktreeResolver(next: RemoteWorktreeResolver | null): void {
  resolver = next;
}

export function remoteWorktreeBackendFor(projectPath: string): RemoteWorktreeBackend | null {
  return resolver ? resolver(projectPath) : null;
}

/**
 * The backend for a task worktree's stand-in folder, `<project>/.kangentic/worktrees/<n>`, found from the
 * folder alone (a probe is handed only that), or null when the folder is not a remote project's. The project
 * is whatever lies before the marker, and only a folder exactly one below the marker counts.
 */
export function remoteWorktreeBackendForWorktree(worktreePath: string): RemoteWorktreeBackend | null {
  const normalized = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const marker = '/.kangentic/worktrees/';
  const index = normalized.lastIndexOf(marker);
  if (index <= 0) return null;
  const folder = normalized.slice(index + marker.length);
  if (folder === '' || folder.includes('/')) return null;
  // The project's path as the project list holds it: the platform's own separators.
  const projectPath = process.platform === 'win32' ? worktreePath.slice(0, index).replace(/\//g, '\\') : worktreePath.slice(0, index);
  return remoteWorktreeBackendFor(projectPath);
}
