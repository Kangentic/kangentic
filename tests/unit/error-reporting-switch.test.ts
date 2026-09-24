import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => {
  const setTagSpy = vi.fn();
  const setContextSpy = vi.fn();
  // The mocked install must be native to the HOST, not always Windows.
  // resolveNativeCrashContext derives the install root with node:path, so on
  // CI's Linux runner path.dirname of a backslash path returns '.', every one
  // of our own images then fails the ownership check, and a real crash is
  // misread as foreign. That is green on Windows and red on CI.
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
    sentryMock: {
      init: vi.fn(),
      setUser: vi.fn(),
      // Top-level Sentry.setContext, distinct from the scope-level setContextSpy
      // passed into withScope's callback below (used only by reportHandledError's
      // per-error contexts). setHostMemoryContext calls the top-level one.
      setContext: vi.fn(),
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

import {
  beforeSendEvent,
  resolveErrorReportingEnabled,
  SENTRY_STACK_FRAME_LIMIT,
  tagTruncatedStack,
} from '../../src/main/analytics/error-reporting';
import {
  buildMinidump,
  FFPROBE_MODULES,
  HEADLESS_SHELL_MODULES,
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
    mocks.sentryMock.setContext.mockClear();
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

  describe('setHostMemoryContext (Sentry DESKTOP-16)', () => {
    const sample = {
      ts: '2026-09-16T14:24:24.000Z',
      platform: 'win32' as const,
      commitLimitBytes: 96_432_717_824,
      commitRemainingBytes: 2_256_896,
      physicalTotalBytes: 34_060_931_072,
      physicalFreeBytes: 5_005_045_760,
    };

    it('forwards the sample to Sentry.setContext("host_memory", ...) only when active', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();

      errorReporting.setHostMemoryContext(sample);

      expect(mocks.sentryMock.setContext).toHaveBeenCalledTimes(1);
      expect(mocks.sentryMock.setContext).toHaveBeenCalledWith('host_memory', sample);
    });

    it('makes no call when the module was never initialized', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.setHostMemoryContext(sample);

      expect(mocks.sentryMock.setContext).not.toHaveBeenCalled();
    });

    it('swallows a throw from Sentry.setContext instead of propagating - this runs on a 60s timer, so a propagating throw would recur for the life of the process', async () => {
      const errorReporting = await importFreshErrorReporting();
      errorReporting.initErrorReporting();
      mocks.sentryMock.setContext.mockImplementationOnce(() => {
        throw new Error('sentry transport exploded');
      });

      expect(() => errorReporting.setHostMemoryContext(sample)).not.toThrow();
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

      // Two shapes carry the same benign EPIPE/EAGAIN write artifact: Node's
      // errnoException (asserted above via the string literals) and a
      // packaged Windows GUI build's uvException, which reads
      // "EPIPE: broken pipe, write" instead. Neither string literal matches
      // that second shape, which is why the two RegExp entries exist.
      expect(matches('EPIPE: broken pipe, write')).toBe(true);
      expect(matches('EAGAIN: resource temporarily unavailable, write')).toBe(true);
      // The errnoException shape must still match through the same helper,
      // so the two shapes coexist rather than one displacing the other.
      expect(matches('write EPIPE')).toBe(true);
      expect(matches('write EAGAIN')).toBe(true);
      // Narrowness guard: a message that merely mentions EPIPE outside the
      // benign stdio-write shape must not match. A loosened pattern like
      // /EPIPE/ would wrongly swallow a real connection error such as this.
      expect(matches('connect EPIPE 127.0.0.1:5432')).toBe(false);

      // The SDK's childProcessIntegration reports every utility-process exit
      // with only the process TYPE, so the event can never say WHICH process
      // died (serviceName/exitCode land in a breadcrumb added after capture).
      // Our own two workers report themselves from their exit handlers instead.
      expect(matches("'Utility' process exited with 'abnormal-exit'")).toBe(true);
      // Scoped to utility processes: renderer crashes come through the SAME
      // integration and array, and must keep reporting.
      expect(matches("'renderer' process exited with 'crashed'")).toBe(false);

      // The same SDK integration's GPU variant (DESKTOP-15): a lone GPU
      // crash Chromium recovers from on its own is un-attributable noise.
      expect(matches("'GPU' process exited with 'abnormal-exit'")).toBe(true);
      // Deliberately narrower than the Utility filter (unanchored, matches
      // any reason): a GPU 'launch-failed' keeps reporting as a backstop,
      // because gpu-health.ts's own next-boot report of the same class
      // cannot be verified to fire when LOG(FATAL) kills the process first.
      // A later broadening to match every GPU reason is a deliberate act,
      // not a silent side effect of some other change.
      expect(matches("'GPU' process exited with 'launch-failed'")).toBe(false);
      expect(matches("'GPU' process exited with 'crashed'")).toBe(false);
      // Our own next-boot self-report must not collide with the filter it
      // exists to replace: no quotes around GPU, so the pattern above cannot
      // match it even loosely.
      expect(matches("GPU process exited repeatedly (reason abnormal-exit, exit code 1)")).toBe(false);

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
   * split in beforeSend instead. These cases pin the wiring; the decision
   * itself is covered in tests/unit/native-crash-event.test.ts, and the dump
   * staying off the real envelope in tests/unit/foreign-crash-real-client.test.ts.
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

    type Attachment = { attachmentType?: string; filename: string };

    function minidumpCount(hint: { attachments?: Attachment[] }): number {
      return (hint.attachments ?? []).filter((attachment) => attachment.attachmentType === 'event.minidump').length;
    }

    it('turns a crash in a process that merely inherited our crash handler into the grouped warning, and keeps its dump off the upload', async () => {
      const beforeSend = await initAndGetBeforeSend();
      const hint = minidumpHint(FFPROBE_MODULES);

      const result = beforeSend(
        { level: 'fatal', platform: 'native', release: 'Kangentic@0.39.0' },
        hint
      );

      expect(result).toMatchObject({
        level: 'warning',
        message: "Foreign process crash reached Kangentic's crash database",
        fingerprint: ['foreign-process-crash'],
        tags: { module: 'ffprobe' },
      });
      // The SDK builds the envelope from this same hint after beforeSend returns.
      expect(minidumpCount(hint)).toBe(0);
    });

    it('keeps our own crash, and its dump, and reattributes it to the build that actually crashed', async () => {
      const beforeSend = await initAndGetBeforeSend();
      const hint = minidumpHint(OUR_APP_MODULES, { _version: '0.38.0' });

      const result = beforeSend(
        { platform: 'native', release: 'Kangentic@0.39.0', breadcrumbs: [{ message: 'later run' }] },
        hint
      );

      expect(result?.release).toBe('Kangentic@0.38.0');
      expect(result?.breadcrumbs).toBeUndefined();
      expect(result?.level).not.toBe('warning');
      expect(minidumpCount(hint)).toBe(1);
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
    });

    it('keeps the event and its dump when the dump cannot be read, so a parser fault cannot delete the stream', async () => {
      const beforeSend = await initAndGetBeforeSend();
      const event = { platform: 'native', release: 'Kangentic@0.39.0' };
      const hint = {
        attachments: [
          { attachmentType: 'event.minidump', filename: 'crash.dmp', data: Buffer.alloc(20000, 0x5a) },
        ],
      };

      const result = beforeSend(event, hint);

      expect(result).toBe(event);
      expect(minidumpCount(hint)).toBe(1);
    });

    it('finds the minidump among several attachments, including one that carries no attachmentType at all, and removes only the dump', async () => {
      // Sentry's other attachment kinds (view-hierarchy, screenshots) do not
      // all carry an attachmentType, and the minidump is not always first in
      // the array. This pins the .find() picking the RIGHT one by type, not
      // by position or by "has Uint8Array data", and the removal leaving the
      // others in place.
      const beforeSend = await initAndGetBeforeSend();
      const hint = {
        attachments: [
          { filename: 'view-hierarchy.json', data: new Uint8Array([1, 2, 3]) },
          { attachmentType: 'event.screenshot', filename: 'screenshot.png', data: new Uint8Array([4, 5, 6]) },
          { attachmentType: 'event.minidump', filename: 'crash.dmp', data: buildMinidump({ modules: FFPROBE_MODULES }) },
        ],
      };

      const result = beforeSend({ platform: 'native', release: 'Kangentic@0.39.0' }, hint);

      expect(result).toMatchObject({ level: 'warning', tags: { module: 'ffprobe' } });
      expect(hint.attachments.map((attachment) => attachment.filename)).toEqual([
        'view-hierarchy.json',
        'screenshot.png',
      ]);
    });

    it('removes EVERY event.minidump attachment on a foreign crash, not only the one .find() read for identity, and leaves the non-minidump attachment alone', async () => {
      // filterNativeCrashEvent reads identity from the first dump only, but no
      // dump may survive a foreign decision. A filter keyed on the single
      // reference .find() returned would leave the second dump in place.
      const beforeSend = await initAndGetBeforeSend();
      const hint = {
        attachments: [
          { attachmentType: 'event.minidump', filename: 'crash.dmp', data: buildMinidump({ modules: FFPROBE_MODULES }) },
          { attachmentType: 'event.minidump', filename: 'crash-2.dmp', data: buildMinidump({ modules: HEADLESS_SHELL_MODULES }) },
          { attachmentType: 'event.screenshot', filename: 'screenshot.png', data: new Uint8Array([4, 5, 6]) },
        ],
      };

      const result = beforeSend({ platform: 'native', release: 'Kangentic@0.39.0' }, hint);

      expect(result).toMatchObject({ level: 'warning', tags: { module: 'ffprobe' } });
      expect(minidumpCount(hint)).toBe(0);
      expect(hint.attachments.map((attachment) => attachment.filename)).toEqual(['screenshot.png']);
    });

    it('tags a frame-capped stack through the REAL Sentry.init() wiring, not only via a direct import of beforeSendEvent', async () => {
      // Every other case in this describe block would stay green even if
      // initErrorReporting() pointed `beforeSend` back at plain
      // filterNativeCrashEvent - none of them touch tagging, and
      // tagTruncatedStack/beforeSendEvent are separate exports nothing here
      // calls. Going through initAndGetBeforeSend (the function Sentry.init
      // actually received) is what makes reverting that one line in
      // initErrorReporting() go red.
      const beforeSend = await initAndGetBeforeSend();

      const cappedStackEvent = {
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Illegal value for lineNumber',
              stacktrace: {
                frames: Array.from({ length: SENTRY_STACK_FRAME_LIMIT }, (_unused, index) => ({
                  filename: 'node_modules/monaco-editor/esm/vs/editor/common/model/textModel.js',
                  function: `frame${index}`,
                  in_app: false,
                })),
              },
            },
          ],
        },
      };

      const result = beforeSend(cappedStackEvent, {});
      const tags = (result as { tags?: Record<string, string> } | null)?.tags;

      expect(tags?.stack_truncated).toBe('true');
    });
  });
});

