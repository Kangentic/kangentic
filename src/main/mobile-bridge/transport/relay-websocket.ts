import { app, net } from 'electron';
import type { RelayWebSocketConstructor } from './relay-client';

/**
 * The WebSocket the relay client dials with in the app: Electron's
 * `net.WebSocket`, which runs on Chromium's network stack.
 *
 * Node's global `WebSocket` (undici) ignores the system proxy, PAC/WPAD and the
 * OS certificate store, so a desktop behind a corporate proxy or a
 * TLS-inspecting firewall could not reach the relay at all. Chromium's stack
 * honours all three, the same as the rest of the app's traffic.
 *
 * `net.WebSocket` exists only in the main process and only once the app is
 * ready. Anywhere else - a unit test's `electron` mock, plain Node, a dial
 * before `ready` - this returns undefined and the client falls back to Node's
 * global, which is what it used before. The lookup never throws: a vitest
 * mock throws on an export it does not define, and that has to read as
 * "not in the app", not as a failed dial.
 *
 * Behavior differences checked against Electron 44.5.1 (the measurements are
 * in the task that introduced this): `binaryType` defaults to 'nodebuffer', and
 * the client sets 'arraybuffer' before anything arrives; the handshake sends an
 * `Origin` header by default, and kangentic-relay never reads it; `error` is
 * always followed by `close`, which is what the client's reconnect logic keys
 * on.
 */
export function resolveRelayWebSocket(): RelayWebSocketConstructor | undefined {
  try {
    if (app.isReady() && typeof net.WebSocket === 'function') {
      // Electron's typings declare the `on*` handlers as `Function | null` and
      // add a 'nodebuffer' binaryType, so its class is not assignable to the
      // lib.dom WebSocket the client is written against, though the runtime is
      // the same WHATWG API.
      return net.WebSocket as unknown as RelayWebSocketConstructor;
    }
  } catch {
    // Not the Electron main process.
  }
  return undefined;
}
