/**
 * The CLI target (#286): where an agent CLI runs when it is not this machine.
 * A null target must give exactly what the code gave before a target existed;
 * a WSL target gives the distro's view. Pure, so it runs on Linux CI.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

const execFileAsyncMock = vi.hoisted(() => vi.fn(async () => ({ stdout: 'usage', stderr: '' })));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({
  execFileAsync: execFileAsyncMock,
}));

import {
  cliEnvValue,
  cliHomeDir,
  cliInvocationForTarget,
  cliPathForTarget,
  cliPlatformForTarget,
  execCliForTarget,
  hostPathForTarget,
  parseStoredCliTarget,
  parseWslCliPath,
  placeFromStored,
  placeOfRecord,
  resolveCliTarget,
  resolveStoredCliPlace,
  serializeCliTarget,
  shellForTarget,
  toStoredCliTarget,
  type CliTarget,
} from '../../src/main/agent/shared/cli-target';
import type { WslDistroFacts } from '../../src/main/agent/shared/wsl-distro';
import type { StoredCliTarget } from '../../src/shared/types';

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

const STORED = {
  kind: 'wsl',
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  env: { CODEX_HOME: '/home/dev/.config/codex' },
};

describe('the stored form', () => {
  it('keeps the kind, the distro and the homes a reader needs, and reads them back', () => {
    expect(toStoredCliTarget(TARGET)).toEqual(STORED);
    expect(toStoredCliTarget(null)).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify(STORED))).toEqual(STORED);
    // A row written before the homes were kept still names its distro.
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: 'Ubuntu' }))).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('serializes for the session row without the interactive PATH or the networking mode', () => {
    const serialized = serializeCliTarget(TARGET);
    expect(serialized).not.toContain('nvm');
    expect(serialized).not.toContain('networkingMode');
    expect(serializeCliTarget(null)).toBeNull();
    expect(parseStoredCliTarget(serialized)).toEqual(STORED);
  });

  it('keeps only the named agent home keys of the distro environment, in and out', () => {
    const leaky: CliTarget = { ...TARGET, facts: { ...FACTS, env: { ...FACTS.env, GITHUB_TOKEN: 'secret' } as WslDistroFacts['env'] } };
    expect(serializeCliTarget(leaky)).not.toContain('secret');
    const tampered = JSON.stringify({ ...STORED, env: { CODEX_HOME: '/x', API_KEY: 'secret' } });
    expect(parseStoredCliTarget(tampered)?.env).toEqual({ CODEX_HOME: '/x' });
  });

  it('rebuilds a place from the stored homes with no call into the distro', () => {
    execFileAsyncMock.mockClear();
    const place = placeFromStored(STORED as StoredCliTarget);
    expect(place?.distro).toBe('Ubuntu');
    expect(place?.facts.homeUnc).toBe(FACTS.homeUnc);
    expect(place?.facts.uncRoot).toBe(FACTS.uncRoot);
    expect(place?.facts.env).toEqual({ CODEX_HOME: '/home/dev/.config/codex' });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(placeOfRecord({ cli_target: JSON.stringify(STORED) })?.facts.homeUnc).toBe(FACTS.homeUnc);
  });

  it('reads a stored target without its homes, and a row with none, as this machine', () => {
    expect(placeFromStored({ kind: 'wsl', distro: 'Ubuntu' })).toBeNull();
    expect(placeFromStored(null)).toBeNull();
    expect(placeOfRecord({ cli_target: null })).toBeNull();
    expect(placeOfRecord(null)).toBeNull();
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts the CLI directly in the distro on the interactive PATH', () => {
    const invocation = cliInvocationForTarget(TARGET, ['--version']);
    expect(invocation.file.toLowerCase().endsWith('wsl.exe')).toBe(true);
    expect(invocation.args).toEqual([
      '-d', 'Ubuntu', '-e', 'env',
      'PATH=/home/dev/.nvm/versions/node/v24.22.1/bin:/usr/bin',
      '/home/dev/.local/bin/claude', '--version',
    ]);
    expect(invocation.env).toEqual({});
  });

  // A token on the command line shows in the distro's process list; WSLENV
  // carries it into the distro without that.
  it('carries the caller\'s variables through WSLENV, never on the command line', () => {
    vi.stubEnv('WSLENV', 'USERPROFILE/p');
    const invocation = cliInvocationForTarget(TARGET, ['--version'], { KANGENTIC_MCP_TOKEN: 'secret-token', NO_COLOR: '1' });

    expect(invocation.args.join(' ')).not.toContain('secret-token');
    expect(invocation.args).not.toContain('NO_COLOR=1');
    expect(invocation.env).toEqual({
      KANGENTIC_MCP_TOKEN: 'secret-token',
      NO_COLOR: '1',
      WSLENV: 'USERPROFILE/p:KANGENTIC_MCP_TOKEN/u:NO_COLOR/u',
    });
  });
});

describe('execCliForTarget', () => {
  it('runs the CLI in its distro through wsl.exe, with the variables in WSLENV and wsl.exe\'s own messages in UTF-8', async () => {
    execFileAsyncMock.mockClear();
    vi.stubEnv('WSLENV', '');
    try {
      await expect(execCliForTarget(TARGET, ['--help'], { timeout: 5_000, cwd: 'C:\\proj', env: { NO_COLOR: '1' } }))
        .resolves.toEqual({ stdout: 'usage', stderr: '' });
    } finally {
      vi.unstubAllEnvs();
    }

    const [file, args, options] = execFileAsyncMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; cwd?: string; timeout: number }];
    expect(file.toLowerCase().endsWith('wsl.exe')).toBe(true);
    expect(args.slice(-2)).toEqual(['/home/dev/.local/bin/claude', '--help']);
    expect(options.cwd).toBe('C:\\proj');
    expect(options.timeout).toBe(5_000);
    expect(options.env.WSL_UTF8).toBe('1');
    expect(options.env.NO_COLOR).toBe('1');
    expect(options.env.WSLENV).toBe('NO_COLOR/u');
  });
});
