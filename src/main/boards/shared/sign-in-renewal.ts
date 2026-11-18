/**
 * When a browser sign-in is renewed with no import asking for it.
 *
 * A provider's refresh token lapses when it goes unused: Linear's 30 days after
 * the last refresh, Atlassian's after 90. The adapters renew only on a read, so a
 * user who opens Kangentic every day and imports once a month was signed out.
 * `BoardAdapter.keepSignInAlive` renews a sign-in once it is this old, which keeps
 * it for anyone who opens the app inside the provider's window.
 */
export const SIGN_IN_RENEWAL_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * True when a sign-in last saved at `savedAt` (UTC ISO 8601, written by the
 * sign-in and by every refresh) is due. A save time that does not parse is due:
 * its age is unknown, and a renewal writes a real one.
 */
export function isSignInRenewalDue(savedAt: string, now: number): boolean {
  const savedAtMs = Date.parse(savedAt);
  return !Number.isFinite(savedAtMs) || now - savedAtMs >= SIGN_IN_RENEWAL_AFTER_MS;
}
