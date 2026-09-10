import { describe, it, expect, afterEach } from 'vitest';
import {
  escapeForDoubleQuotedShell,
  isCmdShell,
  isPowerShellShell,
  isUnixLikeShell,
} from '../../src/shared/shell-quote';
import { convertPathForShell, quoteForShell } from '../../src/renderer/utils/terminal-clipboard';

/**
 * The escaping rules pinned here were measured, not derived: every expectation
 * below was round-tripped through node's `process.argv` on Windows PowerShell
 * 5.1.26100, pwsh 7.6.6, and cmd.exe. The two Windows branches disagree about
 * the backslash, which is the whole reason this helper exists.
 */
describe('escapeForDoubleQuotedShell', () => {
  describe('cmd.exe (backslash IS an escape at the target C runtime)', () => {
    const escapeForCmd = (text: string) => escapeForDoubleQuotedShell(text, true);

    it('doubles a trailing backslash run so it cannot swallow the closing quote', () => {
      // Measured: `"C:\dir\"` reaches a native command as `C:\dir"`, because
      // the CRT reads the `\"` as an escaped quote. Doubling the run delivers
      // `C:\dir\` intact.
      expect(escapeForCmd('C:\\dir\\')).toBe('C:\\dir\\\\');
      expect(escapeForCmd('C:\\Program Files\\')).toBe('C:\\Program Files\\\\');
      expect(escapeForCmd('C:\\dir\\\\')).toBe('C:\\dir\\\\\\\\');
    });

    it('leaves interior backslashes alone, so a path is delivered unchanged', () => {
      expect(escapeForCmd('C:\\Program Files\\bin')).toBe('C:\\Program Files\\bin');
    });

    it('doubles the backslash run before an embedded quote as well', () => {
      expect(escapeForCmd('a"b')).toBe('a\\"b');
      expect(escapeForCmd('a\\"b')).toBe('a\\\\\\"b');
    });

    it('leaves backtick and $ alone, which are literal to both cmd and the CRT', () => {
      // The PowerShell escaping this branch used to share delivered DOUBLED
      // backticks to the agent: cmd never collapses them.
      expect(escapeForCmd('use `code` and $HOME')).toBe('use `code` and $HOME');
    });
  });

  describe('PowerShell (backslash is NOT special)', () => {
    const escapeForPowerShell = (text: string) => escapeForDoubleQuotedShell(text, false);

    it('leaves a trailing backslash alone, because no doubling is right on both hosts', () => {
      // pwsh 7.3+ passes arguments to a native command verbatim, so `"C:\dir\"`
      // and `"C:\Program Files\"` both arrive intact and doubling would break
      // both. Windows PowerShell 5.1 re-quotes any argument containing a SPACE
      // first, so it wants the opposite for the second case and the same for the
      // first. Correct twice on 7.x beats correct once on 5.1; see the measured
      // table on escapeForDoubleQuotedShell before changing this.
      expect(escapeForPowerShell('C:\\dir\\')).toBe('C:\\dir\\');
      expect(escapeForPowerShell('C:\\Program Files\\')).toBe('C:\\Program Files\\');
    });

    it('leaves interior backslashes alone', () => {
      expect(escapeForPowerShell('C:\\Program Files\\bin')).toBe('C:\\Program Files\\bin');
    });

    it('doubles backticks and escapes $, which ARE the PowerShell escapes', () => {
      expect(escapeForPowerShell('use `code` here')).toBe('use ``code`` here');
      expect(escapeForPowerShell('cost $5')).toBe('cost `$5');
    });
  });
});

/**
 * These predicates moved out of `src/shared/paths.ts` so the renderer could
 * share them, and `terminal-clipboard.ts`'s own copy was deleted in the same
 * change. Its two consumers (`quoteForShell` and `convertPathForShell`, which
 * branches on `startsWith('wsl')` after this test) have only UI-tier coverage,
 * so anchor the equivalence here rather than trusting it.
 */
describe('shell predicates', () => {
  it('treats WSL and the POSIX shells as unix-like', () => {
    for (const shell of ['wsl', 'wsl.exe', 'bash', 'zsh', 'fish', 'nu', 'git-bash']) {
      expect(isUnixLikeShell(shell)).toBe(true);
    }
  });

  it('treats cmd and the PowerShell family as not unix-like', () => {
    for (const shell of ['cmd', 'cmd.exe', 'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']) {
      expect(isUnixLikeShell(shell)).toBe(false);
    }
  });

  it('separates cmd from PowerShell', () => {
    expect(isCmdShell('cmd.exe')).toBe(true);
    expect(isCmdShell('pwsh.exe')).toBe(false);
    expect(isPowerShellShell('powershell.exe')).toBe(true);
    expect(isPowerShellShell('pwsh')).toBe(true);
    expect(isPowerShellShell('cmd.exe')).toBe(false);
  });
});

