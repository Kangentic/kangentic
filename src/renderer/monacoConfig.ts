import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Deep specifiers omit the `esm/vs/` prefix: monaco 0.56 maps `./*` to
// `./esm/vs/*.js` in its exports, so the old full paths no longer resolve.
import { errorHandler } from 'monaco-editor/base/common/errors';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { createMonacoUnexpectedErrorHandler } from './monaco-error-funnel';
import { reportHandledRendererError } from './error-reporting';

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

// Wrap monaco's error funnel. monaco's Emitter catches a listener's throw and
// funnels it through errorHandler.unexpectedErrorHandler, whose default
// re-throws it on a timer, surfacing it as a red uncaught error (and a Vite
// overlay). The wrapper (src/renderer/monaco-error-funnel.ts) handles two
// kinds of error and delegates every other one to monaco's real default, so no
// genuine error is masked:
// - It swallows the known-benign errors in BENIGN_RENDERER_ERRORS (see
//   src/shared/benign-renderer-errors.ts), such as the DiffEditor disposal
//   error. On unmount, @monaco-editor/react disposes the two TextModels before
//   the widget resets its model, so a disposal listener throws "TextModel got
//   disposed before DiffEditorWidget model got reset" on a routine panel
//   close. It does not leak (both models are disposed regardless of order; see
//   DiffViewer.tsx).
//   Upstream: https://github.com/suren-atoyan/monaco-react/issues/647
// - It reports Sentry DESKTOP-19 ("Illegal value for lineNumber") as a handled
//   error with the live diff state, instead of letting it be re-thrown.
// This monaco build has no setUnexpectedErrorHandler export, so we reassign
// the singleton's handler field directly.
const defaultUnexpectedErrorHandler = errorHandler.unexpectedErrorHandler;
errorHandler.unexpectedErrorHandler = createMonacoUnexpectedErrorHandler({
  defaultHandler: defaultUnexpectedErrorHandler,
  reportHandled: reportHandledRendererError,
});

// Restore the original handler on HMR dispose so re-executing this module (an
// edit to monacoConfig.ts, or to a module it imports, such as the funnel)
// rewraps the real default rather than stacking another layer on the already-
// wrapped handler. Pattern D cleanup; see .claude/rules/hmr-patterns.md.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    errorHandler.unexpectedErrorHandler = defaultUnexpectedErrorHandler;
  });
}

// Dev-only: expose the monaco instance for UI test automation (Playwright
// page.evaluate), e.g. asserting `editor.getModels()` returns to baseline after
// a DiffEditor unmounts (no leaked TextModels). Production builds drop this via
// dead-code elimination (import.meta.env.DEV is false). Mirrors the
// __zustandStores handle in App.tsx. This is a read-only debug handle, not a
// behavior change.
// @ts-expect-error - Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__monaco = monaco;
}
