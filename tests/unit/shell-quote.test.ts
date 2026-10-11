import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  escapeForDoubleQuotedShell,
  escapeForPowerShellSingleQuoted,
  escapePercentForCmd,
  isCmdShell,
  isPowerShellShell,
  isUnixLikeShell,
  quoteCmdExecutable,
} from '../../src/shared/shell-quote';
import { convertPathForShell, quoteForShell } from '../../src/renderer/utils/terminal-clipboard';

// Curly quotes, built from code points so no editor or formatter rewrites them.
const LEFT_DOUBLE_QUOTE = String.fromCodePoint(0x201c);
const RIGHT_DOUBLE_QUOTE = String.fromCodePoint(0x201d);
const LOW_DOUBLE_QUOTE = String.fromCodePoint(0x201e);
const REVERSED_DOUBLE_QUOTE = String.fromCodePoint(0x201f);
const LEFT_SINGLE_QUOTE = String.fromCodePoint(0x2018);
const RIGHT_SINGLE_QUOTE = String.fromCodePoint(0x2019);
const LOW_SINGLE_QUOTE = String.fromCodePoint(0x201a);
const REVERSED_SINGLE_QUOTE = String.fromCodePoint(0x201b);

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

    it('doubles the three curly double quotes PowerShell ends a string at', () => {
      // Measured at a pwsh 7.6.6 ConPTY prompt. Left bare, one split the
      // argument in two and let a `;` after it run a second command.
      expect(escapeForPowerShell(`${LEFT_DOUBLE_QUOTE}a${RIGHT_DOUBLE_QUOTE} ${LOW_DOUBLE_QUOTE}b`))
        .toBe(`${LEFT_DOUBLE_QUOTE}${LEFT_DOUBLE_QUOTE}a${RIGHT_DOUBLE_QUOTE}${RIGHT_DOUBLE_QUOTE} ${LOW_DOUBLE_QUOTE}${LOW_DOUBLE_QUOTE}b`);
    });

    it('doubles rather than backticks, so a quote dropped by Windows PowerShell 5.1 leaves no escape behind', () => {
      // 5.1 at a ConPTY prompt drops a typed curly quote before parsing. The
      // backtick form then left `t, which reached the agent as a tab in place
      // of the letter (measured). A doubled pair just vanishes.
      expect(escapeForPowerShell(`${LEFT_DOUBLE_QUOTE}tests`)).not.toContain('`');
    });

    it('leaves U+201F and the curly single quotes alone, which are literal inside "..."', () => {
      const text = `${REVERSED_DOUBLE_QUOTE}x it${RIGHT_SINGLE_QUOTE}s`;
      expect(escapeForPowerShell(text)).toBe(text);
    });
  });

  it('leaves curly double quotes alone for cmd, which does not read them as quotes', () => {
    const text = `say ${LEFT_DOUBLE_QUOTE}hi${RIGHT_DOUBLE_QUOTE}`;
    expect(escapeForDoubleQuotedShell(text, true)).toBe(text);
  });
});

describe('escapeForPowerShellSingleQuoted', () => {
  it("doubles ' and each curly single quote, PowerShell's escape inside '...'", () => {
    // Measured on both hosts, doubling only ' left a path holding a curly
    // apostrophe as a parse error, and doubling all five reached the directory.
    expect(escapeForPowerShellSingleQuoted("o'brien")).toBe("o''brien");
    expect(escapeForPowerShellSingleQuoted(`Bob${RIGHT_SINGLE_QUOTE}s`)).toBe(`Bob${RIGHT_SINGLE_QUOTE}${RIGHT_SINGLE_QUOTE}s`);
    expect(escapeForPowerShellSingleQuoted(`${LEFT_SINGLE_QUOTE}${LOW_SINGLE_QUOTE}${REVERSED_SINGLE_QUOTE}`))
      .toBe(`${LEFT_SINGLE_QUOTE}${LEFT_SINGLE_QUOTE}${LOW_SINGLE_QUOTE}${LOW_SINGLE_QUOTE}${REVERSED_SINGLE_QUOTE}${REVERSED_SINGLE_QUOTE}`);
  });

  it('leaves the curly double quotes alone, which are literal inside a single-quoted string', () => {
    const text = `${LEFT_DOUBLE_QUOTE}x${RIGHT_DOUBLE_QUOTE}`;
    expect(escapeForPowerShellSingleQuoted(text)).toBe(text);
  });
});

/**
 * Measured on cmd.exe 10.0.26200 over piped stdin, a ConPTY prompt, node's
 * `shell: true`, and an npm-style `.cmd` shim. Each output below, wrapped in
 * quotes, reaches the agent as the input. The live round trip is in
 * command-builder.test.ts and auto-name-clean.test.ts.
 */
