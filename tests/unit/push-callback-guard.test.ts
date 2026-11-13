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

describe('guardPushCallbacks, callback outcomes', () => {
  it('reports an async callback that rejects, and still hands back its promise', async () => {
    const { api, listeners } = fakeApi();
    const failures: Array<[string, unknown]> = [];
    guardPushCallbacks(api, (method, error) => failures.push([method, error]));
    const rejection = new RangeError('async boom');
    // Registered through a loose type: the fake's listener returns void, this one a promise.
    (api.config.onChanged as (callback: () => Promise<void>) => unknown)(async () => { throw rejection; });

    const returned = (listeners[0] as unknown as () => Promise<void>)();
    expect(returned).toBeInstanceOf(Promise);
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('config.onChanged');
    expect(failures[0][1]).toBe(rejection);
    // The push still sees the callback's own rejection; the guard only observes it.
    await expect(returned).rejects.toBe(rejection);
  });

  it('passes a callback return value through unchanged', () => {
    const api = { widgets: { onTick: (callback: () => unknown) => callback } };
    guardPushCallbacks(api, () => undefined);
    const guarded = api.widgets.onTick(() => 42) as () => unknown;
    expect(guarded()).toBe(42);
  });

  it('does not let an onFailure that throws escape into the push', () => {
    const { api, emit } = fakeApi();
    guardPushCallbacks(api, () => { throw new Error('sink exploded'); });
    api.config.onChanged(() => { throw new TypeError('boom'); });
    expect(() => emit('changed')).not.toThrow();
  });

  it('wraps a top-level on* method and reports it by its unprefixed name', () => {
    let registered: ((value: string) => void) | undefined;
    const api = { onSomething: (callback: (value: string) => void) => { registered = callback; } };
    const failures: Array<[string, unknown]> = [];
    guardPushCallbacks(api, (method, error) => failures.push([method, error]));
    api.onSomething(() => { throw new TypeError('top-level boom'); });
    expect(() => registered?.('x')).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('onSomething');
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
