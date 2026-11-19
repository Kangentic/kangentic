import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the target script out of an npm shim, so detection can tell a live
 * shim from a dead one before spending a version probe on it.
 *
 * npm's cmd-shim writes three files beside a global install: `<name>.cmd`,
 * `<name>.ps1`, and an extensionless sh script. Each hardcodes the launched
 * script relative to its own directory (`"%dp0%\node_modules\...\cli.js"`,
 * `"$basedir/node_modules/.../cli.js"`). When the package behind the shim is
 * removed, the shim files often stay behind, and `which` still returns them
 * because it checks the shim's own existence, never its target's. Running such
 * a shim costs a node spawn that exits 1 with "Cannot find module".
 *
 * Kept separate from shim-launch.ts on purpose: three suites replace that
 * module wholesale with `{ resolveShimLaunch }`, so a new export imported from
 * it would be `undefined` there. This module imports nothing from
 * shim-launch.ts and is not re-exported through the agent/shared barrel, which
 * many suites also replace.
 */

const NODE_LAUNCHER_NAMES = new Set(['node', 'node.exe', 'node$exe']);

/** A `.cmd` shim's own folder as the shim writes it, with the separator after it when it writes one. */
const SHIM_FOLDER_ROOT = String.raw`(?:%dp0%|%~dp0)[\\/]?`;

/** A quoted argument rooted at a `.cmd` shim's own folder. Group 1 is the path under that folder. */
const ROOTED_BATCH_ARGUMENT = new RegExp(`"${SHIM_FOLDER_ROOT}([^"]+)"`, 'gi');

/** A program path rooted the same way, with its quotes off. Group 1 is the path under that folder. */
const ROOTED_PROGRAM_PATH = new RegExp(`^${SHIM_FOLDER_ROOT}(.+)$`, 'i');

/** `.cmd` / `.bat` by extension, case-insensitive (`which` returns `.CMD`). */
export function isWindowsBatchShim(agentPath: string): boolean {
  return /\.(cmd|bat)$/i.test(agentPath);
}

/**
 * Largest file this module will read. A real shim is well under 2KB; the
 * ceiling stops a same-extension file that is not a shim at all (a generated
 * batch script, a binary someone named `.cmd`) from being pulled whole into
 * memory on the main thread. Anything larger is treated as unreadable, so the
 * caller falls through to the normal version probe.
 */
const MAX_SHIM_FILE_BYTES = 64 * 1024;

/**
 * `.cmd` / `.bat` / `.ps1` by extension, case-insensitive (`which` returns
 * `.CMD`).
 *
 * Deliberately Windows-shaped. npm writes a third, EXTENSIONLESS sh shim, and
 * that is the one `which` returns on macOS and Linux, where it filters by the
 * executable bit rather than expanding PATHEXT. Matching bare names here would
 * mean reading every extensionless binary on PATH to find out it is not a
 * shim. The skip is an optimization that avoids a doomed spawn; the fix for a
 * shadowing shim is the caller walking every match, and that works on all
 * three platforms. So on POSIX a dead shim still costs one probe, then the
 * search moves on.
 */
export function isNpmShimCandidate(candidatePath: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(candidatePath);
}

/**
 * The script an npm shim launches, relative to the shim's own directory, or
 * null when the content is not a recognizable npm shim.
 *
 * Every quoted argument rooted at `%dp0%`, `%~dp0`, or `$basedir` is
 * collected; the node launcher references (`IF EXIST "%dp0%\node.exe"`,
 * `Test-Path "$basedir/node$exe"`) are dropped; the last survivor is the
 * script. The separator after `%~dp0` is optional because the minimal
 * `node "%~dp0receiver.js" %*` form omits it.
 */
