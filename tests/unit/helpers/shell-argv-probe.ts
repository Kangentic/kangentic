/**
 * A live rig for the shell escapes in `quoteArg`, `quoteForCmdShell` and
 * `escapeForDoubleQuotedShell`. It types real command lines into a real cmd.exe
 * or PowerShell and reads back the argv a node process received, so those
 * escapes are checked against the shells themselves rather than against a
 * string someone wrote down.
 *
 * Under cmd the probe sits behind an npm-style `.cmd` shim. Under a cmd host,
 * `resolveShimLaunch` keeps an npm-installed agent's shim as it is, and the
 * shim's `%*` line is a second cmd parse between the escape and the agent.
 * There are two copies. `shimPath` sits in a plain directory, so it isolates
 * the argument escape. `percentShimPath` sits in a directory whose name starts
 * with `%KNG_PROBE%`, so a command head that is not escaped fails to resolve,
 * and the backslash before that `%` is doubled by the escape (measured to
 * resolve on both routes). Every run sets KNG_PROBE=EXPANDED, so an input
 * holding `%KNG_PROBE%` shows an expansion as that word.
 *
 * Windows only, and callers gate on it. CI runs Linux and skips those blocks,
 * so the string pins next to them are what CI checks.
 *
 * cmd input stays ASCII. cmd reads piped stdin in the console's OEM code page,
 * so a UTF-8 `é` arrives mangled over the pipe even though a real ConPTY prompt
 * delivers it intact (measured). `typeAtCmdPrompt` throws on a non-ASCII line,
 * which a temp or checkout path under a non-ASCII user name produces, rather
 * than report it as a quoting failure. PowerShell gets its lines from a UTF-8
 * script file with a byte order mark instead, which both hosts read correctly,
 * and which PowerShell tokenizes exactly as it does a line typed at its prompt.
 * One difference is upstream of the tokenizer. Windows PowerShell 5.1 at a
 * ConPTY prompt drops the curly double quotes (and U+2713) from typed input,
 * which a script file does not, so the PowerShell round trip checks the
 * tokenizer only. No test here reproduces that drop. It is why
 * `escapeForDoubleQuotedShell` doubles a curly quote instead of backticking it,
 * and shell-quote.test.ts pins that no backtick is emitted.
 *
 * The argv printer writes every non-ASCII character as a `\uXXXX` JSON escape,
 * so the argv it prints survives whatever code page a shell decodes its output
 * in on the way back.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The value KNG_PROBE holds in every probe run. */
export const PROBE_EXPANSION = 'EXPANDED';

/** Extra environment for a probe run: KNG_PROBE set, everything else inherited. */
export const PROBE_ENVIRONMENT_OVERRIDES: Record<string, string> = { KNG_PROBE: PROBE_EXPANSION };

/**
 * Longest one shell run may take. `spawnSync` blocks the event loop, so the
 * test's own timeout cannot interrupt a hung shell. This bound sits under the
 * 30 s budget of the tests that run one shell, and two runs fit the 60 s
 * budget of the test that runs both PowerShell hosts.
 */
const PROBE_RUN_TIMEOUT_MS = 25_000;

/** npm cmd-shim's template, forwarding `%*` to the argv printer beside it. */
const NPM_STYLE_SHIM = [
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
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\probe.js" %*',
  '',
].join('\r\n');

const ARGV_PRINTER = String.raw`const argvJson = JSON.stringify(process.argv.slice(2));
console.log(argvJson.replace(/[\u007f-￿]/g, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')));
`;

export interface ShellArgvProbe {
  /** The npm-style shim in a plain directory, used as the agent's command head. */
  readonly shimPath: string;
  /** The same shim in a directory whose name starts with `%KNG_PROBE%`. */
  readonly percentShimPath: string;
  /** The argv printer itself, for a host that runs node directly. */
  readonly printerPath: string;
  /** Scratch directory for the PowerShell script files. */
  readonly scratchDirectory: string;
  /** Removes the probe's temp directory. */
  dispose(): void;
}

function writeShim(directory: string): string {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'probe.js'), ARGV_PRINTER);
  fs.writeFileSync(path.join(directory, 'agent.cmd'), NPM_STYLE_SHIM);
  return path.join(directory, 'agent.cmd');
}

