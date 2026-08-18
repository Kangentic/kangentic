/**
 * Unit tests for `detectEmbeddedSignInRefusal`.
 *
 * Google refuses OAuth from embedded user agents, and a top-level Electron popup
 * is still an embedded user agent by that definition - so allowing popups turns a
 * dead sign-in button into a visible 403 rather than into a working login. This
 * predicate is what lets the app say so instead of leaving the user staring at
 * Google's error page.
 *
 * What it deliberately does NOT claim: the `disallowed_useragent` string lives in
 * the rendered page, not the URL, so this detects "the provider returned an OAuth
 * error". The prompt copy is hedged to match, and these tests pin that scope.
 *
 * Tier: Unit (vitest, pure function, no Electron).
 */
import { describe, it, expect } from 'vitest';
import { detectEmbeddedSignInRefusal } from '../../src/main/browser/embedded-signin-refusal';

const SIGN_IN_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example.com';

describe('detectEmbeddedSignInRefusal', () => {
  it('matches Google\'s OAuth error path', () => {
    expect(
      detectEmbeddedSignInRefusal('https://accounts.google.com/signin/oauth/error/v2?authError=xyz', SIGN_IN_URL),
    ).toEqual({ provider: 'Google', signInUrl: SIGN_IN_URL });
  });

  it('carries the ORIGINAL sign-in URL through, not the error URL', () => {
    // The prompt's "open in my browser" action has to send the user to the page
    // the flow started at. Sending them to the error page would be useless.
    const result = detectEmbeddedSignInRefusal(
      'https://accounts.google.com/signin/oauth/error/v2?authError=xyz',
      SIGN_IN_URL,
    );
    expect(result?.signInUrl).toBe(SIGN_IN_URL);
  });

  it('does NOT match the sign-in page itself', () => {
    // The single most important negative: the popup lands here first on every
    // flow, including the ones that go on to succeed.
    expect(detectEmbeddedSignInRefusal(SIGN_IN_URL, SIGN_IN_URL)).toBeNull();
  });

  it('does not match a successful consent redirect', () => {
    expect(
      detectEmbeddedSignInRefusal('https://app.example.com/auth/callback?code=abc', SIGN_IN_URL),
    ).toBeNull();
  });

  it('does not match another host that happens to share the path', () => {
    // Host is checked exactly, so a lookalike domain cannot trigger a prompt that
    // names Google.
    expect(
      detectEmbeddedSignInRefusal('https://accounts.google.com.evil.test/signin/oauth/error/v2', SIGN_IN_URL),
    ).toBeNull();
  });

  it('matches case-insensitively on host and path', () => {
    expect(
      detectEmbeddedSignInRefusal('https://Accounts.Google.COM/Signin/OAuth/Error/v2', SIGN_IN_URL),
    ).not.toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['an unparseable string', 'not a url'],
    ['about:blank', 'about:blank'],
  ])('returns null for %s', (_label, navigatedUrl) => {
    expect(detectEmbeddedSignInRefusal(navigatedUrl, SIGN_IN_URL)).toBeNull();
  });
});
