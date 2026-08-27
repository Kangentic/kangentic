/**
 * Unit tests for src/main/browser/cookie-seed.ts.
 *
 * The copy primitive is shared by the dev cookie rig and (gated) the production
 * jar seeder, so its translation edge cases (host-only vs domain, the
 * __Host-/__Secure- prefix invariants, SameSite=None-without-Secure, session vs
 * persistent, expiry) and its never-throw batching are the load-bearing
 * behavior. The functions under test are pure or take Session-shaped spies, so
 * no electron mock is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Cookie, Session } from 'electron';
import {
  cookieDomainMatches,
  copyCookies,
  cookieToSetDetails,
  isLocalCookieDomain,
} from '../../src/main/browser/cookie-seed';

const NOW = 1_800_000_000; // fixed "now" in epoch seconds for deterministic expiry checks

function cookie(overrides: Partial<Cookie> & Pick<Cookie, 'name' | 'value'>): Cookie {
  return {
    domain: '.example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: false,
    session: false,
    sameSite: 'lax',
    expirationDate: NOW + 10_000,
    ...overrides,
  };
}

function detailsOf(result: ReturnType<typeof cookieToSetDetails>) {
  if ('skipReason' in result) throw new Error(`expected details, got skip: ${result.skipReason}`);
  return result.details;
}

describe('isLocalCookieDomain', () => {
  it('matches loopback hosts with or without a leading dot', () => {
    for (const host of ['localhost', '.localhost', 'app.localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLocalCookieDomain(host)).toBe(true);
    }
  });

  it('does not match real IdP or app domains', () => {
    for (const host of ['.google.com', 'accounts.google.com', 'example.com', 'notlocalhost.com']) {
      expect(isLocalCookieDomain(host)).toBe(false);
    }
  });
});

describe('cookieDomainMatches', () => {
  it('matches a domain and its subdomains, ignoring leading dots', () => {
    expect(cookieDomainMatches('.google.com', ['google.com'])).toBe(true);
    expect(cookieDomainMatches('accounts.google.com', ['google.com'])).toBe(true);
    expect(cookieDomainMatches('google.com', ['.google.com'])).toBe(true);
  });

  it('does not match an unrelated or look-alike domain', () => {
    expect(cookieDomainMatches('notgoogle.com', ['google.com'])).toBe(false);
    expect(cookieDomainMatches('.example.org', ['google.com'])).toBe(false);
  });

  it('matches everything when no filter is given', () => {
    expect(cookieDomainMatches('.anything.example', undefined)).toBe(true);
    expect(cookieDomainMatches('.anything.example', [])).toBe(true);
  });
});

describe('cookieToSetDetails', () => {
  it('builds an https set-URL from the domain host and path', () => {
    const details = detailsOf(
      cookieToSetDetails(cookie({ name: 'a', value: '1', domain: '.google.com', path: '/x' }), NOW),
    );
    expect(details.url).toBe('https://google.com/x');
  });

  it('passes domain through for a domain cookie (leading dot)', () => {
    const details = detailsOf(
      cookieToSetDetails(cookie({ name: 'a', value: '1', domain: '.google.com' }), NOW),
    );
    expect(details.domain).toBe('.google.com');
  });

  it('omits domain for a host-only cookie', () => {
    const details = detailsOf(
      cookieToSetDetails(
        cookie({ name: 'a', value: '1', domain: 'accounts.google.com', hostOnly: true }),
        NOW,
      ),
    );
    expect(details.domain).toBeUndefined();
    expect(details.url).toBe('https://accounts.google.com/');
  });

  it('forces path "/" and omits domain for a __Host- cookie', () => {
    const details = detailsOf(
      cookieToSetDetails(
        cookie({ name: '__Host-GAPS', value: '1', domain: '.google.com', path: '/sub', secure: true }),
        NOW,
      ),
    );
    expect(details.path).toBe('/');
    expect(details.domain).toBeUndefined();
    expect(details.url).toBe('https://google.com/');
  });

  it('skips a __Host- or __Secure- cookie that is not Secure at the source', () => {
    const host = cookieToSetDetails(cookie({ name: '__Host-x', value: '1', secure: false }), NOW);
    const secure = cookieToSetDetails(cookie({ name: '__Secure-x', value: '1', secure: false }), NOW);
    expect(host).toEqual({ skipReason: 'prefix-requires-secure' });
    expect(secure).toEqual({ skipReason: 'prefix-requires-secure' });
  });

  it('carries a __Secure- cookie via the https URL when Secure', () => {
    const details = detailsOf(
      cookieToSetDetails(
        cookie({ name: '__Secure-1PSID', value: '1', domain: '.google.com', secure: true }),
        NOW,
      ),
    );
    expect(details.secure).toBe(true);
    expect(details.url.startsWith('https://')).toBe(true);
  });

  it('coerces SameSite=None without Secure to unspecified', () => {
    const details = detailsOf(
      cookieToSetDetails(cookie({ name: 'a', value: '1', sameSite: 'no_restriction', secure: false }), NOW),
    );
    expect(details.sameSite).toBe('unspecified');
  });

  it('keeps SameSite=None when the cookie is Secure', () => {
    const details = detailsOf(
      cookieToSetDetails(cookie({ name: 'a', value: '1', sameSite: 'no_restriction', secure: true }), NOW),
    );
    expect(details.sameSite).toBe('no_restriction');
  });

  it('carries a session cookie (no expirationDate) as a session cookie', () => {
    const details = detailsOf(
      cookieToSetDetails(cookie({ name: 'a', value: '1', expirationDate: undefined, session: true }), NOW),
    );
    expect(details.expirationDate).toBeUndefined();
  });

  it('skips an already-expired cookie', () => {
    const result = cookieToSetDetails(cookie({ name: 'a', value: '1', expirationDate: NOW - 1 }), NOW);
    expect(result).toEqual({ skipReason: 'expired' });
  });

  it('skips a cookie with no domain', () => {
    const result = cookieToSetDetails(cookie({ name: 'a', value: '1', domain: undefined }), NOW);
    expect(result).toEqual({ skipReason: 'no-domain' });
  });
});

function fakeSession(cookies: Cookie[]) {
  const get = vi.fn(async () => cookies);
  const set = vi.fn(async () => undefined);
  const flushStore = vi.fn(async () => undefined);
  return {
    session: { cookies: { get, set, flushStore } } as unknown as Session,
    get,
    set,
    flushStore,
  };
}

describe('copyCookies', () => {
  it('copies non-local matching cookies and flushes the target once', async () => {
    const source = fakeSession([
      cookie({ name: 'SID', value: 's', domain: '.google.com' }),
      cookie({ name: 'other', value: 'o', domain: '.example.org' }),
    ]);
    const target = fakeSession([]);

    const result = await copyCookies(source.session, target.session, {
      includeDomains: ['google.com'],
    });

    expect(result.sourceTotal).toBe(2);
    expect(result.copied).toBe(1);
    expect(target.set).toHaveBeenCalledTimes(1);
    expect(target.flushStore).toHaveBeenCalledTimes(1);
  });

  it('excludes loopback cookies by default and records them skipped', async () => {
    const source = fakeSession([
      cookie({ name: 'devsid', value: 'd', domain: 'localhost' }),
      cookie({ name: 'SID', value: 's', domain: '.google.com' }),
    ]);
    const target = fakeSession([]);

    const result = await copyCookies(source.session, target.session, {});

    expect(result.copied).toBe(1);
    expect(result.skipped).toContainEqual({ name: 'devsid', domain: 'localhost', reason: 'local-domain' });
  });

  it('isolates a per-cookie set failure without aborting the batch', async () => {
    const source = fakeSession([
      cookie({ name: 'bad', value: 'b', domain: '.google.com' }),
      cookie({ name: 'good', value: 'g', domain: '.google.com' }),
    ]);
    const target = fakeSession([]);
    target.set.mockRejectedValueOnce(new Error('boom'));

    const result = await copyCookies(source.session, target.session, {});

    expect(result.copied).toBe(1);
    expect(result.skipped.some((entry) => entry.reason.startsWith('set-failed: boom'))).toBe(true);
    expect(target.flushStore).toHaveBeenCalledTimes(1);
  });
});
