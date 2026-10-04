/**
 * The short name a leftover process is shown under: the program, plus the
 * script it runs when the program is an interpreter ("node (vite)",
 * "python3 (http.server)").
 *
 * Privacy: a command line can carry a token (`--api-key=...`, a URL with a
 * password), so a reader parses it in place and hands this module the argument
 * list, and only the label it returns ever leaves the reader. A label holds at
 * most the program's file name and ONE more short name, taken from exactly one
 * of three places:
 * - the file an interpreter runs, and only when that path names an existing
 *   file (a flag's value or an inline script never does): its package's name
 *   when it sits in `node_modules`, else its file name;
 * - the module after `-m` (`python3 -m http.server`), when it looks like a
 *   module name;
 * - the first word of a title the process gave itself (npm, `next-server`,
 *   pm2), which Linux and macOS show in place of its arguments.
 * Nothing else from the command line is returned, logged, or kept.
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

/** Interpreters whose label names the script they run. Any other program is shown by its file name alone. */
const INTERPRETER_PATTERN = /^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|pythonw|py|ruby|perl|php)$/i;
/** Flags that hand the interpreter its code inline: there is no script to name. */
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);
const MODULE_FLAG = '-m';
const MODULE_NAME_PATTERN = /^[A-Za-z_][\w.]{0,80}$/;
const TITLE_WORD_PATTERN = /^[\w.@-]{1,40}$/;
/**
 * A UNC path, `\\host\share` or `//host/share`, or its device form,
 * `\\?\UNC\host\share` or `\\.\UNC\host\share`. A drive behind a device prefix
 * (`\\?\C:\`) is local.
 */
const NETWORK_PATH_PATTERN = /^[\\/]{2}(?:[^\\/?.]|[?.][\\/]UNC[\\/])/i;
/** How many arguments after the program are searched for the script. */
const SCRIPT_SEARCH_LIMIT = 4;
const FALLBACK_LABEL = 'process';

function baseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/** A program's name from its path: the file name without a Windows `.exe`. */
export function programName(executablePath: string): string {
  return baseName(executablePath.trim()).replace(/\.exe$/i, '');
}

/**
 * What a script path is called: its package's name when it lives in
 * `node_modules` (`node_modules/vite/bin/vite.js` and `node_modules/.bin/vite`
 * are both `vite`), else its file name.
 */
export function scriptName(scriptPath: string): string {
  const segments = scriptPath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const modulesIndex = segments.lastIndexOf('node_modules');
  if (modulesIndex >= 0 && modulesIndex + 1 < segments.length - 1) {
    const packageSegment = segments[modulesIndex + 1];
    if (packageSegment === '.bin') return segments[modulesIndex + 2].replace(/\.(?:cmd|ps1|js|cjs|mjs)$/i, '');
    if (packageSegment.startsWith('@') && modulesIndex + 2 < segments.length) {
      return `${packageSegment}/${segments[modulesIndex + 2]}`;
    }
    return packageSegment;
  }
  if (modulesIndex >= 0 && segments[modulesIndex + 1] !== undefined) {
    return segments[modulesIndex + 1].replace(/\.(?:cmd|ps1|js|cjs|mjs)$/i, '');
  }
  return segments[segments.length - 1] ?? scriptPath;
}

export interface ProcessLabelInput {
  /** The program's path, from the platform's own record; may be null when unreadable. */
  executablePath: string | null;
  /** The argument list, `argv[0]` first. Read in place by the reader, never retained. */
  argv: readonly string[];
  /** Whether a path, as the process would resolve it from its working directory, is an existing file. */
  isFile: (candidate: string) => Promise<boolean>;
}

/**
 * Whether `candidate` names an existing file, resolved the way the process
 * resolves it: against its working directory when relative. A relative path
 * with no known directory is never a file.
 */
export async function isFileFrom(workingDirectory: string | null, candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate) && !workingDirectory) return false;
  // A network path (`\\host\share\app.js`, or a relative script under a
  // working directory on a share) makes Windows contact the share, and an
  // unreachable one holds the stat, and the report waiting on it, until the
  // SMB timeout. The label drops the script name instead. On Linux and macOS a
  // leading `//` is an ordinary path, so such a script loses its name too; the
  // label is all that costs. A mapped drive letter or an NFS mount reads like
  // a local path and is still stat'ed, so an unreachable one holds the report
  // until its timeout. That is left as is, on purpose: a time limit would free
  // the report but not the thread pool thread the stat holds, and it only bites
  // a script on a dead mount, whose process is most likely hung itself.
  if (NETWORK_PATH_PATTERN.test(path.isAbsolute(candidate) ? candidate : workingDirectory ?? '')) return false;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(workingDirectory ?? '', candidate);
  try {
    return (await fsPromises.stat(resolved)).isFile();
  } catch {
    return false;
  }
}

