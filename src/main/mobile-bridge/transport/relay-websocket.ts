import { app, net, session } from 'electron';
import type { RelayWebSocketConstructor, RelayWebSocketFallback } from './relay-client';

/**
 * Electron's `net.WebSocket` as the relay client's FALLBACK stack. The primary
 * is Node's global `WebSocket` (undici), which the client reads itself.
 *
 * Why this order. Chromium's stack honours the system proxy, PAC/WPAD and the
 * OS certificate store, and Node's ignores all three, so f547a71c9 moved every
 * relay dial onto `net.WebSocket`. The logs say that cost the common case. On one
 * desktop's logs, weekday daytime dials on undici (Electron 41) had p90 208 ms,
 * p99 1.4 s and 1.3% over 1 s; on `net.WebSocket` (Electron 44.5.1) they had
 * p90 869 ms, p99 6.5 s and 9.2% over 1 s, plus isolated ~19.2 s dials on one
 * client while its neighbours connected normally. Those were different weeks,
 * so load on the relay could account for part of the gap.
 *
 * A standalone Electron 44.5.1 rig then dialed both stacks to the hosted relay
 * in the same 30 s cycles for two evening hours on Oct 7, about 5,100 small
 * echoes per stack in each of two rigs. There the stacks came out close: echo
 * p99 647 and 656 ms on Chromium against 586 and 543 ms on undici, 18 and 16
 * echoes over 1 s against 14 and 14, worst cases 5.5 and 5.3 s against 2.0
 * and 4.2 s, and the same dial tail. Most of the tail landed on both stacks in
 * the same minutes, which puts it on the relay path. Chromium's own share is small. Its network log showed stalled bytes
 * arriving late at the socket and never held inside Electron. Connections that
 * negotiated Encrypted ClientHello (the hosted relay's Cloudflare zone
 * publishes an ECH config in its DNS HTTPS record) had 0.94% of echoes over
 * 500 ms, against 0.50% in a rig with ECH turned off in the same hour; undici
 * never negotiates ECH. Chromium's slow dials finished TCP and TLS in under
 * 100 ms and then waited seconds for the upgrade reply.
 *
 * So undici dials by default. It is the stack every dial used before October
 * 2026, it was never the worse one in the rig, and the isolated ~19 s dials
 * appeared only after the switch away from it. `net.WebSocket` is used when
 * the system needs it. That means outright while `session.resolveProxy()` reports a proxy
 * for the relay, and as the client's fallback after undici fails twice in a row
 * (a TLS-inspecting firewall whose root CA is in the OS store but not in Node's
 * bundled list). RelayClient owns that accounting.
 *
 * `net.WebSocket` exists only in the main process and only once the app is
 * ready. Anywhere else (a unit test's `electron` mock, plain Node, a dial
 * before `ready`) this returns undefined and the client dials with undici
 * alone. The lookup never throws: a vitest mock throws on an export it does not
 * define, and that has to read as "not in the app", not as a failed dial.
 *
 * Behaviour checked against Electron 44.5.1: `binaryType` defaults to
 * 'nodebuffer' and the client sets 'arraybuffer' before anything arrives; the
 * handshake sends an `Origin` header, which kangentic-relay never reads;
 * `error` is always followed by `close`, which the client's reconnect logic
 * keys on.
 */
export function resolveRelayChromiumFallback(relayUrl: string): RelayWebSocketFallback | undefined {
  try {
    if (app.isReady() && typeof net.WebSocket === 'function') {
      return {
        // Electron's typings declare the `on*` handlers as `Function | null` and
        // add a 'nodebuffer' binaryType, so its class is not assignable to the
        // lib.dom WebSocket the client is written against, though the runtime
        // is the same WHATWG API.
        webSocketConstructor: net.WebSocket as unknown as RelayWebSocketConstructor,
        stack: 'chromium',
        isPreferred: () => isProxyConfiguredForRelay(relayUrl),
      };
    }
  } catch {
    // Not the Electron main process.
  }
  return undefined;
}

/**
 * How long one `resolveProxy()` answer is trusted. The question is asked again
 * on the first dial after it goes stale, so a proxy turned on or off (or a
 * network change that swaps PAC files) is picked up within a park cycle.
 */
const PROXY_DECISION_TTL_MS = 60_000;

interface ProxyDecision {
  proxied: boolean;
  checkedAtMs: number;
  inFlight: boolean;
}

const proxyDecisionsByOrigin = new Map<string, ProxyDecision>();

/**
 * Whether the default session routes the relay through a proxy. Answered from
 * a cache and refreshed in the background, because the dial that asks is
 * synchronous: the first dial before any answer arrives goes out on undici,
 * and in a proxy-only network that dial fails and the next one, by then
 * informed, uses Chromium.
 */
function isProxyConfiguredForRelay(relayUrl: string): boolean {
  let lookupUrl: string;
  try {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
    lookupUrl = url.origin;
  } catch {
    return false;
  }
  const decision = proxyDecisionsByOrigin.get(lookupUrl) ?? { proxied: false, checkedAtMs: 0, inFlight: false };
  proxyDecisionsByOrigin.set(lookupUrl, decision);
  if (!decision.inFlight && Date.now() - decision.checkedAtMs >= PROXY_DECISION_TTL_MS) {
    decision.inFlight = true;
    session.defaultSession
      .resolveProxy(lookupUrl)
      .then((proxyList) => {
        decision.proxied = proxyList.trim().toUpperCase() !== 'DIRECT';
      })
      .catch(() => {
        decision.proxied = false;
      })
      .finally(() => {
        decision.checkedAtMs = Date.now();
        decision.inFlight = false;
      });
  }
  return decision.proxied;
}

export function resetProxyDecisionsForTests(): void {
  proxyDecisionsByOrigin.clear();
}
