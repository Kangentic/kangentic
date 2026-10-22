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
 *
 * nushell and fish get the same treatment (`typeAtPosixShell`). They are in the
 * shell picker on macOS and Linux only, and neither quotes like POSIX sh, so
 * `quoteArg` has a branch for each. `shell-quoting-posix.yml` installs both on
 * Linux; anywhere else the round trip runs only where they are on PATH (nushell
 * on Windows included, whose parser is the same; fish has no Windows build). On
 * POSIX the probe adds `posixAgentPath`, an executable script in a directory
 * whose name has a space, so the agent's own path is quoted the way a Homebrew
 * `node@22` path is, and nushell has to run a quoted command head.
 *
 * `runAsHookShell` covers a different entry point: an agent CLI handing a whole
 * hook or status-line command to a shell as one argument, never a prompt line.
 * It runs on every platform (sh and bash off Windows), and on Windows finds Git
 * Bash at its install path.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptCommandForShell, quoteArg } from '../../../src/shared/paths';

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
  /**
   * POSIX only (null on Windows): an executable `/bin/sh` script, in a
   * directory whose name has a space, that runs the argv printer. Used as an
   * agent's command head so that head is quoted.
   */
  readonly posixAgentPath: string | null;
  /** Scratch directory for the PowerShell, nushell and fish script files. */
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

/** A `/bin/sh` script that hands its arguments to the argv printer unchanged. */
function writePosixAgent(directory: string, printerPath: string): string {
  fs.mkdirSync(directory);
  const agentPath = path.join(directory, 'agent');
  const singleQuoted = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(agentPath, `#!/bin/sh\nexec ${singleQuoted(process.execPath)} ${singleQuoted(printerPath)} "$@"\n`);
  fs.chmodSync(agentPath, 0o755);
  return agentPath;
}

export function createShellArgvProbe(): ShellArgvProbe {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-argv-probe-'));
  const shimPath = writeShim(path.join(root, 'plain'));
  const printerPath = path.join(path.dirname(shimPath), 'probe.js');
  const scratchDirectory = path.join(root, 'scratch');
  fs.mkdirSync(scratchDirectory);
  return {
    shimPath,
    percentShimPath: writeShim(path.join(root, '%KNG_PROBE%dir')),
    printerPath,
    posixAgentPath: process.platform === 'win32' ? null : writePosixAgent(path.join(root, 'agent dir'), printerPath),
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

/** A PowerShell host, by the program name it runs as. */
export type PowerShellHost = 'powershell.exe' | 'pwsh';

let cachedPowerShellHosts: PowerShellHost[] | undefined;

/**
 * The PowerShell hosts installed here: Windows PowerShell always, pwsh when on
 * PATH. A developer machine without pwsh runs the 5.1 half only. The Windows
 * workflow sets KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS, so a runner image that
 * lost pwsh fails there instead of quietly halving what it checks. The answer
 * is kept for the test file, so pwsh starts once per file, not once per test.
 */
export function installedPowerShellHosts(): PowerShellHost[] {
  if (cachedPowerShellHosts) return cachedPowerShellHosts;
  const hosts: PowerShellHost[] = ['powershell.exe'];
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
    timeout: PROBE_RUN_TIMEOUT_MS,
  });
  if (pwsh.status === 0) {
    hosts.push('pwsh');
  } else if (process.env.KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS === '1') {
    throw new Error('pwsh is not on PATH, and KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS requires it');
  }
  cachedPowerShellHosts = hosts;
  return hosts;
}

/**
 * The line a PowerShell host types for a built agent command, with the agent's
 * head swapped for node and the argv printer so it runs here. Throws when the
 * command does not start with `agentHead`, so a builder that changes its head
 * fails here instead of typing the real agent.
 */
