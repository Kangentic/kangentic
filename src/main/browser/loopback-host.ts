/**
 * The single definition of a loopback host for the embedded browser.
 *
 * True for `localhost`, any `*.localhost` subdomain, all of `127.0.0.0/8`, and
 * IPv6 loopback (`::1`, with or without brackets). These are the hosts the W3C
 * Secure Contexts spec calls potentially trustworthy, and the ones Chromium
 * resolves to loopback itself, so DNS cannot point them anywhere else.
 *
 * Two readers, one rule: the cookie copy keeps a loopback cookie in its own
 * task's jar (`isLocalCookieDomain` in `cookie-seed.ts`), and a popup on a
 * loopback origin is not labelled "Not secure" (`popupWindowTitleForUrl` in
 * `window-open-policy.ts`).
 *
 * Pass a canonical host: `URL.hostname`, or a cookie domain without its leading
 * dot. The WHATWG URL parser has already rewritten forms like `2130706433` and
 * `127.1` to `127.0.0.1`, so this does not re-parse them.
 *
 * Deliberately NOT included: `0.0.0.0`, which is not a potentially trustworthy
 * origin, and private LAN ranges. `isLoopbackOrPrivateHost` in
 * `browser-pane-driver.ts` adds those on top of this predicate, for a different
 * question: where an agent may navigate.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
