/**
 * Minimal typings for the monaco-editor deep-internal error module. monaco only
 * ships public API types (monaco.d.ts); the unexpected-error funnel lives in this
 * internal module, which we reach to suppress one benign disposal-order message
 * on DiffEditor unmount. See src/renderer/monacoConfig.ts and
 * src/shared/benign-renderer-errors.ts.
 */
declare module 'monaco-editor/esm/vs/base/common/errors' {
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
