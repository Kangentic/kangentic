/**
 * The one vocabulary for "where will this agent work": the Branch row hint
 * (a prediction) and the reason the Worktree option is unavailable. This pins
 * every case of the pure builders in
 * `src/renderer/utils/worktree-placement.tsx` so the two dialogs cannot drift
 * from each other or from the main process's structural checks. The copy is
 * deliberately terse: the off-worktree hints mirror the existing on-worktree
 * sentences with the place swapped, and reasons are tooltip fragments.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import {
  computeBranchHint,
  describeWorktreeBlocker,
  resolveWorktreeBlocker,
  type BranchHintInput,
  type WorktreeBlocker,
} from '../../src/renderer/utils/worktree-placement';

function text(node: ReactNode): string {
  return renderToStaticMarkup(node as never).replace(/<[^>]+>/g, '');
}

function hintInput(overrides: Partial<BranchHintInput> = {}): BranchHintInput {
  return {
    customBranchName: '',
    branchExists: false,
    effectiveWorktree: true,
    effectiveBaseBranch: 'main',
    baseBranchPinned: false,
    currentBranch: 'main',
    blocker: null,
    ...overrides,
  };
}

describe('resolveWorktreeBlocker', () => {
  it('mirrors the main-process guard order: remote agent, then repo, nesting, commits', () => {
    const probe = { isGitRepo: false, isInsideWorktree: true, hasCommits: false };
    expect(resolveWorktreeBlocker({ probe, remoteAgent: true })).toBe('remote-agent');
    expect(resolveWorktreeBlocker({ probe, remoteAgent: false })).toBe('not-a-repo');
    expect(resolveWorktreeBlocker({ probe: { ...probe, isGitRepo: true }, remoteAgent: false })).toBe('nested-worktree');
    expect(resolveWorktreeBlocker({ probe: { isGitRepo: true, isInsideWorktree: false, hasCommits: false }, remoteAgent: false })).toBe('no-commits');
    expect(resolveWorktreeBlocker({ probe: { isGitRepo: true, isInsideWorktree: false, hasCommits: true }, remoteAgent: false })).toBeNull();
  });

  it('trusts the toggle alone until the probe answers', () => {
    expect(resolveWorktreeBlocker({ probe: null, remoteAgent: false })).toBeNull();
  });
});

describe('computeBranchHint', () => {
  it('worktree on: the three existing lines are unchanged', () => {
    expect(text(computeBranchHint(hintInput()))).toBe('Auto-generated branch will be created from main in a new worktree');
    expect(text(computeBranchHint(hintInput({ customBranchName: 'feature-x' }))))
      .toBe('feature-x will be created from main in a new worktree');
    expect(text(computeBranchHint(hintInput({ customBranchName: 'feature-x', branchExists: true }))))
      .toBe('feature-x exists and will be checked out in a new worktree');
  });

  it('worktree off: the same sentences with the place swapped', () => {
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, customBranchName: 'feature-x' }))))
      .toBe('feature-x will be created from main in the project folder');
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, customBranchName: 'feature-x', branchExists: true }))))
      .toBe('feature-x exists and will be checked out in the project folder');
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, baseBranchPinned: true, effectiveBaseBranch: 'release/2.0' }))))
      .toBe('release/2.0 will be checked out in the project folder');
  });

  it('worktree off, nothing to check out: names the folder and the branch it is on', () => {
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, currentBranch: 'develop' }))))
      .toBe('Runs in the project folder on develop');
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, currentBranch: null }))))
      .toBe('Runs in the project folder');
    // A pinned base or an existing custom branch already checked out: no checkout to announce.
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, baseBranchPinned: true, effectiveBaseBranch: 'main', currentBranch: 'main' }))))
      .toBe('Runs in the project folder on main');
    expect(text(computeBranchHint(hintInput({ effectiveWorktree: false, customBranchName: 'feature-x', branchExists: true, currentBranch: 'feature-x' }))))
      .toBe('Runs in the project folder on feature-x');
  });

  it.each(['not-a-repo', 'nested-worktree', 'no-commits'] as const)(
    'structural blocker %s overrides the toggle and says only where (the chip tooltip says why)',
    (blocker) => {
      expect(text(computeBranchHint(hintInput({ blocker, effectiveWorktree: true })))).toBe('Runs in the project folder');
    },
  );

  it('a remote agent runs on the server, in neither local place', () => {
    expect(text(computeBranchHint(hintInput({ blocker: 'remote-agent' })))).toBe('Runs on the remote server');
  });

  it('every line is short and authors no dash punctuation', () => {
    const cases: BranchHintInput[] = [
      hintInput({ effectiveWorktree: false }),
      hintInput({ effectiveWorktree: false, customBranchName: 'x', currentBranch: null }),
      hintInput({ effectiveWorktree: false, baseBranchPinned: true, effectiveBaseBranch: 'dev' }),
      hintInput({ blocker: 'no-commits' }),
      hintInput({ blocker: 'remote-agent' }),
    ];
    for (const input of cases) {
      const rendered = text(computeBranchHint(input));
      expect(rendered.length).toBeLessThanOrEqual(70);
      expect(rendered).not.toContain('—');
      expect(rendered).not.toContain('--');
    }
  });
});

describe('describeWorktreeBlocker', () => {
  it('names every blocker as a short fragment', () => {
    const blockers: WorktreeBlocker[] = ['not-a-repo', 'nested-worktree', 'no-commits', 'remote-agent'];
    for (const blocker of blockers) {
      const fragment = describeWorktreeBlocker(blocker);
      expect(fragment.length).toBeLessThanOrEqual(50);
      expect(fragment).not.toContain('—');
    }
  });
});
