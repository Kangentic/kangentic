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
