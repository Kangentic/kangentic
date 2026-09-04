/**
 * Renderer errors that are known-benign and outside the app's control. The
 * single source of truth for THREE consumers: the runtime suppressor (the
 * monaco error-funnel wrapper in src/renderer/monacoConfig.ts, which reassigns
 * errorHandler.unexpectedErrorHandler), the test collector (collectPageErrors
 * in tests/ui/helpers.ts), and Sentry's `ignoreErrors`
 * (src/main/analytics/error-reporting.ts), which spreads this array so a
 * pattern added here cannot reach the issue stream either.
 *
 * PATTERNS MUST STAY UNANCHORED. Monaco's default unexpectedErrorHandler
 * re-throws as `e.message + '\n\n' + e.stack` (monaco-editor
 * esm/vs/base/common/errors.js), so anything that escapes the funnel arrives at
 * Sentry with a stack appended. An anchored pattern (^...$) would match at the
 * funnel and silently fail at Sentry, which is the worst of both.
 *
 * - The monaco DiffEditor disposal-order quirk. On unmount, @monaco-editor/react
 *   disposes a DiffEditor's two TextModels before the widget, so monaco throws a
 *   self-healing BugIndicatingError and resets its own model. Non-fatal and does
 *   not leak (both models are disposed regardless of order); no stable
 *   @monaco-editor/react (4.7.0) / monaco-editor (0.55.1) release fixes the order.
 *   Upstream: https://github.com/suren-atoyan/monaco-react/issues/647
 * - A Monarch grammar executing `@pop` on an empty state stack. Monaco tokenizes
 *   the VIEWPORT first, and for a diff revealed at its first hunk
 *   (revealLineInCenter in DiffViewer.tsx) that viewport starts mid-file, so
 *   `guessStartState` tokenizes from a guessed state and a closing token can be
 *   seen with no matching opener. Tokenization for that region degrades and
 *   nothing else breaks. Every per-line tokenizer call is wrapped by monaco's
 *   own safeTokenize, which routes the throw to this funnel, which is why
 *   suppressing it here works at all. NOT keyed to a language: Monarch's
 *   throwError prefixes the message with the language id (`ruby: trying to...`),
 *   so the same upstream grammar bug in any other bundled language produces the
 *   same event under a different prefix. Deliberately not broadened to all
 *   Monarch errors, which would mask real grammar problems.
 */
export const BENIGN_RENDERER_ERRORS: RegExp[] = [
  /TextModel got disposed before DiffEditorWidget model got reset/,
  /trying to pop an empty stack/,
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
