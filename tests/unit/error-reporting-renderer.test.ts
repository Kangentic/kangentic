/**
 * Unit coverage for the renderer half of Sentry error reporting
 * (src/renderer/error-reporting.ts). This project's vitest config has no
 * jsdom environment (see tests/unit/panel-error-boundary.test.ts's header
 * for the established rationale), so `window` is stubbed directly via
 * vi.stubGlobal - the same pattern that file uses for window.electronAPI.
 *
 * Neither function under test caches module-level state: each call reads
 * window.electronAPI fresh, so unlike error-reporting-switch.test.ts's
 * main-process counterpart, no vi.resetModules() dance is needed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: mocks.init,
  captureException: mocks.captureException,
  setTag: mocks.setTag,
}));

import { componentNamesOf, initRendererErrorReporting, reportCaughtRenderError, reportHandledRendererError } from '../../src/renderer/error-reporting';
import { reportRendererFailure, resetRendererFailureReports, setRendererFailureSink } from '../../src/renderer/utils/renderer-failure';
import { filterBreadcrumb } from '../../src/shared/sentry-breadcrumbs';

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');

function rendererSourceFiles(directory: string = RENDERER_ROOT): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...rendererSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name)) found.push(fullPath);
  }
  return found;
}

interface StampedEvent { tags?: Record<string, string> }

/** Run `event` through the `beforeSend` the last init was handed. */
function stampedByBeforeSend(event: StampedEvent): StampedEvent {
  const options = mocks.init.mock.calls.at(-1)?.[0] as { beforeSend: (event: StampedEvent) => StampedEvent };
  return options.beforeSend(event);
}

describe('initRendererErrorReporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.init.mockClear();
    mocks.setTag.mockClear();
  });

  it('calls @sentry/electron/renderer init() when electronAPI.analytics.errorReportingEnabled is true', () => {
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } } });

    initRendererErrorReporting();

    expect(mocks.init).toHaveBeenCalledTimes(1);
  });

  it('passes the shared breadcrumb policy, since main never filters renderer crumbs', () => {
    // Main adds forwarded renderer crumbs with scope.addBreadcrumb, which skips
    // main's beforeBreadcrumb, so this is the only place they are filtered.
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } } });

    initRendererErrorReporting();

    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({ beforeBreadcrumb: filterBreadcrumb }));
  });

  it('turns every dataCollection field off, since the browser client decides IP inference itself', () => {
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } } });

    initRendererErrorReporting();

    // Exactly these three options, and every field spelled out: Sentry 8
    // collects any dataCollection field left out.
    expect(mocks.init).toHaveBeenCalledWith({
      beforeBreadcrumb: filterBreadcrumb,
      beforeSend: expect.any(Function),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      },
    });
  });

  // A pop-out is its own renderer with its own stores, so an event that cannot
  // say which window sent it reads like a main-window bug.
  it.each([
    ['the main window', { analytics: { errorReportingEnabled: true } }, 'main'],
    ['a stats pop-out', { analytics: { errorReportingEnabled: true }, popOut: { descriptor: { kind: 'stats', params: {} } } }, 'stats'],
    ['a pop-out whose kind is not one', { analytics: { errorReportingEnabled: true }, popOut: { descriptor: { kind: 'Fix Acme billing', params: {} } } }, 'main'],
  ])('tags every event from %s with its window kind', (_label, electronAPI, expected) => {
    vi.stubGlobal('window', { electronAPI, location: { hash: '' } });

    initRendererErrorReporting();

    // An event that carries tags of its own keeps them, and one with none gets the tag.
    expect(stampedByBeforeSend({ tags: { source: 'renderer' } }).tags).toEqual({ source: 'renderer', window_kind: expected });
    expect(stampedByBeforeSend({}).tags).toEqual({ window_kind: expected });
  });

  // The SDK copies a renderer's scope into main's, so a tag set on the scope here
  // rode every main-process event as whichever window started last (seen on a
  // real `ipc_handler` event). The tag goes on the event, and nothing in the
  // renderer touches the scope.
  it('never sets the window kind, or anything else, on the scope', () => {
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } }, location: { hash: '' } });

    initRendererErrorReporting();

    expect(mocks.setTag).not.toHaveBeenCalled();
    const scopeWrites = rendererSourceFiles()
      .filter((file) => /\b(?:setTags?|setContext|setExtras?|setUser)\(|getCurrentScope|withScope\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(RENDERER_ROOT, file));
    expect(scopeWrites, 'A renderer scope write reaches every main-process event. Stamp the event in beforeSend.').toEqual([]);
  });

  it('still registers the failure sink when the window kind cannot be read', () => {
    // No `location` on this stub, so the descriptor read throws.
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } } });
    setRendererFailureSink(null);
    resetRendererFailureReports();

    initRendererErrorReporting();

    expect(stampedByBeforeSend({}).tags).toEqual({ window_kind: 'unknown' });
    expect(reportRendererFailure('board', 'load', new TypeError('defect'))).toBe(true);
    setRendererFailureSink(null);
    resetRendererFailureReports();
    mocks.captureException.mockReset();
  });

  it('does not call init() when errorReportingEnabled is false', () => {
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: false } } });

    initRendererErrorReporting();

    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.setTag).not.toHaveBeenCalled();
  });

  it('does not call init() when window.electronAPI is entirely absent', () => {
    vi.stubGlobal('window', {});

    initRendererErrorReporting();

    expect(mocks.init).not.toHaveBeenCalled();
  });
});

