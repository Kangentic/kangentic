/**
 * Minimal typings for the monaco-editor deep-internal error module. monaco only
 * ships public API types (monaco.d.ts); the unexpected-error funnel lives in this
 * internal module, which we reach to suppress one benign disposal-order message
 * on DiffEditor unmount. See src/renderer/monacoConfig.ts and
 * src/shared/benign-renderer-errors.ts.
 *
 * tsconfig.json maps the bare `monaco-editor` specifier to
 * node_modules/monaco-editor/esm/vs/index.d.ts on purpose (JSON cannot carry
 * this note). monaco 0.56 moved its root types to that file and exposes it only
 * through the package `exports` map, while its `typings` field still names
 * esm/vs/editor/editor.main.d.ts, which no longer exists. Under
 * `moduleResolution: node` tsc ignores `exports`, follows `typings`, misses,
 * and either fails to resolve the package (CI) or walks up into a parent
 * checkout's older copy (a worktree under the main repo), which then
 * type-checks against the wrong monaco. Drop the mapping once upstream fixes
 * the field or the repo moves to bundler resolution.
 */
declare module 'monaco-editor/base/common/errors' {
  /**
   * The process-wide error handler singleton. Its `unexpectedErrorHandler` field
   * is the function monaco routes every unexpected (BugIndicating) error through;
   * reassigning it installs a custom handler (this monaco build has no
   * `setUnexpectedErrorHandler` export).
   */
  export const errorHandler: {
    unexpectedErrorHandler: (error: unknown) => void;
  };
}
