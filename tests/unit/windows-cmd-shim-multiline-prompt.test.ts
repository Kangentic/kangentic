/**
 * Windows-only integration test for #353: the multi-line `{{task_xml}}` prompt
 * through a real npm-format `.cmd` shim under real Windows PowerShell 5.1,
 * pwsh 7, and Git Bash, and through the sibling shims resolveShimLaunch
 * (src/main/agent/shared/shim-launch.ts) launches instead.
 *
 * The reporter's own harness (command builder -> PowerShell -> ConPTY -> a
 * receiver) passed because it stopped short of the `.cmd`; the cut happens in
 * cmd.exe's parse of the child command line, so this test keeps the shim in
 * the chain and records what the receiver's argv actually held.
 *
 * Reports as skipped on Linux CI (no Windows runner) and runs under `/test` on
 * the dogfood machine. The decision logic itself is guarded on CI by
 * tests/unit/shim-launch.test.ts with injected dependencies.
 *
 * No node-pty variant: PowerShell builds the child command line identically
 * whether the statement arrived through PSReadLine or -EncodedCommand (same
 * parser, same backtick-n expansion, same CreateProcess), the reporter already
 * verified ConPTY passes the newline, and an interactive shell would only add
 * this repo's documented flake class. -EncodedCommand and a bash `-s` stdin
 * read are the faithful stand-ins for the spawn flow typing the line.
 *
 * Red-green: the "red pin" cases document the hazard itself (they fail the day
 * a Windows build stops cutting the line, which would be news); the green
 * cases fail if resolveShimLaunch stops finding a sibling, quoteArg stops
 * emitting backtick-n or the quoted `--`, or the flatten fallback regresses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import which from 'which';
import { CodexCommandBuilder } from '../../src/main/agent/adapters/codex';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
import {
  resolveShimLaunch,
  probeExecutionPolicy,
  executionPolicyAllowsScripts,
  resetShimLaunchCacheForTests,
} from '../../src/main/agent/shared/shim-launch';
import { adaptCommandForShell, isPowerShellShell, quoteArg, sanitizeForPty } from '../../src/shared/paths';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

interface HostSpec {
  name: string;
  path: string;
  family: 'powershell' | 'bash';
}

/**
 * Hosts present on this machine, discovered at collection time so
 * describe.each can enumerate them. powershell.exe ships with Windows; pwsh
 * and Git Bash are optional. Git Bash is looked up at its install path only:
 * a bare `which('bash')` can return the WSL launcher in System32.
 */
function discoverHosts(): HostSpec[] {
  if (!IS_WINDOWS) return [];
  const hosts: HostSpec[] = [];
  const powershell = which.sync('powershell', { nothrow: true });
  if (powershell) hosts.push({ name: 'Windows PowerShell 5.1', path: powershell, family: 'powershell' });
  const pwsh = which.sync('pwsh', { nothrow: true });
  if (pwsh) hosts.push({ name: 'pwsh 7', path: pwsh, family: 'powershell' });
  const gitBash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (fs.existsSync(gitBash)) hosts.push({ name: 'Git Bash', path: gitBash, family: 'bash' });
  return hosts;
}

const HOSTS = discoverHosts();

// npm's cmd-shim writes CRLF, and cmd.exe's GOTO label scan is line-ending
// sensitive, so the batch fixture is joined with CRLF. This is on-disk data
// for cmd.exe, not authored text: the cross-platform rule's CRLF ban covers
// assertions and prose.
const CMD_LINE_ENDING = '\r\n';

/** The npm `cmd-shim` batch file, verbatim except for the script path. */
const NPM_CMD_SHIM = [
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
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\receiver.js" %*',
  '',
].join(CMD_LINE_ENDING);

/** The two-line shape every tests/fixtures/mock-*.cmd uses. */
const MINIMAL_CMD_SHIM = ['@echo off', 'node "%~dp0receiver.js" %*', ''].join(CMD_LINE_ENDING);

/** The npm `.ps1` shim, verbatim except for the script path. */
const NPM_PS1_SHIM = `#!/usr/bin/env pwsh
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
    $input | & "$basedir/node$exe"  "$basedir/receiver.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/receiver.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/receiver.js" $args
  } else {
    & "node$exe"  "$basedir/receiver.js" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

/** The npm extensionless sh shim, verbatim except for the script path. */
const NPM_SH_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
basedir_win="$basedir"

case \`uname -a\` in
  *CYGWIN*|*MINGW*|*MSYS*)
    if command -v cygpath > /dev/null 2>&1; then
      basedir_win=\`cygpath -w "$basedir"\`
    fi
  ;;
  *WSL2*)
    if command -v wslpath > /dev/null 2>&1; then
      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"
      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then
        echo "Error: wslpath failed to convert path. WSL environment may be misconfigured." >&2
        exit 1
      fi
    fi
  ;;
esac

PROG_EXE="$basedir/node.exe"
if ! [ -x "$PROG_EXE" ]; then
  PROG_EXE="$basedir/node"
  if ! [ -x "$PROG_EXE" ]; then
    PROG_EXE=node
    if ! [ -x "$PROG_EXE" ]; then
      PROG_EXE=node.exe
    fi
  fi
fi

exec "$PROG_EXE"  "$basedir_win/receiver.js" "$@"
`;