/**
 * The GPU and Utility `ignoreErrors` entries both match a third-party SDK's
 * message template by hand, so either goes quietly blind if @sentry/electron
 * reformats it or changes which reasons it captures by default. Every
 * hand-written case above would stay green through either change. This reads
 * the installed package and fails instead - the same trap
 * updater-error-classifier.test.ts's "against the installed electron-updater
 * source" block exists for.
 */
describe('against the installed @sentry/electron source', () => {
  const requireFromTest = createRequire(import.meta.url);
  // The package's `exports` map only publishes the `main` entry point itself
  // (the subpath error-reporting.ts imports), not the integrations/ folder
  // underneath it - so resolve relative to that entry's directory instead of
  // requiring the internal file directly.
  const mainEntryDir = path.dirname(requireFromTest.resolve('@sentry/electron/main'));
  const childProcessSource = fs.readFileSync(
    path.join(mainEntryDir, 'integrations', 'child-process.js'),
    'utf-8',
  );

  it('still formats the message as `\'<process>\' process exited with \'<reason>\'`, the shape both filters match', () => {
    expect(childProcessSource).toContain(
      "const message = `'${process}' process exited with '${reason}'`;",
    );
  });

  it('still captures exactly abnormal-exit, launch-failed, and integrity-failure by default', () => {
    const eventsMatch = /events:\s*\[([^\]]*)\]/.exec(childProcessSource);
    expect(eventsMatch).not.toBeNull();
    const capturedReasons = (eventsMatch as RegExpExecArray)[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    // If this ever fails because a new reason was added, the ignoreErrors
    // filter above needs a deliberate decision about that reason too, not a
    // silent pass-through - see error-reporting.ts's comment on why the GPU
    // filter is scoped to 'abnormal-exit' alone.
    expect(capturedReasons.sort()).toEqual(['abnormal-exit', 'integrity-failure', 'launch-failed']);
  });
});

