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
import { quoteCmdExecutable } from '../../../shared/shell-quote';
import { isWindowsBatchShim, type BatchShimLaunch } from '../../agent/shared/npm-shim-target';
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

/**
 * The longest line, in bytes with its Enter, that a spawn types into cmd.
 *
 * cmd has a line limit of its own, reached through a real ConPTY at any point in
 * its startup: 8190 typed characters ran, and 8191 printed "The input line is too
 * long." and ran nothing, a `cls` ahead of it included. The limit counts UTF-16
 * characters and this counts UTF-8 bytes, which is never fewer, so it errs safe.
 *
 * Well under that limit, for two reasons. An npm `.cmd` shim's `%*` line has the
 * same limit with the shim's own text added (the node path, the script path,
 * PATHEXT), and past it the shim fails with no error at all. And a key the user
 * pressed may share the line. Nearly every launch stays typed: a 2E resume line
 * was 1575 bytes.
 */
export const CMD_TYPED_LINE_BYTE_BUDGET = 7000;

export interface TypedLaunchInput {
  /** The agent command, before any shell adaptation. */
  command: string;
  /** The session's shell spec, as `performSpawn` resolved it. */
  shell: string;
  /** The folder a launcher file may go in, or null to always type the command. */
  sessionDirectory: string | null;
  /** Injectable for tests (cross-platform parity); production passes the real one. */
  platform: NodeJS.Platform;
  /** What a `.cmd` head would start, or null when that cannot be known (`directLaunchOfBatchShim`). */
  batchShimLaunch: (shimPath: string) => BatchShimLaunch | null;
}

export interface TypedLaunch {
  /** What to type into the shell, without its Enter. */
  typedLine: string;
  /** Bytes the kernel sees for that line, its Enter included. */
  typedLineBytes: number;
  /** The file `typedLine` sources, which the caller writes before typing. */
  launcher: { filePath: string; contents: string } | null;
}

/** Written by a spawn in place of a command no launcher can get past a shim. */
const CMD_LINE_REFUSAL = 'The command line is too long.';

/**
 * Canonical mode is a POSIX tty's. A native Windows shell reads a console, which
 * has no such line limit, and a sourced `.ps1` would meet the execution policy
 * there, so PowerShell and Git Bash on Windows type every line, measured whole at
 * 15769 bytes. cmd is the exception, for a limit of its own
 * (`CMD_TYPED_LINE_BYTE_BUDGET`). A WSL shell reads a Linux tty in the distro.
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
 * Undo `escapePercentForCmd`, leaving each `%` plain. Its `"^%"` works only on a
 * typed line: in a batch file percent expansion runs first and eats it. The match
 * is exact because `quoteArg` never leaves a content `"` under cmd.
 */
function withPlainPercents(cmdLine: string): string {
  return cmdLine.replace(/(\\*)"\^%"/g, (_escape, backslashes: string) => `${backslashes.slice(backslashes.length / 2)}%`);
}

/** The first word of a command, quoted or bare, and what follows it. */
function splitHead(command: string): { head: string; rest: string } {
  const match = /^"([^"]+)"(.*)$/s.exec(command) ?? /^'([^']+)'(.*)$/s.exec(command) ?? /^(\S+)(.*)$/s.exec(command);
  return match ? { head: match[1], rest: match[2] } : { head: '', rest: command };
}

/** The words a shim would have started, in the order a command names them. */
function shimTargetWords(direct: BatchShimLaunch): string[] {
  return [direct.program, direct.script].filter((word) => word !== null);
}

/** A quoted word on a batch line, where cmd's percent expansion runs first. */
function quotedForBatch(word: string): string {
  return `"${word.replaceAll('%', '%%')}"`;
}

/**
 * A command's arguments as a batch file line. Every `"` and metacharacter takes a
 * caret and every `%` is doubled, so cmd is never inside a quote.
 *
 * It has to be. Past 8191 characters cmd's parser goes on reading the line but no
 * longer knows it is inside a quote, so with the argument quoted as a prompt quotes
 * it, a `<` past that point stops the launch and a `&` ends the command, running
 * the rest of the prompt as a second one (measured on cmd 10.0.26200, where a filler
 * of one repeated letter ran 15769 characters clean). A prompt can come from an
 * imported issue, so that is an injection. With nothing quoted there is no state to
 * lose. Measured to 30000 characters, exact, with metacharacters on both sides of
 * the limit and an escape across it in every alignment. cmd removes the carets, so
 * the agent's C runtime reads the quotes as it would have.
 *
 * A `for /f` variable is the other way to keep text from the parser, and it does
 * not work: past 8191 characters once expanded, nothing runs and nothing is printed.
 */
