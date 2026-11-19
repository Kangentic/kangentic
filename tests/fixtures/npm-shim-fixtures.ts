/**
 * Builders for the shim files npm's cmd-shim writes beside a global install,
 * verbatim except for the launched script path. Shared by the npm-shim-target
 * parser tests and the dead-shim detection tests. The Windows-only launch test
 * (windows-cmd-shim-multiline-prompt.test.ts) keeps its own copies because it
 * also drives real shells against them.
 *
 * The batch variants are joined with CRLF: npm writes CRLF, and cmd.exe's GOTO
 * label scan is line-ending sensitive. That is on-disk data for cmd.exe, not
 * authored text.
 */
export const CMD_SHIM_LINE_ENDING = '\r\n';

/**
 * The npm cmd-shim batch file as written in 2026 (`%dp0%` via the `:find_dp0`
 * label), for a target whose first line is a shebang. `writeShim_` in npm's
 * `cmd-shim` (`lib/index.js`) takes the program from that line: `node` for
 * `#!/usr/bin/env node`, `pwsh` for `#!/usr/bin/env pwsh`. Whatever follows
 * the program on the shebang line is `programArguments`, written between
 * `"%_prog%"` and the target.
 *
 * Checked line for line against two versions. 8.0.0, the copy npm 11 bundles,
 * takes `.JS` off `PATHEXT` inside the `ELSE` block. 9.0.2 does it on the last
 * line, ahead of the program. The 8.0.0 text for a `pwsh` shebang, with and
 * without `-NoProfile` after `pwsh`, is also byte for byte the file a bundled
 * 8.0.0 wrote for such a `.ps1`.
 */
export function npmCmdShim(
  relativeTarget: string,
  options: { program?: string; programArguments?: string; cmdShimVersion?: '8.0.0' | '9.0.2' } = {},
): string {
  const program = options.program ?? 'node';
  const pathextOnLastLine = options.cmdShimVersion === '9.0.2';
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    `IF EXIST "%dp0%\\${program}.exe" (`,
    `  SET "_prog=%dp0%\\${program}.exe"`,
    ') ELSE (',
    `  SET "_prog=${program}"`,
    ...(pathextOnLastLine ? [] : ['  SET PATHEXT=%PATHEXT:;.JS;=;%']),
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
      + (pathextOnLastLine ? 'set PATHEXT=%PATHEXT:;.JS;=;% & ' : '')
      + `"%_prog%" ${options.programArguments ?? ''} "%dp0%\\${relativeTarget}" %*`,
    '',
  ].join(CMD_SHIM_LINE_ENDING);
}

/** The older cmd-shim form that used `%~dp0` inline instead of the `:find_dp0` label. */
export function legacyNpmCmdShim(relativeTarget: string): string {
  return [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${relativeTarget}" %*`,
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${relativeTarget}" %*`,
    ')',
    '',
  ].join(CMD_SHIM_LINE_ENDING);
}

/**
 * pnpm's `.cmd` shim, as `generateCmdShim` in pnpm's `@zkochan/cmd-shim` writes
 * it (checked line for line against `src/index.ts` on the pnpm/cmd-shim main
 * branch; not captured from a live install). pnpm writes the `NODE_PATH` block
 * whenever an install has node paths to add, which a default hoisted install
 * does, whatever the target is. A Node script (`nodeScript`) runs through
 * `node.exe` beside the shim or `node`; any other target, a native `.exe` among
 * them, is called directly as `@"%~dp0\<target>"   %*`.
 */
export function pnpmCmdShim(relativeTarget: string, options: { nodeScript: boolean; nodePath?: string }): string {
  return pnpmShimText(relativeTarget, options.nodeScript ? { program: 'node', shebangArguments: '' } : null, options.nodePath);
}

/**
 * pnpm's `.cmd` shim for a `.ps1` target, from the same `generateCmdShim`
 * (checked line for line against `src/index.ts` of `@zkochan/cmd-shim` 9.0.8
 * on the pnpm/cmd-shim main branch, and byte for byte against the shims
 * pnpm 10.5.0 wrote for three `.ps1` bins of a linked package: one with no
 * shebang, one with a `pwsh` shebang, and one with `-NoProfile` after it).
 * Those three carried the `NODE_PATH` block, as a default install's do. Its
 * `extensionToProgramMap` maps `.ps1` to `pwsh`, so a `.ps1` bin runs through
 * `pwsh.exe` beside the shim or `pwsh`, with no flags of pnpm's own: pwsh
 * takes its first positional argument as the file. A `#!/usr/bin/env pwsh`
 * first line writes the same text, and whatever follows `pwsh` on that line is
 * `programArguments`, which pnpm writes after a second space.
 */
