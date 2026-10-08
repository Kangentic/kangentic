/**
 * Unit tests for src/main/mobile-bridge/transport/relay-websocket.ts.
 *
 * The relay dials with Node's global WebSocket and keeps Electron's
 * net.WebSocket as a fallback for networks undici cannot cross (a configured
 * proxy, a TLS-inspecting firewall). The resolver must hand the fallback over
 * only where it exists (the main process, after ready) and must never throw
 * anywhere else: a unit test's electron mock throws on an export it does not
 * define, and that has to read as "not in the app", not as a failed dial.
 * net.WebSocket's own behaviour (binaryType default, the bare error Event, the
 * close reason carrying net:: errors, the Origin header) was measured against
 * a live Electron 44.5.1 and is not unit-testable here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

class FakeNetWebSocket {}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.resetModules();
});

async function loadModule() {
  return import('../../../src/main/mobile-bridge/transport/relay-websocket');
}

/** Lets the background resolveProxy() promise chain settle. */
async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe('resolveRelayChromiumFallback()', () => {
  it("offers Electron's net.WebSocket as the 'chromium' fallback once the app is ready", async () => {
    vi.doMock('electron', () => ({
      app: { isReady: () => true },
      net: { WebSocket: FakeNetWebSocket },
      session: { defaultSession: { resolveProxy: () => Promise.resolve('DIRECT') } },
    }));
    const { resolveRelayChromiumFallback } = await loadModule();
    const fallback = resolveRelayChromiumFallback('wss://relay.example.com');
    expect(fallback?.webSocketConstructor).toBe(FakeNetWebSocket);
    expect(fallback?.stack).toBe('chromium');
  });

  it('returns undefined before the app is ready, so the client dials with undici alone', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => false }, net: { WebSocket: FakeNetWebSocket } }));
    const { resolveRelayChromiumFallback } = await loadModule();
    expect(resolveRelayChromiumFallback('wss://relay.example.com')).toBeUndefined();
  });

  it('returns undefined, never throws, under an electron mock with no net export', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => true } }));
    const { resolveRelayChromiumFallback } = await loadModule();
    expect(() => resolveRelayChromiumFallback('wss://relay.example.com')).not.toThrow();
    expect(resolveRelayChromiumFallback('wss://relay.example.com')).toBeUndefined();
  });

  it('returns undefined when net has no WebSocket (an Electron older than 43.2)', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => true }, net: {} }));
    const { resolveRelayChromiumFallback } = await loadModule();
    expect(resolveRelayChromiumFallback('wss://relay.example.com')).toBeUndefined();
  });

  it('prefers the fallback once the default session reports a proxy for the relay origin, asking with the https form of the URL', async () => {
    const resolveProxy = vi.fn(() => Promise.resolve('PROXY proxy.corp.example:8080; DIRECT'));
    vi.doMock('electron', () => ({
      app: { isReady: () => true },
      net: { WebSocket: FakeNetWebSocket },
      session: { defaultSession: { resolveProxy } },
    }));
    const { resolveRelayChromiumFallback } = await loadModule();
    const fallback = resolveRelayChromiumFallback('wss://relay.example.com/');
    // The first ask has no answer yet, so the dial that asked goes out on undici.
    expect(fallback?.isPreferred?.()).toBe(false);
    await flushPromises();
    expect(fallback?.isPreferred?.()).toBe(true);
    expect(resolveProxy).toHaveBeenCalledWith('https://relay.example.com');
    // Cached for a minute: no second lookup per dial.
    expect(resolveProxy).toHaveBeenCalledTimes(1);
  });

  it('never prefers the fallback for a DIRECT answer or a failed lookup', async () => {
    let answer: Promise<string> = Promise.resolve('DIRECT');
    vi.doMock('electron', () => ({
      app: { isReady: () => true },
      net: { WebSocket: FakeNetWebSocket },
      session: { defaultSession: { resolveProxy: () => answer } },
    }));
    const { resolveRelayChromiumFallback, resetProxyDecisionsForTests } = await loadModule();
    const direct = resolveRelayChromiumFallback('wss://relay.example.com');
    direct?.isPreferred?.();
    await flushPromises();
    expect(direct?.isPreferred?.()).toBe(false);

    resetProxyDecisionsForTests();
    answer = Promise.reject(new Error('lookup failed'));
    const failed = resolveRelayChromiumFallback('wss://relay.example.com');
    failed?.isPreferred?.();
    await flushPromises();
    expect(failed?.isPreferred?.()).toBe(false);
  });
});