/** The label for one process (see the module comment for what it may hold). */
export async function labelProcess(input: ProcessLabelInput): Promise<string> {
  const executableName = programName(input.executablePath ?? '');
  const firstArgument = input.argv[0] ?? '';
  // argv[0] names the interpreter as the user typed it (`python3`, where the
  // executable resolves to `python3.12`) unless the process retitled itself.
  const argumentName = programName(firstArgument);
  const argumentsUntouched = INTERPRETER_PATTERN.test(argumentName);
  // With no executable path, argv[0] stands in for the program only when it is
  // one short name: a retitled argv[0] can hold the whole command line.
  const fallbackName = TITLE_WORD_PATTERN.test(argumentName) ? argumentName : '';
  const name = (argumentsUntouched ? argumentName : executableName) || fallbackName || FALLBACK_LABEL;
  if (!INTERPRETER_PATTERN.test(name) || input.argv.length === 0) return name;

  // A process that set its own title has rewritten argv[0], and on Linux and
  // macOS its other arguments are gone; the title's first word is its name.
  if (!argumentsUntouched) {
    const titleWord = firstArgument.trim().split(/\s+/)[0] ?? '';
    return TITLE_WORD_PATTERN.test(titleWord) && titleWord.toLowerCase() !== name.toLowerCase()
      ? `${name} (${titleWord})`
      : name;
  }

  const searchEnd = Math.min(input.argv.length, 1 + SCRIPT_SEARCH_LIMIT);
  for (let index = 1; index < searchEnd; index += 1) {
    const argument = input.argv[index];
    if (INLINE_CODE_FLAGS.has(argument)) return name;
    if (argument === MODULE_FLAG) {
      const moduleName = input.argv[index + 1] ?? '';
      return MODULE_NAME_PATTERN.test(moduleName) ? `${name} (${moduleName})` : name;
    }
    if (argument.length === 0 || argument.startsWith('-')) continue;
    if (await input.isFile(argument).catch(() => false)) return `${name} (${scriptName(argument)})`;
  }
  return name;
}

/**
 * Split a Windows command line the way `CommandLineToArgvW` does: the program
 * runs to its closing quote or the first space; after it, spaces separate,
 * quotes group, `2n` backslashes before a quote are `n` and the quote toggles,
 * `2n + 1` are `n` and a literal quote, and a doubled quote inside quotes is
 * one literal quote. The result stays inside the reader.
 */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let index = 0;
  const length = commandLine.length;
  while (index < length && /\s/.test(commandLine[index])) index += 1;
  if (index >= length) return argv;

  let program = '';
  if (commandLine[index] === '"') {
    index += 1;
    while (index < length && commandLine[index] !== '"') program += commandLine[index++];
    index += 1;
  } else {
    while (index < length && !/\s/.test(commandLine[index])) program += commandLine[index++];
  }
  argv.push(program);

  while (index < length) {
    while (index < length && /\s/.test(commandLine[index])) index += 1;
    if (index >= length) break;
    let current = '';
    let quoted = false;
    while (index < length && (quoted || !/\s/.test(commandLine[index]))) {
      if (commandLine[index] === '\\') {
        let backslashes = 0;
        while (index < length && commandLine[index] === '\\') {
          backslashes += 1;
          index += 1;
        }
        if (commandLine[index] === '"') {
          current += '\\'.repeat(Math.floor(backslashes / 2));
          if (backslashes % 2 === 1) {
            current += '"';
            index += 1;
          }
        } else {
          current += '\\'.repeat(backslashes);
        }
        continue;
      }
      if (commandLine[index] === '"') {
        if (quoted && commandLine[index + 1] === '"') {
          current += '"';
          index += 2;
          continue;
        }
        quoted = !quoted;
        index += 1;
        continue;
      }
      current += commandLine[index];
      index += 1;
    }
    argv.push(current);
  }
  return argv;
}
