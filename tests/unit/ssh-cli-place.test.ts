/**
 * A CLI on a remote host over SSH is a `CliPlace` of kind `ssh` (#913). The place maps the paths this
 * computer builds under a project's shell folder onto the host's folder, and back, so an adapter that
 * already speaks "the CLI's view of a path" (`cliPathForTarget`) needs no host-specific code.
 *
 * What a user loses if it breaks: a hook script, settings file or working folder named by a path that
 * is this computer's, which does not exist on the host.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  cliHomeDir,
  cliPathForTarget,
  hostPathForTarget,
  hostPathToLocal,
  isSameCliPlace,
  localPathToHost,
  mayReadPlaceUnattended,
  parseStoredCliTarget,
  placeFromStored,
  serializeCliTarget,
  shellForTarget,
  toStoredCliTarget,
  type SshCliPlace,
} from '../../src/main/agent/shared/cli-target';

const shellFolder = path.join('C:\\Users\\dev', 'remote-projects', 'p1');

function sshPlace(overrides: Partial<SshCliPlace> = {}): SshCliPlace {
  return {
    kind: 'ssh',
    hostId: 'host-a',
    home: '/home/dev',
    shellName: 'fish',
    localHome: path.join('C:\\Users\\dev', 'remote-homes', 'host-a'),
    roots: [{ local: shellFolder, host: '/home/dev/projects/api' }],
    ...overrides,
  };
}

describe('mapping a path to the host', () => {
  it('moves a path under the shell folder onto the host folder, with forward slashes', () => {
    expect(cliPathForTarget(path.join(shellFolder, '.kangentic', 'sessions', 's1', 'settings.json'), sshPlace()))
      .toBe('/home/dev/projects/api/.kangentic/sessions/s1/settings.json');
    expect(cliPathForTarget(shellFolder, sshPlace())).toBe('/home/dev/projects/api');
  });

  it('maps a worktree under the shell folder the same way', () => {
    expect(cliPathForTarget(path.join(shellFolder, '.kangentic', 'worktrees', 'fix-login'), sshPlace()))
      .toBe('/home/dev/projects/api/.kangentic/worktrees/fix-login');
  });

  it('leaves a path under no root as written, in forward slashes, and never prefix-matches a sibling folder', () => {
    expect(localPathToHost('C:\\elsewhere\\file.txt', sshPlace().roots)).toBe('C:/elsewhere/file.txt');
    expect(localPathToHost(`${shellFolder}-copy\\file.txt`, sshPlace().roots)).toBe(`${shellFolder.replace(/\\/g, '/')}-copy/file.txt`);
  });

  it('takes the longest matching root', () => {
    const roots = [
      { local: shellFolder, host: '/home/dev/projects/api' },
      { local: path.join(shellFolder, 'docs'), host: '/srv/docs' },
    ];
    expect(localPathToHost(path.join(shellFolder, 'docs', 'a.md'), roots)).toBe('/srv/docs/a.md');
    expect(localPathToHost(path.join(shellFolder, 'src', 'a.ts'), roots)).toBe('/home/dev/projects/api/src/a.ts');
  });

  it('is not the WSL mapping: a host never sees a /mnt path', () => {
    expect(cliPathForTarget(path.join(shellFolder, 'a'), sshPlace())).not.toContain('/mnt/');
  });
});

describe('mapping a path the CLI reported back', () => {
  it('opens a host path under a root in this computer\'s shell folder', () => {
    expect(hostPathToLocal('/home/dev/projects/api/.kangentic/sessions/s1/status.json', sshPlace().roots))
      .toBe(path.join(shellFolder, '.kangentic', 'sessions', 's1', 'status.json'));
    expect(hostPathForTarget('/home/dev/projects/api/src/a.ts', sshPlace())).toBe(path.join(shellFolder, 'src', 'a.ts'));
  });

  it('leaves a host path under no root alone, because it names a file this computer does not have', () => {
    expect(hostPathToLocal('/etc/hosts', sshPlace().roots)).toBe('/etc/hosts');
  });

  it('does not match a sibling folder that shares a name prefix', () => {
    expect(hostPathToLocal('/home/dev/projects/api-old/a.ts', sshPlace().roots)).toBe('/home/dev/projects/api-old/a.ts');
  });

  it('never maps a path that climbs out of a root through `..` into the shell folder', () => {
    expect(hostPathToLocal('/home/dev/projects/api/../../secrets.txt', sshPlace().roots)).toBe('/home/dev/projects/api/../../secrets.txt');
  });
});

describe('a path spelled differently', () => {
  it('resolves `..` before matching a root, on the way to the host', () => {
    expect(localPathToHost(`${shellFolder}\\src\\..\\README.md`, sshPlace().roots)).toBe('/home/dev/projects/api/README.md');
  });

  // Windows paths ignore case, so a working directory in other letter case is still under its root.
  it.runIf(process.platform === 'win32')('matches a root whatever its letter case on Windows', () => {
    expect(localPathToHost(`${shellFolder.toLowerCase()}\\src\\a.ts`, sshPlace().roots)).toBe('/home/dev/projects/api/src/a.ts');
  });
});

describe('the place', () => {
  it('types into the host\'s own shell', () => {
    expect(shellForTarget(sshPlace({ shellName: 'zsh' }))).toBe('zsh');
  });

  it('keeps readers on this computer\'s mirror folder, never the user\'s real home', () => {
    expect(cliHomeDir(sshPlace())).toBe(sshPlace().localHome);
  });

  it('may be read unattended: reading a mirror folder starts nothing', async () => {
    expect(await mayReadPlaceUnattended(sshPlace())).toBe(true);
  });

  it('is the same place only for the same host, and never the same as this machine or a distro', () => {
    const stored = serializeCliTarget(sshPlace());
    expect(isSameCliPlace(stored, sshPlace())).toBe(true);
    expect(isSameCliPlace(stored, sshPlace({ hostId: 'host-b' }))).toBe(false);
    expect(isSameCliPlace(stored, null)).toBe(false);
    expect(isSameCliPlace(null, sshPlace())).toBe(false);
    expect(isSameCliPlace(null, null)).toBe(true);
  });
});

describe('what a session row keeps', () => {
  it('round-trips through JSON, with the host, its home, shell and roots', () => {
    const raw = serializeCliTarget(sshPlace({ linuxCliPath: '/home/dev/.local/bin/claude' }));
    const stored = parseStoredCliTarget(raw);
    expect(stored).toEqual({
      kind: 'ssh',
      hostId: 'host-a',
      home: '/home/dev',
      shellName: 'fish',
      localHome: sshPlace().localHome,
      roots: sshPlace().roots,
      linuxCliPath: '/home/dev/.local/bin/claude',
    });
    expect(placeFromStored(stored)).toMatchObject({ kind: 'ssh', hostId: 'host-a', roots: sshPlace().roots });
  });

  it('reads a row without a host id, or with damaged roots, as no place rather than guessing', () => {
    expect(parseStoredCliTarget(JSON.stringify({ kind: 'ssh', home: '/home/dev' }))).toBeNull();
    const damaged = parseStoredCliTarget(JSON.stringify({ kind: 'ssh', hostId: 'h', roots: [{ local: 1 }, 'x', { local: 'a', host: '/b' }] }));
    expect(damaged).toMatchObject({ kind: 'ssh', hostId: 'h', roots: [{ local: 'a', host: '/b' }] });
  });

  it('keeps a distro and a host apart in one stored column', () => {
    const distro = toStoredCliTarget({ kind: 'wsl', distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl$\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl$\\Ubuntu' });
    expect(distro?.kind).toBe('wsl');
    expect(toStoredCliTarget(sshPlace())?.kind).toBe('ssh');
  });
});
