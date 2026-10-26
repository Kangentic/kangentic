/**
 * How gotoVite (helpers.ts) navigates to the Vite dev server and answers a `page.goto` failure. Its
 * doc comment above gotoVite records where each form was seen. This module imports nothing, so the
 * unit tier can pin it without loading @playwright/test. tests/unit/vite-navigation-retry.test.ts
 * pins the classifier, and tests/unit/navigate-to-vite.test.ts drives navigateToVite with a fake page.
 */

/** A connect that never reached the server, in either of the two forms Playwright reports it. */
const VITE_UNREACHED_MARKERS = ['net::ERR_CONNECTION_REFUSED', 'chrome-error://chromewebdata/'];

/**
 * - `unreached`: the navigation never reached the server. navigateToVite waits for the server and
 *   navigates again.
 * - `superseded`: another navigation to the same url took the goto's place. navigateToVite adopts
 *   that navigation instead of starting a third one that races it.
 * - `fatal`: anything else, rethrown.
 */
export type ViteNavigationFailure = 'unreached' | 'superseded' | 'fatal';

/**
 * Sorts a `page.goto` failure into a ViteNavigationFailure. Only an Error is a navigation failure.
 *
 * A superseded goto reaches the caller in one of two forms, depending on which Chromium reports
 * first. "interrupted by another navigation to <url>" when the other document commits before the
 * goto's own navigation reports its end: Playwright throws that only for a document that committed
 * without error, so the page is already at the url. `net::ERR_ABORTED at <url>` when Chromium
 * reports the goto's navigation cancelled first, which a reload of the same url while the goto is
 * pending produces. Chromium reports the url normalized (`http://localhost:5174/` for a url with no
 * trailing slash), so both matches use `new URL(url).href`.
 */
export function classifyViteNavigationError(error: unknown, url: string): ViteNavigationFailure {
  if (!(error instanceof Error)) return 'fatal';
  if (VITE_UNREACHED_MARKERS.some((marker) => error.message.includes(marker))) return 'unreached';
  const href = new URL(url).href;
  if (error.message.includes(`interrupted by another navigation to "${href}"`)) return 'superseded';
  // The url ends the line here, with no closing quote to bound it, so a longer url on the same
  // origin must not match as a prefix.
  if (new RegExp(`net::ERR_ABORTED at ${escapeRegExp(href)}(?:\\s|$)`).test(error.message)) return 'superseded';
  return 'fatal';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The part of a Playwright Page that navigateToVite drives. */
export interface ViteNavigationPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
  waitForEvent(event: 'load', options: { timeout: number }): Promise<unknown>;
}

export interface ViteNavigationOptions {
  /** How many gotos to start before a failure is rethrown. */
  attempts: number;
  /** How long to wait for the navigation that superseded a goto to reach load. */
  adoptTimeoutMs: number;
  /** How many main-frame load events have fired, counted by a listener attached before the first goto. */
  loadCount: () => number;
  isTimeoutError: (error: unknown) => boolean;
  /** Resolves once the server answers again, before the next goto. */
  waitForServer: () => Promise<void>;
  /** What navigated the page so far, for the warning lines. */
  describeNavigations: () => string;
  warn: (line: string) => void;
}

/**
 * `page.goto(url)`. Retries an `unreached` goto after the server answers again, adopts a
 * `superseded` one, and rethrows a `fatal` one. Any failure on the last attempt is rethrown unless
 * its navigation was adopted.
 */
export async function navigateToVite(page: ViteNavigationPage, url: string, options: ViteNavigationOptions): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const loadsBeforeGoto = options.loadCount();
    try {
      await page.goto(url);
      return;
    } catch (error) {
      const failure = classifyViteNavigationError(error, url);
      if (failure === 'fatal') throw error;
      const firstLine = error instanceof Error ? error.message.split('\n')[0] : String(error);
      options.warn(`[gotoVite] goto ${attempt} of ${options.attempts} was ${failure}: ${firstLine}. ${options.describeNavigations()}`);
      if (failure === 'superseded' && (await adoptNavigationInFlight(page, url, options.loadCount() > loadsBeforeGoto, options))) return;
      if (attempt >= options.attempts) throw error;
      await options.waitForServer();
    }
  }
}

/**
 * Waits for the document that superseded a goto to load. True when the page loaded at `url`, so
 * gotoVite's mount check judges that document. False when it did not load in time or ended at
 * another url, and the caller goes back to goto.
 *
 * Playwright keeps the old document's load state until the new document commits, and a goto
 * reported as `net::ERR_ABORTED` rejects before that commit. A probe of a goto superseded by a
 * reload of the same url saw the rejection 600 ms before the new document committed, and
 * waitForLoadState resolved at once on the old document. On a page already at `url` that would
 * pass the url check. So unless a load fired after the goto began, this waits for the next one.
 */
async function adoptNavigationInFlight(
  page: ViteNavigationPage,
  url: string,
  loadedSinceGoto: boolean,
  options: ViteNavigationOptions,
): Promise<boolean> {
  try {
    if (loadedSinceGoto) await page.waitForLoadState('load', { timeout: options.adoptTimeoutMs });
    else await page.waitForEvent('load', { timeout: options.adoptTimeoutMs });
  } catch (error) {
    if (!options.isTimeoutError(error)) throw error;
    // No "navigating again": on the last attempt navigateToVite rethrows instead.
    options.warn(`[gotoVite] the navigation that superseded goto did not reach load within ${options.adoptTimeoutMs} ms`);
    return false;
  }
  if (page.url() === new URL(url).href) return true;
  options.warn(`[gotoVite] the navigation that superseded goto ended at ${page.url()}`);
  return false;
}