export function parseNpmShimTarget(content: string): string | null {
  const quotedArguments: string[] = [];
  for (const match of content.matchAll(ROOTED_BATCH_ARGUMENT)) {
    quotedArguments.push(match[1]);
  }
  for (const match of content.matchAll(/"\$basedir(?:_win)?\/([^"]+)"/g)) {
    quotedArguments.push(match[1]);
  }
  const scriptArguments = quotedArguments.filter(
    (quotedArgument) => !NODE_LAUNCHER_NAMES.has(lastPathSegment(quotedArgument).toLowerCase()),
  );
  return scriptArguments.length > 0 ? scriptArguments[scriptArguments.length - 1] : null;
}

/** Injection points for tests; production callers pass nothing. */
export interface NpmShimTargetDependencies {
  /** Whole-file read; throws when unreadable. Default: `fs.readFileSync(path, 'utf8')`. */
  readFile?: (candidatePath: string) => string;
  /** Default: `fs.existsSync`. */
  fileExists?: (candidatePath: string) => boolean;
  /** What a `%NAME%` in a shim's program path stands for. Default: `process.env`. */
  environment?: Record<string, string | undefined>;
}

/**
 * The absolute path of the script `shimPath` launches, resolved against the
 * shim's own directory, or null when the file cannot be read or does not
 * parse as an npm shim. The relative target is split on either separator
 * before joining, so a backslash target resolves on a posix host too.
 */
export function npmShimTargetPath(
  shimPath: string,
  dependencies: NpmShimTargetDependencies = {},
): string | null {
  let content: string;
  try {
    // The call itself sits inside the try: a suite that replaces `node:fs`
    // wholesale leaves `fs.readFileSync` undefined, and that must read as
    // "unknown", never throw out of detection.
    const readFile = dependencies.readFile ?? readShimFromDisk;
    content = readFile(shimPath);
  } catch {
    return null;
  }
  const relativeTarget = parseNpmShimTarget(content);
  return relativeTarget === null ? null : underShimFolder(shimPath, relativeTarget);
}

/** A path a shim roots at its own folder, made absolute, or null for one with no segments. */
function underShimFolder(shimPath: string, relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  return path.join(path.dirname(shimPath), ...segments);
}

/**
 * The absolute target path when `shimPath` parses as an npm shim whose
 * target is missing on disk. Null when it is not a shim, cannot be read, or
 * the target exists, so the caller proceeds to the normal version probe.
 */
export function missingNpmShimTarget(
  shimPath: string,
  dependencies: NpmShimTargetDependencies = {},
): string | null {
  const targetPath = npmShimTargetPath(shimPath, dependencies);
  if (targetPath === null) return null;
  try {
    const fileExists = dependencies.fileExists ?? fs.existsSync;
    return fileExists(targetPath) ? null : targetPath;
  } catch {
    return null;
  }
}

/** The program a batch shim would start, and the script it would hand that program. */
export interface BatchShimLaunch {
  /**
   * An absolute path, or a bare name when no such file sits beside the shim:
   * `node`, or the `pwsh` or `powershell` a shim hands a `.ps1` to.
   */
  program: string;
  /**
   * What the shim writes between the program and the script, as the program's
   * own flags (`-NoProfile -File`). Plain words, which need no quoting under
   * any shell. Absent when the shim writes none, as for node.
   */
  programArguments?: string[];
  /** The script the program runs, or null when the target is itself a program. */
  script: string | null;
}

/**
 * Why `batchShimLaunchOutcome` could not say what a shim starts. A fixed word,
 * sent as the `batch_shim` tag of a start refused for it, so a report can say
 * which shim a user has without its text or its path.
 */
