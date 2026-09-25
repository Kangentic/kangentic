import type { WebContents } from 'electron';

/**
 * The Browser pane's user agent: Chromium's own string with the
 * `Electron/<version>` token removed, and `Kangentic/<version>` kept.
 *
 * WHY. Some web application firewalls reject any user agent carrying
 * `Electron/` as a bot. Such a host answers with an HTML block page in place of
 * the CSS or JavaScript asked for, and Chromium's Opaque Response Blocking then
 * discards it, so a page loading its assets from that host renders unstyled in
 * the pane while Chrome shows it correctly. Measured with curl, varying only the
 * user agent: the token was the one trigger, and `Kangentic/0.43.0` without it
 * got the CSS. Client hints carry no Electron brand, so the string is the only
 * thing to change.
 *
 * This reverses the rejection recorded in decision 15 of
 * `docs/embedded-browser.md`; decision 41 records why and what it costs.
 */

/** Idempotent, and a no-op on a string that carries no Electron token. */
export function stripElectronToken(userAgent: string): string {
  return userAgent.replace(/ Electron\/\S+/, '');
}

/**
 * Present a Browser pane guest without the Electron token.
 *
 * Both calls are needed, and each was measured failing without the other
 * against a real guest. `session.setUserAgent` does not reach a WebContents
 * that already exists, because each one takes the session's value when it is
 * created, so the session call covers what is created LATER in this jar
 * (sign-in popups, a second pane, an offscreen lane) and the guest's own call
 * covers the guest that is already here. A popup does not inherit from its
 * opener, only from the session.
 */
export function applyBrowserUserAgent(guest: WebContents): void {
  const userAgent = stripElectronToken(guest.session.getUserAgent());
  guest.session.setUserAgent(userAgent);
  guest.setUserAgent(userAgent);
}
