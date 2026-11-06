import path from 'node:path';
import {
  adaptCommandForShell,
  buildSpawnClearPrelude,
  isCmdShell,
  isFishShell,
  isNushellShell,
  isPowerShellShell,
  isUncPath,
  parseWslUncPath,
  quoteArg,
  toWslPath,
} from '../../../shared/paths';
import { isWindowsBatchShim } from '../../agent/shared/npm-shim-target';
import { parseWslShellSpec, type WslShellSpec } from '../process-tag/task-process-tag';

/** CreateProcess's limit on a command line, in characters: 32,767 less its terminating NUL. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_766;

/** cmd.exe's limit on the line it reads, which a `.cmd` or `.bat` head runs through too. */
export const CMD_COMMAND_LINE_LIMIT = 8_191;

/** Linux's MAX_ARG_STRLEN: the most bytes one argument to `exec` can hold. */
export const LINUX_ARGUMENT_BYTE_LIMIT = 131_072;

/**
 * Whether a launch's arguments reach Linux's `exec`: on Linux, and from a WSL
 * shell, whose CLI runs in the distro. A description under
 * `TASK_DESCRIPTION_MAX_LENGTH` cannot reach this limit, but an imported one can.
 * macOS has no limit per argument, and its 1 MiB for a whole launch is out of
 * reach.
 */
export function launchRunsOnLinux(input: { shell: string; platform: NodeJS.Platform }): boolean {
  return input.platform === 'linux' || (input.platform === 'win32' && parseWslShellSpec(input.shell) !== null);
}

/**
 * The longest command line a Windows launch can have, in characters, or null off
 * Windows and under a WSL shell, where a launch has no such limit.
 */
export function commandLineLimit(input: {
  /** The program the command starts: an agent's path, or a built command's head. */
  program: string;
  shell: string;
  platform: NodeJS.Platform;
}): number | null {
  if (input.platform !== 'win32' || parseWslShellSpec(input.shell) !== null) return null;
  const throughCmd = isCmdShell(input.shell.toLowerCase()) || isWindowsBatchShim(input.program);
  return throughCmd ? CMD_COMMAND_LINE_LIMIT : WINDOWS_COMMAND_LINE_LIMIT;
}

/**
 * A built command's first token, without the quotes `quoteArg` gave it. A POSIX
 * shell's apostrophe is `'\''` inside single quotes, which does not end the token.
 */
