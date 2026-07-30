/**
 * Recognizing a path-length failure on Windows.
 *
 * This module deliberately holds no length threshold, because measurement says
 * there is not one worth acting on. Inside a 98-character Kangentic worktree of
 * a React Native project (75,133 files, longest absolute path 337), **1,958
 * files already exceeded MAX_PATH (260)** and `npm install`, `expo prebuild` and
 * Gradle all completed, on a machine with `LongPathsEnabled` set to `0`. Node,
 * the JVM and Git route around MAX_PATH with the `\\?\` prefix, so a length
 * check fires on healthy projects and predicts nothing.
 *
 * An earlier version of this file carried two reserves and a proactive warning.
 * Both reserves were derived rather than observed, and the evidence above
 * disproves them, so they are gone. What remains is recognition after the fact:
 * when a worktree operation has ALREADY failed, say whether the error looks like
 * a path-length error, so the user is not left reading raw git output.
 *
 * The failure that does bind on Windows is not the worktree path being long in
 * itself. It is a tool composing a path from the worktree and hitting MAX_PATH
 * on the composed string. Shortening the worktree root buys room; it cannot be
 * a guarantee, because Kangentic controls neither the project's own location nor
 * how deep a toolchain builds beneath it.
 */

/** Windows MAX_PATH, including the terminating NUL. Kept for message text only. */
export const WINDOWS_MAX_PATH = 260;

/**
 * Error text that means a tool ran out of path. Matched case-insensitively
 * against the message of a failure that has already happened.
 *
 * - `ENAMETOOLONG` is the POSIX-style errno libuv surfaces.
 * - "filename or extension is too long" is the Win32 message (error 206).
 * - "filename longer than 260 characters" is ninja's own stat failure.
 * - "still dirty after" is ninja giving up regenerating its manifest. It reads
 *   like a build-graph problem and names no path, but the cause is a required
 *   output that ninja stats through a `..` from the build directory: Windows
 *   applies MAX_PATH to the composed string BEFORE collapsing the `..`, so the
 *   stat fails on a file that exists, the generator re-runs, and it loops.
 *
 * CMake's `CMAKE_OBJECT_PATH_MAX` strings are deliberately NOT here. Measured
 * on 2026-07-30 against a React Native Android build: they fired 402 times on a
 * build whose actual failure was the ninja loop above, and 0 times on a build
 * that still failed after the CMake limit was raised. They are a policy warning
 * the build routinely survives, so matching them mislabels the cause.
 */
const PATH_LENGTH_ERROR_SIGNATURES = [
  'enametoolong',
  'filename or extension is too long',
  'filename too long',
  'filename longer than',
  "manifest 'build.ninja' still dirty after",
];

/** Every message in the `cause` chain, so a wrapped error still matches. */
function errorMessageChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join('\n').toLowerCase();
}

/** True when a failure's text indicates a tool ran out of path. */
export function isPathLengthError(error: unknown): boolean {
  const haystack = errorMessageChain(error);
  return PATH_LENGTH_ERROR_SIGNATURES.some((signature) => haystack.includes(signature));
}

/**
 * A sentence to append to a worktree failure that path length actually caused,
 * or null when the error says otherwise.
 *
 * Gated on EVIDENCE, not on length. It cannot false-positive on a project with
 * no path problem, and it stays silent off Windows, where PATH_MAX is 1024 or
 * more and none of these signatures can arise from length.
 */
export function describeWorktreePathLengthCause(
  worktreePath: string,
  error: unknown,
): string | null {
  if (process.platform !== 'win32') return null;
  if (!isPathLengthError(error)) return null;
  return `A tool ran out of path inside ${worktreePath} (${worktreePath.length} characters of `
    + `Windows' ${WINDOWS_MAX_PATH}-character limit are used before it starts). Moving the project `
    + 'to a shorter location gives every tool inside it more room.';
}
