/**
 * Unit tests for `src/renderer/utils/dictation-sink.ts` - the abstraction over
 * WHERE a dictation session writes.
 *
 * `dictation-sink.ts` had no test of its own before this file: its behavior was
 * only exercised indirectly through `tests/ui/dictation-note-input.spec.ts`'s
 * full push-to-talk flow. Two of its four sink kinds are reachable at this tier
 * without jsdom:
 *
 * - `createTerminalSink` writes through `window.electronAPI.dictation.*` only -
 *   no DOM at all, so `window` is stubbed the way `dictation-target.test.ts`
 *   stubs `document`.
 * - `createGuestSink` takes the `<webview>` as a constructor argument and calls
 *   `.executeJavaScript` on it - a fake object satisfies that, no real guest
 *   needed.
 *
 * `createInputSink` and `createContentEditableSink` call `writeTextTarget` /
 * `writeContentEditable`, which read `HTMLInputElement.prototype` and
 * `window.getSelection()` - real DOM globals this project's jsdom-less unit
 * tier does not have. Those two stay covered at the UI tier
 * (`dictation-note-input.spec.ts`); only `createDictationSink`'s FACTORY
 * branching for them (does it return a sink at all) is exercised here, since
 * that much needs no DOM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDictationSink } from '../../src/renderer/utils/dictation-sink';
import type { DictationTarget } from '../../src/renderer/utils/dictation-target';
import type { WebviewElement } from '../../src/renderer/components/browser/webview-types';

interface DictationApiStub {
  liveWrite: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
}

function stubDictationApi(overrides: Partial<DictationApiStub> = {}): DictationApiStub {
  const stub: DictationApiStub = {
    liveWrite: vi.fn(),
    submit: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  vi.stubGlobal('window', { electronAPI: { dictation: stub } });
  return stub;
}

function noopCallbacks() {
  return { onSubmitStarted: vi.fn(), onSubmitSettled: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDictationSink - factory branching', () => {
  it('returns null for a refused target - there is nowhere to write', () => {
    const target: DictationTarget = { kind: 'refused', reason: 'password' };
    expect(createDictationSink(target, noopCallbacks())).toBeNull();
  });

  it('returns null for a guest target with no probe result yet', () => {
    // The caller has not yet learned which field (if any) the guest has
    // focused, so there is nothing safe to write into. A no-op sink here
    // would silently swallow the user's speech instead of reporting no target.
    const target: DictationTarget = { kind: 'guest', webview: {} as WebviewElement };
    expect(createDictationSink(target, noopCallbacks())).toBeNull();
  });

  it('returns a sink for a guest target once a probe anchor is supplied', () => {
    const webview = { executeJavaScript: vi.fn(() => Promise.resolve(true)) } as unknown as WebviewElement;
    const target: DictationTarget = { kind: 'guest', webview };
    const sink = createDictationSink(target, {
      ...noopCallbacks(),
      guestAnchor: { baseValue: '', anchorStart: 0, anchorEnd: 0, richText: false },
    });
    expect(sink).not.toBeNull();
  });

  it('returns a sink for a terminal target', () => {
    stubDictationApi();
    const target: DictationTarget = { kind: 'terminal', sessionId: 'sess-1' };
    expect(createDictationSink(target, noopCallbacks())).not.toBeNull();
  });
});

describe('createTerminalSink - write', () => {
  it('replaces with no erase on the first write', () => {
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.write('hello');
    expect(api.liveWrite).toHaveBeenCalledWith('sess-1', 'hello');
  });

  it('erases exactly the previous partial before writing the revised one', () => {
    // This is the arithmetic that makes a revised partial replace itself in
    // place instead of stuttering the sentence out again.
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.write('fix');
    sink?.write('fix the');
    expect(api.liveWrite).toHaveBeenNthCalledWith(2, 'sess-1', '\x7f\x7f\x7ffix the');
    sink?.write('fix the spacing');
    expect(api.liveWrite).toHaveBeenNthCalledWith(3, 'sess-1', '\x7f\x7f\x7f\x7f\x7f\x7f\x7ffix the spacing');
  });
});

describe('createTerminalSink - clear', () => {
  it('is a no-op when nothing has been written yet', () => {
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.clear();
    expect(api.liveWrite).not.toHaveBeenCalled();
  });

  it('erases everything written so far', () => {
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.write('scratch that');
    api.liveWrite.mockClear();
    sink?.clear();
    expect(api.liveWrite).toHaveBeenCalledWith('sess-1', '\x7f'.repeat('scratch that'.length));
  });

  it('is a no-op after a submit already zeroed the written count', () => {
    // `submit` clears `written` up front, so a later `clear()` must not reach
    // back and delete text that is no longer this session's to erase.
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.write('done');
    sink?.submit('done', false);
    api.liveWrite.mockClear();
    sink?.clear();
    expect(api.liveWrite).not.toHaveBeenCalled();
  });
});

describe('createTerminalSink - submit', () => {
  it('with autoSubmit OFF, erases and writes the final text but never calls submit', () => {
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.write('draft');
    api.liveWrite.mockClear();
    sink?.submit('final text', false);
    expect(api.liveWrite).toHaveBeenCalledWith('sess-1', '\x7f'.repeat('draft'.length) + 'final text');
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('with autoSubmit ON but whitespace-only text, downgrades to a plain write', () => {
    // An empty release must not fire a paste-and-Enter into a live shell.
    const api = stubDictationApi();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, noopCallbacks());
    sink?.submit('   ', true);
    expect(api.liveWrite).toHaveBeenCalledWith('sess-1', '   ');
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('with autoSubmit ON and real text, calls dictation.submit with the erase count', () => {
    const api = stubDictationApi();
    const callbacks = noopCallbacks();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, callbacks);
    sink?.write('fix the sp');
    api.liveWrite.mockClear();
    sink?.submit('fix the spacing', true);
    expect(api.submit).toHaveBeenCalledWith('sess-1', 'fix the spacing', 'fix the sp'.length);
    // Fire-and-forget through dictation.submit, NOT the erase-and-liveWrite
    // path the autoSubmit-off case above takes.
    expect(api.liveWrite).not.toHaveBeenCalled();
  });

  it('calls onSubmitStarted synchronously, before the IPC call resolves', () => {
    stubDictationApi();
    const callbacks = noopCallbacks();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, callbacks);
    sink?.submit('go', true);
    expect(callbacks.onSubmitStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onSubmitSettled).not.toHaveBeenCalled();
  });

  it('calls onSubmitSettled once the submit call resolves', async () => {
    stubDictationApi();
    const callbacks = noopCallbacks();
    const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, callbacks);
    sink?.submit('go', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.onSubmitSettled).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmitSettled even when the submit call REJECTS', async () => {
    // The highest-value case in this file. `onSubmitSettled` is what releases
    // the session id from the per-session paste-guard Set (decision 22 in
    // docs/embedded-browser.md). If this regressed from `.finally` to `.then`,
    // a rejected submit would strand the session id in that guard forever -
    // every later press for it silently refused as "busy", which is exactly
    // the bug report ("works sometimes, seems to need a reset") the guard was
    // rewritten to fix.
    //
    // The source discards `.finally(...)`'s OWN returned promise via `void`
    // (fire-and-forget, so the chip closes immediately), so a rejection here
    // is a genuine unhandled rejection from Node's point of view even though
    // this test's assertions all pass - Vitest's own collector would
    // otherwise flag it and fail the whole run. Suppress Vitest's
    // `unhandledRejection` listener for the narrow window this settles in,
    // then restore it; this does not touch the sink's own behavior.
    const suppressedListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    // A NO listener at all makes Node's default (`--unhandled-rejections=throw`)
    // convert the rejection into an uncaught exception instead - worse than
    // what we are suppressing. One inert listener keeps Node's default off
    // without handing the event back to Vitest's collector.
    const noop = () => {};
    process.on('unhandledRejection', noop);
    try {
      stubDictationApi({ submit: vi.fn(() => Promise.reject(new Error('ipc failed'))) });
      const callbacks = noopCallbacks();
      const sink = createDictationSink({ kind: 'terminal', sessionId: 'sess-1' }, callbacks);
      sink?.submit('go', true);
      // Let the rejection and its .finally handler run, and let Node's
      // unhandled-rejection check complete while Vitest's listener is
      // suppressed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbacks.onSubmitSettled).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', noop);
      for (const listener of suppressedListeners) {
        process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener);
      }
    }
  });
});

describe('createGuestSink', () => {
  function guestTarget() {
    const executeJavaScript = vi.fn(() => Promise.resolve(true));
    const webview = { executeJavaScript } as unknown as WebviewElement;
    return { webview, executeJavaScript };
  }

  it('write composes against the probed anchor and sends the composed value', () => {
    const { webview, executeJavaScript } = guestTarget();
    const sink = createDictationSink(
      { kind: 'guest', webview },
      { ...noopCallbacks(), guestAnchor: { baseValue: 'note: ', anchorStart: 6, anchorEnd: 6, richText: false } },
    );
    sink?.write('fix this');
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain(JSON.stringify('note: fix this'));
  });

  it('a rich-text anchor writes the raw text and does NOT compose against baseValue', () => {
    // The rich-text branch replaces its own last insertion instead of
    // recomposing a `.value` string, which a contenteditable host has none of.
    const { webview, executeJavaScript } = guestTarget();
    const sink = createDictationSink(
      { kind: 'guest', webview },
      {
        ...noopCallbacks(),
        guestAnchor: { baseValue: 'irrelevant', anchorStart: 3, anchorEnd: 3, richText: true },
      },
    );
    sink?.write('hello');
    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain(JSON.stringify('hello'));
    expect(script).not.toContain(JSON.stringify('irrelevant'));
  });

  it('passes the growing previousLength across successive rich-text writes', () => {
    const { webview, executeJavaScript } = guestTarget();
    const sink = createDictationSink(
      { kind: 'guest', webview },
      { ...noopCallbacks(), guestAnchor: { baseValue: '', anchorStart: 0, anchorEnd: 0, richText: true } },
    );
    sink?.write('fix');
    sink?.write('fix the');
    // write(value, caret, previousLength) - previousLength is the third arg,
    // and must equal the LENGTH of what this session wrote last time ('fix').
    const secondScript = executeJavaScript.mock.calls[1][0] as string;
    expect(secondScript.endsWith(`, ${'fix'.length})`)).toBe(true);
  });

  it('clear is a no-op when nothing has been written yet', () => {
    const { webview, executeJavaScript } = guestTarget();
    const sink = createDictationSink(
      { kind: 'guest', webview },
      { ...noopCallbacks(), guestAnchor: { baseValue: '', anchorStart: 0, anchorEnd: 0, richText: false } },
    );
    sink?.clear();
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('clear erases by writing back the base value', () => {
    const { webview, executeJavaScript } = guestTarget();
    const sink = createDictationSink(
      { kind: 'guest', webview },
      { ...noopCallbacks(), guestAnchor: { baseValue: 'kept', anchorStart: 4, anchorEnd: 4, richText: false } },
    );
    sink?.write('added');
    executeJavaScript.mockClear();
    sink?.clear();
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain(JSON.stringify('kept'));
  });
});
