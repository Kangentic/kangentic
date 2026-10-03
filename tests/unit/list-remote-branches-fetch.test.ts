/**
 * Unit coverage for the fetch inside `WorktreeManager.listRemoteBranches`
 * (src/main/git/worktree-manager.ts).
 *
 * The branch picker waits on this call. A fetch ends with `git maintenance run
 * --auto`, and on Windows a due gc then runs INSIDE the fetch, so the picker sat
 * on a repack. The fetch passes `--no-auto-gc` for that reason, the same as
 * fetchIfStale. Nothing else observes the argv: the call is wrapped in a bare
 * try/catch and the result is only the branch list, so dropping the flag changes
 * no return value. The assertion has to read the command git received.
 *
 * WorktreeManager takes its SimpleGit as a constructor argument, so a plain
 * double stands in and no module mock is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SimpleGit } from 'simple-git';
import { WorktreeManager } from '../../src/main/git/worktree-manager';

const REMOTE_BRANCH_LISTING = [
  'origin/main',
  'origin/HEAD',
  'origin/feature/auth',
  'upstream/main',
  'origin/main',
  '',
].join('\n');

function makeManager(raw: ReturnType<typeof vi.fn>): WorktreeManager {
  return new WorktreeManager('/mock/project', { raw } as unknown as SimpleGit);
}

describe('WorktreeManager.listRemoteBranches fetch', () => {
  it('fetches with --prune and --no-auto-gc before it lists the remote branches', async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(REMOTE_BRANCH_LISTING);

    await makeManager(raw).listRemoteBranches();

    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[0][0]).toEqual(['fetch', '--prune', '--no-auto-gc']);
    expect(raw.mock.calls[1][0]).toEqual(expect.arrayContaining(['branch', '-r']));
  });

  it('keeps only origin branches, drops the HEAD symref, and de-duplicates', async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(REMOTE_BRANCH_LISTING);

    await expect(makeManager(raw).listRemoteBranches()).resolves.toEqual(['main', 'feature/auth']);
  });

  it('still lists the locally known remote branches when the fetch fails (offline)', async () => {
    const raw = vi.fn()
      .mockRejectedValueOnce(new Error('fatal: unable to access remote'))
      .mockResolvedValueOnce(REMOTE_BRANCH_LISTING);

    await expect(makeManager(raw).listRemoteBranches()).resolves.toEqual(['main', 'feature/auth']);
    expect(raw.mock.calls[0][0]).toEqual(['fetch', '--prune', '--no-auto-gc']);
  });
});