function commandHead(command: string): string {
  const trimmed = command.trimStart();
  const quote = trimmed[0];
  if (quote === "'") {
    const quoted = /^'((?:[^']|'\\'')*)'/.exec(trimmed);
    return quoted ? quoted[1].replaceAll("'\\''", "'") : trimmed.slice(1);
  }
  if (quote === '"') {
    const closing = trimmed.indexOf(quote, 1);
    return closing === -1 ? trimmed.slice(1) : trimmed.slice(1, closing);
  }
  const space = trimmed.search(/\s/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/**
 * What a command takes up as a process's command line, as opposed to as typed.
 * PowerShell's backtick escapes are spent before the process starts, so they
 * count for nothing. A `"` a Git Bash keeps inside single quotes reaches the
 * Windows program as `\"`, so it counts for two.
 */
function processCommandLineLength(command: string, shellName: string): number {
  if (isPowerShellShell(shellName)) return command.replace(/`([\s\S])/g, '$1').length;
  if (isCmdShell(shellName)) return command.length;
  return command.length + (command.match(/"/g)?.length ?? 0);
}

/**
 * Whether a built command can start at all under `shell`. A launch past its
 * limit fails in the shell with the agent never started, and nothing reports it
 * for minutes, so the spawn refuses one before it has a PTY
 * (`AgentCommandTooLongError`). On Linux this measures the whole command, which
 * is never shorter than its longest argument.
 */
export function commandFitsShell(input: { command: string; shell: string; platform: NodeJS.Platform }): boolean {
  if (launchRunsOnLinux(input)) return Buffer.byteLength(input.command, 'utf8') <= LINUX_ARGUMENT_BYTE_LIMIT;
  const limit = commandLineLimit({ program: commandHead(input.command), shell: input.shell, platform: input.platform });
  if (limit === null) return true;
  return processCommandLineLength(input.command, input.shell.toLowerCase()) <= limit;
}

/**
 * The longest line, in bytes with its Enter, that a spawn types into a shell.
 *
 * A spawn types its command 100 ms after the shell starts, and a shell in its
 * startup files has not reached its line editor, so the tty is in canonical
 * mode. There the kernel keeps one line per its own limit and drops the rest,
 * the Enter included: 1024 bytes on macOS (`MAX_CANON`), about 4 KB on Linux.
 * The agent then never starts, and nothing reports an error. Whether a long
 * line survives depends on how far the shell got in those 100 ms.
 *
 * Under 1024 with room to spare, since a key the user pressed may already be
 * in the same queue.
 */
export const TYPED_LINE_BYTE_BUDGET = 900;

export interface TypedLaunchInput {
  /** The agent command, before any shell adaptation. */
  command: string;
  /** The session's shell spec, as `performSpawn` resolved it. */
  shell: string;
  /** The folder a launcher file may go in, or null to always type the command. */
  sessionDirectory: string | null;
  /** Injectable for tests (cross-platform parity); production passes the real one. */
  platform: NodeJS.Platform;
}

export interface TypedLaunch {
  /** What to type into the shell, without its Enter. */
  typedLine: string;
  /** Bytes the kernel sees for that line, its Enter included. */
  typedLineBytes: number;
  /** The file `typedLine` sources, which the caller writes before typing. */
  launcher: { filePath: string; contents: string } | null;
}

/**
 * Canonical mode is a POSIX tty's. A native Windows shell reads a console, which
 * has no such line limit, and a sourced `.ps1` would meet the execution policy
 * there. A WSL shell reads a Linux tty in the distro.
 */
function readsPosixTty(wslShell: WslShellSpec | null, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' || wslShell !== null;
}

/**
 * The launcher's path as the shell reads it, or null when it has none: a WSL
 * shell cannot reach a Windows share, or another distro's files. A sourced path
 * that does not resolve fails every launch, where a typed line fails only while
 * the shell is slow, so those type the whole command.
 */
function launcherPathForShell(filePath: string, wslShell: WslShellSpec | null): string | null {
  if (wslShell === null) return filePath;
  const distroPath = parseWslUncPath(filePath);
  if (distroPath) {
    const sameDistro = wslShell.distro === null || wslShell.distro.toLowerCase() === distroPath.distro.toLowerCase();
    return sameDistro ? distroPath.linuxPath : null;
  }
  return isUncPath(filePath) ? null : toWslPath(filePath);
}

/**
 * The file name and the statement that runs it, given the file's quoted path.
 *
 * A POSIX shell evaluates the file's text (`eval "$(cat <path>)"`) instead of
 * sourcing it. Measured on bash, a SIGHUP to the shell leaves an agent started
 * from a sourced file running, where it ends an agent typed at the prompt, and a
 * suspend ends a Linux Claude by exactly that hangup. `eval` keeps the agent a
 * job of the interactive shell, so the hangup reaches it as it does a typed line,
 * and still runs in this shell. `cat` rather than `$(< file)`, which dash and sh
 * lack. The text is parsed as the typed line would have been.
 *
 * fish, nushell and PowerShell still source, which has no such measurement:
 * nushell's `source` is a parser keyword that reads its path while the line
 * parses, so a literal is the only form it takes, and the file has to exist
 * before the line is typed. PowerShell dot-sources only a `.ps1`.
 * `typed-launch-round-trip.test.ts` hangs each of them up.
 */
function launcherFormFor(shellName: string): { fileName: string; run: (quotedPath: string) => string } {
  if (isNushellShell(shellName)) return { fileName: 'launch.nu', run: (quotedPath) => `source ${quotedPath}` };
  if (isFishShell(shellName)) return { fileName: 'launch.fish', run: (quotedPath) => `source ${quotedPath}` };
  if (isPowerShellShell(shellName)) return { fileName: 'launch.ps1', run: (quotedPath) => `. ${quotedPath}` };
  return { fileName: 'launch.sh', run: (quotedPath) => `eval "$(cat ${quotedPath})"` };
}

function typedLaunchOf(typedLine: string, launcher: TypedLaunch['launcher']): TypedLaunch {
  return { typedLine, typedLineBytes: Buffer.byteLength(`${typedLine}\r`, 'utf8'), launcher };
}

/**
 * The line a spawn types, keeping it short whatever the command's length.
 *
 * Within the budget the command is typed as it is. Past it, the command goes in a
 * file and the shell is typed a line that runs it in the same shell the typed
 * line would have (`launcherFormFor`). The clear prelude stays on the typed line, so it runs
 * first either way. The file holds `adaptCommandForShell`'s output, already quoted
 * for that shell.
 */
export function buildTypedLaunch(input: TypedLaunchInput): TypedLaunch {
  const shellName = input.shell.toLowerCase();
  const prelude = buildSpawnClearPrelude(shellName);
  const adapted = adaptCommandForShell(input.command, shellName, input.platform);
  const fullLaunch = typedLaunchOf(prelude + adapted, null);
  if (fullLaunch.typedLineBytes <= TYPED_LINE_BYTE_BUDGET) return fullLaunch;
  const wslShell = parseWslShellSpec(input.shell);
  if (input.sessionDirectory === null || !readsPosixTty(wslShell, input.platform)) return fullLaunch;

  const { fileName, run } = launcherFormFor(shellName);
  const filePath = path.join(input.sessionDirectory, fileName);
  const shellPath = launcherPathForShell(filePath, wslShell);
  if (shellPath === null) return fullLaunch;
  // `multiline` only to keep the path exact: the default form collapses a run of
  // spaces, which a folder name may hold.
  const typedLine = prelude + run(quoteArg(shellPath, shellName, { multiline: true }));
  return typedLaunchOf(typedLine, { filePath, contents: `${adapted}\n` });
}
