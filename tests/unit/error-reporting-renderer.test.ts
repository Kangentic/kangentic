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
import { describe, it, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: mocks.init,
  captureException: mocks.captureException,
}));

import { initRendererErrorReporting, reportBoundaryError } from '../../src/renderer/error-reporting';

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

describe('reportBoundaryError', () => {
  afterEach(() => {
    mocks.captureException.mockReset();
  });

  it('forwards the error to Sentry.captureException', () => {
    const error = new Error('boundary caught this');

    reportBoundaryError(error);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(error);
  });

  it('never throws even when captureException itself throws', () => {
    mocks.captureException.mockImplementation(() => {
      throw new Error('sentry transport exploded');
    });

    expect(() => reportBoundaryError(new Error('boundary caught this'))).not.toThrow();
  });
});
