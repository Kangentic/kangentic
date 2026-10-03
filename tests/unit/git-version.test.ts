import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isVersionAtLeast, parseGitVersion } from '../../src/main/git/git-version';
import { MINIMUM_GIT_VERSION, MINIMUM_GIT_VERSION_DISPLAY } from '../../src/shared/git-minimum-version';

const { mockRaw } = vi.hoisted(() => ({ mockRaw: vi.fn() }));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({ raw: mockRaw })),
}));

describe('isVersionAtLeast', () => {
  it('returns true when versions are equal', () => {
    expect(isVersionAtLeast('2.25.0', '2.25.0')).toBe(true);
  });

  it('returns true when actual patch is higher', () => {
    expect(isVersionAtLeast('2.25.1', '2.25.0')).toBe(true);
  });

  it('returns true when actual minor is higher', () => {
    expect(isVersionAtLeast('2.26.0', '2.25.0')).toBe(true);
  });

  it('returns true when actual major is higher', () => {
    expect(isVersionAtLeast('3.0.0', '2.25.0')).toBe(true);
  });

  it('returns false when actual patch is lower', () => {
    expect(isVersionAtLeast('2.25.0', '2.25.1')).toBe(false);
  });

  it('returns false when actual minor is lower', () => {
    expect(isVersionAtLeast('2.24.0', '2.25.0')).toBe(false);
  });

  it('returns false when actual major is lower', () => {
    expect(isVersionAtLeast('1.99.99', '2.25.0')).toBe(false);
  });

  it('handles actual with more segments than minimum', () => {
    expect(isVersionAtLeast('2.43.0', '2.25.0')).toBe(true);
  });

  it('handles actual with fewer segments than minimum', () => {
    expect(isVersionAtLeast('3.0', '2.25.0')).toBe(true);
  });

  it('treats missing segments as zero', () => {
    expect(isVersionAtLeast('2.25', '2.25.0')).toBe(true);
    expect(isVersionAtLeast('2.25', '2.25.1')).toBe(false);
  });

  it('handles real-world git versions', () => {
    // Windows: "2.43.0" from "git version 2.43.0.windows.1"
    expect(isVersionAtLeast('2.43.0', '2.25.0')).toBe(true);
    // Old git
    expect(isVersionAtLeast('2.17.1', '2.25.0')).toBe(false);
    // Exact minimum
    expect(isVersionAtLeast('2.25.0', '2.25.0')).toBe(true);
  });

  it('sets the supported minimum at 2.26.0, the first git that can sparse-checkout a linked worktree', () => {
    expect(MINIMUM_GIT_VERSION).toBe('2.26.0');
    expect(MINIMUM_GIT_VERSION_DISPLAY).toBe('2.26');
    // 2.25.1 did not carry the worktree fix, so the whole 2.25 line is below it.
    expect(isVersionAtLeast('2.25.1', MINIMUM_GIT_VERSION)).toBe(false);
    expect(isVersionAtLeast('2.26.0', MINIMUM_GIT_VERSION)).toBe(true);
  });

  it('places the sparse-checkout `set --no-cone` boundary at 2.35.0', () => {
    expect(isVersionAtLeast('2.34.1', '2.35.0')).toBe(false);
    expect(isVersionAtLeast('2.35.0', '2.35.0')).toBe(true);
    expect(isVersionAtLeast('2.51.0', '2.35.0')).toBe(true);
  });
});

describe('parseGitVersion', () => {
  it('reads the version from each platform\'s `git --version` output', () => {
    expect(parseGitVersion('git version 2.51.0.windows.2\n')).toBe('2.51.0');
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)\n')).toBe('2.39.5');
    expect(parseGitVersion('git version 2.43.0\n')).toBe('2.43.0');
  });

  it('returns null when there is no x.y.z version', () => {
    expect(parseGitVersion('')).toBeNull();
    expect(parseGitVersion('git: command not found')).toBeNull();
  });
});

describe('getInstalledGitVersion', () => {
  beforeEach(() => {
    // The lookup caches at module level, so each test loads a fresh copy.
    vi.resetModules();
    mockRaw.mockReset();
  });

  it('runs `git --version` once and reuses the answer', async () => {
    mockRaw.mockResolvedValue('git version 2.51.0.windows.2\n');
    const { getInstalledGitVersion } = await import('../../src/main/git/git-version');

    expect(await getInstalledGitVersion()).toBe('2.51.0');
    expect(await getInstalledGitVersion()).toBe('2.51.0');
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw).toHaveBeenCalledWith(['--version']);
  });

  it('resolves null on failure and tries again on the next call', async () => {
    mockRaw.mockRejectedValueOnce(new Error('spawn git ENOENT'));
    mockRaw.mockResolvedValueOnce('git version 2.43.0\n');
    const { getInstalledGitVersion } = await import('../../src/main/git/git-version');

    expect(await getInstalledGitVersion()).toBeNull();
    expect(await getInstalledGitVersion()).toBe('2.43.0');
    expect(mockRaw).toHaveBeenCalledTimes(2);
  });

  it('resolves null, never rejects, when the output cannot be parsed', async () => {
    // A bare vi.fn() mock resolves undefined; parsing that must not poison the cache.
    mockRaw.mockResolvedValueOnce(undefined);
    mockRaw.mockResolvedValueOnce('git version 2.43.0\n');
    const { getInstalledGitVersion } = await import('../../src/main/git/git-version');

    await expect(getInstalledGitVersion()).resolves.toBeNull();
    expect(await getInstalledGitVersion()).toBe('2.43.0');
  });
});