export type BatchShimGiveUp =
  /** The file could not be read, or was too large to be a shim. */
  | 'unreadable'
  /** No quoted target rooted at the shim's own folder. */
  | 'unparsed'
  /** The target the shim names is not on disk. */
  | 'target_missing'
  /** A chain of `.cmd` or `.bat` shims longer than `MAX_SHIM_HOPS`, or one that loops. */
  | 'target_batch'
  /**
   * The target is a `.ps1` script, and the shim does not hand it to one
   * PowerShell this can start in its place (`powerShellLaunchOf`), or a shim
   * of the chain sets a variable of its own (`setsVariableOfItsOwn`).
   */
  | 'target_ps1'
  /** The target has no extension, such as the sh script cmd-shim hands to `sh`. */
  | 'target_extensionless'
  /** The target is some other file that is neither a program nor a Node script. */
  | 'target_other'
  /**
   * A Node script whose shim, or a shim before it in the chain, sets
   * `NODE_PATH`, which the script may read. A `.ps1` behind one too, since it
   * may start node.
   */
  | 'node_path';

type BatchShimOutcome = { launch: BatchShimLaunch } | { gaveUp: BatchShimGiveUp };

/**
 * The most shims one launch reads through: the shim on the command line and
 * the shims it calls in turn. A global bin that calls the package's own
 * `node_modules\.bin\<name>.cmd` is two. The bound also ends a shim that names
 * itself, or two that name each other.
 */
export const MAX_SHIM_HOPS = 3;

/** Why a target that is neither a program, a Node script nor a batch shim cannot be started, by its shape. */
function unsupportedTargetOf(target: string): BatchShimGiveUp {
  const extension = path.extname(target).toLowerCase();
  if (extension === '') return 'target_extensionless';
  if (extension === '.ps1') return 'target_ps1';
  return 'target_other';
}

/** The programs a shim may hand a `.ps1` to: PowerShell 7 and Windows PowerShell. */
const POWERSHELL_NAMES = new Set(['pwsh', 'powershell']);

/**
 * A flag that reads the same under cmd, PowerShell and a POSIX shell, with no
 * quoting. No `/`: Git Bash rewrites a word that starts with one (`/NoProfile`)
 * into a Windows path before the program sees it, and quoting does not stop it.
 */
const PLAIN_FLAG = /^[\w.:-]+$/;

/**
 * The variables npm's and pnpm's shims set for themselves. `NODE_PATH` is here
 * because it has a give-up of its own.
 */
const GENERATOR_VARIABLES = new Set(['dp0', '_prog', 'pathext', 'node_path']);

/**
 * Where a batch `SET` starts, up to the name it sets: at the start of a line
 * or after a character that can end the command before it, then a `/A` or
 * `/P` switch and an opening quote when it has them.
 */
const BATCH_SET = String.raw`(?:^|[\s&|(@])SET\s+(?:\/[AP]\s+)?"?`;

/** Every variable a batch file sets. Group 1 is the name, which may hold anything but `=` (`MY-VAR`). */
const BATCH_ASSIGNMENT = new RegExp(`${BATCH_SET}([^=\\s"]+)=`, 'gim');

/** A Windows path that names its drive or its share, so it is the same file from any folder on any drive. */
const FULLY_QUALIFIED_WINDOWS_PATH = /^(?:[a-z]:[\\/]|[\\/]{2})/i;

/**
 * Whether a shim sets a variable its generator would not. A wrapper that sets
 * one (an endpoint, a config folder, pnpm's `PATH` prepend) means it for what
 * it starts, and a direct start would run without it and say nothing. Asked of
 * every shim of a chain, since each inherits the one before it.
 */
