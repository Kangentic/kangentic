/**
 * What `project:probePath` reports about a remote project's folder, read from the host's git (#913). The
 * folder on this computer is an empty stand-in, so this computer's git answers "not a repository" for every
 * remote project, and the Branch row then disabled Worktree for a repository that has a commit. The four
 * answers are the ones the host's own worktree script gives before it makes one (`remote-worktrees.ts`), in the
 * same terms: the folder is the top of a repository, is not itself a linked worktree, and has a commit.
 *
 * A host that cannot answer rejects (`RemoteGitRunner.run` does), and the caller lets it: the renderer reads
 * that as "unknown" and leaves the Worktree option alone, never as "not a repository".
 *
 * Imports nothing of electron.
 */

import type { RemoteGitRunner } from './remote-git';

export interface HostGitProbe {
  isGitRepo: boolean;
  isInsideWorktree: boolean;
  hasCommits: boolean;
  currentBranch: string | null;
}

const PROBE_TIMEOUT_MS = 15_000;

export async function probeGitOnHost(runner: Pick<RemoteGitRunner, 'run'>): Promise<HostGitProbe> {
  const read = async (args: string[]): Promise<{ code: number; text: string }> => {
    const result = await runner.run(args, { timeoutMs: PROBE_TIMEOUT_MS });
    return { code: result.code, text: result.stdout.toString('utf8').trim() };
  };

  const insideWorkTree = await read(['rev-parse', '--is-inside-work-tree']);
  const prefix = insideWorkTree.code === 0 ? await read(['rev-parse', '--show-prefix']) : null;
  // The top of a repository, as a local `.git` check reads it: a subfolder of one is not a project root.
  const isGitRepo = insideWorkTree.code === 0 && insideWorkTree.text === 'true' && prefix?.code === 0 && prefix.text === '';
  if (!isGitRepo) return { isGitRepo: false, isInsideWorktree: false, hasCommits: false, currentBranch: null };

  const [gitDir, commonDir, head, branch] = await Promise.all([
    read(['rev-parse', '--git-dir']),
    read(['rev-parse', '--git-common-dir']),
    read(['rev-parse', '--verify', '--quiet', 'HEAD']),
    read(['symbolic-ref', '--short', '-q', 'HEAD']),
  ]);
  return {
    isGitRepo: true,
    isInsideWorktree: gitDir.code === 0 && commonDir.code === 0 && gitDir.text !== commonDir.text,
    hasCommits: head.code === 0,
    currentBranch: branch.code === 0 && branch.text ? branch.text : null,
  };
}
