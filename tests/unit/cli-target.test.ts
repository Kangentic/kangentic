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
  cliHomeDir,
  cliInvocationForTarget,
  cliPathForTarget,
  cliPlatformForTarget,
  execCliForTarget,
  hostPathForTarget,
  isSameCliPlace,
  parseStoredCliTarget,
  parseWslCliPath,
  placeFromStored,
  placeOfRecord,
  resolveCliTarget,
  serializeCliTarget,
  shellForTarget,
  targetOfPlace,
  toStoredCliTarget,
  wslExecutablePath,
  type CliPlace,
  type CliTarget,
} from '../../src/main/agent/shared/cli-target';
import type { WslDistroFacts } from '../../src/main/agent/shared/wsl-distro';
import { parseWslUncPath } from '../../src/shared/paths';
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

  // The session shell is `wsl -d <name>`, which the PTY spawn splits on
  // whitespace, and wsl.exe reads a leading dash as a flag. Both names are valid
  // share paths, so only the name check can refuse them.
  it('is null for a distro name with whitespace or a leading dash, and still names Ubuntu-22.04', () => {
    const spaced = '\\\\wsl.localhost\\My Distro\\usr\\bin\\claude';
    const dashed = '\\\\wsl.localhost\\-x\\usr\\bin\\claude';
    expect(parseWslUncPath(spaced)).toEqual({ distro: 'My Distro', linuxPath: '/usr/bin/claude' });
    expect(parseWslUncPath(dashed)).toEqual({ distro: '-x', linuxPath: '/usr/bin/claude' });

    expect(parseWslCliPath(spaced, 'win32')).toBeNull();
    expect(parseWslCliPath(dashed, 'win32')).toBeNull();
    expect(parseWslCliPath('\\\\wsl.localhost\\Ubuntu-22.04\\usr\\bin\\claude', 'win32'))
      .toEqual({ distro: 'Ubuntu-22.04', linuxCliPath: '/usr/bin/claude' });
  });
});

describe('resolveCliTarget', () => {
  it('is null, reading nothing, for a distro the session shell cannot name', async () => {
    const resolveFacts = vi.fn(async () => FACTS);
    await expect(resolveCliTarget('\\\\wsl.localhost\\My Distro\\usr\\bin\\claude', true, { platform: 'win32', resolveFacts })).resolves.toBeNull();
    await expect(resolveCliTarget('\\\\wsl.localhost\\-x\\usr\\bin\\claude', true, { platform: 'win32', resolveFacts })).resolves.toBeNull();
    expect(resolveFacts).not.toHaveBeenCalled();
  });

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
  linuxCliPath: '/home/dev/.local/bin/claude',
};

describe('the stored form', () => {
  it('keeps the CLI path, so a reader after the session can run the CLI there', () => {
    const place = placeFromStored(parseStoredCliTarget(serializeCliTarget(TARGET)));
    expect(targetOfPlace(place)).toEqual({ ...place, linuxCliPath: '/home/dev/.local/bin/claude' });
    // A row from before the path was kept, and a path that is not the distro's, give no target.
    expect(targetOfPlace(placeFromStored({ ...STORED, linuxCliPath: undefined } as StoredCliTarget))).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ ...STORED, linuxCliPath: 'C:\\bin\\claude.exe' }))?.linuxCliPath).toBeUndefined();
    expect(targetOfPlace(null)).toBeNull();
  });

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

  // A row names the distro the session shell `wsl -d <name>` was started in, so
  // a name that shell could never have taken is not a row this version wrote.
  it('reads a stored distro the session shell cannot name, whitespace or a leading dash, as this machine', () => {
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: 'My Distro' }))).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: '-x' }))).toBeNull();
    expect(parseStoredCliTarget(JSON.stringify({ ...STORED, distro: 'My Distro' }))).toBeNull();
    // The same shape with a usable name reads back, so the name alone was refused.
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'wsl', distro: 'Ubuntu-22.04' }))).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04' });
  });
});

describe('isSameCliPlace', () => {
  function placeIn(distro: string): CliPlace {
    return { kind: 'wsl', distro, facts: { ...FACTS, distro } };
  }
  const storedUbuntu = JSON.stringify(STORED);

  it('is true when both sides are this machine, and for a damaged row, which reads as this machine', () => {
    expect(isSameCliPlace(null, null)).toBe(true);
    expect(isSameCliPlace(undefined, null)).toBe(true);
    expect(isSameCliPlace('not json', null)).toBe(true);
    // A damaged row is this machine, not a wildcard that matches a distro.
    expect(isSameCliPlace('not json', placeIn('Ubuntu'))).toBe(false);
  });

  it('is true for the same distro, whatever the case of its name', () => {
    expect(isSameCliPlace(storedUbuntu, placeIn('Ubuntu'))).toBe(true);
    expect(isSameCliPlace(storedUbuntu, placeIn('ubuntu'))).toBe(true);
    expect(isSameCliPlace(JSON.stringify({ ...STORED, distro: 'UBUNTU' }), placeIn('ubuntu'))).toBe(true);
  });

  it('is false when exactly one side is a distro, or the distros differ', () => {
    expect(isSameCliPlace(storedUbuntu, null)).toBe(false);
    expect(isSameCliPlace(null, placeIn('Debian'))).toBe(false);
    expect(isSameCliPlace(storedUbuntu, placeIn('Debian'))).toBe(false);
  });
});

