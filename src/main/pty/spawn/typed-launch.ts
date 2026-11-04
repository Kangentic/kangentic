import path from 'node:path';
import {
  adaptCommandForShell,
  buildSpawnClearPrelude,
  isFishShell,
  isNushellShell,
  isPowerShellShell,
  isUncPath,
  parseWslUncPath,
  quoteArg,
  toWslPath,
} from '../../../shared/paths';
import { parseWslShellSpec, type WslShellSpec } from '../process-tag/task-process-tag';

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
 * The file name and sourcing statement for a shell. `.` is the POSIX spelling
 * (dash and sh have no `source`), and fish still takes it, so a WSL distro whose
 * login shell is fish runs it too. Nushell's `source` is a parser keyword, which
 * reads its path while it parses the line: a literal is the only form it takes,
 * and the file has to exist before the line is typed. PowerShell dot-sources only
 * a `.ps1`.
 */
function launcherFormFor(shellName: string): { fileName: string; sourceStatement: string } {
  if (isNushellShell(shellName)) return { fileName: 'launch.nu', sourceStatement: 'source' };
  if (isFishShell(shellName)) return { fileName: 'launch.fish', sourceStatement: 'source' };
  if (isPowerShellShell(shellName)) return { fileName: 'launch.ps1', sourceStatement: '.' };
  return { fileName: 'launch.sh', sourceStatement: '.' };
}

function typedLaunchOf(typedLine: string, launcher: TypedLaunch['launcher']): TypedLaunch {
  return { typedLine, typedLineBytes: Buffer.byteLength(`${typedLine}\r`, 'utf8'), launcher };
}

/**
 * The line a spawn types, keeping it short whatever the command's length.
 *
 * Within the budget the command is typed as it is. Past it, the command goes in a
 * file and the shell is typed a line that sources it, so it runs in the same shell
 * the typed line would have. The clear prelude stays on the typed line, so it runs
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

  const { fileName, sourceStatement } = launcherFormFor(shellName);
  const filePath = path.join(input.sessionDirectory, fileName);
  const shellPath = launcherPathForShell(filePath, wslShell);
  if (shellPath === null) return fullLaunch;
  // `multiline` only to keep the path exact: the default form collapses a run of
  // spaces, which a folder name may hold.
  const typedLine = `${prelude}${sourceStatement} ${quoteArg(shellPath, shellName, { multiline: true })}`;
  return typedLaunchOf(typedLine, { filePath, contents: `${adapted}\n` });
}
