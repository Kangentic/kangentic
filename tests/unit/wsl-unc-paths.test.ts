/**
 * Paths into a WSL distro's own filesystem (#286). A CLI installed in the
 * distro is configured by its `\\wsl.localhost\<distro>\...` path; every
 * conversion here is pure, so it runs on Linux CI with Windows-shaped input.
 */
import { describe, it, expect } from 'vitest';
import { adaptCommandForShell, convertWindowsExePath, parseWslUncPath, quoteArg, toWslPath } from '../../src/shared/paths';

describe('parseWslUncPath', () => {
  it('reads both share names, either slash, any case', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude'))
      .toEqual({ distro: 'Ubuntu', linuxPath: '/home/dev/.local/bin/claude' });
    expect(parseWslUncPath('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\bin\\codex'))
      .toEqual({ distro: 'Ubuntu-24.04', linuxPath: '/home/dev/bin/codex' });
    expect(parseWslUncPath('//wsl.localhost/Debian/usr/local/bin/gemini'))
      .toEqual({ distro: 'Debian', linuxPath: '/usr/local/bin/gemini' });
    expect(parseWslUncPath('\\\\WSL.LOCALHOST\\Ubuntu\\opt\\x'))
      .toEqual({ distro: 'Ubuntu', linuxPath: '/opt/x' });
  });

  it('gives the root for a bare distro and drops a trailing separator', () => {
    expect(parseWslUncPath('\\\\wsl$\\Ubuntu')).toEqual({ distro: 'Ubuntu', linuxPath: '/' });
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/dev' });
  });

  it('is null for anything that is not a distro path', () => {
    expect(parseWslUncPath('\\\\wsl.localhost')).toBeNull();
    expect(parseWslUncPath('\\\\wsl$\\')).toBeNull();
    expect(parseWslUncPath('\\\\fileserver\\share\\claude.exe')).toBeNull();
    expect(parseWslUncPath('C:\\Users\\dev\\.local\\bin\\claude.exe')).toBeNull();
    expect(parseWslUncPath('/home/dev/.local/bin/claude')).toBeNull();
  });
});

describe('toWslPath', () => {
  it('maps a distro path to the path the distro sees', () => {
    expect(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\x.jsonl')).toBe('/home/dev/.claude/projects/x.jsonl');
  });

  it('is unchanged for drive and other UNC paths', () => {
    expect(toWslPath('C:\\Users\\dev\\repo')).toBe('/mnt/c/Users/dev/repo');
    expect(toWslPath('\\\\fileserver\\share\\x')).toBe('//fileserver/share/x');
  });
});

describe('convertWindowsExePath with a distro path head', () => {
  const head = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

  it('turns the head into the in-distro path for WSL, in every quoting quoteArg emits', () => {
    expect(convertWindowsExePath(`'${head}' --resume abc`, true)).toBe("'/home/dev/.local/bin/claude' --resume abc");
    expect(convertWindowsExePath(`"${head}" --resume abc`, true)).toBe('"/home/dev/.local/bin/claude" --resume abc');
    expect(convertWindowsExePath(`${head} --resume abc`, true)).toBe('/home/dev/.local/bin/claude --resume abc');
  });

  it('leaves the arguments alone', () => {
    expect(convertWindowsExePath(`'${head}' --settings 'C:\\x\\settings.json'`, true))
      .toBe("'/home/dev/.local/bin/claude' --settings 'C:\\x\\settings.json'");
  });

  it('keeps the old slash normalization for Git Bash and for a non-distro share', () => {
    expect(convertWindowsExePath(`'${head}' -p`, false)).toBe("'//wsl.localhost/Ubuntu/home/dev/.local/bin/claude' -p");
    expect(convertWindowsExePath("'\\\\fileserver\\share\\claude.exe' -p", true)).toBe("'//fileserver/share/claude.exe' -p");
  });

  it('reaches the head through adaptCommandForShell for a WSL shell on Windows only', () => {
    const command = `${quoteArg(head, 'wsl -d Ubuntu')} --model opus`;
    expect(adaptCommandForShell(command, 'wsl -d Ubuntu', 'win32')).toBe("'/home/dev/.local/bin/claude' --model opus");
    expect(adaptCommandForShell(command, 'wsl -d Ubuntu', 'linux')).toBe(command);
  });

  it('converts a drive head exactly as before', () => {
    expect(adaptCommandForShell("'C:\\Users\\dev\\.local\\bin\\claude.exe' -p", 'wsl -d Ubuntu', 'win32'))
      .toBe("'/mnt/c/Users/dev/.local/bin/claude.exe' -p");
  });
});