describe('reportCaughtRenderError (the root onCaughtError)', () => {
  afterEach(() => {
    mocks.captureException.mockReset();
  });

  it('sends a path-free copy tagged with the boundary that caught it and its component stack', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'title') for Fix Acme billing");
    const panelBoundary = { boundaryReportTags: () => ({ boundary: 'panel' as const, panel: 'agent monitor' }) };

    // A packaged build's component stack names files under the user's home folder.
    const componentStack = [
      '',
      '    at MonitorBody (file:///C:/Users/dev/AppData/Local/Programs/Kangentic/resources/app.asar/.vite/renderer/main_window/assets/index.js:12:345)',
      '    at div (<anonymous>)',
      '    at PanelErrorBoundary (file:///C:/Users/dev/AppData/Local/Programs/Kangentic/resources/app.asar/.vite/renderer/main_window/assets/index.js:9:87)',
    ].join('\n');
    reportCaughtRenderError(error, { componentStack, errorBoundary: panelBoundary });

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [sent, context] = mocks.captureException.mock.calls[0] as [Error, { tags: Record<string, string>; contexts: Record<string, Record<string, unknown>> }];
    expect(sent.message).toBe('Handled render failure: TypeError');
    expect(context.tags).toEqual({ boundary: 'panel', panel: 'agent monitor', source: 'react_boundary', error_name: 'TypeError' });
    // Names only: no URL, no path, no line number.
    expect(context.contexts.react).toEqual({ componentStack: 'MonitorBody\ndiv\nPanelErrorBoundary' });
    expect(sent.stack).not.toContain('Acme');
    // The boundary sends the component names and nothing else: no error text rides along in contexts.
    expect(Object.keys(context.contexts)).toEqual(['react']);
    expect(JSON.stringify(mocks.captureException.mock.calls[0])).not.toContain('Acme');
  });

  it('tags an unknown boundary when React hands over none', () => {
    reportCaughtRenderError(new Error('x'), {});
    expect((mocks.captureException.mock.calls[0][1] as { tags: Record<string, string> }).tags.boundary).toBe('unknown');
  });

  it('never throws even when captureException itself throws', () => {
    mocks.captureException.mockImplementation(() => {
      throw new Error('sentry transport exploded');
    });

    expect(() => reportCaughtRenderError(new Error('boundary caught this'), {})).not.toThrow();
  });
});

describe('componentNamesOf', () => {
  it('keeps the name of "at Foo (location)" and drops a line whose name is not an identifier', () => {
    const stack = [
      '',
      '    at Foo (file:///C:/Users/dev/app/index.js:1:2)',
      '    at <anonymous>',
      '    at (http://localhost/x.js:1:2)',
      '    at Bar.Inner (http://localhost/y.js:3:4)',
    ].join('\n');
    expect(componentNamesOf(stack)).toBe('Foo\nBar.Inner');
  });

  it('cuts the result to 4000 characters', () => {
    const stack = Array.from({ length: 1000 }, (_, index) => `    at Component${index} (x.js:1:1)`).join('\n');
    const result = componentNamesOf(stack);
    expect(result.length).toBe(4000);
    expect(result.startsWith('Component0\nComponent1\n')).toBe(true);
  });
});

