import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { errorHandler } from 'monaco-editor/esm/vs/base/common/errors';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { isBenignRendererError } from '../shared/benign-renderer-errors';

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

// Silence one known-benign error at monaco's source. On DiffEditor unmount,
// @monaco-editor/react disposes the two TextModels before the widget resets its
// model, so a disposal listener throws "TextModel got disposed before
// DiffEditorWidget model got reset". monaco's Emitter catches that throw and
// funnels it through errorHandler.unexpectedErrorHandler, whose default re-throws
// it on a timer, surfacing it as a red uncaught error (and a Vite overlay) on a
// routine panel close. It is benign and does not leak (both models are disposed
// regardless of order; see DiffViewer.tsx). Wrap the funnel: swallow exactly that
// message and delegate every other unexpected error to monaco's real default, so
// no genuine error is masked. This monaco build has no setUnexpectedErrorHandler
// export, so we reassign the singleton's handler field directly.
// Upstream: https://github.com/suren-atoyan/monaco-react/issues/647
const defaultUnexpectedErrorHandler = errorHandler.unexpectedErrorHandler;
errorHandler.unexpectedErrorHandler = (error: unknown) => {
  if (isBenignRendererError(error)) return;
  defaultUnexpectedErrorHandler(error);
};

// Restore the original handler on HMR dispose so re-executing this module (an
// edit to monacoConfig.ts, or to benign-renderer-errors.ts which it imports)
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
