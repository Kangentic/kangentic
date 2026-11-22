/**
 * addRelayDialBreadcrumb (src/main/analytics/error-reporting.ts): how a relay
 * dial outcome becomes a Sentry breadcrumb. The module gates on a module-level
 * `active` flag that only initErrorReporting() sets, so each test loads a fresh
 * copy of the module (vi.resetModules) and decides whether to init it. The
 * Sentry SDK and Electron are mocked; nothing is sent anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RelayDialOutcome } from '../../src/main/mobile-bridge/transport/relay-client';

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  init: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/home/dev/.config/kangentic', getVersion: () => '0.0.0' } }));
vi.mock('@sentry/electron/main', () => ({
  init: mocks.init,
  addBreadcrumb: mocks.addBreadcrumb,
}));

type ErrorReportingModule = typeof import('../../src/main/analytics/error-reporting');

async function loadModule(): Promise<ErrorReportingModule> {
  vi.resetModules();
  return import('../../src/main/analytics/error-reporting');
}

const OPENED: RelayDialOutcome = { dialId: '0123456789abcdef', stack: 'node', outcome: 'opened' };
const FAILED: RelayDialOutcome = { dialId: 'fedcba9876543210', stack: 'chromium', outcome: 'failed' };
const TIMED_OUT: RelayDialOutcome = { dialId: 'aaaaaaaaaaaaaaaa', stack: 'node', outcome: 'timed_out' };

describe('addRelayDialBreadcrumb', () => {
  beforeEach(() => {
    mocks.addBreadcrumb.mockReset();
    mocks.init.mockReset();
    // Reporting is enabled for a packaged app unless a kill switch says otherwise.
    vi.stubEnv('KANGENTIC_TELEMETRY', undefined);
    vi.stubEnv('KANGENTIC_ERROR_REPORTING', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records nothing before error reporting is initialised', async () => {
    const { addRelayDialBreadcrumb } = await loadModule();
    addRelayDialBreadcrumb(OPENED);
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('records nothing when Sentry.init throws, so reporting never went active', async () => {
    mocks.init.mockImplementation(() => {
      throw new Error('init failed');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
    initErrorReporting();
    addRelayDialBreadcrumb(OPENED);
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('records nothing when a kill switch disables error reporting', async () => {
    vi.stubEnv('KANGENTIC_ERROR_REPORTING', '0');
    const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
    initErrorReporting();
    addRelayDialBreadcrumb(OPENED);
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
  });

  describe('once reporting is active', () => {
    it('records an opened dial at info level with exactly the three fixed fields and no message', async () => {
      const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
      initErrorReporting();
      addRelayDialBreadcrumb(OPENED);

      expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
      const crumb = mocks.addBreadcrumb.mock.calls[0][0];
      expect(crumb).toEqual({
        category: 'mobile-bridge.relay-dial',
        level: 'info',
        data: { relay_dial_id: '0123456789abcdef', stack: 'node', outcome: 'opened' },
      });
      expect(crumb).not.toHaveProperty('message');
    });

    it('records a failed dial at warning level', async () => {
      const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
      initErrorReporting();
      addRelayDialBreadcrumb(FAILED);

      expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
        category: 'mobile-bridge.relay-dial',
        level: 'warning',
        data: { relay_dial_id: 'fedcba9876543210', stack: 'chromium', outcome: 'failed' },
      });
    });

    it('records a timed-out dial at warning level', async () => {
      const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
      initErrorReporting();
      addRelayDialBreadcrumb(TIMED_OUT);

      expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
        category: 'mobile-bridge.relay-dial',
        level: 'warning',
        data: { relay_dial_id: 'aaaaaaaaaaaaaaaa', stack: 'node', outcome: 'timed_out' },
      });
    });

    it('swallows an SDK throw instead of failing the dial', async () => {
      mocks.addBreadcrumb.mockImplementation(() => {
        throw new Error('sdk failed');
      });
      const { initErrorReporting, addRelayDialBreadcrumb } = await loadModule();
      initErrorReporting();
      expect(() => addRelayDialBreadcrumb(OPENED)).not.toThrow();
      expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    });
  });
});