describe('reportRendererFailure', () => {
  beforeEach(() => {
    setRendererFailureSink(reportHandledRendererError);
  });

  afterEach(() => {
    mocks.captureException.mockReset();
    resetRendererFailureReports();
    vi.unstubAllGlobals();
  });

  it('sends nothing until error reporting registers its sink, and through it after', () => {
    setRendererFailureSink(null);
    expect(reportRendererFailure('board', 'load', new TypeError('x'))).toBe(false);
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: true } } });
    initRendererErrorReporting();
    expect(reportRendererFailure('board', 'load', new TypeError('x'))).toBe(true);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    resetRendererFailureReports();
  });

  it('reports once per area, op and error class, fingerprinted on them', () => {
    expect(reportRendererFailure('board', 'load', new RangeError('Invalid time value'))).toBe(true);
    expect(reportRendererFailure('board', 'load', new RangeError('Invalid time value'))).toBe(false);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [sent, context] = mocks.captureException.mock.calls[0] as [Error, { tags: Record<string, string>; fingerprint: string[] }];
    expect(sent.message).toBe('Handled board_load failure: RangeError');
    expect(context.tags).toEqual({ source: 'renderer', area: 'board', op: 'load', error_name: 'RangeError' });
    expect(context.fingerprint).toEqual(['renderer', 'board', 'load', 'RangeError']);
  });

  it('skips a rejected IPC call, which main reported, an abort and the network', () => {
    expect(reportRendererFailure('board', 'load', new Error("Error invoking remote method 'board:get': TypeError: x"))).toBe(false);
    expect(reportRendererFailure('board', 'load', new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(reportRendererFailure('board', 'load', new TypeError('Failed to fetch'))).toBe(false);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('stops at 25 distinct operations', () => {
    let sent = 0;
    for (let index = 0; index < 26; index += 1) {
      // `as const`: the reporter takes only words the compiler can see, never a plain string.
      if (reportRendererFailure('board', `op${index}` as const, new RangeError('x'))) sent += 1;
    }
    expect(sent).toBe(25);
    expect(mocks.captureException).toHaveBeenCalledTimes(25);
  });

  it('skips a TypeError for a NetworkError or Load failed, and an error named AbortError', () => {
    expect(reportRendererFailure('board', 'a', new TypeError('NetworkError when attempting to fetch resource.'))).toBe(false);
    expect(reportRendererFailure('board', 'b', new TypeError('Load failed'))).toBe(false);
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(reportRendererFailure('board', 'c', aborted)).toBe(false);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  // The app's chunks are files in its own package, so one that will not load is
  // a broken build or install. Chromium words it like a network failure.
  it('reports a lazy chunk that did not load, which opens with the network words', () => {
    const missingChunk = new TypeError('Failed to fetch dynamically imported module: file:///C:/Users/dev/app/assets/markdown-pipeline.js');
    expect(reportRendererFailure('markdown', 'pipeline_load', missingChunk)).toBe(true);
    const [sent] = mocks.captureException.mock.calls[0] as [Error];
    expect(sent.message).toBe('Handled markdown_pipeline_load failure: TypeError');
    // The chunk's address, which holds the install path, stays out of the copy.
    expect(`${sent.message}\n${sent.stack ?? ''}`).not.toContain('markdown-pipeline.js');
  });

  it('skips a refusal the renderer raised itself', () => {
    const refusal = new Error('No project is currently open');
    refusal.name = 'RefusalError';
    const configuration = new Error('The base branch is not set');
    configuration.name = 'UserConfigurationError';
    expect(reportRendererFailure('command_terminal', 'branch_switch', refusal)).toBe(false);
    expect(reportRendererFailure('command_terminal', 'spawn', configuration)).toBe(false);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('hands the sink only the caller contexts, never the error message', () => {
    const sink = vi.fn();
    setRendererFailureSink(sink);
    const error = new TypeError("Cannot read properties of undefined (reading 'Fix Acme billing')");

    expect(reportRendererFailure('board', 'load', error)).toBe(true);
    expect(reportRendererFailure('board', 'save', error, { stage: 'write' })).toBe(true);

    expect(sink.mock.calls[0][2]).toEqual({});
    expect(sink.mock.calls[1][2]).toEqual({ stage: 'write' });
    expect(JSON.stringify(sink.mock.calls.map(([sent, tags, contexts, fingerprint]) => [sent.message, sent.stack, tags, contexts, fingerprint])))
      .not.toContain('Acme');
  });

  it('still reports a rejection that never reached a handler, which main cannot see', () => {
    const skew = new Error("Error invoking remote method 'new:channel': Error: No handler registered for 'new:channel'");
    expect(reportRendererFailure('board', 'load', skew)).toBe(true);
  });
});