export function pnpmPs1CmdShim(relativeTarget: string, options: { nodePath?: string; programArguments?: string } = {}): string {
  const shebangArguments = options.programArguments ? ` ${options.programArguments}` : '';
  return pnpmShimText(relativeTarget, { program: 'pwsh', shebangArguments }, options.nodePath);
}

/** `generateCmdShim`'s text: `runtime` is the program pnpm found for the target, or null to call it directly. */
function pnpmShimText(
  relativeTarget: string,
  runtime: { program: string; shebangArguments: string } | null,
  nodePath: string | undefined,
): string {
  const quotedTarget = `"%~dp0\\${relativeTarget}"`;
  const lines = ['@SETLOCAL'];
  if (nodePath) {
    lines.push(
      '@IF NOT DEFINED NODE_PATH (',
      `  @SET "NODE_PATH=${nodePath}"`,
      ') ELSE (',
      `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
      ')',
    );
  }
  if (runtime) {
    const { program, shebangArguments } = runtime;
    lines.push(
      `@IF EXIST "%~dp0\\${program}.exe" (`,
      `  "%~dp0\\${program}.exe" ${shebangArguments} ${quotedTarget} %*`,
      ') ELSE (',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      `  ${program} ${shebangArguments} ${quotedTarget} %*`,
      ')',
    );
  } else {
    lines.push(`@${quotedTarget}   %*`);
  }
  lines.push('');
  return lines.join(CMD_SHIM_LINE_ENDING);
}

/**
 * A hand-written trampoline: one line that hands the `.ps1` beside it to
 * PowerShell, with flags. No generator was found that writes this. pnpm and
 * npm name `pwsh` and add only the flags a shebang line holds (above), and
 * Scoop's `.cmd` quotes an absolute path. Built from the shapes the parser
 * already reads: `minimalCmdShim`'s `%~dp0` with no separator, and
 * `invocation` in place of `node`.
 */
export function powerShellTrampolineCmdShim(invocation: string, relativeTarget: string): string {
  return ['@echo off', `${invocation} "%~dp0${relativeTarget}" %*`, ''].join(CMD_SHIM_LINE_ENDING);
}

/**
 * npm's `.cmd` shim for a target with no shebang, as `writeShim_` in npm's
 * `cmd-shim` writes it (checked line for line against `lib/index.js` of
 * cmd-shim 9.0.2, the copy npm bundles under `bin-links`, and byte for byte
 * against the file npm's bundled cmd-shim 8.0.0 wrote for a
 * `node_modules\.bin\claude.cmd` target). With no interpreter to name, `prog`
 * becomes the quoted target and `args` and `target` are empty, so the last
 * line is the target called directly, three spaces, then `%*`.
 *
 * A `.cmd` or `.bat` target has no shebang, so this is the shim a global bin
 * gets when its target is itself a batch shim (a `node_modules\.bin\<name>.cmd`).
 * pnpm takes the same branch (`pnpmCmdShim` with `nodeScript: false`). Either
 * one, pointed at a second shim, is a chain.
 */
export function npmDirectCmdShim(relativeTarget: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    `"%dp0%\\${relativeTarget}"   %*`,
    '',
  ].join(CMD_SHIM_LINE_ENDING);
}

/** The two-line shape every tests/fixtures/mock-*.cmd uses (no separator after `%~dp0`). */
export function minimalCmdShim(relativeTarget: string): string {
  return ['@echo off', `node "%~dp0${relativeTarget}" %*`, ''].join(CMD_SHIM_LINE_ENDING);
}

/**
 * The extensionless sh shim, copied from a real `node_modules/.bin` entry in
 * this repo with only the target path swapped. This is the file `which`
 * returns on macOS and Linux. `isNpmShimCandidate` does not match it (see its
 * doc comment), so detection never reaches the parser with one, but the parser
 * handles it and this pins that against the real format rather than an
 * idealized one.
 */
export function npmShShim(relativeTarget: string): string {
  return `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${relativeTarget}" "$@"
else
  exec node  "$basedir/${relativeTarget}" "$@"
fi
`;
}

/** The npm `.ps1` shim. `relativeTarget` uses forward slashes, as npm writes it. */
export function npmPs1Shim(relativeTarget: string): string {
  return `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${relativeTarget}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${relativeTarget}" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${relativeTarget}" $args
  } else {
    & "node$exe"  "$basedir/${relativeTarget}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;
}
