/**
 * How much of Windows' MAX_PATH a worktree leaves for the tools that run inside
 * it.
 *
 * This is used ONLY to explain a failure that has already happened, never to
 * predict one. A path-length check fires on path length rather than on the
 * presence of a native toolchain, so warning up front would tell most users
 * about a failure that will never reach them. It also could not catch the worst
 * case anyway: a CMake object-path overflow surfaces inside Gradle, in the
 * agent's terminal, which Kangentic never observes.
 *
 * The reserves below are measured, not estimated. See docs/cross-platform.md.
 */

/** Windows MAX_PATH, including the terminating NUL. */
export const WINDOWS_MAX_PATH = 260;

/**
 * Deepest path measured relative to a checkout root under an npm `node_modules`
 * tree (this repository, 39,571 files). Below this, ordinary install and
 * typecheck operations start failing.
 *
 * This is the right reserve even though a Kangentic worktree's `node_modules` is
 * a junction to the project root's: Node resolves through a junction using the
 * pre-resolution path, so the worktree path is what counts against the limit.
 */
export const ORDINARY_TOOLING_RESERVE = 142;

/**
 * Deepest object path measured relative to a checkout root for a React Native
 * Android (CMake/NDK) build, after CMake's own MD5 path shortening. The heaviest
 * toolchain measured; node-gyp, Rust and .NET need considerably less.
 *
 * A worktree with less headroom than this cannot host such a build no matter
 * what Kangentic names its directories, which is why there is no setting for it.
 */
export const DEEP_NATIVE_BUILD_RESERVE = 242;

/**
 * Characters left for a relative path inside `worktreePath` before MAX_PATH is
 * reached. Accounts for the separator that joins the two.
 */
export function worktreePathHeadroom(worktreePath: string): number {
  return WINDOWS_MAX_PATH - worktreePath.length - 1;
}

/**
 * A sentence to append to a worktree failure that path length plausibly caused,
 * or null when length is not a plausible cause.
 *
 * Returns null off Windows (other platforms have a 1024 to 4096 byte PATH_MAX)
 * and whenever there is enough headroom for ordinary tooling, so this can never
 * put a misleading explanation on an unrelated error.
 */
export function describeWorktreePathLengthCause(worktreePath: string): string | null {
  if (process.platform !== 'win32') return null;
  const headroom = worktreePathHeadroom(worktreePath);
  if (headroom >= ORDINARY_TOOLING_RESERVE) return null;
  return `This worktree path is ${worktreePath.length} characters, leaving ${headroom} of `
    + `Windows' ${WINDOWS_MAX_PATH}-character limit for files inside it. Tools need about `
    + `${ORDINARY_TOOLING_RESERVE} for an npm install, so path length is the likely cause. `
    + `Moving the project to a shorter path fixes it.`;
}
