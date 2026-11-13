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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: mocks.init,
  captureException: mocks.captureException,
}));

import { initRendererErrorReporting, reportCaughtRenderError, reportHandledRendererError } from '../../src/renderer/error-reporting';
import { reportRendererFailure, resetRendererFailureReports, setRendererFailureSink } from '../../src/renderer/utils/renderer-failure';
import { filterBreadcrumb } from '../../src/shared/sentry-breadcrumbs';

describe('initRendererErrorReporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.init.mockClear();
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

    // Exactly these two options, and every field spelled out: Sentry 8
    // collects any dataCollection field left out.
    expect(mocks.init).toHaveBeenCalledWith({
      beforeBreadcrumb: filterBreadcrumb,
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

  it('does not call init() when errorReportingEnabled is false', () => {
    vi.stubGlobal('window', { electronAPI: { analytics: { errorReportingEnabled: false } } });

    initRendererErrorReporting();

    expect(mocks.init).not.toHaveBeenCalled();
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

  it('still reports a rejection that never reached a handler, which main cannot see', () => {
    const skew = new Error("Error invoking remote method 'new:channel': Error: No handler registered for 'new:channel'");
    expect(reportRendererFailure('board', 'load', skew)).toBe(true);
  });
});
