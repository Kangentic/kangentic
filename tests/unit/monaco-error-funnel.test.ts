/**
 * Unit coverage for the monaco error funnel (src/renderer/monaco-error-funnel.ts),
 * the handler monacoConfig.ts installs on errorHandler.unexpectedErrorHandler.
 *
 * Sentry DESKTOP-19 ("Illegal value for lineNumber") is an error monaco has
 * already CAUGHT: Emitter._deliver catches the scroll listener's throw and
 * calls the funnel, whose default rethrows it on a timer. The funnel now
 * reports it as handled, with the live diff state, and does not rethrow. Every
 * other error must still reach monaco's default, or a genuine bug is masked.
 *
 * monacoConfig.ts itself cannot load here (Vite `?worker` imports), so these
 * tests build the handler with the same factory and inject the real
 * reportHandledRendererError, with the Sentry SDK mocked the way
 * error-reporting-renderer.test.ts mocks it. The last block installs the
 * handler on monaco's REAL errorHandler and fires a real monaco Emitter, which
 * is the route DESKTOP-19 takes in the app.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: vi.fn(),
  captureException: mocks.captureException,
}));

import {
  MONACO_HANDLED_ERROR_LOG_TAG,
  HANDLED_REPORT_INTERVAL_MS,
  captureCallSiteFrames,
  createMonacoUnexpectedErrorHandler,
  isMonacoLineNumberError,
  registerDiffViewerSnapshotReader,
  toCallSiteFrames,
  type DiffViewerSnapshot,
  type ReportHandledError,
} from '../../src/renderer/monaco-error-funnel';
import { reportHandledRendererError } from '../../src/renderer/error-reporting';

const LINE_NUMBER_MESSAGE = 'Illegal value for lineNumber';

const SNAPSHOT: DiffViewerSnapshot = {
  view_mode: 'split',
  language: 'typescript',
  hide_unchanged_regions: true,
  fold_reenable_pending: false,
  fold_reenable_in_progress: true,
  content_matches: true,
  line_change_count: 1,
  folded_region_count: 2,
  original_line_count: 1500,
  original_scroll_top: 26982,
  original_scroll_height: 27000,
  original_viewport_height: 528,
  original_visible_ranges: `threw: ${LINE_NUMBER_MESSAGE}`,
  modified_line_count: 3000,
  modified_scroll_top: 26982,
  modified_scroll_height: 54000,
  modified_viewport_height: 528,
  modified_visible_ranges: '1480-1509',
};

let unregisterReaders: Array<() => void> = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function register(reader: () => DiffViewerSnapshot | null): void {
  unregisterReaders.push(registerDiffViewerSnapshotReader(reader));
}

function buildFunnel() {
  const defaultHandler = vi.fn();
  const handler = createMonacoUnexpectedErrorHandler({
    defaultHandler,
    reportHandled: reportHandledRendererError,
  });
  return { handler, defaultHandler };
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const unregister of unregisterReaders) unregister();
  unregisterReaders = [];
  mocks.captureException.mockReset();
  consoleErrorSpy.mockRestore();
  vi.useRealTimers();
});

describe('the lineNumber error is reported as handled, with context, and not rethrown', () => {
  it('sends exactly one handled report carrying the diff snapshot and never calls the default', () => {
    register(() => SNAPSHOT);
    const { handler, defaultHandler } = buildFunnel();
    const error = new Error(LINE_NUMBER_MESSAGE);

    expect(() => handler(error)).not.toThrow();

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [reportedError, captureContext] = mocks.captureException.mock.calls[0];
    expect(reportedError).toBe(error);
    expect(captureContext.tags).toEqual({
      source: 'monaco_line_number',
      hide_unchanged_regions: 'true',
      diff_viewers_live: '1',
    });
    expect(captureContext.contexts.diff_viewer_1).toEqual(SNAPSHOT);
    expect(Array.isArray(captureContext.contexts.call_site.frames)).toBe(true);
    expect(captureContext.contexts.call_site.frames.length).toBeGreaterThan(0);

    // The default rethrows on a timer, which is exactly what must not happen.
    expect(defaultHandler).not.toHaveBeenCalled();
    // It stays visible in dev, as a console line the UI-test collector reads.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      MONACO_HANDLED_ERROR_LOG_TAG,
      expect.any(String),
      error,
      captureContext.contexts,
    );
  });

  it('gives each co-mounted viewer its own context block', () => {
    register(() => SNAPSHOT);
    register(() => ({ ...SNAPSHOT, hide_unchanged_regions: false, language: 'json' }));
    const { handler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));

    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.tags.diff_viewers_live).toBe('2');
    expect(captureContext.contexts.diff_viewer_1.language).toBe('typescript');
    expect(captureContext.contexts.diff_viewer_2.language).toBe('json');
    // Any live viewer with collapse on is what the tag filters for.
    expect(captureContext.tags.hide_unchanged_regions).toBe('true');
  });

  it('skips a viewer with no live editor (binary file, markdown preview)', () => {
    register(() => null);
    register(() => SNAPSHOT);
    const { handler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));

    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.tags.diff_viewers_live).toBe('1');
    expect(captureContext.contexts.diff_viewer_1).toEqual(SNAPSHOT);
    expect(captureContext.contexts.diff_viewer_2).toBeUndefined();
  });

  it('still reports once when no DiffViewer is mounted', () => {
    const { handler, defaultHandler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.tags).toEqual({
      source: 'monaco_line_number',
      hide_unchanged_regions: 'unknown',
      diff_viewers_live: '0',
    });
    expect(Object.keys(captureContext.contexts).sort()).toEqual(['call_site', 'funnel']);
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('still reports once when a snapshot reader throws', () => {
    register(() => {
      throw new Error('editor already disposed');
    });
    const { handler, defaultHandler } = buildFunnel();

    expect(() => handler(new Error(LINE_NUMBER_MESSAGE))).not.toThrow();

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.contexts.diff_viewer_1).toEqual({ snapshot_error: 'editor already disposed' });
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('sends a lineNumber error raised while reporting to the default instead of recursing', () => {
    const { handler, defaultHandler } = buildFunnel();
    const nestedError = new Error(LINE_NUMBER_MESSAGE);
    register(() => {
      handler(nestedError);
      return SNAPSHOT;
    });
    const outerError = new Error(LINE_NUMBER_MESSAGE);

    handler(outerError);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0][0]).toBe(outerError);
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(nestedError);
  });

  it('tags hide_unchanged_regions as false when every live viewer has collapse off', () => {
    register(() => ({ ...SNAPSHOT, hide_unchanged_regions: false }));
    register(() => ({ ...SNAPSHOT, hide_unchanged_regions: false, language: 'json' }));
    const { handler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));

    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.tags.hide_unchanged_regions).toBe('false');
    expect(captureContext.tags.diff_viewers_live).toBe('2');
  });

  it('stops reporting a viewer once the unregister returned by its registration is called', () => {
    const unregisterFirst = registerDiffViewerSnapshotReader(() => SNAPSHOT);
    unregisterReaders.push(unregisterFirst);
    register(() => ({ ...SNAPSHOT, language: 'json' }));
    const { handler } = buildFunnel();

    unregisterFirst();
    handler(new Error(LINE_NUMBER_MESSAGE));

    const [, captureContext] = mocks.captureException.mock.calls[0];
    expect(captureContext.tags.diff_viewers_live).toBe('1');
    expect(captureContext.contexts.diff_viewer_1.language).toBe('json');
    expect(captureContext.contexts.diff_viewer_2).toBeUndefined();
  });
});

describe('a stuck editor throwing on every scroll tick is rate limited', () => {
  it('reports the first throw of a burst, absorbs the rest unrethrown, and counts them into the next report', () => {
    vi.useFakeTimers();
    register(() => SNAPSHOT);
    const { handler, defaultHandler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));
    for (let tick = 0; tick < 5; tick++) {
      vi.advanceTimersByTime(16);
      expect(() => handler(new Error(LINE_NUMBER_MESSAGE))).not.toThrow();
    }

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0][1].contexts.funnel).toEqual({ suppressed_since_last_report: 0 });
    // Absorbed throws skip the console line and never reach monaco's rethrowing default.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(defaultHandler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(HANDLED_REPORT_INTERVAL_MS);
    handler(new Error(LINE_NUMBER_MESSAGE));

    expect(mocks.captureException).toHaveBeenCalledTimes(2);
    expect(mocks.captureException.mock.calls[1][1].contexts.funnel).toEqual({ suppressed_since_last_report: 5 });
  });

  it('does not let a failed report open a window, so the next throw is still reported', () => {
    vi.useFakeTimers();
    const reportHandled = vi.fn<ReportHandledError>().mockImplementationOnce(() => {
      throw new Error('reporter exploded');
    });
    const handler = createMonacoUnexpectedErrorHandler({ defaultHandler: vi.fn(), reportHandled });

    handler(new Error(LINE_NUMBER_MESSAGE));
    vi.advanceTimersByTime(16);
    handler(new Error(LINE_NUMBER_MESSAGE));

    expect(reportHandled).toHaveBeenCalledTimes(2);
  });

  it('treats a wall clock that stepped back as an expired window, so reports do not go silent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const { handler, defaultHandler } = buildFunnel();

    handler(new Error(LINE_NUMBER_MESSAGE));
    // An NTP correction or a VM resume moves the clock ten minutes back.
    vi.setSystemTime(new Date('2026-01-01T11:50:00Z'));
    handler(new Error(LINE_NUMBER_MESSAGE));

    expect(mocks.captureException).toHaveBeenCalledTimes(2);
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('keeps sending unrelated errors to the default while a window is open', () => {
    vi.useFakeTimers();
    const { handler, defaultHandler } = buildFunnel();
    handler(new Error(LINE_NUMBER_MESSAGE));
    const unrelated = new Error('an unrelated monaco bug');

    handler(unrelated);

    expect(defaultHandler).toHaveBeenCalledWith(unrelated);
  });
});

describe('a failure while reporting never escapes monaco\'s catch block', () => {
  it('hands the error to the default handler when the report itself throws', () => {
    const defaultHandler = vi.fn();
    const handler = createMonacoUnexpectedErrorHandler({
      defaultHandler,
      reportHandled: () => {
        throw new Error('reporter exploded');
      },
    });
    const error = new Error(LINE_NUMBER_MESSAGE);

    expect(() => handler(error)).not.toThrow();

    // Never reported, so the default is the only place the error can still surface.
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(error);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does not hand a reported error to the default when only the console line fails', () => {
    consoleErrorSpy.mockImplementation(() => {
      throw new Error('console closed');
    });
    const { handler, defaultHandler } = buildFunnel();

    expect(() => handler(new Error(LINE_NUMBER_MESSAGE))).not.toThrow();

    // The default would rethrow it on a timer and Sentry would count the incident twice.
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('resets the re-entrancy guard after a failed report, so the next error is still reported', () => {
    const defaultHandler = vi.fn();
    const reportHandled = vi.fn<ReportHandledError>().mockImplementationOnce(() => {
      throw new Error('reporter exploded');
    });
    const handler = createMonacoUnexpectedErrorHandler({ defaultHandler, reportHandled });
    const firstError = new Error(LINE_NUMBER_MESSAGE);
    const secondError = new Error(LINE_NUMBER_MESSAGE);

    handler(firstError);
    handler(secondError);

    // A guard left set by the first failure would send the second to the default unreported.
    expect(reportHandled).toHaveBeenCalledTimes(2);
    expect(reportHandled.mock.calls[1][0]).toBe(secondError);
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(firstError);
  });
});

describe('reportHandledRendererError', () => {
  it('passes the error, tags, and contexts through to captureException unchanged', () => {
    const error = new Error('handled');
    const tags = { source: 'unit_test', mode: 'split' };
    const contexts = { call_site: { frames: ['a (b.js:1:2)'] }, diff_viewer_1: { language: 'json' } };

    reportHandledRendererError(error, tags, contexts);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [reportedError, captureContext] = mocks.captureException.mock.calls[0];
    expect(reportedError).toBe(error);
    expect(captureContext).toEqual({ tags, contexts });
    expect(captureContext.tags).toBe(tags);
    expect(captureContext.contexts).toBe(contexts);
  });

  it('never throws, even when captureException does', () => {
    mocks.captureException.mockImplementationOnce(() => {
      throw new Error('sdk transport failed');
    });

    expect(() => reportHandledRendererError(new Error('handled'), { source: 'unit_test' }, {})).not.toThrow();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('every other error keeps its existing path', () => {
  it('hands an unrelated error to the default handler unchanged, with no report', () => {
    register(() => SNAPSHOT);
    const { handler, defaultHandler } = buildFunnel();
    const error = new TypeError("Cannot read properties of undefined (reading 'getLineCount')");

    handler(error);

    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(error);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('does not treat a lineNumber message with a stack appended as the raw error', () => {
    // The funnel receives the raw BugIndicatingError. The appended shape only
    // exists after monaco's default has rethrown it, and must not be matched.
    expect(isMonacoLineNumberError(new Error(`${LINE_NUMBER_MESSAGE}\n\n    at x (y.js:1:1)`))).toBe(false);
    expect(isMonacoLineNumberError(LINE_NUMBER_MESSAGE)).toBe(false);
    expect(isMonacoLineNumberError(new Error(LINE_NUMBER_MESSAGE))).toBe(true);
  });

  it('still swallows the benign DiffEditor disposal error, with no report and no default', () => {
    const { handler, defaultHandler } = buildFunnel();

    handler(new Error('TextModel got disposed before DiffEditorWidget model got reset'));

    expect(defaultHandler).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
});

describe('call-site frames', () => {
  it('cuts every location to its basename, so no home directory leaves the machine', () => {
    const stack = [
      'Error',
      '    at createHandler (file:///C:/Users/dev/AppData/Local/Programs/kangentic/resources/app.asar/.vite/renderer/assets/index-abc123.js:1:2345)',
      '    at Emitter._deliver (C:\\Users\\dev\\kangentic\\node_modules\\monaco-editor\\esm\\vs\\base\\common\\event.js:978:22)',
      '    at http://localhost:5173/node_modules/.vite/deps/monaco-editor.js?v=9f8e7d6c:120:7',
      '    at async Promise.all (index 0)',
    ].join('\n');

    expect(toCallSiteFrames(stack)).toEqual([
      'createHandler (index-abc123.js:1:2345)',
      'Emitter._deliver (event.js:978:22)',
      'monaco-editor.js:120:7',
      'async Promise.all (index 0)',
    ]);
    expect(toCallSiteFrames(stack).join('\n')).not.toContain('Users');
  });

  it('leaks no fragment of a home directory whose name has a space, raw or percent-encoded', () => {
    const stack = [
      'Error',
      '    at scrollTo (file:///C:/Users/dev user/AppData/Local/kangentic/app.asar/assets/index-abc123.js:1:2345)',
      '    at scrollTo (file:///C:/Users/dev%20user/AppData/Local/kangentic/app.asar/assets/index-abc123.js:1:2345)',
      '    at /home/dev user/kangentic/assets/index-abc123.js:7:8',
      '    at eval (eval at run (file:///C:/Users/dev user/x/index-abc123.js:3:4), <anonymous>:1:1)',
    ].join('\n');

    const frames = toCallSiteFrames(stack);

    expect(frames.slice(0, 3)).toEqual([
      'scrollTo (index-abc123.js:1:2345)',
      'scrollTo (index-abc123.js:1:2345)',
      'index-abc123.js:7:8',
    ]);
    for (const frame of frames) {
      expect(frame).not.toContain('Users');
      expect(frame).not.toContain('home');
      expect(frame).not.toMatch(/\bdev\b/);
      expect(frame).not.toContain('user');
    }
  });

  it('reduces a real-shape V8 stack to function names and file basenames', () => {
    const stack = [
      `Error: ${LINE_NUMBER_MESSAGE}`,
      '    at new Foo (file:///C:/Users/dev/AppData/Local/kangentic/app.asar/assets/index-abc.js:10:5)',
      '    at async scrollAll (file:///C:/Users/dev/AppData/Local/kangentic/app.asar/assets/index-abc.js:1:2)',
      '    at Object.<anonymous> (/home/dev/kangentic/lib/main.js:5:6)',
      '    at Array.map (<anonymous>)',
      '    at <anonymous>',
      '    at tick (http://localhost:5173/src/renderer/app.js?v=abc123:12:3)',
      '    at http://localhost:5173/src/renderer/app.js?v=abc123:12:3',
    ].join('\n');

    // The leading "Error: ..." line is not a frame and is dropped.
    expect(toCallSiteFrames(stack)).toEqual([
      'new Foo (index-abc.js:10:5)',
      'async scrollAll (index-abc.js:1:2)',
      'Object.<anonymous> (main.js:5:6)',
      'Array.map (<anonymous>)',
      '<anonymous>',
      'tick (app.js:12:3)',
      'app.js:12:3',
    ]);
  });

  it('keeps a directory out of an eval frame, whose location nests a second group', () => {
    const frames = toCallSiteFrames(
      ['Error', '    at eval (eval at run (file:///C:/Users/dev/x/index-abc.js:3:4), <anonymous>:1:1)'].join('\n'),
    );

    // Only the innermost path is cut; the "eval at run" origin stays readable.
    expect(frames).toEqual(['eval (eval at run (index-abc.js:3:4), <anonymous>:1:1)']);
  });

  it('cuts a path whose directories hold parentheses, balanced or not', () => {
    const frames = toCallSiteFrames(
      [
        'Error',
        '    at scrollTo (C:\\Program Files (x86)\\kangentic\\index-abc.js:1:2)',
        '    at eval (eval at run (C:\\Users\\dev (work)\\x\\index-abc.js:3:4), <anonymous>:1:1)',
        '    at scrollTo (C:\\Users\\dev(\\index-abc.js:5:6)',
      ].join('\n'),
    );

    expect(frames[0]).toBe('scrollTo (index-abc.js:1:2)');
    expect(frames[1]).toBe('eval (eval at run (index-abc.js:3:4), <anonymous>:1:1)');
    // An unbalanced paren defeats the parse; the separator check still cuts the frame.
    expect(frames[2]).toBe('index-abc.js:5:6)');
    for (const frame of frames) {
      expect(frame).not.toMatch(/[\\/]/);
      expect(frame).not.toMatch(/\bdev\b|Users|Program Files/);
    }
  });

  it('cuts the path in a doubly nested eval frame', () => {
    const frames = toCallSiteFrames(
      [
        'Error',
        '    at eval (eval at outer (eval at inner (file:///C:/Users/dev user/x/index-abc.js:3:4), <anonymous>:2:2), <anonymous>:1:1)',
      ].join('\n'),
    );

    expect(frames).toEqual(['eval (eval at outer (eval at inner (index-abc.js:3:4), <anonymous>:2:2), <anonymous>:1:1)']);
  });

  it('returns no frames for a missing stack', () => {
    expect(toCallSiteFrames(undefined)).toEqual([]);
  });

  it('raises the stack limit for the capture and restores it afterwards', () => {
    const previousLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 3;
    try {
      const nest = (depth: number): string[] => (depth === 0 ? captureCallSiteFrames() : nest(depth - 1));
      // Deeper than the limit in force, so a capture under that limit would be cut to 3.
      expect(nest(20).length).toBeGreaterThan(20);
      expect(Error.stackTraceLimit).toBe(3);
    } finally {
      Error.stackTraceLimit = previousLimit;
    }
  });
});

describe('the real monaco route: Emitter._deliver catches the throw and calls the funnel', () => {
  it('reports a throwing listener once and leaves no rethrow timer, while an unrelated throw still rethrows', async () => {
    const { errorHandler } = await import('monaco-editor/base/common/errors');
    const { Emitter } = await import('monaco-editor/base/common/event');
    const monacoDefault = errorHandler.unexpectedErrorHandler;
    errorHandler.unexpectedErrorHandler = createMonacoUnexpectedErrorHandler({
      defaultHandler: monacoDefault,
      reportHandled: reportHandledRendererError,
    });
    vi.useFakeTimers();
    try {
      register(() => SNAPSHOT);
      const emitter = new Emitter<number>();
      let thrownError: Error = new Error(LINE_NUMBER_MESSAGE);
      const subscription = emitter.event(() => {
        throw thrownError;
      });

      // The listener's throw is caught inside fire(); nothing escapes it.
      expect(() => emitter.fire(1)).not.toThrow();
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
      expect(mocks.captureException.mock.calls[0][0]).toBe(thrownError);
      // monaco's default would have armed its rethrow timer here.
      expect(vi.getTimerCount()).toBe(0);

      thrownError = new Error('an unrelated monaco bug');
      emitter.fire(2);
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      expect(() => vi.runAllTimers()).toThrow(/an unrelated monaco bug/);

      subscription.dispose();
      emitter.dispose();
    } finally {
      errorHandler.unexpectedErrorHandler = monacoDefault;
    }
  });
});
