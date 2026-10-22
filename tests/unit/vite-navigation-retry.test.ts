import { describe, it, expect } from 'vitest';
import { isRetryableViteNavigationError } from '../ui/vite-navigation-retry';

// Pins which `page.goto` failures against the Vite dev server navigateToVite (tests/ui/helpers.ts)
// retries. Before the predicate moved into its own module nothing covered it, so reverting the
// newest form (a goto interrupted by another navigation to the SAME url, matched through
// `new URL(url).href`) passed every test.
//
// The fixtures are the messages a caller receives, not strings guessed from the predicate. Two
// templates in node_modules/playwright-core/lib/coreBundle.js produce them:
//
//   - the frame's goto, when a second navigation commits first:
//       Navigation to "${url3}" is interrupted by another navigation to "${event.url}"
//   - the Chromium navigation, when the load itself fails (errorText is a Chromium net error):
//       ${response2.errorText} at ${url3}
//   - the timeout fixture, from the same file: Timeout ${timeout}ms exceeded.
//
// The client then rewrites the message twice before a caller sees it. The API-name zone prefixes
// `page.goto: `, and the connection layer appends the call log (formatCallLog: a "Call log:" line,
// then each progress line dimmed with ANSI escapes). The shape below was also read from a real
// `page.goto` against a closed port, where the connect-refused message arrived as
//   page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:59871/
//   Call log:
//     - navigating to "http://localhost:59871/", waiting until "load"
// (the log line wrapped in dim and undim escapes, a newline after it). Playwright completes the url
// before it navigates, so both templates carry the NORMALIZED url (trailing slash on a bare
// origin) while VITE_URL has none. Only the connect-refused message was observed from a live
// `page.goto`. The two interrupted-by-navigation fixtures are the template wrapped in that same
// observed prefix and call log.

const VITE_URL = 'http://localhost:5174';
const NORMALIZED_VITE_URL = 'http://localhost:5174/';

/** The message a caller of `page.goto` receives for a failure whose core message is `coreMessage`. */
function gotoFailure(coreMessage: string): Error {
  const dimmedLogLine = `\u001b[2m  - navigating to "${NORMALIZED_VITE_URL}", waiting until "load"\u001b[22m`;
  return new Error(`page.goto: ${coreMessage}\nCall log:\n${dimmedLogLine}\n`);
}

function interruptedBy(interruptingUrl: string): Error {
  return gotoFailure(
    `Navigation to "${NORMALIZED_VITE_URL}" is interrupted by another navigation to "${interruptingUrl}"`,
  );
}

describe('isRetryableViteNavigationError', () => {
  describe('retries a navigation that never reached the server or that a reload cut short', () => {
    it('retries a goto interrupted by another navigation to the same url, which Chromium reports with a trailing slash', () => {
      // Fails if `new URL(url).href` is replaced by `url`: the message names the normalized
      // `http://localhost:5174/`, so the bare `http://localhost:5174"` never matches.
      expect(isRetryableViteNavigationError(interruptedBy(NORMALIZED_VITE_URL), VITE_URL)).toBe(true);
    });

    it('retries a goto interrupted by Chromium committing its network error page', () => {
      expect(isRetryableViteNavigationError(interruptedBy('chrome-error://chromewebdata/'), VITE_URL)).toBe(true);
    });

    it('retries a refused connect', () => {
      const refused = gotoFailure(`net::ERR_CONNECTION_REFUSED at ${NORMALIZED_VITE_URL}`);
      expect(isRetryableViteNavigationError(refused, VITE_URL)).toBe(true);
    });

    it('matches a url that already carries its trailing slash', () => {
      expect(isRetryableViteNavigationError(interruptedBy(NORMALIZED_VITE_URL), NORMALIZED_VITE_URL)).toBe(true);
    });
  });

  describe('rethrows everything else', () => {
    it('rethrows a goto interrupted by a navigation to a different path on the same origin', () => {
      expect(isRetryableViteNavigationError(interruptedBy('http://localhost:5174/settings'), VITE_URL)).toBe(false);
    });

    it('rethrows a goto interrupted by a navigation to a different origin', () => {
      expect(isRetryableViteNavigationError(interruptedBy('http://localhost:3000/'), VITE_URL)).toBe(false);
    });

    it('rethrows a goto interrupted by a navigation to a different port that starts with the same digits', () => {
      expect(isRetryableViteNavigationError(interruptedBy('http://localhost:51740/'), VITE_URL)).toBe(false);
    });

    it('rethrows a timeout', () => {
      const timedOut = gotoFailure('Timeout 30000ms exceeded.');
      expect(isRetryableViteNavigationError(timedOut, VITE_URL)).toBe(false);
    });

    it('rethrows a net error other than a refused connect', () => {
      const nameNotResolved = gotoFailure(`net::ERR_NAME_NOT_RESOLVED at ${NORMALIZED_VITE_URL}`);
      expect(isRetryableViteNavigationError(nameNotResolved, VITE_URL)).toBe(false);
    });

    it('rethrows a string that carries a retryable message, since only an Error is a navigation failure', () => {
      const refusedAsString = `page.goto: net::ERR_CONNECTION_REFUSED at ${NORMALIZED_VITE_URL}`;
      expect(isRetryableViteNavigationError(refusedAsString, VITE_URL)).toBe(false);
    });

    it('rethrows a plain object that carries a retryable message', () => {
      const lookalike = { message: `page.goto: net::ERR_CONNECTION_REFUSED at ${NORMALIZED_VITE_URL}` };
      expect(isRetryableViteNavigationError(lookalike, VITE_URL)).toBe(false);
    });
  });
});
