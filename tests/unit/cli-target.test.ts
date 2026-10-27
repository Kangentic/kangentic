/**
 * The CLI target (#286): where an agent CLI runs when it is not this machine.
 * A null target must give exactly what the code gave before a target existed;
 * a WSL target gives the distro's view. Pure, so it runs on Linux CI.
 */
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import {
  cliEnvValue,
  cliHomeDir,
  cliInvocationForTarget,
  cliPathForTarget,
  cliPlatformForTarget,
  hostPathForTarget,
  parseStoredCliTarget,
  parseWslCliPath,
  resolveCliTarget,
  resolveStoredCliPlace,
  shellForTarget,
  toStoredCliTarget,
  type CliTarget,
} from '../../src/main/agent/shared/cli-target';
import type { WslDistroFacts } from '../../src/main/agent/shared/wsl-distro';

const FACTS: WslDistroFacts = {
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/home/dev/.nvm/versions/node/v24.22.1/bin:/usr/bin',
  env: { CODEX_HOME: '/home/dev/.config/codex' },
  networkingMode: 'nat',
};

const TARGET: CliTarget = { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude', facts: FACTS };
const CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

describe('parseWslCliPath', () => {
  it('names the distro and the in-distro path on Windows only', () => {
    expect(parseWslCliPath(CLI_PATH, 'win32')).toEqual({ distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude' });
    expect(parseWslCliPath(CLI_PATH, 'linux')).toBeNull();
    expect(parseWslCliPath(CLI_PATH, 'darwin')).toBeNull();
  });

  it('is null for a bare distro, a drive path, or nothing', () => {
    expect(parseWslCliPath('\\\\wsl$\\Ubuntu', 'win32')).toBeNull();
    expect(parseWslCliPath('C:\\Users\\dev\\.local\\bin\\claude.exe', 'win32')).toBeNull();
    expect(parseWslCliPath(null, 'win32')).toBeNull();
  });
});

describe('resolveCliTarget', () => {
  it('reads the facts for a WSL path on an adapter that runs from WSL', async () => {
    const resolveFacts = vi.fn(async () => FACTS);
    await expect(resolveCliTarget(CLI_PATH, true, { platform: 'win32', resolveFacts })).resolves.toEqual(TARGET);
    expect(resolveFacts).toHaveBeenCalledWith('Ubuntu');
  });

  it('is null, reading nothing, for an adapter without WSL support or a path that is not a WSL path', async () => {
    const resolveFacts = vi.fn(async () => FACTS);
    await expect(resolveCliTarget(CLI_PATH, false, { platform: 'win32', resolveFacts })).resolves.toBeNull();
    await expect(resolveCliTarget('C:\\bin\\claude.exe', true, { platform: 'win32', resolveFacts })).resolves.toBeNull();
    await expect(resolveCliTarget(CLI_PATH, true, { platform: 'linux', resolveFacts })).resolves.toBeNull();
    expect(resolveFacts).not.toHaveBeenCalled();
  });

  it('rejects with the distro error so the spawn fails with it', async () => {
    const resolveFacts = vi.fn(async () => { throw new Error('There is no distribution with the supplied name.'); });
    await expect(resolveCliTarget(CLI_PATH, true, { platform: 'win32', resolveFacts })).rejects.toThrow('no distribution');
  });
});

describe('the stored form', () => {
  it('keeps the kind and the distro, and reads it back', () => {
    expect(toStoredCliTarget(TARGET)).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
    expect(toStoredCliTarget(null)).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: 'Ubuntu' }))).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('reads anything else as this machine', () => {
    expect(parseStoredCliTarget(null)).toBeNull();
    expect(parseStoredCliTarget('not json')).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'ssh', host: 'box' }))).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: '' }))).toBeNull();
  });

  it('resolves a stored target back to a place with its facts', async () => {
    const resolveFacts = vi.fn(async () => FACTS);
    await expect(resolveStoredCliPlace({ kind: 'wsl', distro: 'Ubuntu' }, resolveFacts)).resolves.toEqual({ kind: 'wsl', distro: 'Ubuntu', facts: FACTS });
    await expect(resolveStoredCliPlace(null, resolveFacts)).resolves.toBeNull();
  });
});

describe('path helpers', () => {
  it('hands this machine forward slashes, byte for byte as before, and a WSL CLI the distro view', () => {
    expect(cliPathForTarget('C:\\proj\\.kangentic\\sessions\\a\\settings.json', null)).toBe('C:/proj/.kangentic/sessions/a/settings.json');
    expect(cliPathForTarget('C:\\proj\\.kangentic\\sessions\\a\\settings.json', TARGET)).toBe('/mnt/c/proj/.kangentic/sessions/a/settings.json');
  });

  it('maps a path the CLI reported back to one Kangentic can open', () => {
    expect(hostPathForTarget('/home/dev/.claude/projects/-mnt-c-proj/abc.jsonl', TARGET))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-mnt-c-proj\\abc.jsonl');
    expect(hostPathForTarget('/mnt/c/proj/.kangentic/x.json', TARGET)).toBe('C:\\proj\\.kangentic\\x.json');
    expect(hostPathForTarget('/mnt/d', TARGET)).toBe('D:\\');
    expect(hostPathForTarget('/home/dev/x', null)).toBe('/home/dev/x');
  });

  it('reads the home and environment where the CLI keeps them', () => {
    expect(cliHomeDir(TARGET)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev');
    expect(cliHomeDir(null)).toBe(os.homedir());
    expect(cliEnvValue('CODEX_HOME', TARGET)).toBe('/home/dev/.config/codex');
    expect(cliEnvValue('GROK_HOME', TARGET)).toBeUndefined();
  });

  it('quotes hooks for the shell that runs them and picks the session shell', () => {
    expect(cliPlatformForTarget(TARGET, 'win32')).toBe('linux');
    expect(cliPlatformForTarget(null, 'win32')).toBe('win32');
    expect(shellForTarget(TARGET)).toBe('wsl -d Ubuntu');
    expect(shellForTarget(null)).toBeNull();
  });
});

describe('cliInvocationForTarget', () => {
  it('starts the CLI directly in the distro on the interactive PATH, with env riding as arguments', () => {
    const invocation = cliInvocationForTarget(TARGET, ['--version'], { NO_COLOR: '1' });
    expect(invocation.file.toLowerCase().endsWith('wsl.exe')).toBe(true);
    expect(invocation.args).toEqual([
      '-d', 'Ubuntu', '-e', 'env',
      'PATH=/home/dev/.nvm/versions/node/v24.22.1/bin:/usr/bin',
      'NO_COLOR=1',
      '/home/dev/.local/bin/claude', '--version',
    ]);
  });
});