/** The renderer consumer of the same escaping (drag-drop and image paste). */
describe('quoteForShell', () => {
  it('doubles a trailing backslash run for cmd but not for PowerShell', () => {
    expect(quoteForShell('C:\\Program Files\\', 'cmd.exe')).toBe('"C:\\Program Files\\\\"');
    expect(quoteForShell('C:\\Program Files\\', 'pwsh.exe')).toBe('"C:\\Program Files\\"');
  });

  it('leaves a backtick in a filename alone under cmd and doubles it under PowerShell', () => {
    // A backtick is legal in a Windows filename, so this is reachable from a
    // real drag-drop, unlike the double-quote case (illegal in a path).
    expect(quoteForShell('C:\\a`b\\note.txt', 'cmd.exe')).toBe('"C:\\a`b\\note.txt"');
    expect(quoteForShell('C:\\a`b\\note.txt', 'pwsh.exe')).toBe('"C:\\a``b\\note.txt"');
  });

  it('preserves consecutive spaces in a path', () => {
    // The reason quoteForShell shares the escaping with quoteArg but does not
    // call it: quoteArg runs sanitizeForPty, which would collapse this to one
    // space and hand the agent a path that does not exist.
    expect(quoteForShell('C:\\My  Docs\\a.txt', 'pwsh.exe')).toBe('"C:\\My  Docs\\a.txt"');
    expect(quoteForShell('/home/dev/My  Docs/a.txt', 'bash')).toBe("'/home/dev/My  Docs/a.txt'");
  });

  it('still single-quotes for unix-like shells, WSL included', () => {
    expect(quoteForShell('/mnt/c/a b/x.txt', 'wsl')).toBe("'/mnt/c/a b/x.txt'");
    expect(quoteForShell("/tmp/it's.txt", 'bash')).toBe("'/tmp/it'\\''s.txt'");
  });
});

/**
 * `convertPathForShell` now routes its unix-like check through the shared
 * `isUnixLikeShell` from `../../src/shared/shell-quote` (this diff deleted its
 * own local copy). That refactor is behavior-preserving - the deleted local
 * predicate (`!lower.includes('cmd') && !lower.includes('powershell') &&
 * !lower.includes('pwsh')`) and the shared one (`!lower.includes('cmd') &&
 * !isPowerShellShell(lower)`, which itself checks 'powershell' / 'pwsh') agree
 * on every input, and the equivalence is pinned above in 'shell predicates' -
 * so this suite is not red-green against THIS diff's change, and none of it
 * needs to be: the WSL-vs-Git-Bash prefix logic below is untouched by the
 * refactor. It is added because the function had NO direct unit coverage at
 * all before or after this diff (the comment in the 'shell predicates' block
 * above calls this out as UI-tier-only, but no UI spec actually exercises the
 * WSL/`mnt/` branch either - the one UI spec that drops a file path through
 * this function always drops it under `/mock/...`, which never matches the
 * `^[A-Za-z]:` drive-letter regex this function keys on). Deriving expectations
 * from the function's own docstring (WSL: `/mnt/<drive>/...`; other unix-like
 * shells, Git Bash included: `/<drive>/...`; cmd/PowerShell/non-Windows: no
 * conversion), not from a debugger read of the current output.
 */
describe('convertPathForShell', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  function stubPlatform(platform: string): void {
    // @ts-expect-error -- minimal window stub; convertPathForShell only reads .platform
    globalThis.window = { electronAPI: { platform } };
  }

  it('converts a Windows path to the WSL mount form under a WSL shell', () => {
    stubPlatform('win32');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'wsl')).toBe('/mnt/c/Users/dev/file.txt');
    expect(convertPathForShell('D:\\project\\a.png', 'wsl.exe')).toBe('/mnt/d/project/a.png');
  });

  it('converts a Windows path to the plain-root form under Git Bash and other unix-like shells', () => {
    stubPlatform('win32');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'bash')).toBe('/c/Users/dev/file.txt');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'git-bash')).toBe('/c/Users/dev/file.txt');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'zsh')).toBe('/c/Users/dev/file.txt');
  });

  it('lowercases the drive letter and converts every backslash in the remainder', () => {
    stubPlatform('win32');
    expect(convertPathForShell('D:\\a\\b\\c.txt', 'bash')).toBe('/d/a/b/c.txt');
  });

  it('does not convert for cmd or PowerShell, which take native Windows paths', () => {
    stubPlatform('win32');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'cmd.exe')).toBe('C:\\Users\\dev\\file.txt');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'pwsh.exe')).toBe('C:\\Users\\dev\\file.txt');
  });

  it('does not convert on a non-Windows platform, even for a WSL-named shell', () => {
    stubPlatform('darwin');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'wsl')).toBe('C:\\Users\\dev\\file.txt');
    stubPlatform('linux');
    expect(convertPathForShell('C:\\Users\\dev\\file.txt', 'bash')).toBe('C:\\Users\\dev\\file.txt');
  });

  it('leaves a path with no drive-letter prefix unchanged', () => {
    stubPlatform('win32');
    expect(convertPathForShell('/already/posix/path.txt', 'bash')).toBe('/already/posix/path.txt');
  });
});
