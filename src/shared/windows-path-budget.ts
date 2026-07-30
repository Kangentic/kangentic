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
 */

/** Windows MAX_PATH, including the terminating NUL. Kept for message text only. */
export const WINDOWS_MAX_PATH = 260;

/**
 * Error text that means a tool ran out of path. Matched case-insensitively
 * against the message of a failure that has already happened.
 *
 * - `ENAMETOOLONG` is the POSIX-style errno libuv surfaces.
 * - "filename or extension is too long" is the Win32 message (error 206).
 * - The two CMake strings are its object-path policy check, which is not an OS
 *   limit and fires well before one.
 */
const PATH_LENGTH_ERROR_SIGNATURES = [
  'enametoolong',
  'filename or extension is too long',
  'filename too long',
  'cmake_object_path_max',
  'cannot be safely placed',
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
