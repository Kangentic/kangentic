import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const setTagSpy = vi.fn();
  const setContextSpy = vi.fn();
  const trackEventSpy = vi.fn();
  // The mocked install must be native to the HOST, not always Windows.
  // resolveNativeCrashContext derives the install root with node:path, so on
  // CI's Linux runner path.dirname of a backslash path returns '.', every one
  // of our own images then fails the ownership check, and a real crash is
  // dropped. That is green on Windows and red on CI.
  const executablePath =
    process.platform === 'win32'
      ? 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\Kangentic.exe'
      : process.platform === 'darwin'
        ? '/Applications/Kangentic.app/Contents/MacOS/Kangentic'
        : '/opt/Kangentic/kangentic';
  const userDataPath =
    process.platform === 'win32' ? 'C:\\Users\\dev\\AppData\\Roaming\\kangentic' : '/home/dev/.config/kangentic';
  return {
    electronMock: {
      app: {
        isPackaged: true,
        // beforeSend resolves the install root and the reporting build from
        // these, but only once an event actually carries a minidump.
        getPath: (name: string) => (name === 'exe' ? executablePath : userDataPath),
        getVersion: () => '0.39.0',
      },
    },
    setTagSpy,
    setContextSpy,
    trackEventSpy,
    sentryMock: {
      init: vi.fn(),
      setUser: vi.fn(),
      captureException: vi.fn(),
      withScope: vi.fn(
        (
          callback: (scope: {
            setTag: (key: string, value: string) => void;
            setContext: (name: string, value: Record<string, unknown>) => void;
          }) => void
        ) => {
          callback({ setTag: setTagSpy, setContext: setContextSpy });
        }
      ),
    },
  };
});

vi.mock('electron', () => ({ app: mocks.electronMock.app }));
vi.mock('@sentry/electron/main', () => mocks.sentryMock);
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mocks.trackEventSpy }));

import { resolveErrorReportingEnabled } from '../../src/main/analytics/error-reporting';
import {
  buildMinidump,
  FFPROBE_MODULES,
  LINUX_APP_MODULES,
  MACOS_APP_MODULES,
  WINDOWS_APP_MODULES,
} from '../fixtures/minidump-fixture';