/**
 * SENTRY_STACK_FRAME_LIMIT is a hand-copied duplicate of the number the SDK
 * itself enforces, not a value this project controls. A dependency bump that
 * moves the real cap would leave every other test in this file green - they
 * all derive their frame counts from our own constant - while the tag it
 * drives quietly stopped meaning the SDK's actual cap. This reads the
 * installed source and compares it to the imported constant, rather than
 * asserting a bare literal 50, so a failure states the coupling instead of
 * just restating the magic number: it means SENTRY_STACK_FRAME_LIMIT must be
 * updated to the new upstream number, not that this test is wrong.
 */
describe('SENTRY_STACK_FRAME_LIMIT against the installed Sentry SDK source', () => {
  const requireFromTest = createRequire(import.meta.url);

  it("still matches @sentry/core's STACKTRACE_FRAME_LIMIT, the parser that actually slices the frames array this code counts", () => {
    const coreEntryDir = path.dirname(requireFromTest.resolve('@sentry/core'));
    const stacktraceSource = fs.readFileSync(
      path.join(coreEntryDir, 'utils', 'stacktrace.js'),
      'utf-8',
    );

    const limitMatch = /const STACKTRACE_FRAME_LIMIT = (\d+);/.exec(stacktraceSource);
    expect(limitMatch).not.toBeNull();
    const installedLimit = Number((limitMatch as RegExpExecArray)[1]);

    expect(installedLimit).toBe(SENTRY_STACK_FRAME_LIMIT);
  });

  // The other half of the cap, and the lesser one: @sentry/core's parser above
  // is what actually slices the frames array this code counts, so it is the
  // load-bearing pin. This one catches an upstream that moved only the capture
  // depth.
  it("still matches @sentry/browser's globalHandlers Error.stackTraceLimit", () => {
    // Derived from the resolved entry's own directory rather than a
    // hardcoded dev/prod path, so this follows whichever build condition
    // Node actually selected for @sentry/browser instead of guessing at it.
    const browserEntryDir = path.dirname(requireFromTest.resolve('@sentry/browser'));
    const globalHandlersSource = fs.readFileSync(
      path.join(browserEntryDir, 'integrations', 'globalhandlers.js'),
      'utf-8',
    );

    const limitMatch = /Error\.stackTraceLimit = (\d+);/.exec(globalHandlersSource);
    expect(limitMatch).not.toBeNull();
    const installedLimit = Number((limitMatch as RegExpExecArray)[1]);

    expect(installedLimit).toBe(SENTRY_STACK_FRAME_LIMIT);
  });
});

