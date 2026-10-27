/**
 * The per-distro facts a WSL CLI needs (#286): the interactive shell's PATH
 * (where an nvm node resolves), the home both ways, the agent home overrides
 * and the networking mode. `wsl.exe` is injected, so this runs on every OS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  describeWslFailure,
  isWslDistroRunning,
  parseInteractiveEnvironment,
  parsePathsAndMode,
  resetWslDistroCacheForTests,
  resolveWslDistroFacts,
  type WslExec,
} from '../../src/main/agent/shared/wsl-distro';

const ENVIRONMENT_OUTPUT = [
  'Welcome to Ubuntu 24.04 LTS',
  '__KANGENTIC_ENV_BEGIN__',
  'SHELL=/bin/bash',
  'HOME=/home/dev',
  'PATH=/home/dev/.nvm/versions/node/v24.22.1/bin:/home/dev/.local/bin:/usr/bin',
  'CODEX_HOME=/home/dev/.config/codex',
  'SOME_SERVICE_SECRET=do-not-keep-this',
  'MULTILINE=first',
  'second line=not a key we want',
  '__KANGENTIC_ENV_END__',
  'goodbye from .bash_logout',
].join('\n');

const PATHS_OUTPUT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\r\n\\\\wsl.localhost\\Ubuntu\\\r\nnat\r\n';

beforeEach(() => {
  resetWslDistroCacheForTests();
});

describe('parseInteractiveEnvironment', () => {
  it('reads PATH, HOME and the agent overrides from between the markers only', () => {
    const captured = parseInteractiveEnvironment(ENVIRONMENT_OUTPUT);
    expect(captured.get('HOME')).toBe('/home/dev');
    expect(captured.get('PATH')).toBe('/home/dev/.nvm/versions/node/v24.22.1/bin:/home/dev/.local/bin:/usr/bin');
    expect(captured.get('CODEX_HOME')).toBe('/home/dev/.config/codex');
  });

  it('keeps nothing else the shell holds', () => {
    const captured = parseInteractiveEnvironment(ENVIRONMENT_OUTPUT);
    expect([...captured.keys()].sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    expect([...captured.values()].join(' ')).not.toContain('do-not-keep-this');
  });

  it('reads nothing when the markers are missing', () => {
    expect(parseInteractiveEnvironment('HOME=/home/dev\nPATH=/usr/bin').size).toBe(0);
  });

  it('drops the NULs of UTF-16 output', () => {
    const utf16Ish = ENVIRONMENT_OUTPUT.split('').join('\u0000');
    expect(parseInteractiveEnvironment(utf16Ish).get('HOME')).toBe('/home/dev');
  });
});

describe('parsePathsAndMode', () => {
  it('reads the home, the root without its trailing separator, and the mode', () => {
    expect(parsePathsAndMode(PATHS_OUTPUT)).toEqual({
      homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
      networkingMode: 'nat',
    });
  });

  it('reads an unknown mode as unknown', () => {
    expect(parsePathsAndMode('\\\\wsl$\\Debian\\home\\dev\n\\\\wsl$\\Debian\\\nunknown')?.networkingMode).toBe('unknown');
    expect(parsePathsAndMode('\\\\wsl$\\Debian\\home\\dev\n\\\\wsl$\\Debian\\\nmirrored')?.networkingMode).toBe('mirrored');
  });
});

describe('resolveWslDistroFacts', () => {
  function fakeWsl(): { run: WslExec; calls: string[][] } {
    const calls: string[][] = [];
    const run: WslExec = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      return args.includes('-c') && String(args[args.indexOf('-c') + 1]).includes('wslpath')
        ? { stdout: PATHS_OUTPUT, stderr: '' }
        : { stdout: ENVIRONMENT_OUTPUT, stderr: 'bash: no job control in this shell' };
    });
    return { run, calls };
  }

  it('reads the facts with two wsl.exe runs, passing the home as an argument, never in the script', async () => {
    const { run, calls } = fakeWsl();
    const facts = await resolveWslDistroFacts('Ubuntu', run);
    expect(facts).toEqual({
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
      interactivePath: '/home/dev/.nvm/versions/node/v24.22.1/bin:/home/dev/.local/bin:/usr/bin',
      env: { CODEX_HOME: '/home/dev/.config/codex' },
      networkingMode: 'nat',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 5)).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-c']);
    expect(calls[0][5]).toContain('-ic');
    expect(calls[1].slice(-2)).toEqual(['sh', '/home/dev']);
    expect(calls[1][5]).not.toContain('/home/dev');
  });

  it('reads a distro once and serves the cache after', async () => {
    const { run } = fakeWsl();
    await resolveWslDistroFacts('Ubuntu', run);
    await resolveWslDistroFacts('Ubuntu', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, and rejects with the error wsl.exe printed', async () => {
    const failing: WslExec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: wsl.exe'), { stderr: 'There is no distribution with the supplied name.\r\n', code: 1 });
    });
    await expect(resolveWslDistroFacts('Missing', failing)).rejects.toThrow('There is no distribution with the supplied name.');
    const { run } = fakeWsl();
    await expect(resolveWslDistroFacts('Missing', run)).resolves.toMatchObject({ distro: 'Missing' });
  });

  it('rejects when the shell gives no HOME or PATH', async () => {
    const empty: WslExec = vi.fn(async () => ({ stdout: '__KANGENTIC_ENV_BEGIN__\n__KANGENTIC_ENV_END__\n', stderr: '' }));
    await expect(resolveWslDistroFacts('Ubuntu', empty)).rejects.toThrow('Could not read HOME and PATH');
  });
});

describe('describeWslFailure', () => {
  it('prefers the first line of stderr, then stdout, then the message', () => {
    expect(describeWslFailure(Object.assign(new Error('x'), { stderr: "\n/usr/bin/env: 'node': No such file or directory\n" })))
      .toBe("/usr/bin/env: 'node': No such file or directory");
    expect(describeWslFailure(Object.assign(new Error('x'), { stderr: '', stdout: 'only on stdout' }))).toBe('only on stdout');
    expect(describeWslFailure(new Error('spawn wsl.exe ENOENT'))).toBe('spawn wsl.exe ENOENT');
  });
});

describe('isWslDistroRunning', () => {
  // Reading a stopped distro's share starts it, so the readers nobody asked
  // for ask this first. One `wsl.exe -l --running -q` answers a whole sweep.
  it('reads the running list, UTF-16 NULs and any case included', async () => {
    const run = vi.fn<WslExec>(async () => ({ stdout: 'U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\n\u0000docker-desktop\r\n', stderr: '' }));
    expect(await isWslDistroRunning('ubuntu', run, 1_000)).toBe(true);
    expect(await isWslDistroRunning('Debian', run, 1_000)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual(['-l', '--running', '-q']);
  });

  it('asks again once its answer is a few seconds old', async () => {
    const run = vi.fn<WslExec>()
      .mockResolvedValueOnce({ stdout: 'docker-desktop\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Ubuntu\ndocker-desktop\n', stderr: '' });
    expect(await isWslDistroRunning('Ubuntu', run, 1_000)).toBe(false);
    expect(await isWslDistroRunning('Ubuntu', run, 2_000)).toBe(false);
    expect(await isWslDistroRunning('Ubuntu', run, 7_000)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reads a list it cannot get as nothing running', async () => {
    const run = vi.fn<WslExec>(async () => { throw new Error('spawn wsl.exe ENOENT'); });
    expect(await isWslDistroRunning('Ubuntu', run, 1_000)).toBe(false);
  });
});
