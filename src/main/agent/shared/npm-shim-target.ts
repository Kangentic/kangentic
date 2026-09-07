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