describe('escapePercentForCmd', () => {
  it('breaks each % out of the quotes as "^%"', () => {
    expect(escapePercentForCmd('fix %PATH% now')).toBe('fix "^%"PATH"^%" now');
    expect(escapePercentForCmd('100% done')).toBe('100"^%" done');
    expect(escapePercentForCmd('a%%b')).toBe('a"^%""^%"b');
  });

  it('doubles the backslash run before a %, which the inserted quote would otherwise escape', () => {
    expect(escapePercentForCmd('C:\\dir\\%X%')).toBe('C:\\dir\\\\"^%"X"^%"');
    expect(escapePercentForCmd('a\\\\%b')).toBe('a\\\\\\\\"^%"b');
  });

  it('leaves text with no % untouched, interior backslashes included', () => {
    expect(escapePercentForCmd('C:\\Program Files\\bin')).toBe('C:\\Program Files\\bin');
  });
});

/** Every `.ts` file under a directory, as absolute paths. */
function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * An `execAsync` command head written as a bare `"${...}"`: the shape every
 * site had before `quoteCmdExecutable`. `execAsync` runs `cmd /d /s /c` on
 * Windows, which expands a `%NAME%` in that head and then cannot find the
 * expanded path.
 */
const BARE_QUOTED_EXEC_HEAD = /execAsync\(\s*`"\$\{/;

describe('quoteCmdExecutable', () => {
  it('wraps a plain path in quotes and nothing else', () => {
    expect(quoteCmdExecutable('C:\\Program Files\\cursor\\cursor-agent.CMD')).toBe(
      '"C:\\Program Files\\cursor\\cursor-agent.CMD"',
    );
  });

  it('breaks a %NAME% out of the quotes, doubling the backslash run before it', () => {
    expect(quoteCmdExecutable('C:\\Users\\dev\\%KNG_PROBE%\\agent.cmd')).toBe(
      '"C:\\Users\\dev\\\\"^%"KNG_PROBE"^%"\\agent.cmd"',
    );
    // A % that follows no backslash gets only the "^%" form.
    expect(quoteCmdExecutable('C:\\tools\\100%\\agent.cmd')).toBe('"C:\\tools\\100"^%"\\agent.cmd"');
  });

  it('the scan pattern matches a bare quoted head on one line or two, and not the helper form', () => {
    // Guards the regex itself, so the scan below cannot go quiet by matching nothing.
    expect(BARE_QUOTED_EXEC_HEAD.test('execAsync(`"${cliPath}" --help`, {})')).toBe(true);
    expect(BARE_QUOTED_EXEC_HEAD.test('execAsync(\n    `"${cliPath}" --help`, {})')).toBe(true);
    expect(BARE_QUOTED_EXEC_HEAD.test('execAsync(`${quoteCmdExecutable(cliPath)} --help`, {})')).toBe(false);
  });

  it('no execAsync command head under src/main is a bare quoted path', () => {
    const mainRoot = path.resolve(__dirname, '../../src/main');
    const sourceFiles = collectTypeScriptFiles(mainRoot).map((file) => ({
      relativePath: path.relative(mainRoot, file).replace(/\\/g, '/'),
      text: fs.readFileSync(file, 'utf8'),
    }));

    // Not vacuous: the helper and execAsync are both really in use.
    const filesUsingHelperWithExec = sourceFiles.filter(
      (file) => file.text.includes('quoteCmdExecutable(') && file.text.includes('execAsync('),
    );
    expect(filesUsingHelperWithExec.length).toBeGreaterThan(0);

    const offendingFiles = sourceFiles
      .filter((file) => BARE_QUOTED_EXEC_HEAD.test(file.text))
      .map((file) => file.relativePath);
    expect(
      offendingFiles,
      `These files write an execAsync command head as a bare "\${...}". Use quoteCmdExecutable(...) from src/shared/shell-quote.ts so cmd.exe cannot expand a %NAME% in the path:\n${offendingFiles.join('\n')}`,
    ).toEqual([]);
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

  it('doubles a curly double quote in a path under PowerShell, as quoteArg does', () => {
    // Legal in a Windows filename. Dropped at a PowerShell prompt bare, it
    // would end the string partway through the path.
    expect(quoteForShell(`C:\\a\\${LEFT_DOUBLE_QUOTE}x${RIGHT_DOUBLE_QUOTE}.txt`, 'pwsh.exe'))
      .toBe(`"C:\\a\\${LEFT_DOUBLE_QUOTE}${LEFT_DOUBLE_QUOTE}x${RIGHT_DOUBLE_QUOTE}${RIGHT_DOUBLE_QUOTE}.txt"`);
  });

  it('leaves % alone under cmd, unlike quoteArg', () => {
    // A dropped or pasted path usually lands in an agent's input box, not at
    // the cmd prompt, so the "^%" escape quoteArg writes for cmd would arrive
    // in the path as literal text.
    expect(quoteForShell('C:\\a\\100%\\x.txt', 'cmd.exe')).toBe('"C:\\a\\100%\\x.txt"');
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