describe('path helpers', () => {
  it('hands this machine forward slashes, byte for byte as before, and a WSL CLI the distro view', () => {
    expect(cliPathForTarget('C:\\proj\\.kangentic\\sessions\\a\\settings.json', null)).toBe('C:/proj/.kangentic/sessions/a/settings.json');
    expect(cliPathForTarget('C:\\proj\\.kangentic\\sessions\\a\\settings.json', TARGET)).toBe('/mnt/c/proj/.kangentic/sessions/a/settings.json');
  });

  // A share path into another distro has no path from inside this one, and its
  // Linux path could name a different file here.
  it('leaves a path into another distro as it is, and maps one into the target\'s own distro without case', () => {
    const debianShare = '\\\\wsl.localhost\\Debian\\home\\dev\\x';
    const debianShareOldForm = '\\\\wsl$\\Debian\\home\\dev\\x';
    // The Linux path it would map to is real, so leaving it alone is cliPathForTarget's decision.
    expect(parseWslUncPath(debianShare)).toEqual({ distro: 'Debian', linuxPath: '/home/dev/x' });
    expect(TARGET.distro).toBe('Ubuntu');
    expect(cliPathForTarget(debianShare, TARGET)).toBe(debianShare);
    expect(cliPathForTarget(debianShareOldForm, TARGET)).toBe(debianShareOldForm);

    // The same share for the target's own distro, differing only in case.
    const lowerCaseOwnShare = '\\\\wsl.localhost\\ubuntu\\home\\dev\\x';
    expect(parseWslUncPath(lowerCaseOwnShare)?.distro).toBe('ubuntu');
    expect(cliPathForTarget(lowerCaseOwnShare, TARGET)).toBe('/home/dev/x');
    expect(cliPathForTarget('\\\\wsl.localhost\\Ubuntu\\home\\dev\\x', TARGET)).toBe('/home/dev/x');
  });

  it('maps a path the CLI reported back to one Kangentic can open', () => {
    expect(hostPathForTarget('/home/dev/.claude/projects/-mnt-c-proj/abc.jsonl', TARGET))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-mnt-c-proj\\abc.jsonl');
    expect(hostPathForTarget('/mnt/c/proj/.kangentic/x.json', TARGET)).toBe('C:\\proj\\.kangentic\\x.json');
    expect(hostPathForTarget('/mnt/d', TARGET)).toBe('D:\\');
    expect(hostPathForTarget('/home/dev/x', null)).toBe('/home/dev/x');
  });

  // The session manager maps a status line's transcript path as it arrives,
  // and the readers downstream map what they are given again.
  it('leaves a path that is already this machine\'s as it is, so mapping twice is mapping once', () => {
    const onShare = hostPathForTarget('/home/dev/.claude/projects/-mnt-c-proj/abc.jsonl', TARGET);
    expect(hostPathForTarget(onShare, TARGET)).toBe(onShare);
    expect(hostPathForTarget('C:\\proj\\x.json', TARGET)).toBe('C:\\proj\\x.json');
  });

  it('reads the home where the CLI keeps its files', () => {
    expect(cliHomeDir(TARGET)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev');
    expect(cliHomeDir(null)).toBe(os.homedir());
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

  it('keeps the distro\'s own PATH for a target read back from a session row, which captured none', () => {
    const fromRow = targetOfPlace(placeFromStored(parseStoredCliTarget(serializeCliTarget(TARGET))));
    expect(fromRow).not.toBeNull();
    expect(cliInvocationForTarget(fromRow!, ['export', 'ses_1']).args).toEqual([
      '-d', 'Ubuntu', '-e', 'env', '/home/dev/.local/bin/claude', 'export', 'ses_1',
    ]);
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

// node-pty's ConPTY spawn needs the absolute path, and it is a Windows path on
// every host. The host `path.join` gave `C:\Windows/System32/wsl.exe` on Linux,
// so this fails there if the join stops being `path.win32`.
describe('wslExecutablePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is wsl.exe under SystemRoot\\System32 as a Windows path, whatever the host', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    expect(wslExecutablePath()).toBe('C:\\Windows\\System32\\wsl.exe');
    vi.stubEnv('SystemRoot', 'D:\\Win');
    expect(wslExecutablePath()).toBe('D:\\Win\\System32\\wsl.exe');
  });

  it('falls back to C:\\Windows when SystemRoot is not set', () => {
    vi.stubEnv('SystemRoot', undefined);
    expect(wslExecutablePath()).toBe('C:\\Windows\\System32\\wsl.exe');
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
