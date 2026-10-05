/**
 * Unit tests for src/main/mobile-bridge/transport/relay-websocket.ts.
 *
 * The relay dials with Electron's net.WebSocket in the app, because Node's
 * global WebSocket ignores the system proxy, PAC and the OS certificate store.
 * The resolver must hand that class over only where it exists (the main
 * process, after ready) and must never throw anywhere else: a unit test's
 * electron mock throws on an export it does not define, and that has to read
 * as "not in the app" so the client falls back to the global, not as a failed
 * dial. The behaviour of net.WebSocket itself (binaryType default, the bare
 * error Event, the close reason carrying net:: errors, the Origin header) was
 * measured against a live Electron 44.5.1 and is not unit-testable here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

class FakeNetWebSocket {}

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

async function loadResolver() {
  const module = await import('../../../src/main/mobile-bridge/transport/relay-websocket');
  return module.resolveRelayWebSocket;
}

describe('resolveRelayWebSocket()', () => {
  it("returns Electron's net.WebSocket once the app is ready", async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => true }, net: { WebSocket: FakeNetWebSocket } }));
    const resolveRelayWebSocket = await loadResolver();
    expect(resolveRelayWebSocket()).toBe(FakeNetWebSocket);
  });

  it('returns undefined before the app is ready, so a dial falls back to the global', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => false }, net: { WebSocket: FakeNetWebSocket } }));
    const resolveRelayWebSocket = await loadResolver();
    expect(resolveRelayWebSocket()).toBeUndefined();
  });

  it('returns undefined, never throws, under an electron mock with no net export', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => true } }));
    const resolveRelayWebSocket = await loadResolver();
    expect(() => resolveRelayWebSocket()).not.toThrow();
    expect(resolveRelayWebSocket()).toBeUndefined();
  });

  it('returns undefined when net has no WebSocket (an Electron older than 44)', async () => {
    vi.doMock('electron', () => ({ app: { isReady: () => true }, net: {} }));
    const resolveRelayWebSocket = await loadResolver();
    expect(resolveRelayWebSocket()).toBeUndefined();
  });
});
