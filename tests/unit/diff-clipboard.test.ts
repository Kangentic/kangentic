import { describe, it, expect, vi, afterEach } from 'vitest';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import {
  getDiffSelectionText,
  copyDiffSelection,
  type DiffSelectionSource,
} from '../../src/renderer/utils/diff-clipboard';

/**
 * Unit coverage for the diff-editor copy path added to fix Copy / Ctrl+C in the
 * Changes panel's Monaco diff viewer. Monaco's own copy routes through the web
 * clipboard, which rejects once the document loses focus (exactly the state
 * while a context menu is open); this module reads the selection directly off
 * the diff editor's two sub-editors and writes it via the focus-independent
 * main-process clipboard.
 */

type StubCodeEditor = MonacoEditorNamespace.ICodeEditor;

/** `selectionText` of `null` means no selection object at all (getSelection()
 *  returns null); an empty string means a selection object with isEmpty() true. */
function makeEditorStub(focused: boolean, selectionText: string | null): StubCodeEditor {
  return {
    hasTextFocus: () => focused,
    getSelection: () => {
      if (selectionText === null) return null;
      return { isEmpty: () => selectionText.length === 0 };
    },
    getModel: () => ({
      getValueInRange: () => selectionText ?? '',
    }),
  } as unknown as StubCodeEditor;
}

function makeDiffEditorStub(modified: StubCodeEditor, original: StubCodeEditor): DiffSelectionSource {
  return {
    getModifiedEditor: () => modified,
    getOriginalEditor: () => original,
  };
}

describe('getDiffSelectionText', () => {
  it('reads the modified side selection when it holds text focus', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, 'modified selection'),
      makeEditorStub(false, null),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('modified selection');
  });

  it('reads the original side selection when it holds text focus', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(false, null),
      makeEditorStub(true, 'original selection'),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('original selection');
  });

  it('prefers the focused side even when the other side also has a selection', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, 'modified selection'),
      makeEditorStub(false, 'stale original selection'),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('modified selection');
  });

  it('falls back to the modified side when neither side has text focus', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(false, 'modified selection'),
      makeEditorStub(false, null),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('modified selection');
  });

  it('falls back to the original side when neither side has text focus and only it has a selection', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(false, null),
      makeEditorStub(false, 'original selection'),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('original selection');
  });

  it('returns an empty string when neither side has a selection', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, null),
      makeEditorStub(false, null),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('');
  });

  it('returns an empty string for a collapsed (empty) selection', () => {
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, ''),
      makeEditorStub(false, null),
    );

    expect(getDiffSelectionText(diffEditor)).toBe('');
  });

  it('prefers a non-empty preferredEditor selection over both sides, even when neither has focus (context-menu path)', () => {
    const originalEditor = makeEditorStub(false, 'original selection');
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(false, 'stale modified selection'),
      originalEditor,
    );

    expect(getDiffSelectionText(diffEditor, originalEditor)).toBe('original selection');
  });

  it('falls back to the focused/content selection when preferredEditor has an empty selection', () => {
    const preferredEditor = makeEditorStub(false, '');
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, 'modified selection'),
      makeEditorStub(false, null),
    );

    expect(getDiffSelectionText(diffEditor, preferredEditor)).toBe('modified selection');
  });
});

describe('copyDiffSelection', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  function stubWindowClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error -- minimal window stub for the write call
    globalThis.window = { electronAPI: { clipboard: { writeText } } };
    return writeText;
  }

  it('writes the selection via window.electronAPI.clipboard.writeText (focus-independent main-process write)', () => {
    const writeText = stubWindowClipboard();
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, 'copy me'),
      makeEditorStub(false, null),
    );

    copyDiffSelection(diffEditor);

    expect(writeText).toHaveBeenCalledWith('copy me');
  });

  it('is a no-op when there is no selection', () => {
    const writeText = stubWindowClipboard();
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, null),
      makeEditorStub(false, null),
    );

    copyDiffSelection(diffEditor);

    expect(writeText).not.toHaveBeenCalled();
  });

  it('swallows a rejected clipboard write instead of throwing (best-effort write)', async () => {
    // A plain (non-vi.fn) function, deliberately not a mock: vitest's spy
    // wrapper internally chains its own .then()/.catch() onto a mocked
    // async function's return value to populate `mock.results`, which
    // would mask a missing .catch() in the source under test.
    let callCount = 0;
    let lastArg: string | undefined;
    const writeText = (text: string): Promise<void> => {
      callCount += 1;
      lastArg = text;
      return Promise.reject(new Error('denied'));
    };
    // @ts-expect-error -- minimal window stub for the write call
    globalThis.window = { electronAPI: { clipboard: { writeText } } };
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(true, 'copy me'),
      makeEditorStub(false, null),
    );

    // A rejected promise only surfaces as `process.on('unhandledRejection')`
    // if nothing calls .catch() on it by the end of the microtask queue, so
    // synchronous expect(...).not.toThrow() can't detect a missing .catch():
    // install a listener and give the rejection a full macrotask to surface.
    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      expect(() => copyDiffSelection(diffEditor)).not.toThrow();
      expect(callCount).toBe(1);
      expect(lastArg).toBe('copy me');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('writes the preferredEditor selection when passed explicitly (right-click path)', () => {
    const writeText = stubWindowClipboard();
    const originalEditor = makeEditorStub(false, 'original selection');
    const diffEditor = makeDiffEditorStub(
      makeEditorStub(false, 'stale modified selection'),
      originalEditor,
    );

    copyDiffSelection(diffEditor, originalEditor);

    expect(writeText).toHaveBeenCalledWith('original selection');
  });
});
