/**
 * Detects an identity provider refusing to sign in inside an embedded browser.
 *
 * Google has rejected OAuth from embedded user agents since 2017, and the check
 * is user-agent based: a top-level Electron `BrowserWindow` popup carries the
 * same `Electron/<version>` token as the `<webview>` guest that opened it, so it
 * is refused too. Allowing popups therefore turns a dead sign-in button into a
 * visible `Error 403: disallowed_useragent`, which is a strict improvement but
 * still a dead end for the user unless someone says so.
 *
 * SPOOFING THE USER AGENT IS THE REJECTED FIX, deliberately, and this module is
 * the reason it does not have to be reconsidered every time someone hits the
 * wall. `<webview useragent>` is already typed and is one attribute away, but:
 * the block is a deliberate Google anti-phishing control rather than a bug; a
 * spoofed UA would misrepresent Kangentic to every site the pane visits, not
 * just to Google; and the token list it would have to defeat is a moving target.
 * See `docs/embedded-browser.md` decision 15.
 *
 * WHAT THIS CAN AND CANNOT SEE. The `disallowed_useragent` string lives in the
 * page Google renders, not in the URL, so this predicate detects "the provider
 * returned an OAuth error", not specifically the user-agent refusal. The prompt
 * copy it drives must be hedged to match that precision: the embedded-browser
 * block is the usual cause, not a certainty.
 */

export interface EmbeddedSignInRefusal {
  /** Display name for the prompt, e.g. `Google`. */
  provider: string;
  /** The URL the popup was opened with, for the "open in my browser" action. */
  signInUrl: string;
}

/**
 * One row per provider. Kept table-driven so a second provider is a row rather
 * than a branch, and so the shape a signature matches on stays visible.
 *
 * UNVERIFIED AGAINST A LIVE REFUSAL. This signature was written from Google's
 * documented behavior, not captured from a real `disallowed_useragent` bounce -
 * the live repro that motivated it was never re-run end to end. The failure mode
 * if it is wrong is benign (the popup shows Google's own error and no prompt
 * appears, which is exactly today's behavior without this module), but do not
 * read a passing unit test as evidence the URL shape is right: the tests pin the
 * matching logic against this table, not the table against Google.
 */
const REFUSAL_SIGNATURES: readonly { provider: string; host: string; pathIncludes: string }[] = [
  { provider: 'Google', host: 'accounts.google.com', pathIncludes: '/signin/oauth/error' },
];

/**
 * `navigatedUrl` is where the popup has just landed; `signInUrl` is where it was
 * opened. Returns null for anything unparseable or unmatched, so the caller can
 * treat a null as "carry on, nothing to say".
 */
export function detectEmbeddedSignInRefusal(
  navigatedUrl: string,
  signInUrl: string,
): EmbeddedSignInRefusal | null {
  let parsed: URL;
  try {
    parsed = new URL(navigatedUrl);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  for (const signature of REFUSAL_SIGNATURES) {
    if (host === signature.host && path.includes(signature.pathIncludes)) {
      return { provider: signature.provider, signInUrl };
    }
  }
  return null;
}