function setsVariableOfItsOwn(content: string): boolean {
  for (const match of content.matchAll(BATCH_ASSIGNMENT)) {
    if (!GENERATOR_VARIABLES.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * The words of a batch command: a quoted run is one word, and so is each run
 * of the characters that end a command (`&`, `|`, `(`, `)`).
 */
function batchWords(text: string): string[] {
  return text.match(/"[^"]*"|[&|()]+|[^\s"&|()]+/g) ?? [];
}

/**
 * What a program word may stand for, as the shim spells it. A `"%_prog%"` is
 * every value the shim sets that variable to, which in npm's shim is the
 * program beside the shim and the bare name.
 */
function programSpellings(word: string, content: string): string[] {
  const spelling = word.replace(/^"|"$/g, '');
  const variable = /^%(\w+)%$/.exec(spelling);
  if (!variable) return [spelling];
  const assignments = new RegExp(`${BATCH_SET}${variable[1]}=([^"\\r\\n]*)`, 'gim');
  return Array.from(content.matchAll(assignments), (match) => match[1].trim());
}

/**
 * A program path a shim writes out in full, with each `%NAME%` replaced as cmd
 * replaces it, or null when a name is not set or what is left does not name
 * its drive or share. A careful trampoline names Windows PowerShell as
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. Names are
 * matched without case, as Windows matches them, and the path is read as a
 * Windows one on any host. A path with no drive (`\tools\pwsh.exe`, or one
 * whose leading name is set to nothing) is on whichever drive the shell is on,
 * which is not the drive the existence check here would read.
 */
function programPathInFull(spelling: string, environment: Record<string, string | undefined>): string | null {
  let everyNameSet = true;
  const expanded = spelling.replace(/%([^%]+)%/g, (_reference, name: string) => {
    const wanted = name.toLowerCase();
    const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === wanted);
    if (entry?.[1] === undefined) everyNameSet = false;
    return entry?.[1] ?? '';
  });
  return everyNameSet && FULLY_QUALIFIED_WINDOWS_PATH.test(expanded) ? expanded : null;
}

/**
 * The PowerShell a shim hands its `.ps1` target to, with the flags it gives
 * it, or null when the shim's text does not name one such start.
 *
 * Read from the shim's own invocation lines, never assumed: the program
 * (`pwsh` or `powershell`) and every word between it and the script are the
 * shim's, so an execution policy is passed only where the shim passes one.
 * pnpm's shim for a `.ps1` and npm's for one with a `pwsh` shebang both write
 * `pwsh.exe` beside the shim under `IF EXIST`, else a bare `pwsh`, and that is
 * the rule here, as it is for `node.exe`: a path the shim names when that file
 * is on disk, else the bare name. The path may be beside the shim or written
 * out in full (`programPathInFull`).
 *
 * Null, which the caller reports as `target_ps1`, for any shim this cannot
 * repeat exactly: one that calls the script with no program (npm's, for a
 * `.ps1` with no shebang, which cmd hands to the file association), one that
 * hands it to another program, one whose lines name two different starts (a
 * shim that picks `pwsh` or `powershell` when it runs), a program path that is
 * relative, names no drive or holds a name that is not set, a flag that would
 * need quoting or holds a `/`, anything of the shim's own after the script on
 * a line that passes the arguments on (an argument, a second command), and a
 * script inside a longer quoted string. A shim that sets a variable of its own
 * never gets here: the caller refuses it first, for the whole chain.
 */
