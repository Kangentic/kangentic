/**
 * Unit tests for src/shared/browser-partition.ts.
 *
 * The legacy BROWSER_PARTITION constant must stay stable. The per-worktree
 * browserPartitionForWorktree keys the embedded Browser pane's persistent
 * cookie jar by worktree so concurrent worktrees' localhost logins stay
 * isolated. The renderer (using the session cwd) and the main process
 * (building the path from disk) must derive the SAME name from the same
 * directory, so normalization (separators + case) and determinism are the
 * load-bearing properties.
 */

import { describe, it, expect } from 'vitest';
import {
  BROWSER_PARTITION,
  browserPartitionForWorktree,
} from '../../src/shared/browser-partition';

describe('BROWSER_PARTITION', () => {
  it('equals the canonical string "persist:kangentic-browser"', () => {
    expect(BROWSER_PARTITION).toBe('persist:kangentic-browser');
  });

  it('starts with "persist:" so Electron creates a named persistent session', () => {
    expect(BROWSER_PARTITION.startsWith('persist:')).toBe(true);
  });
});

describe('browserPartitionForWorktree', () => {
  it('is deterministic for the same path', () => {
    const path = 'C:/Users/dev/project/.kangentic/worktrees/feature-x';
    expect(browserPartitionForWorktree(path)).toBe(browserPartitionForWorktree(path));
  });

  it('produces a persist: partition with the kngbrowser prefix', () => {
    const partition = browserPartitionForWorktree('/home/dev/project');
    expect(partition).toMatch(/^persist:kngbrowser-[0-9a-f]{8}$/);
  });

  it('gives distinct worktrees distinct partitions', () => {
    const a = browserPartitionForWorktree('/home/dev/project/.kangentic/worktrees/a');
    const b = browserPartitionForWorktree('/home/dev/project/.kangentic/worktrees/b');
    expect(a).not.toBe(b);
  });

  it('normalizes path separators (backslash vs forward slash)', () => {
    const backslash = browserPartitionForWorktree('C:\\Users\\dev\\project\\wt');
    const forward = browserPartitionForWorktree('C:/Users/dev/project/wt');
    expect(backslash).toBe(forward);
  });

  it('normalizes case so a drive-letter casing difference still matches', () => {
    const lower = browserPartitionForWorktree('c:/users/dev/project/wt');
    const upper = browserPartitionForWorktree('C:/Users/Dev/Project/WT');
    expect(lower).toBe(upper);
  });

  it('ignores a trailing slash', () => {
    expect(browserPartitionForWorktree('/home/dev/project/wt/')).toBe(
      browserPartitionForWorktree('/home/dev/project/wt'),
    );
  });

  it('falls back to the legacy shared jar when no path is given', () => {
    expect(browserPartitionForWorktree(null)).toBe(BROWSER_PARTITION);
    expect(browserPartitionForWorktree(undefined)).toBe(BROWSER_PARTITION);
    expect(browserPartitionForWorktree('')).toBe(BROWSER_PARTITION);
  });
});