/** Records the argv it was launched with; the out path rides an env var so the argv shape stays production's. */
const RECEIVER_JS = `const fs = require('node:fs');
fs.writeFileSync(process.env.KANGENTIC_RECEIVER_OUT, JSON.stringify(process.argv.slice(2)), 'utf8');
`;

const XML = buildTaskXml({ title: 'Fix login for issue 353', description: 'Step 1.\n\nStep 2.' });

describe.runIf(IS_WINDOWS)('Windows npm .cmd shim vs multiline prompt (#353)', () => {
  let tempDir: string;
  let cmdShim: string;
  let minimalCmdShim: string;
  let ps1Shim: string;
  let shShim: string;
  let runCounter = 0;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-cmd-shim-'));
    cmdShim = path.join(tempDir, 'receiver.cmd');
    minimalCmdShim = path.join(tempDir, 'receiver-minimal.cmd');
    ps1Shim = path.join(tempDir, 'receiver.ps1');
    shShim = path.join(tempDir, 'receiver');
    fs.writeFileSync(path.join(tempDir, 'receiver.js'), RECEIVER_JS, 'utf8');
    fs.writeFileSync(cmdShim, NPM_CMD_SHIM, 'utf8');
    fs.writeFileSync(minimalCmdShim, MINIMAL_CMD_SHIM, 'utf8');
    fs.writeFileSync(ps1Shim, NPM_PS1_SHIM, 'utf8');
    fs.writeFileSync(shShim, NPM_SH_SHIM, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Run the typed command line through the host exactly as the spawn flow
   * would hand it over, then return the receiver's recorded argv. A fresh out
   * file per run, asserted absent first, so a stale file from an earlier case
   * can never satisfy a later one. Non-zero exits are expected on the red
   * pins (cmd.exe tries to run the cut-off lines as commands), so the exit
   * status is not asserted; the argv file is the evidence.
   */
  async function runThroughHost(
    host: HostSpec,
    commandLine: string,
    options: { bypassPolicy?: boolean } = {},
  ): Promise<string[]> {
    runCounter += 1;
    const outPath = path.join(tempDir, `argv-${runCounter}.json`);
    expect(fs.existsSync(outPath)).toBe(false);
    const env = {
      ...process.env,
      KANGENTIC_RECEIVER_OUT: outPath,
      // The shim's `node` fallback must resolve under any launcher.
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    let diagnostics = '';
    try {
      if (host.family === 'powershell') {
        const hostArguments = ['-NoProfile', '-NonInteractive'];
        if (options.bypassPolicy !== false) hostArguments.push('-ExecutionPolicy', 'Bypass');
        hostArguments.push('-EncodedCommand', Buffer.from(commandLine, 'utf16le').toString('base64'));
        const result = await execFileAsync(host.path, hostArguments, {
          env, timeout: 30_000, windowsHide: true, encoding: 'utf-8',
        });
        diagnostics = result.stderr;
      } else {
        // `-s` reads the command from stdin, the way the PTY types it.
        execFileSync(host.path, ['--noprofile', '--norc', '-s'], {
          input: `${commandLine}\n`, env, timeout: 30_000, windowsHide: true, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (error) {
      diagnostics = error instanceof Error ? error.message : String(error);
    }
    if (!fs.existsSync(outPath)) {
      throw new Error(`${host.name} never ran the receiver for: ${commandLine}\n${diagnostics}`);
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8')) as string[];
  }

  /** The command line the spawn flow types: builder output plus the host's own head adaptation. */
  function typedLine(built: string, host: HostSpec): string {
    return adaptCommandForShell(built, host.path, 'win32');
  }

  function buildCodexCommand(host: HostSpec, codexPath: string, prompt: string | undefined): string {
    // No eventsOutputPath, so buildHooks never runs and there is no hook file
    // I/O; MCP off so no -c payload. What remains is the head, -C, the
    // approval flags, and the positional prompt: the reporter's exact shape.
    return new CodexCommandBuilder().buildCodexCommand({
      codexPath,
      taskId: 'task-353',
      cwd: tempDir,
      permissionMode: 'default',
      shell: host.path,
      prompt,
      mcpServerEnabled: false,
    });
  }

  describe.each(HOSTS)('$name', (host) => {
    it('is recognised by the shell predicates the resolver keys on', () => {
      expect(isPowerShellShell(host.path)).toBe(host.family === 'powershell');
    });

    it.each([
      ['the npm cmd-shim', () => cmdShim],
      ['the tests/fixtures mock-*.cmd shape', () => minimalCmdShim],
    ])('red pin: a quoteArg multiline prompt through %s reaches the receiver as <task> alone', async (_label, shim) => {
      const built = `${quoteArg(shim(), host.path)} ${quoteArg(XML, host.path, { multiline: true })}`;

      const argv = await runThroughHost(host, typedLine(built, host));

      // Strict equality also proves the newline ended the whole command line:
      // nothing after it reached the receiver either.
      expect(argv).toEqual(['<task>']);
    }, 60_000);

    it('red pin: the real CodexCommandBuilder command through the .cmd shim loses everything after the first line', async () => {
      const built = buildCodexCommand(host, cmdShim, XML);

      const argv = await runThroughHost(host, typedLine(built, host));

      expect(argv).toContain('-C');
      expect(argv.at(-1)).toBe('<task>');
    }, 60_000);

    it('green: resolveShimLaunch picks the sibling shim and the receiver gets the XML byte for byte', async () => {
      resetShimLaunchCacheForTests();
      // The policy is injected so this case is deterministic whatever the
      // machine's setting; the runner's -ExecutionPolicy Bypass covers the
      // script itself. The Git Bash route has no policy to inject.
      const launch = await resolveShimLaunch(
        { agentPath: cmdShim, shell: host.path, prompt: XML },
        { probeExecutionPolicy: async () => 'RemoteSigned' },
      );
      expect(launch.agentPath).toBe(host.family === 'powershell' ? ps1Shim : shShim);
      expect(launch.strategy).toBe(host.family === 'powershell' ? 'ps1-sibling' : 'sh-sibling');
      expect(launch.prompt).toBe(XML);
      const built = buildCodexCommand(host, launch.agentPath, launch.prompt);

      const argv = await runThroughHost(host, typedLine(built, host));

      expect(argv).toContain('-C');
      expect(argv.at(-1)).toBe(XML);
    }, 60_000);

    it('green: a quoted -- end-of-options marker survives the sibling shim ahead of the prompt', async () => {
      // The Claude, Grok, Ollama, and Warp builders emit the marker before the
      // prompt. PowerShell's binder eats a bare -- before a .ps1 sees $args;
      // quoteArg's quoted form is what reaches the receiver as a plain --.
      const shim = host.family === 'powershell' ? ps1Shim : shShim;
      const built = `${quoteArg(shim, host.path)} ${quoteArg('--', host.path)} ${quoteArg(XML, host.path, { multiline: true })}`;

      const argv = await runThroughHost(host, typedLine(built, host));

      expect(argv).toEqual(['--', XML]);
    }, 60_000);

    it('green: the flatten fallback through the .cmd shim delivers the whole prompt on one line', async () => {
      resetShimLaunchCacheForTests();
      // PowerShell: the probe says Restricted. Git Bash: no sh sibling. Both
      // keep the .cmd head and flatten; this is also the path the Windows E2E
      // suite takes, since the mock fixtures have no sibling shims.
      const siblingless = path.join(tempDir, 'lonely.cmd');
      fs.writeFileSync(siblingless, NPM_CMD_SHIM, 'utf8');
      const launch = await resolveShimLaunch(
        { agentPath: siblingless, shell: host.path, prompt: XML },
        { probeExecutionPolicy: async () => 'Restricted', warn: () => {} },
      );
      expect(launch.agentPath).toBe(siblingless);
      expect(launch.strategy).toBe('flattened-prompt');
      const built = buildCodexCommand(host, launch.agentPath, launch.prompt);

      const argv = await runThroughHost(host, typedLine(built, host));

      expect(argv.at(-1)).toBe(sanitizeForPty(XML));
      expect(argv.at(-1)).toContain('<title>Fix login for issue 353</title>');
    }, 60_000);

    if (host.family === 'powershell') {
      it('the production execution-policy probe returns a known policy name from this host', async () => {
        const policy = await probeExecutionPolicy(host.path);

        expect(policy).toMatch(/^(Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Undefined)$/);
      }, 60_000);

      it('under the host\'s own policy, a permissive machine runs the .ps1 sibling (skips when blocked)', async (context) => {
        // The one case that ties the probe's verdict to what a live PTY,
        // spawned with only -NoLogo, would actually do.
        const policy = await probeExecutionPolicy(host.path);
        if (!executionPolicyAllowsScripts(policy)) {
          context.skip();
          return;
        }
        const built = buildCodexCommand(host, ps1Shim, XML);

        const argv = await runThroughHost(host, typedLine(built, host), { bypassPolicy: false });

        expect(argv.at(-1)).toBe(XML);
      }, 60_000);
    }
  });
});
