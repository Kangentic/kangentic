import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const setTagSpy = vi.fn();
  return {
    electronMock: { app: { isPackaged: true } },
    setTagSpy,
    sentryMock: {
      init: vi.fn(),
      setUser: vi.fn(),
      captureException: vi.fn(),
      withScope: vi.fn(
        (callback: (scope: { setTag: (key: string, value: string) => void }) => void) => {
          callback({ setTag: setTagSpy });
        }
      ),
    },
  };
});

vi.mock('electron', () => ({ app: mocks.electronMock.app }));
vi.mock('@sentry/electron/main', () => mocks.sentryMock);

import { resolveErrorReportingEnabled } from '../../src/main/analytics/error-reporting';

describe('resolveErrorReportingEnabled', () => {
  it('KANGENTIC_TELEMETRY=0/false is the superset kill switch: disables Sentry regardless of the error-reporting switch', () => {
    expect(resolveErrorReportingEnabled('0', undefined, true)).toBe(false);
    expect(resolveErrorReportingEnabled('false', undefined, true)).toBe(false);
    expect(resolveErrorReportingEnabled('0', '1', true)).toBe(false);
    expect(resolveErrorReportingEnabled('false', 'true', true)).toBe(false);
  });

  it('KANGENTIC_ERROR_REPORTING=0/false disables Sentry alone', () => {
    expect(resolveErrorReportingEnabled(undefined, '0', true)).toBe(false);
    expect(resolveErrorReportingEnabled(undefined, 'false', true)).toBe(false);
    expect(resolveErrorReportingEnabled('1', '0', true)).toBe(false);
  });

  it('KANGENTIC_ERROR_REPORTING=1/true force-enables (dev), unless the superset switch is off', () => {
    expect(resolveErrorReportingEnabled(undefined, '1', false)).toBe(true);
    expect(resolveErrorReportingEnabled(undefined, 'true', false)).toBe(true);
    expect(resolveErrorReportingEnabled('0', '1', false)).toBe(false);
  });

  it('unset inherits the analytics default: telemetry force-on wins, else packaged only', () => {
    expect(resolveErrorReportingEnabled('1', undefined, false)).toBe(true);
    expect(resolveErrorReportingEnabled('true', undefined, false)).toBe(true);
    expect(resolveErrorReportingEnabled(undefined, undefined, true)).toBe(true);
    expect(resolveErrorReportingEnabled(undefined, undefined, false)).toBe(false);
  });
});

/**
 * `active` (the opt-out promise gate) is module-scoped with no exported
 * reset helper, unlike usage.ts's resetUsageAnalyticsForTests(). Isolating
 * it between cases needs vi.resetModules() + a dynamic re-import per case,
 * the same pattern tests/unit/announcements-init-guard.test.ts uses for its
 * own module-scoped state. The hoisted `mocks.sentryMock` fn instances are
 * stable across resets (same object reference returned by the mock
 * factory), so call history is inspected via those, cleared per test below.
 */
async function importFreshErrorReporting() {
  vi.resetModules();
  return import('../../src/main/analytics/error-reporting');
}