/** The image list of one of our own crashes, on whichever host runs the suite. */
const OUR_APP_MODULES =
  process.platform === 'win32'
    ? WINDOWS_APP_MODULES
    : process.platform === 'darwin'
      ? MACOS_APP_MODULES
      : LINUX_APP_MODULES;

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
      // No context was given, so none is set: the SDK would otherwise show an
      // empty block on every handled error.
      expect(mocks.setContextSpy).not.toHaveBeenCalled();
    });

    it('sets each provided context on the scope alongside the tags (content goes in a context, never a tag)', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      const error = new Error('kangentic-embeddings worker exited repeatedly (exit code 1)');
      errorReporting.reportHandledError(
        error,
        { source: 'utility_process' },
        { utility_process: { exitCode: 1, stderrTail: "Error: Cannot find module 'sharp'" } }
      );

      expect(mocks.sentryMock.captureException).toHaveBeenCalledWith(error);
      expect(mocks.setTagSpy).toHaveBeenCalledWith('source', 'utility_process');
      expect(mocks.setTagSpy).toHaveBeenCalledTimes(1);
      expect(mocks.setContextSpy).toHaveBeenCalledWith('utility_process', {
        exitCode: 1,
        stderrTail: "Error: Cannot find module 'sharp'",
      });
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

    it('drops a UserConfigurationError even when fully active', async () => {
      // A missing agent CLI is the user's environment, not a defect we can ship
      // a fix for, so it is surfaced in-app and counted in Aptabase instead of
      // becoming an un-actionable issue. The exclusion lives inside
      // reportHandledError so every catch site inherits it.
      // Import the error class AFTER importFreshErrorReporting, never before:
      // that helper calls vi.resetModules(), so a class imported first comes
      // from the discarded registry and `instanceof` fails against the copy
      // error-reporting.ts actually holds. Production bundles main into one
      // file, so there is only ever one class there.
      const errorReporting = await importFreshErrorReporting();
      const { UserConfigurationError } = await import(
        '../../src/shared/user-configuration-error'
      );
      errorReporting.initErrorReporting();

      errorReporting.reportHandledError(
        new UserConfigurationError('Codex CLI not found on PATH.'),
        { source: 'spawn', reason: 'resume' },
      );

      expect(mocks.sentryMock.captureException).not.toHaveBeenCalled();
      expect(mocks.setTagSpy).not.toHaveBeenCalled();
    });

    it('drops an AgentCliNotFoundError, the concrete case this exclusion exists for', async () => {
      const errorReporting = await importFreshErrorReporting();
      const { AgentCliNotFoundError } = await import(
        '../../src/main/agent/shared/agent-cli-not-found'
      );
      errorReporting.initErrorReporting();

      errorReporting.reportHandledError(new AgentCliNotFoundError('codex', 'Codex CLI'), {
        source: 'spawn',
        reason: 'resume',
      });

      expect(mocks.sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('still forwards an ordinary spawn failure, so the exclusion is not a blanket mute', async () => {
      // The passthrough half: a genuine engine failure on the same code path
      // must keep reporting. Without this, a broadened predicate would silently
      // blind the whole spawn surface.
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      const error = new Error('worktree is locked');
      errorReporting.reportHandledError(error, { source: 'spawn', reason: 'resume' });

      expect(mocks.sentryMock.captureException).toHaveBeenCalledTimes(1);
      expect(mocks.sentryMock.captureException).toHaveBeenCalledWith(error);
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
        ignoreErrors: Array<string | RegExp>;
      };

      expect(options.sendDefaultPii).toBe(false);
      expect(options.ignoreErrors).toContain('write EAGAIN');
      expect(options.ignoreErrors).toContain('write EPIPE');

      const matches = (message: string) =>
        options.ignoreErrors.some((pattern) =>
          typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message),
        );

      // The SDK's childProcessIntegration reports every utility-process exit
      // with only the process TYPE, so the event can never say WHICH process
      // died (serviceName/exitCode land in a breadcrumb added after capture).
      // Our own two workers report themselves from their exit handlers instead.
      expect(matches("'Utility' process exited with 'abnormal-exit'")).toBe(true);
      // Scoped to utility processes: renderer crashes come through the SAME
      // integration and array, and must keep reporting.
      expect(matches("'renderer' process exited with 'crashed'")).toBe(false);

      // The benign-renderer-error registry is spread in, so a pattern added
      // there is filtered here too. The monaco funnel normally swallows these
      // first; this is the backstop for anything that escapes it.
      expect(matches('ruby: trying to pop an empty stack in rule: (unknown)')).toBe(true);
      // Monaco re-throws as `message + '\n\n' + stack`, so the patterns must
      // match a message that carries a stack suffix.
      expect(
        matches('ruby: trying to pop an empty stack in rule: (unknown)\n\n    at kw.tokenizeHeuristically'),
      ).toBe(true);
      expect(matches('TypeError: cannot read properties of undefined')).toBe(false);

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

  /**
   * The native crash class cannot go in ignoreErrors: that matcher reads an
   * event's message and exception value, and a minidump event has neither. What
   * says whether the crash was even ours is in the attached dump, so it is
   * filtered in beforeSend instead. These cases pin the wiring; the decision
   * itself is covered in tests/unit/native-crash-event.test.ts.
   */
  describe('beforeSend, for native crash events', () => {
    type BeforeSend = (
      event: Record<string, unknown>,
      hint: Record<string, unknown>
    ) => Record<string, unknown> | null;

    async function initAndGetBeforeSend(): Promise<BeforeSend> {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();
      const options = mocks.sentryMock.init.mock.calls[0][0] as { beforeSend: BeforeSend };
      expect(typeof options.beforeSend).toBe('function');
      return options.beforeSend;
    }

    function minidumpHint(modules: string[], annotations: Record<string, string> = {}) {
      return {
        attachments: [
          {
            attachmentType: 'event.minidump',
            filename: 'crash.dmp',
            data: buildMinidump({ modules, simpleAnnotations: annotations }),
          },
        ],
      };
    }

    beforeEach(() => {
      mocks.trackEventSpy.mockClear();
    });

    it('drops a crash in a process that merely inherited our crash handler, and counts it', async () => {
      const beforeSend = await initAndGetBeforeSend();

      const result = beforeSend(
        { platform: 'native', release: 'Kangentic@0.39.0' },
        minidumpHint(FFPROBE_MODULES)
      );

      expect(result).toBeNull();
      expect(mocks.trackEventSpy).toHaveBeenCalledWith('foreign_minidump_dropped', {
        module: 'ffprobe',
      });
    });

    it('keeps our own crash and reattributes it to the build that actually crashed', async () => {
      const beforeSend = await initAndGetBeforeSend();

      const result = beforeSend(
        { platform: 'native', release: 'Kangentic@0.39.0', breadcrumbs: [{ message: 'later run' }] },
        minidumpHint(OUR_APP_MODULES, { _version: '0.38.0' })
      );

      expect(result).not.toBeNull();
      expect(result?.release).toBe('Kangentic@0.38.0');
      expect(result?.breadcrumbs).toBeUndefined();
      expect(mocks.trackEventSpy).not.toHaveBeenCalled();
    });

    it('leaves a live-reported error alone: it carries no minidump', async () => {
      const beforeSend = await initAndGetBeforeSend();
      const liveError = {
        release: 'Kangentic@0.39.0',
        breadcrumbs: [{ message: 'the crashed session own trail' }],
        exception: { values: [{ type: 'TypeError', value: 'boom' }] },
      };

      // DESKTOP-J's shape: mechanism generic, its own breadcrumbs, correct tag.
      expect(beforeSend(liveError, {})).toBe(liveError);
      expect(liveError.breadcrumbs).toHaveLength(1);
      expect(mocks.trackEventSpy).not.toHaveBeenCalled();
    });

    it('keeps the event when the dump cannot be read, so a parser fault cannot delete the stream', async () => {
      const beforeSend = await initAndGetBeforeSend();
      const event = { platform: 'native', release: 'Kangentic@0.39.0' };

      const result = beforeSend(event, {
        attachments: [
          { attachmentType: 'event.minidump', filename: 'crash.dmp', data: Buffer.alloc(20000, 0x5a) },
        ],
      });

      expect(result).toBe(event);
      expect(mocks.trackEventSpy).not.toHaveBeenCalled();
    });

    it('finds the minidump among several attachments, including one that carries no attachmentType at all', async () => {
      // Sentry's other attachment kinds (view-hierarchy, screenshots) do not
      // all carry an attachmentType, and the minidump is not always first in
      // the array. This pins the .find() picking the RIGHT one by type, not
      // by position or by "has Uint8Array data".
      const beforeSend = await initAndGetBeforeSend();

      const result = beforeSend(
        { platform: 'native', release: 'Kangentic@0.39.0' },
        {
          attachments: [
            { filename: 'view-hierarchy.json', data: new Uint8Array([1, 2, 3]) },
            { attachmentType: 'event.screenshot', filename: 'screenshot.png', data: new Uint8Array([4, 5, 6]) },
            { attachmentType: 'event.minidump', filename: 'crash.dmp', data: buildMinidump({ modules: FFPROBE_MODULES }) },
          ],
        }
      );

      expect(result).toBeNull();
      expect(mocks.trackEventSpy).toHaveBeenCalledWith('foreign_minidump_dropped', {
        module: 'ffprobe',
      });
    });
  });
});
