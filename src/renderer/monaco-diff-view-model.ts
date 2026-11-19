import type { editor as MonacoEditorNamespace } from 'monaco-editor';

/**
 * Who disposes a monaco diff VIEW model.
 *
 * A diff editor computes its diff in a view model, in an async autorun that
 * awaits the editor worker and stops only when the view model's own
 * cancellation token is cancelled (monaco 0.57 diffEditorViewModel.js:188-234).
 * Only disposing the view model cancels that token, and monaco never disposes
 * one that `setModel({ original, modified })` built: the widget keeps a
 * reference it never releases (diffEditorWidget.js `setModel`, utils.js
 * `BaseRefCounted`). So this app disposes every view model itself, at two
 * moments. DiffViewer's content swap disposes the outgoing one (Sentry
 * DESKTOP-22), and `disposeViewModelWithEditor` disposes the last one with its
 * editor (Sentry DESKTOP-4D).
 */

/** A diff view model its owner holds. Disposing it is all an owner does with one. */
export interface DisposableViewModel {
  dispose(): void;
}

/**
 * A disposer for the diff view model attached to `diffEditor`, read from
 * monaco's private state, or null when nothing is attached or that state is
 * not where monaco 0.57 keeps it.
 *
 * monaco has no getter for the attached view model (`getModel()` returns the
 * text models), so this reads the widget's `_diffModel` observable. Two callers
 * need it, both for a view model they did not create. DiffViewer adopts the one
 * @monaco-editor/react attached before onMount, so its first swap disposes it
 * like any other. `disposeViewModelWithEditor` reads whatever is attached each
 * time the attachment changes.
 *
 * A missing field returns null at the first check, and the identity check
 * against `getModel()` keeps a field that now holds something else from being
 * disposed. A null leaves a view model alive, as every swap did before Sentry
 * DESKTOP-22, and tests/ui/diff-swap-stale-view-model.spec.ts goes red.
 */
export function readAttachedViewModel(diffEditor: MonacoEditorNamespace.IDiffEditor): DisposableViewModel | null {
  const diffModelObservable: unknown = Reflect.get(diffEditor, '_diffModel');
  if (typeof diffModelObservable !== 'object' || diffModelObservable === null) return null;
  const readObservable: unknown = Reflect.get(diffModelObservable, 'get');
  if (typeof readObservable !== 'function') return null;
  const viewModel: unknown = readObservable.call(diffModelObservable);
  if (typeof viewModel !== 'object' || viewModel === null) return null;
  const textModels = diffEditor.getModel();
  if (textModels === null || Reflect.get(viewModel, 'model') !== textModels) return null;
  const dispose: unknown = Reflect.get(viewModel, 'dispose');
  if (typeof dispose !== 'function') return null;
  return {
    dispose: () => {
      dispose.call(viewModel);
    },
  };
}

/**
 * Dispose the view model last attached to `diffEditor` when the editor itself
 * is disposed. monacoConfig.ts registers this on monaco's diff editor creation
 * event, so it holds for every diff editor from the moment it exists.
 *
 * It starts at creation, not at @monaco-editor/react's onMount, because of
 * Sentry DESKTOP-4D ("no diff result available" as an unhandled rejection).
 * The library creates the editor and attaches its own view model in one effect
 * and calls onMount from an effect one render later. A task window that closes
 * in between never reaches DiffViewer's onMount handler, so nothing there can
 * own that view model. Its first diff is still waiting on the worker's `$ping`
 * (editorWorkerService.js `_getProxy`). By the time the request is posted the
 * text models are disposed, so the worker has neither and answers null
 * (editorWebWorker.js `$computeDiff`), and the provider throws unless the view
 * model's token is cancelled (diffProviderFactoryService.js:101-111). That
 * needs the worker to outlive the two models, which it does while any other
 * text model is registered: monaco stops its worker client only when the last
 * one goes (editorWorkerService.js `_checkStopEmptyWorker`).
 * tests/ui/diff-swap-stale-view-model.spec.ts reproduces it.
 *
 * It remembers the last view model that WAS attached because none is by the
 * time the editor goes. @monaco-editor/react disposes the text models first,
 * and the widget detaches as they go. A view model DiffViewer's swap already
 * disposed may be disposed here again, which monaco ignores.
 *
 * The diff editor's own onDidDispose never fires in monaco 0.57
 * (DelegatingEditor declares the emitter and nothing fires it), so this
 * listens on the modified editor.
 */
export function disposeViewModelWithEditor(diffEditor: MonacoEditorNamespace.IDiffEditor): void {
  let lastAttachedViewModel: DisposableViewModel | null = null;
  const attachmentSubscription = diffEditor.onDidChangeModel(() => {
    lastAttachedViewModel = readAttachedViewModel(diffEditor) ?? lastAttachedViewModel;
  });
  diffEditor.getModifiedEditor().onDidDispose(() => {
    attachmentSubscription.dispose();
    lastAttachedViewModel?.dispose();
    lastAttachedViewModel = null;
  });
}