describe('error reporting runtime behavior (module-state gated)', () => {
  const originalTelemetry = process.env.KANGENTIC_TELEMETRY;
  const originalErrorReporting = process.env.KANGENTIC_ERROR_REPORTING;

  beforeEach(() => {
    mocks.sentryMock.init.mockClear();
    mocks.sentryMock.setUser.mockClear();
    mocks.sentryMock.captureException.mockClear();
    mocks.sentryMock.withScope.mockClear();
    mocks.setTagSpy.mockClear();
    mocks.electronMock.app.isPackaged = true;
    delete process.env.KANGENTIC_TELEMETRY;
    // Force the switch ON regardless of packaged state, so initErrorReporting
    // actually activates in every case below unless a test deliberately
    // skips calling it.
    process.env.KANGENTIC_ERROR_REPORTING = '1';
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.KANGENTIC_TELEMETRY;
    else process.env.KANGENTIC_TELEMETRY = originalTelemetry;
    if (originalErrorReporting === undefined) delete process.env.KANGENTIC_ERROR_REPORTING;
    else process.env.KANGENTIC_ERROR_REPORTING = originalErrorReporting;
  });

  describe('reportHandledError', () => {
    it('forwards to Sentry.withScope/captureException and sets each provided tag once initErrorReporting ran with the switch ON', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      const error = new Error('spawn failed');
      errorReporting.reportHandledError(error, { source: 'pty', component: 'spawn' });

      expect(mocks.sentryMock.withScope).toHaveBeenCalledTimes(1);
      expect(mocks.sentryMock.captureException).toHaveBeenCalledTimes(1);
      expect(mocks.sentryMock.captureException).toHaveBeenCalledWith(error);
      expect(mocks.setTagSpy).toHaveBeenCalledWith('source', 'pty');
      expect(mocks.setTagSpy).toHaveBeenCalledWith('component', 'spawn');
    });

    it('makes ZERO Sentry calls when the module was never initialized (the opt-out promise gate)', async () => {
      const errorReporting = await importFreshErrorReporting();
      // Deliberately do NOT call initErrorReporting() - this is the
      // fresh-module, never-activated state a fully opted-out install stays
      // in for its whole run.
      errorReporting.reportHandledError(new Error('spawn failed'), { source: 'pty' });

      expect(mocks.sentryMock.withScope).not.toHaveBeenCalled();
      expect(mocks.sentryMock.captureException).not.toHaveBeenCalled();
      expect(mocks.setTagSpy).not.toHaveBeenCalled();
    });
  });

  describe('initErrorReporting respects the switch (the state a real opted-out user is actually in)', () => {
    // index.ts always calls initErrorReporting() unconditionally at startup;
    // an opted-out user's real runtime state is "init WAS called, the switch
    // resolved OFF, initErrorReporting bails before touching Sentry.init".
    // That is a different code path than "init was never called" above, and
    // it is the one production actually exercises for an opted-out install.
    it('does not call Sentry.init, active stays false, and reportHandledError stays inert when the superset kill switch is OFF - even in a packaged build', async () => {
      mocks.electronMock.app.isPackaged = true;
      process.env.KANGENTIC_TELEMETRY = '0';

      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      expect(mocks.sentryMock.init).not.toHaveBeenCalled();
      expect(errorReporting.isErrorReportingActive()).toBe(false);

      errorReporting.reportHandledError(new Error('spawn failed'), { source: 'pty' });
      expect(mocks.sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('does not call Sentry.init when KANGENTIC_ERROR_REPORTING alone is OFF', async () => {
      process.env.KANGENTIC_ERROR_REPORTING = '0';

      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      expect(mocks.sentryMock.init).not.toHaveBeenCalled();
      expect(errorReporting.isErrorReportingActive()).toBe(false);
    });
  });

  describe('setErrorReportingUser', () => {
    it('calls Sentry.setUser({ id }) only when active', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();
      errorReporting.setErrorReportingUser('client-abc-123');

      expect(mocks.sentryMock.setUser).toHaveBeenCalledTimes(1);
      expect(mocks.sentryMock.setUser).toHaveBeenCalledWith({ id: 'client-abc-123' });
    });

    it('makes no call when the module was never initialized', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.setErrorReportingUser('client-abc-123');

      expect(mocks.sentryMock.setUser).not.toHaveBeenCalled();
    });
  });

  describe('initErrorReporting Sentry.init option shape', () => {
    it('passes sendDefaultPii: false, filters MainProcessSession out of integrations while keeping others, and ignores the known-benign write errors', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      expect(mocks.sentryMock.init).toHaveBeenCalledTimes(1);
      const options = mocks.sentryMock.init.mock.calls[0][0] as {
        sendDefaultPii: boolean;
        integrations: (defaultIntegrations: Array<{ name: string }>) => Array<{ name: string }>;
        ignoreErrors: string[];
      };

      expect(options.sendDefaultPii).toBe(false);
      expect(options.ignoreErrors).toContain('write EAGAIN');
      expect(options.ignoreErrors).toContain('write EPIPE');

      const syntheticDefaultIntegrations = [
        { name: 'MainProcessSession' },
        { name: 'Console' },
        { name: 'FunctionToString' },
      ];
      const filtered = options.integrations(syntheticDefaultIntegrations);
      expect(filtered.map((integration) => integration.name)).toEqual([
        'Console',
        'FunctionToString',
      ]);
    });
  });
});
