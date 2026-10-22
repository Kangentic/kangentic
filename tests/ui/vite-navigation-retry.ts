/**
 * Which `page.goto` failures against the Vite dev server navigateToVite (helpers.ts) retries. Its
 * doc comment above gotoVite records where each form was seen. This module imports nothing, so
 * tests/unit/vite-navigation-retry.test.ts can pin it without loading @playwright/test.
 */

/** A connect that never reached the server, in either of the two forms Playwright reports it. */
const VITE_UNREACHED_MARKERS = ['net::ERR_CONNECTION_REFUSED', 'chrome-error://chromewebdata/'];

/**
 * True for a navigation that never reached the server, or that a reload of the same url cut
 * short. Chromium reports the interrupting url normalized (`http://localhost:5174/` for a url
 * with no trailing slash), so the match uses `new URL(url).href`.
 */
export function isRetryableViteNavigationError(error: unknown, url: string): boolean {
  if (!(error instanceof Error)) return false;
  if (VITE_UNREACHED_MARKERS.some((marker) => error.message.includes(marker))) return true;
  return error.message.includes(`interrupted by another navigation to "${new URL(url).href}"`);
}
