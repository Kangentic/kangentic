/**
 * A renderer callback that throws when the preload calls it on a push is an
 * error of the preload's isolated world, which the renderer's Sentry SDK cannot
 * see (measured: the preload's own `error` listener gets "Script error." and no
 * stack). The guard catches it at the call, and main reports its type and
 * frames, never its message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { guardPushCallbacks } = await import('../../src/preload/push-callback-guard');
const { reportPushCallbackRecord, pushCallbackReporter } = await import('../../src/main/diagnostics/push-callback-report');

type Listener = (value: string) => void;

function fakeApi() {
  const listeners: Listener[] = [];
  const api = {
    config: {
      get: () => 'config',
      onChanged: (callback: Listener) => {
        listeners.push(callback);
        return () => listeners.splice(listeners.indexOf(callback), 1);
      },
    },
    onboarding: { onboardingProgress: (callback: Listener) => callback('not a push') },
  };
  return { api, emit: (value: string) => { for (const listener of [...listeners]) listener(value); }, listeners };
}

describe('guardPushCallbacks', () => {
  it('catches a throwing callback, names its method, and lets the next listener run', () => {
    const { api, emit } = fakeApi();
    const failures: Array<[string, unknown]> = [];
    guardPushCallbacks(api, (method, error) => failures.push([method, error]));
    const heard: string[] = [];
    api.config.onChanged(() => { throw new TypeError('boom'); });
    api.config.onChanged((value) => heard.push(value));

    expect(() => emit('changed')).not.toThrow();
    expect(heard).toEqual(['changed']);
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('config.onChanged');
    expect(failures[0][1]).toBeInstanceOf(TypeError);
  });

  it('keeps the unsubscribe and leaves every other method alone', () => {
    const { api, listeners } = fakeApi();
    const originalGet = api.config.get;
    const originalOnboarding = api.onboarding.onboardingProgress;
    guardPushCallbacks(api, () => undefined);
    const unsubscribe = api.config.onChanged(() => undefined);
    expect(listeners).toHaveLength(1);
    unsubscribe();
    expect(listeners).toHaveLength(0);
    expect(api.config.get).toBe(originalGet);
    expect(api.onboarding.onboardingProgress).toBe(originalOnboarding);
  });
});

describe('reportPushCallbackRecord', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    pushCallbackReporter.reset();
  });

  const record = (overrides: Record<string, unknown> = {}) => ({
    ts: new Date().toISOString(),
    kind: 'renderer-window-error' as const,
    source: 'preload' as const,
    message: "Cannot read properties of undefined (reading 'Fix Acme billing')",
    stack: "TypeError: Cannot read properties of undefined (reading 'Fix Acme billing')\n    at onConfigChanged (index.js:1:2)",
    origin: null,
    context: { pushCallback: 'config.onChanged', errorName: 'TypeError' },
    versions: { kangentic: 'x', electron: 'x', node: 'x', chrome: 'x' },
    ...overrides,
  });

  it('sends the type and frames, tagged with the method, and no message', () => {
    expect(reportPushCallbackRecord(record())).toBe(true);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags, , fingerprint] = reportHandledError.mock.calls[0] as [Error, Record<string, string>, unknown, string[]];
    expect(sent.message).toBe('Handled preload_callback failure: TypeError');
    expect(sent.stack).toContain('at onConfigChanged');
    expect(tags).toMatchObject({ source: 'preload_callback', method: 'config.onChanged' });
    // The bridge leaves only the preload's own frames, so the method groups it.
    expect(fingerprint).toEqual(['preload-callback', 'config.onChanged']);
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toMatch(/acme/i);
  });

  it('ignores a record the guard did not send, and a method that is not an API name', () => {
    expect(reportPushCallbackRecord(record({ source: 'renderer' }))).toBe(false);
    expect(reportPushCallbackRecord(record({ context: null }))).toBe(false);
    reportPushCallbackRecord(record({ context: { pushCallback: 'C:/Users/dev/a.js', errorName: 'TypeError' } }));
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ method: 'unknown' });
  });
});