export function lineWithPrinterHead(probe: ShellArgvProbe, host: string, command: string, agentHead: string): string {
  if (!command.startsWith(`${agentHead} `)) {
    throw new Error(`The command does not start with ${agentHead}: ${command}`);
  }
  const printerHead = `${quoteArg(process.execPath, host)} ${quoteArg(probe.printerPath, host)}`;
  return adaptCommandForShell(`${printerHead}${command.slice(agentHead.length)}`, host, 'win32');
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

/** The shells with their own `quoteArg` branch outside POSIX sh. */
export type PosixProbeShell = 'nu' | 'fish';

const POSIX_PROBE_SHELLS: readonly PosixProbeShell[] = ['nu', 'fish'];

/** How each shell runs a script file without the user's own config. */
const POSIX_SCRIPT_ARGS: Record<PosixProbeShell, readonly string[]> = {
  nu: ['--no-config-file'],
  fish: ['--no-config'],
};

let cachedPosixShells: PosixProbeShell[] | undefined;

/**
 * nushell and fish, where each is on PATH. `shell-quoting-posix.yml` sets
 * KANGENTIC_SHELL_PROBE_REQUIRE_POSIX_SHELLS, so a runner that lost either
 * fails there instead of skipping the round trip. Cached for the test file.
 */
export function installedPosixShells(): PosixProbeShell[] {
  if (cachedPosixShells) return cachedPosixShells;
  const shells: PosixProbeShell[] = [];
  for (const shell of POSIX_PROBE_SHELLS) {
    const version = spawnSync(shell, ['--version'], { windowsHide: true, timeout: PROBE_RUN_TIMEOUT_MS });
    if (version.status === 0) {
      shells.push(shell);
    } else if (process.env.KANGENTIC_SHELL_PROBE_REQUIRE_POSIX_SHELLS === '1') {
      throw new Error(`${shell} is not on PATH, and KANGENTIC_SHELL_PROBE_REQUIRE_POSIX_SHELLS requires it`);
    }
  }
  cachedPosixShells = shells;
  return shells;
}

/**
 * The shells an agent CLI hands a whole hook or status-line command to, each
 * entered the way a CLI was measured to enter it (docs/integrations/agents/claude-code.md,
 * "Paths in hook commands"):
 * - `sh`, `bash`: `-c <command>` (macOS and Linux).
 * - `git-bash`: `bash.exe -c <command>` (Claude Code on Windows with Git Bash).
 * - `powershell.exe`, `pwsh`: `-NoProfile -NonInteractive -Command <command>`
 *   (Claude Code without Git Bash, Gemini, Copilot hooks, grok).
 * - `cmd-verbatim`: `cmd /d /s /c "<command>"` passed verbatim (Node's
 *   `shell: true`: the Copilot status line).
 * - `cmd-escaped`: `cmd /d /s /c <command>` with Node's normal argument
 *   escaping, which turns each `"` into `\"` (Qwen's hooks).
 */
export type HookShellHost = 'sh' | 'bash' | 'git-bash' | PowerShellHost | 'cmd-verbatim' | 'cmd-escaped';

/**
 * A folder name every hook round trip puts its paths under. Each shell or CLI
 * that expands `$KNG_PROBE`, `${KNG_PROBE}` or `%KNG_PROBE%` shows EXPANDED,
 * and the adjacent `$$`, `` `$ `` and curly pair catch a quoting that writes two
 * single-quoted runs back to back, which PowerShell reads as one with a quote
 * in it. Legal in a Windows file name, so it runs on every platform.
 */
export const HOOK_PROBE_SEGMENT = "k $KNG_PROBE `t %KNG_PROBE% & 'q ${KNG_PROBE} “c” $$KNG_PROBE `$KNG_PROBE “”";

/**
 * Matches what Gemini, Qwen and grok replace in a hook command before any shell
 * sees it: `$NAME`, `${NAME}` and `${NAME:-default}`. Copied from Gemini CLI
 * 0.64.0's `resolveEnvVarsInString`. A built command must never match it.
 */
export const CLI_ENVIRONMENT_REFERENCE = /\$(?:(\w+)|{([^}]+?)(?::-([^}]*))?})/;

let cachedGitBash: string | null | undefined;
let cachedShOrPowerShellHosts: HookShellHost[] | undefined;

/**
 * Git Bash at its install path, or null. Looked up there only, because a bare
 * `which bash` on Windows can return the WSL launcher in System32. The Windows
 * workflow sets KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS, so a runner that lost
 * Git Bash fails instead of skipping its round trips.
 */
export function gitBashPath(): string | null {
  if (cachedGitBash !== undefined) return cachedGitBash;
  const candidate = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (fs.existsSync(candidate)) {
    cachedGitBash = candidate;
  } else if (process.env.KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS === '1') {
    throw new Error(`Git Bash is not at ${candidate}, and KANGENTIC_SHELL_PROBE_REQUIRE_ALL_HOSTS requires it`);
  } else {
    cachedGitBash = null;
  }
  return cachedGitBash;
}