/**
 * The SDK parses a V8 stack innermost-first and stops at 50 frames, so an event
 * that hits the cap has lost its OUTER frames: the app code that called into
 * the library and the timer it ran under. Such an event reads as a pure
 * third-party failure with no in-app frame, which is exactly how DESKTOP-19's
 * six events read. The tag makes "no app frames survived" distinguishable from
 * "no app frames".
 */
describe('tagTruncatedStack', () => {
  function eventWithFrameCount(frameCount: number): ErrorEvent {
    return {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Illegal value for lineNumber',
            stacktrace: {
              frames: Array.from({ length: frameCount }, (_unused, index) => ({
                filename: 'node_modules/monaco-editor/esm/vs/editor/common/model/textModel.js',
                function: `frame${index}`,
                in_app: false,
              })),
            },
          },
        ],
      },
    };
  }

  it('tags an event whose stack sits exactly on the SDK frame cap', () => {
    const tagged = tagTruncatedStack(eventWithFrameCount(SENTRY_STACK_FRAME_LIMIT));
    expect(tagged.tags?.stack_truncated).toBe('true');
  });

  it('leaves a shorter stack untagged, so the tag means truncation and not merely "deep"', () => {
    const tagged = tagTruncatedStack(eventWithFrameCount(SENTRY_STACK_FRAME_LIMIT - 1));
    expect(tagged.tags?.stack_truncated).toBeUndefined();
  });

  it('leaves an event with no exception values untouched', () => {
    const event: ErrorEvent = { message: 'no stack here' };
    expect(tagTruncatedStack(event).tags?.stack_truncated).toBeUndefined();
  });

  it('preserves tags the event already carried', () => {
    const event = eventWithFrameCount(SENTRY_STACK_FRAME_LIMIT);
    event.tags = { source: 'pty_spawn' };
    const tagged = tagTruncatedStack(event);
    expect(tagged.tags?.source).toBe('pty_spawn');
    expect(tagged.tags?.stack_truncated).toBe('true');
  });

  it('beforeSendEvent tags a capped stack and still returns the event', () => {
    const returned = beforeSendEvent(eventWithFrameCount(SENTRY_STACK_FRAME_LIMIT), {});
    expect(returned).not.toBeNull();
    expect(returned?.tags?.stack_truncated).toBe('true');
  });

  it('beforeSendEvent passes an ordinary event through unchanged', () => {
    const returned = beforeSendEvent(eventWithFrameCount(3), {});
    expect(returned).not.toBeNull();
    expect(returned?.tags?.stack_truncated).toBeUndefined();
  });
});
