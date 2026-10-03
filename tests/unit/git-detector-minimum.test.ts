/**
 * Unit coverage for `GitDetector.detect()`'s `meetsMinimum` verdict
 * (src/main/git/git-detector.ts).
 *
 * The floor is git 2.26.0, shared with the Welcome screen's warning through
 * `MINIMUM_GIT_VERSION`. git 2.25.0 has sparse-checkout but cannot use it in a
 * linked worktree, and 2.25.1 did not carry the 2.26.0 fix, so the detector used
 * to call 2.25.x "supported" while worktree creation silently lost the
 * `.claude/commands/` exclusion. git-version.test.ts pins `isVersionAtLeast`
 * against the constant; this file pins that the DETECTOR applies it, on the
 * output `git --version` really prints, and treats a version it cannot read as
 * unsupported.
 *
 * `which` and the off-main exec are mocked, so no git binary is consulted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whichMock, execFileAsyncMock } = vi.hoisted(() => ({
  whichMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
}));

vi.mock('which', () => ({ default: whichMock }));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({ execFileAsync: execFileAsyncMock }));

import { GitDetector } from '../../src/main/git/git-detector';

const GIT_PATH = '/mock/bin/git';

function gitReports(versionOutput: string): void {
  execFileAsyncMock.mockResolvedValue({ stdout: versionOutput, stderr: '' });
}

describe('GitDetector meetsMinimum', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whichMock.mockResolvedValue(GIT_PATH);
  });

  it.each([
    { output: 'git version 2.25.0\n', version: '2.25.0' },
    { output: 'git version 2.25.1\n', version: '2.25.1' },
    { output: 'git version 2.25.9.windows.1\n', version: '2.25.9' },
    { output: 'git version 2.9.5\n', version: '2.9.5' },
  ])('rejects $version, below the 2.26.0 floor', async ({ output, version }) => {
    gitReports(output);

    const info = await new GitDetector().detect();

    expect(info).toEqual({ found: true, path: GIT_PATH, version, meetsMinimum: false });
  });

  it.each([
    { output: 'git version 2.26.0\n', version: '2.26.0' },
    { output: 'git version 2.43.0.windows.1\n', version: '2.43.0' },
    { output: 'git version 2.39.5 (Apple Git-154)\n', version: '2.39.5' },
    { output: 'git version 3.0.0\n', version: '3.0.0' },
  ])('accepts $version, at or above the floor', async ({ output, version }) => {
    gitReports(output);

    const info = await new GitDetector().detect();

    expect(info).toEqual({ found: true, path: GIT_PATH, version, meetsMinimum: true });
  });

  it('reports an unparseable version as unsupported rather than guessing', async () => {
    gitReports('git version unknown\n');

    const info = await new GitDetector().detect();

    expect(info).toEqual({ found: true, path: GIT_PATH, version: null, meetsMinimum: false });
  });

  it('reports a git that cannot run `--version` as found but unsupported', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('spawn git ETIMEDOUT'));

    const info = await new GitDetector().detect();

    expect(info).toEqual({ found: true, path: GIT_PATH, version: null, meetsMinimum: false });
  });

  it('reports git as not found when it is not on PATH', async () => {
    whichMock.mockRejectedValue(new Error('not found: git'));

    const info = await new GitDetector().detect();

    expect(info).toEqual({ found: false, path: null, version: null, meetsMinimum: false });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('asks the resolved binary for its version, with a timeout', async () => {
    gitReports('git version 2.51.0\n');

    await new GitDetector().detect();

    expect(execFileAsyncMock).toHaveBeenCalledWith(GIT_PATH, ['--version'], expect.objectContaining({ timeout: expect.any(Number) }));
  });
});
