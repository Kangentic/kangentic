import type { editor as MonacoEditorNamespace } from 'monaco-editor';

/** The subset of `@monaco-editor/react`'s `MonacoDiffEditor` this module needs,
 *  kept structural (rather than importing the library) so this stays a plain,
 *  monaco-runtime-free util that is trivial to stub in unit tests. */
export interface DiffSelectionSource {
  getModifiedEditor(): MonacoEditorNamespace.ICodeEditor;
  getOriginalEditor(): MonacoEditorNamespace.ICodeEditor;
}

function selectedText(editor: MonacoEditorNamespace.ICodeEditor): string {
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return '';
  return editor.getModel()?.getValueInRange(selection) ?? '';
}

/**
 * Read the current selection out of whichever side of the diff (original or
 * modified) holds it. A DiffEditor has two independent sub-editors, so a
 * selection made in the left (original) pane never appears on the right
 * (modified) pane's model.
 *
 * When `preferredEditor` is given (the pane the caller resolved from a
 * right-click POINT), its selection wins if non-empty. This is the reliable
 * signal for the context-menu path, because Menu.popup steals document focus,
 * so hasTextFocus() reads false on both panes by the time this runs and both
 * panes may still hold stale selections. Otherwise (the keyboard path, where
 * focus is intact) prefer the side with text focus, then fall back to whichever
 * side has a non-empty selection. Returns '' when nothing is selected.
 */
export function getDiffSelectionText(
  diffEditor: DiffSelectionSource,
  preferredEditor?: MonacoEditorNamespace.ICodeEditor,
): string {
  const modifiedEditor = diffEditor.getModifiedEditor();
  const originalEditor = diffEditor.getOriginalEditor();
  if (preferredEditor) {
    const preferred = selectedText(preferredEditor);
    if (preferred) return preferred;
  }
  if (modifiedEditor.hasTextFocus()) return selectedText(modifiedEditor);
  if (originalEditor.hasTextFocus()) return selectedText(originalEditor);
  return selectedText(modifiedEditor) || selectedText(originalEditor);
}

/**
 * Copy the diff editor's current selection to the system clipboard. Writes via
 * the main process (window.electronAPI.clipboard.writeText), which is focus-
 * and permission-independent, rather than Monaco's default copy action (which
 * routes through document.execCommand('copy') / navigator.clipboard.writeText
 * and rejects with NotAllowedError once the document loses focus - exactly the
 * state while a context menu is open). Best-effort: a failed write is
 * swallowed. No-op when there is no selection.
 */
export function copyDiffSelection(
  diffEditor: DiffSelectionSource,
  preferredEditor?: MonacoEditorNamespace.ICodeEditor,
): void {
  const text = getDiffSelectionText(diffEditor, preferredEditor);
  if (text) window.electronAPI.clipboard.writeText(text).catch(() => { /* best-effort */ });
}
