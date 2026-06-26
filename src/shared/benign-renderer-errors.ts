/**
 * Renderer errors that are known-benign and outside the app's control. The
 * single source of truth for both the runtime suppressor (the monaco
 * error-funnel wrapper in src/renderer/monacoConfig.ts, which reassigns
 * errorHandler.unexpectedErrorHandler) and the test collector (collectPageErrors
 * in tests/ui/helpers.ts).
 *
 * - The monaco DiffEditor disposal-order quirk. On unmount, @monaco-editor/react
 *   disposes a DiffEditor's two TextModels before the widget, so monaco throws a
 *   self-healing BugIndicatingError and resets its own model. Non-fatal and does
 *   not leak (both models are disposed regardless of order); no stable
 *   @monaco-editor/react (4.7.0) / monaco-editor (0.55.1) release fixes the order.
 *   Upstream: https://github.com/suren-atoyan/monaco-react/issues/647
 */
export const BENIGN_RENDERER_ERRORS: RegExp[] = [
  /TextModel got disposed before DiffEditorWidget model got reset/,
];

/**
 * Returns true when `error` matches one of the known-benign renderer error
 * patterns and should be silently suppressed. Returns false for any genuine
 * unexpected error that must reach the default handler.
 *
 * Accepts both Error objects and raw strings so it can be used both in the
 * runtime error funnel (monaco throws arbitrary values) and in test collectors
 * (Playwright pageerror events and raw message strings alike).
 */
export function isBenignRendererError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return BENIGN_RENDERER_ERRORS.some((pattern) => pattern.test(message));
}