/** Whether `shell -c` runs here (sh and bash off Windows). */
function posixShellRuns(shell: 'sh' | 'bash'): boolean {
  return spawnSync(shell, ['-c', 'exit 0'], { windowsHide: true, timeout: PROBE_RUN_TIMEOUT_MS }).status === 0;
}

/**
 * The hosts that run a command quoted for `sh-or-powershell` here: Git Bash and
 * both PowerShells on Windows, sh and bash elsewhere. Only those installed.
 * Cached for the test file, like the hosts it is built from.
 */
export function installedShOrPowerShellHosts(): HookShellHost[] {
  if (cachedShOrPowerShellHosts) return cachedShOrPowerShellHosts;
  if (process.platform !== 'win32') {
    cachedShOrPowerShellHosts = (['sh', 'bash'] as const).filter((shell) => posixShellRuns(shell));
  } else {
    cachedShOrPowerShellHosts = [...(gitBashPath() ? ['git-bash' as const] : []), ...installedPowerShellHosts()];
  }
  return cachedShOrPowerShellHosts;
}

/**
 * Run `build` with `process.platform` reading `platform`. The bridge builders
 * read it at call time, so this pins a Windows command's string on Linux CI.
 */
export function buildForPlatform<T>(platform: NodeJS.Platform, build: () => T): T {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!originalPlatformDescriptor) throw new Error('process.platform has no property descriptor');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return build();
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
}

/** Write the argv printer into `directory` and return its path. */
export function writeArgvPrinter(directory: string, fileName = 'print-argv.cjs'): string {
  fs.mkdirSync(directory, { recursive: true });
  const printerPath = path.join(directory, fileName);
  fs.writeFileSync(printerPath, ARGV_PRINTER);
  return printerPath;
}

/**
 * Run a whole hook command through `host` the way a CLI does, with KNG_PROBE
 * and `env` set and `input` on stdin (the CLI's payload), and return every argv
 * the printer printed with any other output.
 */
export function runAsHookShell(
  host: HookShellHost,
  command: string,
  options: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): ProbeRun {
  const spawnOptions = {
    encoding: 'utf8' as const,
    cwd: options.cwd,
    input: options.input ?? '',
    env: { ...process.env, ...PROBE_ENVIRONMENT_OVERRIDES, ...options.env },
    windowsHide: true,
    timeout: PROBE_RUN_TIMEOUT_MS,
  };
  let result: SpawnSyncReturns<string>;
  switch (host) {
    case 'sh':
    case 'bash':
      result = spawnSync(host, ['-c', command], spawnOptions);
      break;
    case 'git-bash': {
      const bash = gitBashPath();
      if (!bash) throw new Error('Git Bash is not installed here');
      result = spawnSync(bash, ['-c', command], spawnOptions);
      break;
    }
    case 'powershell.exe':
    case 'pwsh':
      result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-Command', command], spawnOptions);
      break;
    case 'cmd-verbatim':
      result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...spawnOptions, windowsVerbatimArguments: true });
      break;
    case 'cmd-escaped':
      result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], spawnOptions);
      break;
  }
  assertRunFinished(result, host);
  return readProbeOutput(`${result.stdout}\n${result.stderr}`);
}

/**
 * Run each line through `shell` as a script file of its own, which the shell
 * tokenizes as it does its prompt. One process per line, so every line's
 * command is the script's last and its output is never held back as an
 * intermediate value.
 */
export function typeAtPosixShell(probe: ShellArgvProbe, shell: PosixProbeShell, lines: readonly string[]): ProbeRun {
  let output = '';
  lines.forEach((line, index) => {
    const scriptPath = path.join(probe.scratchDirectory, `typed-line-${index}.${shell}`);
    fs.writeFileSync(scriptPath, `${line}\n`, 'utf8');
    const result = spawnSync(shell, [...POSIX_SCRIPT_ARGS[shell], scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...PROBE_ENVIRONMENT_OVERRIDES },
      windowsHide: true,
      timeout: PROBE_RUN_TIMEOUT_MS,
    });
    assertRunFinished(result, shell);
    output += `${result.stdout}\n${result.stderr}\n`;
  });
  return readProbeOutput(output);
}