/** Mocks electron as a ready main process whose default session answers with `resolveProxy`. */
function mockReadyElectron(resolveProxy: (url: string) => Promise<string>): void {
  vi.doMock('electron', () => ({
    app: { isReady: () => true },
    net: { WebSocket: FakeNetWebSocket },
    session: { defaultSession: { resolveProxy } },
  }));
}

/** Loads the module and returns the fallback's isPreferred(), failing loudly if there is no fallback. */
async function loadIsPreferred(relayUrl: string): Promise<() => boolean> {
  const { resolveRelayChromiumFallback } = await loadModule();
  const isPreferred = resolveRelayChromiumFallback(relayUrl)?.isPreferred;
  if (!isPreferred) throw new Error('expected a chromium fallback with an isPreferred() check');
  return isPreferred;
}

describe('proxy decision for the relay origin', () => {
  it('asks again once the 60 s TTL has passed, and a DIRECT answer then turns the preference off', async () => {
    vi.useFakeTimers();
    const answers = ['PROXY proxy.corp.example:8080; DIRECT', 'DIRECT'];
    const resolveProxy = vi.fn((_url: string) => Promise.resolve(answers.shift() ?? 'DIRECT'));
    mockReadyElectron(resolveProxy);
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    isPreferred();
    await flushPromises();
    expect(isPreferred()).toBe(true);
    expect(resolveProxy).toHaveBeenCalledTimes(1);

    // Still inside the TTL: the cached answer is served and nothing is asked.
    vi.advanceTimersByTime(59_000);
    expect(isPreferred()).toBe(true);
    expect(resolveProxy).toHaveBeenCalledTimes(1);

    // Past the TTL the first dial that asks gets the stale answer and starts a
    // background re-check; the next one sees the new answer.
    vi.advanceTimersByTime(2_000);
    expect(isPreferred()).toBe(true);
    expect(resolveProxy).toHaveBeenCalledTimes(2);
    await flushPromises();
    expect(isPreferred()).toBe(false);
  });

  it('flips a proxied decision to false when the re-check lookup rejects', async () => {
    vi.useFakeTimers();
    let answer: Promise<string> = Promise.resolve('PROXY proxy.corp.example:8080');
    const resolveProxy = vi.fn((_url: string) => answer);
    mockReadyElectron(resolveProxy);
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    isPreferred();
    await flushPromises();
    expect(isPreferred()).toBe(true);

    vi.advanceTimersByTime(61_000);
    answer = Promise.reject(new Error('lookup failed'));
    isPreferred();
    await flushPromises();
    expect(resolveProxy).toHaveBeenCalledTimes(2);
    expect(isPreferred()).toBe(false);
  });

  it('looks up the http origin for a ws relay URL and the https origin for a wss one', async () => {
    const resolveProxy = vi.fn((_url: string) => Promise.resolve('DIRECT'));
    mockReadyElectron(resolveProxy);
    const { resolveRelayChromiumFallback } = await loadModule();

    resolveRelayChromiumFallback('ws://relay.example.com:8080/some/path?slot=abc')?.isPreferred?.();
    resolveRelayChromiumFallback('wss://relay.example.com/some/path?slot=abc')?.isPreferred?.();

    expect(resolveProxy.mock.calls.map((call) => call[0])).toEqual(['http://relay.example.com:8080', 'https://relay.example.com']);
  });

  // The cache is per origin and shared: every paired device owns a RelayClient
  // with its own fallback object, and all of them dial the same relay at app
  // start, before the first answer has come back.
  it('shares one in-flight lookup between callers, so dials made before the answer arrives ask once', async () => {
    const resolveProxy = vi.fn((_url: string) => Promise.resolve('PROXY proxy.corp.example:8080; DIRECT'));
    mockReadyElectron(resolveProxy);
    const { resolveRelayChromiumFallback } = await loadModule();
    const firstDevice = resolveRelayChromiumFallback('wss://relay.example.com')?.isPreferred;
    const secondDevice = resolveRelayChromiumFallback('wss://relay.example.com')?.isPreferred;
    if (!firstDevice || !secondDevice) throw new Error('expected a chromium fallback with an isPreferred() check');

    // Three dials, none of which has an answer yet, so all go out unproxied.
    expect(firstDevice()).toBe(false);
    expect(secondDevice()).toBe(false);
    expect(firstDevice()).toBe(false);
    expect(resolveProxy).toHaveBeenCalledTimes(1);

    // Once the one lookup lands, every caller sees it and nothing more is asked.
    await flushPromises();
    expect(firstDevice()).toBe(true);
    expect(secondDevice()).toBe(true);
    expect(resolveProxy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'a list that leads with DIRECT', proxyList: 'DIRECT; PROXY proxy.corp.example:8080', proxied: false },
    { label: 'a list that leads with a proxy and ends in DIRECT', proxyList: 'PROXY proxy.corp.example:8080; DIRECT', proxied: true },
    { label: 'DIRECT in lower case with padding', proxyList: ' direct ', proxied: false },
    { label: 'an empty answer', proxyList: '', proxied: false },
  ])('reads $label as proxied=$proxied', async ({ proxyList, proxied }) => {
    mockReadyElectron(() => Promise.resolve(proxyList));
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    isPreferred();
    await flushPromises();

    expect(isPreferred()).toBe(proxied);
  });

  it('reads a synchronous resolveProxy throw as no proxy, and asks again after the TTL instead of staying stuck in flight', async () => {
    vi.useFakeTimers();
    const resolveProxy = vi.fn((_url: string): Promise<string> => {
      throw new Error('session torn down');
    });
    mockReadyElectron(resolveProxy);
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    expect(() => isPreferred()).not.toThrow();
    expect(isPreferred()).toBe(false);
    // The failed ask recorded its time, so the very next dial does not ask again.
    expect(resolveProxy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    expect(isPreferred()).toBe(false);
    expect(resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('flips a proxied decision to false when the re-check throws synchronously', async () => {
    vi.useFakeTimers();
    let failSynchronously = false;
    mockReadyElectron((_url: string) => {
      if (failSynchronously) throw new Error('session torn down');
      return Promise.resolve('PROXY proxy.corp.example:8080');
    });
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    isPreferred();
    await flushPromises();
    expect(isPreferred()).toBe(true);

    failSynchronously = true;
    vi.advanceTimersByTime(61_000);
    expect(() => isPreferred()).not.toThrow();
    expect(isPreferred()).toBe(false);
  });

  it('reads a throwing defaultSession getter as no proxy without throwing', async () => {
    vi.doMock('electron', () => ({
      app: { isReady: () => true },
      net: { WebSocket: FakeNetWebSocket },
      session: {
        get defaultSession(): never {
          throw new Error('no default session before ready');
        },
      },
    }));
    const isPreferred = await loadIsPreferred('wss://relay.example.com');

    expect(() => isPreferred()).not.toThrow();
    expect(isPreferred()).toBe(false);
  });

  it('reads a malformed relay URL as no proxy, without asking or throwing', async () => {
    const resolveProxy = vi.fn((_url: string) => Promise.resolve('PROXY proxy.corp.example:8080'));
    mockReadyElectron(resolveProxy);
    const isPreferred = await loadIsPreferred('not a url');

    expect(() => isPreferred()).not.toThrow();
    await flushPromises();
    expect(isPreferred()).toBe(false);
    expect(resolveProxy).not.toHaveBeenCalled();
  });
});
