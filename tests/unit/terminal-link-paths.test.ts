import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCliTarget } from '../../src/shared/types';
import { presentLinkPaths, revealLinkPath, withStatTimeout, type LinkPathDependencies } from '../../src/main/terminal-links/link-path-service';

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({
  execFileAsync: execFileAsyncMock,
  execAsync: vi.fn(),
}));
import { linkPlaceOfSession, resolveLinkPath, type LinkPathPlace, type SessionLinkFacts } from '../../src/main/terminal-links/resolve-link-path';

const LOCAL: LinkPathPlace = { kind: 'local' };
const UBUNTU: LinkPathPlace = { kind: 'wsl', distro: 'Ubuntu' };

function onWindows(printedPath: string, place: LinkPathPlace = LOCAL, cwd = 'C:\\Users\\dev\\project'): string | null {
  return resolveLinkPath(printedPath, { place, cwd, homeDirectory: 'C:\\Users\\dev', platform: 'win32' });
}

function onPosix(printedPath: string, cwd = '/home/dev/project'): string | null {
  return resolveLinkPath(printedPath, { place: LOCAL, cwd, homeDirectory: '/home/dev', platform: 'linux' });
}

describe('resolveLinkPath on Windows', () => {
  it.each([
    ['an absolute path', 'C:\\Users\\dev\\a.ts', 'C:\\Users\\dev\\a.ts'],
    ['forward slashes', 'C:/Users/dev/a.ts', 'C:\\Users\\dev\\a.ts'],
    ['a relative path', 'src\\a.ts', 'C:\\Users\\dev\\project\\src\\a.ts'],
    ['a relative path with forward slashes', 'src/a.ts', 'C:\\Users\\dev\\project\\src\\a.ts'],
    ['a parent path', '..\\other\\a.ts', 'C:\\Users\\dev\\other\\a.ts'],
    ['a home path', '~/a.ts', 'C:\\Users\\dev\\a.ts'],
    ['a Git Bash path', '/c/Users/dev/a.ts', 'C:\\Users\\dev\\a.ts'],
  ])('resolves %s', (_label, printed, expected) => {
    expect(onWindows(printed)).toBe(expected);
  });

  it.each([
    ['a network share', '\\\\fileserver\\share\\a.txt'],
    ['a network share in forward slashes', '//fileserver/share/a.txt'],
    ['a device path', '\\\\.\\PhysicalDrive0'],
    ['a verbatim path', '\\\\?\\C:\\a.txt'],
    ['a verbatim UNC path', '\\\\?\\UNC\\fileserver\\share\\a.txt'],
    ['a distro share from a Windows session', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts'],
    ['a rooted path with no drive', '/etc/hosts'],
    ['a NUL byte', 'src\\a\0.ts'],
    ['an empty string', ''],
  ])('refuses %s', (_label, printed) => {
    expect(onWindows(printed)).toBeNull();
  });

  it('refuses a relative path that lands on a network share', () => {
    expect(onWindows('a.txt', LOCAL, '\\\\fileserver\\share\\project')).toBeNull();
  });

  it('clamps a walk out of a distro share at its root, so no other host is reached', () => {
    expect(onWindows('../../../../other-host/share/a.txt', UBUNTU, '\\\\wsl.localhost\\Ubuntu\\home\\dev')).toBe('\\\\wsl.localhost\\Ubuntu\\other-host\\share\\a.txt');
  });
});

describe('resolveLinkPath on POSIX', () => {
  it.each([
    ['an absolute path', '/etc/hosts', '/etc/hosts'],
    ['a relative path', 'src/a.ts', '/home/dev/project/src/a.ts'],
    ['a parent path', '../other/a.ts', '/home/dev/other/a.ts'],
    ['a home path', '~/a.ts', '/home/dev/a.ts'],
  ])('resolves %s', (_label, printed, expected) => {
    expect(onPosix(printed)).toBe(expected);
  });
});

describe('resolveLinkPath in a WSL session', () => {
  it.each([
    ['a drive mount', '/mnt/c/Users/dev/a.ts', 'C:\\Users\\dev\\a.ts'],
    ['a distro path', '/home/dev/a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts'],
    ['a Windows path', 'C:\\Users\\dev\\a.ts', 'C:\\Users\\dev\\a.ts'],
    ['its own share', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts'],
    ['the older share name', '\\\\wsl$\\ubuntu\\home\\dev\\a.ts', '\\\\wsl$\\ubuntu\\home\\dev\\a.ts'],
    ['a relative path under a Windows folder', 'src/a.ts', 'C:\\Users\\dev\\project\\src\\a.ts'],
  ])('resolves %s', (_label, printed, expected) => {
    expect(onWindows(printed, UBUNTU)).toBe(expected);
  });

  it('resolves a relative path under a folder in the distro', () => {
    expect(onWindows('src/a.ts', UBUNTU, '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\src\\a.ts');
  });

  it.each([
    ['another distro', '\\\\wsl.localhost\\Debian\\home\\dev\\a.ts'],
    ['a network share', '\\\\fileserver\\share\\a.txt'],
    ['a home path, whose home is not known here', '~/a.ts'],
  ])('refuses %s', (_label, printed) => {
    expect(onWindows(printed, UBUNTU)).toBeNull();
  });

  it.each([
    ['a printed share path', '\\\\wsl.localhost\\Ubuntu\\..\\..\\fileserver\\share\\a.txt', '\\\\wsl.localhost\\Ubuntu\\fileserver\\share\\a.txt'],
    ['a Linux path', '/home/../../etc/hosts', '\\\\wsl.localhost\\Ubuntu\\etc\\hosts'],
  ])('reads a walk out of %s as the path the stat will reach, clamped at the share root', (_label, printed, expected) => {
    expect(onWindows(printed, UBUNTU)).toBe(expected);
  });

  it('reads a parent segment as the distro does before it picks a drive', () => {
    expect(onWindows('/mnt/c/../d/a.ts', UBUNTU)).toBe('D:\\a.ts');
  });

  it('refuses a Linux path with no distro to name, and still resolves a drive mount', () => {
    const noDistro: LinkPathPlace = { kind: 'wsl', distro: null };
    expect(onWindows('/home/dev/a.ts', noDistro)).toBeNull();
    expect(onWindows('/mnt/d/a.ts', noDistro)).toBe('D:\\a.ts');
  });
});

describe('linkPlaceOfSession', () => {
  const facts = (overrides: Partial<SessionLinkFacts>): SessionLinkFacts => ({
    shell: 'powershell',
    commandCwd: 'C:\\Users\\dev\\project',
    cliTarget: null,
    runsOnRemoteServer: false,
    ...overrides,
  });

  it('reads a plain shell as this machine', () => {
    expect(linkPlaceOfSession(facts({}))).toEqual({ kind: 'local' });
  });

  it('links nothing for an agent on a remote server, whose paths are not here', () => {
    expect(linkPlaceOfSession(facts({ runsOnRemoteServer: true }))).toBeNull();
  });

  it('names the distro from the shell, the folder, or the CLI target', () => {
    expect(linkPlaceOfSession(facts({ shell: 'wsl -d Ubuntu' }))).toEqual(UBUNTU);
    expect(linkPlaceOfSession(facts({ shell: 'wsl', commandCwd: '\\\\wsl.localhost\\Debian\\home\\dev' }))).toEqual({ kind: 'wsl', distro: 'Debian' });
    expect(linkPlaceOfSession(facts({ shell: 'wsl' }))).toEqual({ kind: 'wsl', distro: null });
    const cliTarget: StoredCliTarget = { kind: 'wsl', distro: 'Arch' };
    expect(linkPlaceOfSession(facts({ cliTarget }))).toEqual({ kind: 'wsl', distro: 'Arch' });
  });

  it('links nothing for an agent on an SSH host, whose paths are not on this computer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cliTarget: StoredCliTarget = { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'bash', localHome: '', roots: [] };
    expect(linkPlaceOfSession(facts({ cliTarget }))).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('links nothing for a CLI target it has not classified, and says so', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cliTarget = { kind: 'future-kind' } as unknown as StoredCliTarget;
    expect(linkPlaceOfSession(facts({ cliTarget }))).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

function dependencies(overrides: Partial<LinkPathDependencies> = {}): LinkPathDependencies {
  return {
    statIsPresent: vi.fn(async () => true),
    isDistroRunning: vi.fn(async () => true),
    defaultDistro: vi.fn(async () => 'Ubuntu'),
    reveal: vi.fn(),
    homeDirectory: 'C:\\Users\\dev',
    platform: 'win32',
    ...overrides,
  };
}

const LOCAL_FACTS: SessionLinkFacts = { shell: 'powershell', commandCwd: 'C:\\project', cliTarget: null, runsOnRemoteServer: false };
const WSL_FACTS: SessionLinkFacts = { ...LOCAL_FACTS, shell: 'wsl -d Ubuntu' };

describe('presentLinkPaths', () => {
  it('never stats a network path, which would send this user\'s credentials to that host', async () => {
    const stubs = dependencies();
    expect(await presentLinkPaths(['\\\\fileserver\\share\\a.txt', '//fileserver/share/a.txt'], LOCAL_FACTS, stubs)).toEqual([false, false]);
    expect(stubs.statIsPresent).not.toHaveBeenCalled();
  });

  it('never stats for a session that links nothing', async () => {
    const stubs = dependencies();
    expect(await presentLinkPaths(['src/a.ts'], { ...LOCAL_FACTS, runsOnRemoteServer: true }, stubs)).toEqual([false]);
    expect(stubs.statIsPresent).not.toHaveBeenCalled();
  });

  it('answers in request order', async () => {
    const stubs = dependencies({ statIsPresent: vi.fn(async (hostPath: string) => hostPath.endsWith('a.ts')) });
    expect(await presentLinkPaths(['src/a.ts', 'src/b.ts'], LOCAL_FACTS, stubs)).toEqual([true, false]);
  });

  it('does not touch a stopped distro, which a read would start', async () => {
    const stubs = dependencies({ isDistroRunning: vi.fn(async () => false) });
    expect(await presentLinkPaths(['/home/dev/a.ts'], WSL_FACTS, stubs)).toEqual([false]);
    expect(stubs.statIsPresent).not.toHaveBeenCalled();
  });

  it('still reaches a drive mount with the distro stopped', async () => {
    const stubs = dependencies({ isDistroRunning: vi.fn(async () => false) });
    expect(await presentLinkPaths(['/mnt/c/a.ts'], WSL_FACTS, stubs)).toEqual([true]);
  });

  it('finds the default distro for a bare wsl shell', async () => {
    const stubs = dependencies();
    await presentLinkPaths(['/home/dev/a.ts'], { ...LOCAL_FACTS, shell: 'wsl' }, stubs);
    expect(stubs.statIsPresent).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts');
  });

  it('holds a renderer to one row of paths', async () => {
    const stubs = dependencies();
    const answers = await presentLinkPaths(Array.from({ length: 50 }, (_unused, index) => `src/${index}.ts`), LOCAL_FACTS, stubs);
    expect(answers.length).toBeLessThanOrEqual(12);
  });
});

describe('revealLinkPath', () => {
  it('reveals what main resolved, not what the renderer holds', async () => {
    const stubs = dependencies();
    expect(await revealLinkPath('src/a.ts', LOCAL_FACTS, stubs)).toBe(true);
    expect(stubs.reveal).toHaveBeenCalledWith('C:\\project\\src\\a.ts');
  });

  it('reveals nothing that has gone since the hover', async () => {
    const stubs = dependencies({ statIsPresent: vi.fn(async () => false) });
    expect(await revealLinkPath('src/a.ts', LOCAL_FACTS, stubs)).toBe(false);
    expect(stubs.reveal).not.toHaveBeenCalled();
  });

  it('refuses a network path on the click too', async () => {
    const stubs = dependencies();
    expect(await revealLinkPath('\\\\fileserver\\share\\a.txt', LOCAL_FACTS, stubs)).toBe(false);
    expect(stubs.reveal).not.toHaveBeenCalled();
  });
});

describe('withStatTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a stat that never settles as missing once the timeout passes', async () => {
    const answer = withStatTimeout(new Promise<boolean>(() => {}), 1_000);
    const settled = vi.fn();
    void answer.then(settled);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(false);
  });

  it('reads a rejected stat as missing at once, and leaves no timer behind', async () => {
    expect(await withStatTimeout(Promise.reject(new Error('EACCES')), 1_000)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a fast answer through and clears its timer', async () => {
    expect(await withStatTimeout(Promise.resolve(true), 1_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('liveLinkPathDependencies.defaultDistro', () => {
  const WSL_LISTING = '  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  Debian    Stopped         2\r\n';

  /** A fresh module, since the read is cached for the life of the module. */
  async function freshDefaultDistro(): Promise<() => Promise<string | null>> {
    vi.resetModules();
    const fresh = await import('../../src/main/terminal-links/link-path-service');
    return fresh.liveLinkPathDependencies.defaultDistro;
  }

  beforeEach(() => {
    execFileAsyncMock.mockReset();
  });

  it('runs wsl.exe once however many paths ask, after it found a default', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: WSL_LISTING, stderr: '' });
    const defaultDistro = await freshDefaultDistro();

    expect(await defaultDistro()).toBe('Ubuntu');
    expect(await defaultDistro()).toBe('Ubuntu');
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('asks again after a read that found nothing', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('wsl.exe missing'));
    execFileAsyncMock.mockResolvedValueOnce({ stdout: WSL_LISTING, stderr: '' });
    const defaultDistro = await freshDefaultDistro();

    expect(await defaultDistro()).toBeNull();
    expect(await defaultDistro()).toBe('Ubuntu');
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });
});
