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

/** The npm cmd-shim batch file as written in 2026 (`%dp0%` via the `:find_dp0` label). */
export function npmCmdShim(relativeTarget: string): string {
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
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`,
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