export function createShellArgvProbe(): ShellArgvProbe {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-argv-probe-'));
  const shimPath = writeShim(path.join(root, 'plain'));
  const scratchDirectory = path.join(root, 'scratch');
  fs.mkdirSync(scratchDirectory);
  return {
    shimPath,
    percentShimPath: writeShim(path.join(root, '%KNG_PROBE%dir')),
    printerPath: path.join(path.dirname(shimPath), 'probe.js'),
    scratchDirectory,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Every argv the probe printed, in order, with whatever else the run wrote. */
export interface ProbeRun {
  readonly printed: string[][];
  /** Output lines that are not a printed argv, such as a command that should not have run. */
  readonly strayLines: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The argv a probe line printed, or null for any other line, error text included. */
function parseArgvLine(line: string): string[] | null {
  const argvMatch = /\["[^\r\n]*\]/.exec(line);
  if (!argvMatch) return null;
  try {
    const parsed: unknown = JSON.parse(argvMatch[0]);
    return isStringArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readProbeOutput(output: string): ProbeRun {
  const printed: string[][] = [];
  const strayLines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const argv = parseArgvLine(line);
    if (argv) {
      printed.push(argv);
    } else if (line.trim().length > 0) {
      strayLines.push(line);
    }
  }
  return { printed, strayLines };
}

/** Throws with the shell's own error and stderr when the run did not finish. */
function assertRunFinished(result: SpawnSyncReturns<string>, shellName: string): void {
  if (result.error || typeof result.stdout !== 'string') {
    const reason = result.error?.message ?? 'no stdout';
    throw new Error(`${shellName} probe run failed: ${reason}. stderr: ${String(result.stderr ?? '')}`);
  }
}

/**
 * Type each line at one interactive cmd prompt (piped stdin, which parses the
 * same way a ConPTY prompt does, measured) and return every argv the probe
 * printed, in order. `/d` skips the user's AutoRun so it cannot change the line.
 */
export function typeAtCmdPrompt(lines: readonly string[]): string[][] {
  const nonAsciiLine = lines.find((line) => /[^ -~]/.test(line));
  if (nonAsciiLine !== undefined) {
    throw new Error(
      `cmd reads piped stdin in the OEM code page, so this line would arrive mangled. Run from an ASCII-only temp and checkout path: ${nonAsciiLine}`,
    );
  }
  const result = spawnSync('cmd.exe', ['/d', '/q'], {
    input: `${lines.join('\r\n')}\r\nexit\r\n`,
    encoding: 'utf8',
    env: { ...process.env, ...PROBE_ENVIRONMENT_OVERRIDES },
    windowsHide: true,
    timeout: PROBE_RUN_TIMEOUT_MS,
  });
  assertRunFinished(result, 'cmd.exe');
  // The prompt, the banner and a `cls` form feed are cmd's own output, so the
  // stray lines say nothing here.
  return readProbeOutput(result.stdout).printed;
}

/**
 * The PowerShell hosts installed here: Windows PowerShell always, pwsh when on
 * PATH. A developer machine without pwsh runs the 5.1 half only. The Windows
 * workflow sets KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS, so a runner image that
 * lost pwsh fails there instead of quietly halving what it checks.
 */
export function installedPowerShellHosts(): string[] {
  const hosts = ['powershell.exe'];
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
    timeout: PROBE_RUN_TIMEOUT_MS,
  });
  if (pwsh.status === 0) {
    hosts.push('pwsh');
  } else if (process.env.KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS === '1') {
    throw new Error('pwsh is not on PATH, and KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS requires it');
  }
  return hosts;
}

/**
 * Run each line through `host`, as a script file the host tokenizes the way it
 * tokenizes its prompt. `-ExecutionPolicy Bypass` applies to this one process.
 */
export function typeAtPowerShellPrompt(probe: ShellArgvProbe, host: string, lines: readonly string[]): ProbeRun {
  const scriptPath = path.join(probe.scratchDirectory, 'typed-lines.ps1');
  const byteOrderMark = String.fromCodePoint(0xfeff);
  fs.writeFileSync(scriptPath, `${byteOrderMark}${lines.join('\r\n')}\r\n`, 'utf8');
  const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...PROBE_ENVIRONMENT_OVERRIDES },
    windowsHide: true,
    timeout: PROBE_RUN_TIMEOUT_MS,
  });
  assertRunFinished(result, host);
  return readProbeOutput(`${result.stdout}\n${result.stderr}`);
}
