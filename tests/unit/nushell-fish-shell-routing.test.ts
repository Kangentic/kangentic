/**
 * nushell and fish are decided by PROGRAM NAME, ahead of the substring gates the
 * other shell predicates use. The cases here are the ones a substring match gets
 * wrong: a nushell or fish binary that sits under a directory whose name holds
 * `pwsh` or `cmd`.
 *
 * Without the name-first check, `isPowerShellShell('/home/dev/pwsh-tools/bin/nu')`
 * was true, so `buildSpawnClearPrelude` typed `Clear-Host;` into nushell, and
 * `isUnixLikeShell('/opt/cmd/bin/fish')` was false, so `quoteArg` wrapped a fish
 * argument in the cmd.exe double-quote rules.
 *
 * The expected values come from each shell's documented contract (the docstrings
 * in src/shared/shell-quote.ts and src/shared/paths.ts), not from reading the
 * code under test:
 *
 *   - isPowerShellShell is the PowerShell family only; isUnixLikeShell is true
 *     for nu and fish and false for cmd.
 *   - buildSpawnClearPrelude is `Clear-Host; ` for PowerShell, `cls & ` for cmd,
 *     and `clear; ` for everything else.
 *   - quoteArg collapses whitespace unless `{ multiline: true }`; nushell quotes
 *     with double quotes, fish with single quotes.
 *   - adaptCommandForShell prefixes a QUOTED nushell head with `^`.
 *   - convertPathForShell leaves a Windows path alone for nushell, which reads
 *     native paths, and converts it for the other unix-like shells.
 *
 * Red-green: remove the `isNushellShell || isFishShell` line from
 * isPowerShellShell and the PowerShell and prelude cases fail; remove it from
 * isUnixLikeShell and the fish-under-cmd case fails; remove the nushell and fish
 * branch from quoteArg and the nushell collapse, multiline and escape cases and
 * the fish escape cases fail (fish whitespace handling matches POSIX sh, so the
 * fish collapse and multiline cases pin the contract but cannot go red on their
 * own); remove the nushell branch from adaptCommandForShell and the caret cases
 * fail; remove `|| isNushellShell(shellName)` from convertPathForShell and the
 * win32 nushell case fails. Each removal was applied and confirmed red.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isPowerShellShell,
  isUnixLikeShell,
} from '../../src/shared/shell-quote';
import {
  adaptCommandForShell,
  buildSpawnClearPrelude,
  quoteArg,
} from '../../src/shared/paths';
import { convertPathForShell } from '../../src/renderer/utils/terminal-clipboard';

const NU_UNDER_PWSH_DIR = '/home/dev/pwsh-tools/bin/nu';
const FISH_UNDER_CMD_DIR = '/opt/cmd/bin/fish';
const FISH_UNDER_PWSH_DIR = '/home/dev/pwsh-tools/bin/fish';

describe('isPowerShellShell and isUnixLikeShell decide nushell and fish by program name', () => {
  it('does not read a nushell or fish binary as PowerShell because a directory says pwsh', () => {
    expect(isPowerShellShell(NU_UNDER_PWSH_DIR)).toBe(false);
    expect(isPowerShellShell(FISH_UNDER_PWSH_DIR)).toBe(false);
    expect(isPowerShellShell('C:\\Tools\\powershell\\nu.exe')).toBe(false);
  });

  it('reads nushell and fish as unix-like wherever they are installed', () => {
    expect(isUnixLikeShell(NU_UNDER_PWSH_DIR)).toBe(true);
    expect(isUnixLikeShell(FISH_UNDER_CMD_DIR)).toBe(true);
    expect(isUnixLikeShell(FISH_UNDER_PWSH_DIR)).toBe(true);
    expect(isUnixLikeShell('C:\\Tools\\cmd\\fish.exe')).toBe(true);
  });

  it('keeps the existing answers for the shells it was never about', () => {
    expect(isPowerShellShell('pwsh')).toBe(true);
    expect(isPowerShellShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(isPowerShellShell('/usr/bin/bash')).toBe(false);
    expect(isUnixLikeShell('cmd.exe')).toBe(false);
    expect(isUnixLikeShell('pwsh')).toBe(false);
    expect(isUnixLikeShell('/bin/bash')).toBe(true);
  });
});

describe('buildSpawnClearPrelude', () => {
  it('types the POSIX clear into a nushell that sits under a pwsh directory', () => {
    expect(buildSpawnClearPrelude(NU_UNDER_PWSH_DIR)).toBe('clear; ');
    expect(buildSpawnClearPrelude('C:\\Tools\\pwsh\\nu.exe')).toBe('clear; ');
    expect(buildSpawnClearPrelude(FISH_UNDER_PWSH_DIR)).toBe('clear; ');
  });

  it('keeps PowerShell on Clear-Host and cmd on cls', () => {
    expect(buildSpawnClearPrelude('pwsh')).toBe('Clear-Host; ');
    expect(buildSpawnClearPrelude('powershell.exe')).toBe('Clear-Host; ');
    expect(buildSpawnClearPrelude('cmd.exe')).toBe('cls & ');
    expect(buildSpawnClearPrelude('/bin/bash')).toBe('clear; ');
  });
});

describe('quoteArg for nushell and fish', () => {
  it('collapses whitespace in a nushell argument unless multiline is asked for', () => {
    expect(quoteArg('a\n\n  b\tc', 'nu')).toBe('"a b c"');
    expect(quoteArg('a\n\n  b\tc', '/usr/bin/nu')).toBe('"a b c"');
  });

  it('collapses whitespace in a fish argument unless multiline is asked for', () => {
    expect(quoteArg('a\n\n  b\tc', 'fish')).toBe("'a b c'");
    expect(quoteArg('a\n\n  b\tc', '/usr/bin/fish')).toBe("'a b c'");
  });

  it('keeps a literal newline for fish under multiline, as fish single quotes hold one', () => {
    expect(quoteArg('a\nb', 'fish', { multiline: true })).toBe("'a\nb'");
  });

  it('keeps a newline for nushell under multiline as an escape, on one physical line', () => {
    expect(quoteArg('a\nb', 'nu', { multiline: true })).toBe('"a\\nb"');
  });

  it('quotes a nushell argument as nushell when a directory in the path says pwsh', () => {
    // PowerShell would write the dollar sign as a backtick and a dollar sign.
    // nushell leaves $ alone inside a plain double-quoted string.
    expect(quoteArg('$x y', NU_UNDER_PWSH_DIR)).toBe('"$x y"');
    expect(quoteArg("it's here", NU_UNDER_PWSH_DIR)).toBe(`"it's here"`);
  });

  it('quotes a fish argument as fish, which reads backslash escapes inside single quotes', () => {
    // POSIX sh would write the apostrophe as '\'' and leave the backslash alone.
    expect(quoteArg("it's here", 'fish')).toBe("'it\\'s here'");
    expect(quoteArg('a\\b c', '/usr/bin/fish')).toBe("'a\\\\b c'");
  });

  it('quotes a fish argument as fish when a directory in the path says cmd', () => {
    // The program name decides, so a directory named cmd must not send fish down
    // the cmd.exe double-quote path.
    expect(quoteArg("it's here", FISH_UNDER_CMD_DIR)).toBe("'it\\'s here'");
  });

  it('leaves a bare token unquoted for both', () => {
    expect(quoteArg('--print', 'nu')).toBe('--print');
    expect(quoteArg('/usr/bin/claude', 'fish')).toBe('/usr/bin/claude');
  });
});

describe('adaptCommandForShell for nushell', () => {
  it('prefixes a single-quoted head with the caret, where PowerShell would get an ampersand', () => {
    expect(adaptCommandForShell("'/opt/a b/claude' --print", '/usr/bin/nu', 'linux')).toBe("^'/opt/a b/claude' --print");
    expect(adaptCommandForShell("'/opt/a b/claude' --print", NU_UNDER_PWSH_DIR, 'linux')).toBe("^'/opt/a b/claude' --print");
  });

  it('prefixes a double-quoted head too', () => {
    expect(adaptCommandForShell('"/opt/a b/claude" --print', '/usr/bin/nu', 'linux')).toBe('^"/opt/a b/claude" --print');
  });

  it('leaves a bare head alone, since a bare head is already a command', () => {
    expect(adaptCommandForShell('claude --print', '/usr/bin/nu', 'linux')).toBe('claude --print');
  });

  it('adds the caret on every platform and does not convert a Windows path to the Git Bash form', () => {
    expect(adaptCommandForShell("'C:\\Program Files\\claude.exe' --print", 'nu', 'win32'))
      .toBe("^'C:\\Program Files\\claude.exe' --print");
    expect(adaptCommandForShell("'/opt/a b/claude' --print", 'nu', 'darwin')).toBe("^'/opt/a b/claude' --print");
  });
});

describe('convertPathForShell for nushell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPlatform(platform: string): void {
    vi.stubGlobal('window', { electronAPI: { platform } });
  }

  it('leaves a Windows path as it is for nushell, which reads native paths', () => {
    stubPlatform('win32');
    expect(convertPathForShell('C:\\Users\\dev\\a.txt', 'nu')).toBe('C:\\Users\\dev\\a.txt');
    expect(convertPathForShell('C:\\Users\\dev\\a.txt', '/usr/bin/nu')).toBe('C:\\Users\\dev\\a.txt');
    expect(convertPathForShell('C:\\Users\\dev\\a.txt', 'nu.exe')).toBe('C:\\Users\\dev\\a.txt');
  });

  it('still converts the same path for bash, so nushell is the exception and not the rule', () => {
    stubPlatform('win32');
    expect(convertPathForShell('C:\\Users\\dev\\a.txt', 'bash')).toBe('/c/Users/dev/a.txt');
  });
});
