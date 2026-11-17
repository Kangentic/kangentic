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
  for (const match of content.matchAll(/"(?:%dp0%|%~dp0)[\\/]?([^"]+)"/gi)) {
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
  if (relativeTarget === null) return null;
  const segments = relativeTarget.split(/[\\/]+/).filter((segment) => segment.length > 0);
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
  /** An absolute path, or the bare name `node` when no `node.exe` sits beside the shim. */
  program: string;
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
  /** The target is a `.ps1` script. */
  | 'target_ps1'
  /** The target has no extension, such as the sh script cmd-shim hands to `sh`. */
  | 'target_extensionless'
  /** The target is some other file that is neither a program nor a Node script. */
  | 'target_other'
  /** A Node script whose shim, or a shim before it in the chain, sets `NODE_PATH`, which the script may read. */
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
  return shimChainOutcome(shimPath, dependencies, { hop: 1, nodePathSet: false });
}

/**
 * One step of `batchShimLaunchOutcome`'s walk down a chain of shims. `hop` is
 * this shim's place in the chain, the outermost being 1, and `nodePathSet` says
 * a shim before it set `NODE_PATH`.
 */
function shimChainOutcome(
  shimPath: string,
  dependencies: NpmShimTargetDependencies,
  chain: { hop: number; nodePathSet: boolean },
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
  try {
    const target = npmShimTargetPath(shimPath, { readFile: () => content });
    if (target === null) return { gaveUp: 'unparsed' };
    if (!fileExists(target)) return { gaveUp: 'target_missing' };
    if (/\.exe$/i.test(target)) return { launch: { program: target, script: null } };
    if (isWindowsBatchShim(target)) {
      if (chain.hop >= MAX_SHIM_HOPS) return { gaveUp: 'target_batch' };
      return shimChainOutcome(target, dependencies, { hop: chain.hop + 1, nodePathSet: setsNodePath });
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