function powerShellLaunchOf(
  shim: { path: string; content: string; relativeTarget: string },
  fileExists: (candidatePath: string) => boolean,
  environment: Record<string, string | undefined>,
): Pick<BatchShimLaunch, 'program' | 'programArguments'> | null {
  let powerShellName: string | null = null;
  let flags: string[] | null = null;
  let programPath: string | null = null;
  let bareName: string | null = null;

  for (const line of shim.content.split(/\r?\n/)) {
    for (const match of line.matchAll(ROOTED_BATCH_ARGUMENT)) {
      const afterTarget = line.slice(match.index + match[0].length).trim();
      // A line that names the script without passing the arguments on starts nothing.
      if (match[1] !== shim.relativeTarget || !afterTarget.includes('%*')) continue;
      const beforeTarget = line.slice(0, match.index);
      const insideQuotes = (beforeTarget.match(/"/g)?.length ?? 0) % 2 !== 0;
      if (afterTarget !== '%*' || insideQuotes) return null;

      const words = batchWords(beforeTarget);
      const commandWords = words.slice(words.findLastIndex((word) => /^[&|()]+$/.test(word)) + 1);
      // An echo-off `@` stands alone ahead of a quoted program, and leads a bare one.
      if (commandWords[0] === '@') commandWords.shift();
      const [programWord, ...lineFlags] = commandWords;
      if (programWord === undefined || !lineFlags.every((flag) => PLAIN_FLAG.test(flag))) return null;
      if (flags !== null && flags.join(' ') !== lineFlags.join(' ')) return null;
      flags = lineFlags;

      const spellings = programSpellings(programWord.replace(/^@/, ''), shim.content);
      if (spellings.length === 0) return null;
      for (const spelling of spellings) {
        // Read first, since `%~dp0pwsh.exe` has no separator for the name to follow.
        const besideShim = ROOTED_PROGRAM_PATH.exec(spelling);
        const name = lastPathSegment(besideShim ? besideShim[1] : spelling).toLowerCase().replace(/\.exe$/, '');
        if (!POWERSHELL_NAMES.has(name) || (powerShellName !== null && powerShellName !== name)) return null;
        powerShellName = name;
        if (/^[\w.-]+$/.test(spelling)) {
          bareName = spelling;
          continue;
        }
        const namedPath = besideShim ? underShimFolder(shim.path, besideShim[1]) : programPathInFull(spelling, environment);
        if (namedPath === null || (programPath !== null && programPath !== namedPath)) return null;
        programPath = namedPath;
      }
    }
  }

  const program = programPath !== null && fileExists(programPath) ? programPath : bareName;
  if (program === null || flags === null) return null;
  return flags.length > 0 ? { program, programArguments: flags } : { program };
}

/**
 * What a `.cmd` shim runs, so a launch too long for one can start it directly,
 * or why that cannot be known.
 *
 * A shim's `%*` line has its own cmd line limit and fails past it with no error
 * at all: through an npm-style shim, 8000 characters ran and 8388 never did. The
 * rules are the shim's own: `node.exe` beside the shim if there is one, else
 * `node`, and a binary target runs as it is.
 *
 * A shim that sets `NODE_PATH` (pnpm's, whenever its install has node paths to
 * add) gives up only for a Node script, which may resolve modules through it. A
 * native `.exe` target (Claude Code's npm bin is `bin/claude.exe`) never reads
 * it, and pnpm calls such a target directly, so it starts as an npm shim's does.
 *
 * A `.ps1` target starts the PowerShell the shim hands it to, with the flags
 * the shim gives it (`powerShellLaunchOf`). Sentry DESKTOP-3Y, on 0.60.0, was a
 * `claude.cmd` that runs a `.ps1`: every launch past cmd's typed budget was
 * refused, on each restart. A `NODE_PATH` set ahead of it gives up as for a
 * Node script, since the `.ps1` may start node. A shim of the chain that sets
 * a variable of its own gives up too, which a direct start would drop
 * (`setsVariableOfItsOwn`). That check is for a `.ps1` target only.
 *
 * A target that is itself a `.cmd` or `.bat` shim is read in turn, up to
 * `MAX_SHIM_HOPS` shims, and the launch is what the last one starts. A batch
 * target has no shebang, so npm's and pnpm's shims both call it directly with
 * nothing in front of it. The innermost shim is the one that runs node, so its
 * folder is where `node.exe` is looked for. `NODE_PATH` set by any shim of the
 * chain reaches the script, since each shim inherits the one before it.
 */
function batchShimLaunchOutcome(
  shimPath: string,
  dependencies: NpmShimTargetDependencies = {},
): BatchShimOutcome {
  return shimChainOutcome(shimPath, dependencies, { hop: 1, nodePathSet: false, ownVariableSet: false });
}

/**
 * One step of `batchShimLaunchOutcome`'s walk down a chain of shims. `hop` is
 * this shim's place in the chain, the outermost being 1. `nodePathSet` says a
 * shim before it set `NODE_PATH`, and `ownVariableSet` that one set a variable
 * of its own.
 */
function shimChainOutcome(
  shimPath: string,
  dependencies: NpmShimTargetDependencies,
  chain: { hop: number; nodePathSet: boolean; ownVariableSet: boolean },
): BatchShimOutcome {
  const fileExists = dependencies.fileExists ?? fs.existsSync;
  const readFile = dependencies.readFile ?? readShimFromDisk;
  let content: string;
  try {
    content = readFile(shimPath);
  } catch {
    // report-ok: an unreadable shim is the answer, named by the outcome.
    return { gaveUp: 'unreadable' };
  }
  const setsNodePath = chain.nodePathSet || content.toUpperCase().includes('NODE_PATH');
  const setsOwnVariable = chain.ownVariableSet || setsVariableOfItsOwn(content);
  try {
    const relativeTarget = parseNpmShimTarget(content);
    const target = relativeTarget === null ? null : underShimFolder(shimPath, relativeTarget);
    if (relativeTarget === null || target === null) return { gaveUp: 'unparsed' };
    if (!fileExists(target)) return { gaveUp: 'target_missing' };
    if (/\.exe$/i.test(target)) return { launch: { program: target, script: null } };
    if (isWindowsBatchShim(target)) {
      if (chain.hop >= MAX_SHIM_HOPS) return { gaveUp: 'target_batch' };
      return shimChainOutcome(target, dependencies, { hop: chain.hop + 1, nodePathSet: setsNodePath, ownVariableSet: setsOwnVariable });
    }
    if (/\.ps1$/i.test(target)) {
      const powerShell = setsOwnVariable
        ? null
        : powerShellLaunchOf({ path: shimPath, content, relativeTarget }, fileExists, dependencies.environment ?? process.env);
      if (powerShell === null) return { gaveUp: unsupportedTargetOf(target) };
      return setsNodePath ? { gaveUp: 'node_path' } : { launch: { ...powerShell, script: target } };
    }
    if (!/\.[cm]?js$/i.test(target)) return { gaveUp: unsupportedTargetOf(target) };
    if (setsNodePath) return { gaveUp: 'node_path' };
    const siblingNode = path.join(path.dirname(shimPath), 'node.exe');
    return { launch: { program: fileExists(siblingNode) ? siblingNode : 'node', script: target } };
  } catch {
    // report-ok: an injected `fileExists` that throws reads as a target not found.
    return { gaveUp: 'target_missing' };
  }
}

/**
 * What a `.cmd` shim runs, or null when this cannot be sure it would start what
 * the shim starts (`batchShimLaunchOutcome` says why).
 */
export function directLaunchOfBatchShim(
  shimPath: string,
  dependencies: NpmShimTargetDependencies = {},
): BatchShimLaunch | null {
  const outcome = batchShimLaunchOutcome(shimPath, dependencies);
  return 'launch' in outcome ? outcome.launch : null;
}

/** Why `directLaunchOfBatchShim` gave up on a shim, or null when it did not. */
export function batchShimGiveUpOf(shimPath: string, dependencies: NpmShimTargetDependencies = {}): BatchShimGiveUp | null {
  const outcome = batchShimLaunchOutcome(shimPath, dependencies);
  return 'gaveUp' in outcome ? outcome.gaveUp : null;
}

function readShimFromDisk(candidatePath: string): string {
  const { size } = fs.statSync(candidatePath);
  if (size > MAX_SHIM_FILE_BYTES) {
    throw new Error(`${candidatePath} is ${size} bytes, too large to be an npm shim`);
  }
  return fs.readFileSync(candidatePath, 'utf8');
}

function lastPathSegment(candidatePath: string): string {
  const segments = candidatePath.split(/[\\/]/);
  return segments[segments.length - 1];
}
