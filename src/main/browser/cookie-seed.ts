// Shared cookie-copy primitive for the embedded Browser pane.
//
// Two consumers, one implementation so they cannot drift:
//   - the dev-only cookie experiment rig (src/devtools/main/cookie-jar-routes.ts),
//     which is how the copy-carries-the-login question is answered empirically
//     before any production seeding ships;
//   - the production jar seeder (src/main/browser/jar-seeder.ts), shipped once
//     that experiment confirmed a copied session carries the login.
//
// This module only KNOWS HOW to copy cookies between two Electron sessions and
// how to translate a read `Cookie` into the `CookiesSetDetails` that faithfully
// recreates it. It never decides WHICH sessions or WHEN; the caller controls
// `session.fromPartition` ordering (load-bearing for the dev rig's
// existed-on-disk reporting, which must stat the jar directory BEFORE
// `fromPartition` materializes it).

import type { Cookie, CookiesSetDetails, Session } from 'electron';

/**
 * True for the loopback hosts a dev server runs on: `localhost`, `127.0.0.1`,
 * IPv6 loopback (`::1`, with or without brackets), and any `*.localhost`
 * subdomain. A cookie on one of these is the per-task dev-app session that
 * MUST stay isolated per task, so it is never carried between jars in either
 * direction. Tolerates a leading dot (domain cookies report `.localhost`).
 */
export function isLocalCookieDomain(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/**
 * The host portion of a cookie's set-URL: the domain with any leading dot
 * removed. A domain cookie `.google.com` and a host-only cookie `google.com`
 * both resolve to the host `google.com` here; whether the recreated cookie is
 * domain-scoped or host-only is decided separately by whether we pass `domain`
 * in the details.
 */
function cookieHost(domain: string): string {
  return domain.replace(/^\./, '');
}

/**
 * Translate a `Cookie` read from one jar into the `CookiesSetDetails` that
 * recreates it in another, or return a `skipReason` when it cannot be carried
 * faithfully. Pure and side-effect free so every edge case is a unit test.
 *
 * `nowSeconds` is passed in (never read from the clock here) so the expiry check
 * is deterministic under test.
 */
export function cookieToSetDetails(
  cookie: Cookie,
  nowSeconds: number,
):
  | { details: CookiesSetDetails }
  | { skipReason: string } {
  const domain = cookie.domain ?? '';
  if (!domain) return { skipReason: 'no-domain' };

  if (cookie.expirationDate !== undefined && cookie.expirationDate < nowSeconds) {
    return { skipReason: 'expired' };
  }

  const host = cookieHost(domain);
  // Always an https set-URL: a Secure cookie can only be set from https, and a
  // non-Secure cookie may legally be set from one, so there is no scheme branch.
  const path = cookie.path ?? '/';

  const isHostPrefix = cookie.name.startsWith('__Host-');
  const isSecurePrefix = cookie.name.startsWith('__Secure-');

  // A __Host- / __Secure- cookie that is not Secure at the source could never
  // have been set by a browser under the prefix rules; refuse rather than write
  // an invalid cookie the target would reject anyway.
  if ((isHostPrefix || isSecurePrefix) && !cookie.secure) {
    return { skipReason: 'prefix-requires-secure' };
  }

  // __Host- is host-only, path "/", Secure. Everything else keeps the source's
  // host-only vs domain distinction: a host-only cookie omits `domain` (the URL
  // host alone yields host-only), a domain cookie passes `domain` through so the
  // subdomain match is preserved.
  const hostOnly = isHostPrefix || cookie.hostOnly === true || !domain.startsWith('.');
  const effectivePath = isHostPrefix ? '/' : path;

  // SameSite=None requires Secure; Chromium rejects the set otherwise. Coerce a
  // non-Secure no_restriction cookie to unspecified rather than lose the write.
  const sameSite =
    cookie.sameSite === 'no_restriction' && !cookie.secure ? 'unspecified' : cookie.sameSite;

  const details: CookiesSetDetails = {
    url: `https://${host}${effectivePath}`,
    name: cookie.name,
    value: cookie.value,
    path: effectivePath,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
  };
  if (!hostOnly) details.domain = domain;
  // A session cookie (no expirationDate) is carried as a session cookie: omit
  // expirationDate so it lands as one in the target and dies with the app.
  if (cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;

  return { details };
}

/** Which cookies `copyCookies` carries. */
export interface CookieCopyFilter {
  /**
   * Suffix match against each cookie's domain (leading dot stripped): `google.com`
   * matches `.google.com`, `accounts.google.com`, and `google.com`, but not
   * `notgoogle.com`. Undefined or empty carries every domain.
   */
  includeDomains?: string[];
  /** Default true: never carry a loopback (dev-server) cookie between jars. */
  excludeLocal?: boolean;
}

/** Outcome of a `copyCookies` run. */
export interface CookieCopyResult {
  sourceTotal: number;
  copied: number;
  skipped: { name: string; domain: string; reason: string }[];
}

/**
 * True when `cookieDomain` is, or is a subdomain of, one of `includeDomains`
 * (leading dots ignored on both sides). Empty/undefined `includeDomains` matches
 * everything. Exported so the dev cookie rig's list filter uses the exact same
 * semantics as the copy filter here.
 */
export function cookieDomainMatches(cookieDomain: string, includeDomains: string[] | undefined): boolean {
  if (!includeDomains || includeDomains.length === 0) return true;
  const host = cookieHost(cookieDomain).toLowerCase();
  return includeDomains.some((filterDomain) => {
    const target = filterDomain.replace(/^\./, '').toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  });
}

/**
 * Copy cookies from `source` into `target`, filtered by domain and (by default)
 * excluding loopback cookies. Reads the whole source jar, translates each cookie,
 * writes it, and flushes the target store ONCE at the end so the copy survives an
 * immediate app kill. A per-cookie translation or write failure is recorded in
 * `skipped` and never thrown, so one bad cookie cannot abort the batch.
 *
 * Takes `Session` objects, not partition strings, so the caller owns the
 * `session.fromPartition` calls (and can stat the on-disk jar first).
 */
export async function copyCookies(
  source: Session,
  target: Session,
  filter: CookieCopyFilter,
): Promise<CookieCopyResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const excludeLocal = filter.excludeLocal !== false;
  const all = await source.cookies.get({});
  const skipped: CookieCopyResult['skipped'] = [];
  let copied = 0;

  for (const cookie of all) {
    const domain = cookie.domain ?? '';
    if (excludeLocal && isLocalCookieDomain(domain)) {
      skipped.push({ name: cookie.name, domain, reason: 'local-domain' });
      continue;
    }
    if (!cookieDomainMatches(domain, filter.includeDomains)) continue;

    const translated = cookieToSetDetails(cookie, nowSeconds);
    if ('skipReason' in translated) {
      skipped.push({ name: cookie.name, domain, reason: translated.skipReason });
      continue;
    }
    try {
      await target.cookies.set(translated.details);
      copied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ name: cookie.name, domain, reason: `set-failed: ${message}` });
    }
  }

  try {
    await target.cookies.flushStore();
  } catch {
    // Best-effort durability: an unflushed copy still lives in memory for this run.
  }

  return { sourceTotal: all.length, copied, skipped };
}
