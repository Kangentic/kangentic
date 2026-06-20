/**
 * Unit tests for ShellResolver caching and the async WSL probe
 * (src/main/pty/spawn/shell-resolver.ts).
 *
 * getAvailableShells() used to call execSync('wsl --list') on every invocation,
 * synchronously blocking the main thread. It now uses async execFile and caches
 * the result for the session (shells do not change while the app runs). These
 * tests verify the cache (no re-probe on the second call), the reset hook, and
 * that the WSL probe is win32-only.
 *
 * process.platform is overridden per case to exercise both branches on any CI OS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('which', () => ({
  default: vi.fn(),
}));

import { execFile } from 'node:child_process';
import which from 'which';
import { ShellResolver, resetShellResolverCacheForTests } from '../../src/main/pty/spawn/shell-resolver';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetShellResolverCacheForTests();
  execFileMock.mockReset();
  whichMock.mockReset();
  // Every candidate resolves to a fake path so the shell list is non-empty.
  whichMock.mockImplementation(async (cmd: string) => `/usr/bin/${cmd}`);
  // The WSL probe resolves with a single distro.
  execFileMock.mockReturnValue(Promise.resolve({ stdout: 'Ubuntu\n', stderr: '' }));
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('ShellResolver caching', () => {
  it('probes WSL once and serves the cached list on the second call (win32)', async () => {
    setPlatform('win32');
    const resolver = new ShellResolver();

    const first = await resolver.getAvailableShells();
    const second = await resolver.getAvailableShells();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith('wsl', ['--list', '--quiet'], expect.objectContaining({ timeout: 5000 }));
    expect(second).toEqual(first);
    expect(first.some((shell) => shell.name === 'WSL: Ubuntu')).toBe(true);
  });

  it('shares the cache across separate ShellResolver instances', async () => {
    setPlatform('win32');

    await new ShellResolver().getAvailableShells();
    await new ShellResolver().getAvailableShells();

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes after resetShellResolverCacheForTests', async () => {
    setPlatform('win32');
    const resolver = new ShellResolver();

    await resolver.getAvailableShells();
    resetShellResolverCacheForTests();
    await resolver.getAvailableShells();

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('never invokes the WSL probe off Windows', async () => {
    setPlatform('linux');
    const resolver = new ShellResolver();

    const shells = await resolver.getAvailableShells();

    expect(execFileMock).not.toHaveBeenCalled();
    expect(shells.some((shell) => shell.name.startsWith('WSL:'))).toBe(false);
  });
});