function batchArguments(text: string): string {
  return text.replace(/[\^&|<>()"]/g, '^$&').replaceAll('%', '%%');
}

/**
 * The text of `launch.cmd`, or null when no file can run this command.
 *
 * UTF-8 with no BOM, CRLF as measured. `chcp` first: a batch file is read in the
 * console's code page, so without it `café` arrives as `caf├⌐`. The code page
 * outlives the file, and that is accepted. A restore has to read the old page first
 * from `chcp`'s output, which is worded per locale, and would be a line that runs
 * after the agent exits, when nothing reads this console. The console is this
 * session's alone and ends with it, and a Node CLI writes to it as UTF-16.
 *
 * A `.cmd` or `.bat` head never runs from here. Its `%*` line fails past cmd's
 * limit with no error at all, so the file starts what the shim would have, and a
 * shim that cannot be read gets null. With a bare `node` the file takes `.JS` off
 * PATHEXT as npm's shim does, so a `node.js` in the task's folder cannot run. That
 * line outlives the file as the code page does, in the same console.
 *
 * A bare `cliPath` override has no extension to read, and cmd resolves it through
 * PATHEXT, so a shim found that way still runs its `%*` line. The launch then ends
 * as any other that never started.
 */
function cmdLauncherContents(adapted: string, batchShimLaunch: TypedLaunchInput['batchShimLaunch']): string | null {
  const { head, rest } = splitHead(withPlainPercents(adapted));
  const statements = ['@chcp 65001 >nul'];
  let program = quotedForBatch(head);
  if (isWindowsBatchShim(head)) {
    const direct = batchShimLaunch(head);
    if (direct === null) return null;
    if (direct.program === 'node') statements.push('@set "PATHEXT=%PATHEXT:;.JS;=;%"');
    program = shimTargetWords(direct).map(quotedForBatch).join(' ');
  }
  statements.push(`@${program}${batchArguments(rest)}`);
  return `${statements.join('\r\n')}\r\n`;
}

/** The launch for a line cmd cannot take: a launcher, or a named refusal. */
function cmdLaunch(sessionDirectory: string, input: TypedLaunchInput, prelude: string, adapted: string): TypedLaunch {
  const contents = cmdLauncherContents(adapted, input.batchShimLaunch);
  // Named rather than typed whole: under 8190 a too-long shim fails with no error.
  if (contents === null) return typedLaunchOf(`${prelude}echo ${CMD_LINE_REFUSAL}`, null);
  const filePath = path.join(sessionDirectory, 'launch.cmd');
  // `call` parses its line twice and doubles each caret, so it cannot find a path
  // holding one (measured). A bare path at a prompt runs the same file in the same
  // cmd, and reached every folder, but `call` is the form the tree was measured on.
  const run = filePath.includes('^') ? '' : 'call ';
  return typedLaunchOf(`${prelude}${run}${quoteCmdExecutable(filePath)}`, { filePath, contents });
}

/**
 * A Windows shell that types every line, with a `.cmd` head past cmd's budget.
 *
 * That head stays only where `resolveShimLaunch` found no sibling or a blocked
 * execution policy, and PowerShell or Git Bash then hands the line to cmd, which
 * runs the shim's `%*` line. Measured with a metacharacter in the prompt's tail: up
 * to 8000 characters ran exact, about 8050 ran nothing and printed nothing, and from
 * 8100 cmd printed "The command line is too long." So past the budget the line
 * starts what the shim would have, which these shells can do with no launcher. The
 * head's words are quoted for the shell, and it adapts them as it did the shim. A
 * bare `node` needs no PATHEXT line here: neither shell looks in the working folder.
 *
 * A shim that cannot be read gets the same named refusal as under cmd, from the same
 * budget. Its text is unknown, so the limit is too: a line of 7000 to 8000 bytes that
 * might have run is refused, which beats one that fails with no error.
 */
function typedPastBatchShim(input: TypedLaunchInput, shellName: string, prelude: string, fullLaunch: TypedLaunch): TypedLaunch {
  if (fullLaunch.typedLineBytes <= CMD_TYPED_LINE_BYTE_BUDGET) return fullLaunch;
  // The command as given, not the adapted line `cmdLauncherContents` splits: this
  // text goes back through `adaptCommandForShell` below.
  const { head, rest } = splitHead(input.command);
  if (!isWindowsBatchShim(head)) return fullLaunch;
  const direct = input.batchShimLaunch(head);
  if (direct === null) return typedLaunchOf(`${prelude}echo ${quoteArg(CMD_LINE_REFUSAL, shellName)}`, null);
  const words = shimTargetWords(direct).map((word) => quoteArg(word, shellName, { multiline: true }));
  return typedLaunchOf(prelude + adaptCommandForShell(`${words.join(' ')}${rest}`, shellName, input.platform), null);
}

/**
 * The line a spawn types, keeping it short whatever the command's length.
 *
 * Within the budget the command is typed as it is. Past it, the command goes in a
 * file and the shell is typed a line that runs it in the same shell the typed
 * line would have (`launcherFormFor`). The clear prelude stays on the typed line, so it runs
 * first either way. The file holds `adaptCommandForShell`'s output, already quoted
 * for that shell. cmd has its own budget and its own file form (`cmdLauncherContents`),
 * since a batch file does not read a line the way a prompt does.
 */
export function buildTypedLaunch(input: TypedLaunchInput): TypedLaunch {
  const shellName = input.shell.toLowerCase();
  const prelude = buildSpawnClearPrelude(shellName);
  const adapted = adaptCommandForShell(input.command, shellName, input.platform);
  const fullLaunch = typedLaunchOf(prelude + adapted, null);
  if (input.platform === 'win32' && isCmdShell(shellName)) {
    if (fullLaunch.typedLineBytes <= CMD_TYPED_LINE_BYTE_BUDGET || input.sessionDirectory === null) return fullLaunch;
    return cmdLaunch(input.sessionDirectory, input, prelude, adapted);
  }
  if (fullLaunch.typedLineBytes <= TYPED_LINE_BYTE_BUDGET) return fullLaunch;
  const wslShell = parseWslShellSpec(input.shell);
  if (!readsPosixTty(wslShell, input.platform)) return typedPastBatchShim(input, shellName, prelude, fullLaunch);
  if (input.sessionDirectory === null) return fullLaunch;

  const { fileName, run } = launcherFormFor(shellName);
  const filePath = path.join(input.sessionDirectory, fileName);
  const shellPath = launcherPathForShell(filePath, wslShell);
  if (shellPath === null) return fullLaunch;
  // `multiline` only to keep the path exact: the default form collapses a run of
  // spaces, which a folder name may hold.
  const typedLine = prelude + run(quoteArg(shellPath, shellName, { multiline: true }));
  return typedLaunchOf(typedLine, { filePath, contents: `${adapted}\n` });
}
