/**
 * resolveShellLaunch (src/main/pty/spawn/shell-launch.ts): on macOS a shell we
 * launch goes through node-pty's spawn-helper, which clears Crashpad's inherited
 * exception port before exec. Everywhere else, and with no usable helper, the
 * launch is exactly what the caller would have written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const { helperCandidatesMock, accessSyncMock } = vi.hoisted(() => ({
  helperCandidatesMock: vi.fn((): string[] => []),
  accessSyncMock: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: helperCandidatesMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, accessSync: accessSyncMock } };
});

import { findExecutableSpawnHelper, resolveShellLaunch } from '../../src/main/pty/spawn/shell-launch';

const HELPER = '/Applications/Kangentic.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  helperCandidatesMock.mockReset();
  helperCandidatesMock.mockReturnValue([]);
  accessSyncMock.mockReset();
});

describe('resolveShellLaunch on macOS with a helper', () => {
  beforeEach(() => setPlatform('darwin'));

  it('spells a command string out as `/bin/sh -c`, which is what shell: true runs, behind the helper', () => {
    expect(resolveShellLaunch({ command: 'npm run dev' }, () => HELPER)).toEqual({
      file: HELPER,
      args: ['', '/bin/sh', '-c', 'npm run dev'],
      shell: false,
    });
  });

  it('puts a shell and its argv behind the helper, with an empty cwd so the spawn\'s own cwd applies', () => {
    expect(resolveShellLaunch({ file: '/bin/zsh', args: ['-ilc', 'echo hi'] }, () => HELPER)).toEqual({
      file: HELPER,
      args: ['', '/bin/zsh', '-ilc', 'echo hi'],
      shell: false,
    });
  });
});

describe('resolveShellLaunch without a helper', () => {
  it('launches directly on macOS when no helper is usable', () => {
    setPlatform('darwin');

    expect(resolveShellLaunch({ command: 'npm run dev' }, () => null)).toEqual({
      file: 'npm run dev',
      args: [],
      shell: true,
    });
    expect(resolveShellLaunch({ file: '/bin/zsh', args: ['-c', 'x'] }, () => null)).toEqual({
      file: '/bin/zsh',
      args: ['-c', 'x'],
      shell: false,
    });
  });

  it.each(['linux', 'win32'] as const)('never looks for a helper on %s, and launches exactly as before', (platform) => {
    setPlatform(platform);
    const findHelper = vi.fn(() => HELPER);

    expect(resolveShellLaunch({ command: 'npm run dev' }, findHelper)).toEqual({
      file: 'npm run dev',
      args: [],
      shell: true,
    });
    expect(resolveShellLaunch({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'x'] }, findHelper)).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'x'],
      shell: false,
    });
    expect(findHelper).not.toHaveBeenCalled();
  });

  it('copies the args rather than handing back the caller\'s array', () => {
    setPlatform('linux');
    const args = ['-c', 'x'];

    const launch = resolveShellLaunch({ file: '/bin/sh', args });

    expect(launch.args).toEqual(args);
    expect(launch.args).not.toBe(args);
  });
});

describe('findExecutableSpawnHelper', () => {
  const RELEASE_HELPER = path.join('node-pty', 'build', 'Release', 'spawn-helper');
  const PREBUILT_HELPER = path.join('node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');

  it('returns the first candidate this process may execute', () => {
    helperCandidatesMock.mockReturnValue([RELEASE_HELPER, PREBUILT_HELPER]);
    accessSyncMock.mockImplementation((candidate: string) => {
      if (candidate === RELEASE_HELPER) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    expect(findExecutableSpawnHelper()).toBe(PREBUILT_HELPER);
  });

  it('asks for execute permission, not just existence', () => {
    helperCandidatesMock.mockReturnValue([PREBUILT_HELPER]);

    findExecutableSpawnHelper();

    expect(accessSyncMock).toHaveBeenCalledWith(PREBUILT_HELPER, expect.any(Number));
    const mode = accessSyncMock.mock.calls[0][1] as number;
    // X_OK is 1 on every platform Node supports.
    expect(mode & 1).toBe(1);
  });

  it('returns null when every candidate is missing or lacks the execute bit, so the caller spawns directly', () => {
    helperCandidatesMock.mockReturnValue([RELEASE_HELPER, PREBUILT_HELPER]);
    accessSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    expect(findExecutableSpawnHelper()).toBeNull();
  });

  it('returns null when node-pty cannot be resolved at all', () => {
    helperCandidatesMock.mockReturnValue([]);

    expect(findExecutableSpawnHelper()).toBeNull();
    expect(accessSyncMock).not.toHaveBeenCalled();
  });
});

describe('spawnHelperCandidatePaths', () => {
  it('lists build/Release before the darwin prebuild, the order node-pty\'s own loader tries', async () => {
    const actual = await vi.importActual<typeof import('../../src/main/pty/spawn/spawn-helper-permissions')>(
      '../../src/main/pty/spawn/spawn-helper-permissions'
    );

    const candidates = actual.spawnHelperCandidatePaths();

    expect(candidates).toHaveLength(2);
    expect(candidates[0].endsWith(path.join('node-pty', 'build', 'Release', 'spawn-helper'))).toBe(true);
    expect(
      candidates[1].endsWith(path.join('node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'))
    ).toBe(true);
  });
});
