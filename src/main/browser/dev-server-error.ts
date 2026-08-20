import type { WebContents } from 'electron';
import { runtimeEvaluate } from './cdp/cdp';

/**
 * Detect a dev server's build-error overlay so a tool can report it as an
 * ERROR instead of answering with it.
 *
 * The failure this removes: a build breaks, the dev server paints a full-screen
 * error overlay, and `kangentic_browser_screenshot` faithfully returns a picture
 * of it. The agent then spends a turn working out that the red rectangle is not
 * the app - and when several agents share one dev server, the one that reads the
 * overlay is usually not the one that broke the build, so it has no reason to
 * suspect a build error at all.
 *
 * Detection is by CUSTOM ELEMENT, not by scraping text: Vite renders
 * `<vite-error-overlay>` with its content in a shadow root, so its message never
 * appears in `document.body.innerText` and no text-based check would see it.
 *
 * Deliberately framework-shaped rather than a generic heuristic. Absence of a
 * known overlay means "no error detected", never "the page is fine", so a dev
 * server this does not recognize simply behaves exactly as it does today. That
 * is the honest failure direction: a missed overlay costs what it costs now, a
 * false positive would break a working tool.
 */

/** Overlays we can recognize, and how to pull their message out. */
const OVERLAY_PROBE = `(() => {
  const overlay = document.querySelector('vite-error-overlay');
  if (overlay) {
    const root = overlay.shadowRoot;
    const message = root && root.querySelector('.message-body');
    const file = root && root.querySelector('.file');
    return {
      kind: 'vite',
      message: message ? message.textContent.trim() : 'Vite reported a build error.',
      file: file ? file.textContent.trim() : null,
    };
  }
  // Next.js / webpack overlays render into a portal with a stable id.
  const nextOverlay = document.querySelector('nextjs-portal');
  if (nextOverlay) {
    return { kind: 'next', message: 'The Next.js dev overlay is showing a build or runtime error.', file: null };
  }
  return null;
})()`;

export interface DevServerError {
  kind: 'vite' | 'next';
  message: string;
  file: string | null;
}

/**
 * Returns the dev server's reported build error, or null.
 *
 * Never throws and never reports an error of its own: a probe that cannot run
 * (no CDP, a page mid-navigation, a hostile CSP) must degrade to "nothing
 * detected" rather than turning a working tool call into a failure.
 */
export async function detectDevServerError(webContents: WebContents): Promise<DevServerError | null> {
  const result = await runtimeEvaluate<DevServerError | null>(webContents, OVERLAY_PROBE);
  if (result.error || !result.value) return null;
  return result.value;
}

/** One-line detail for the `dev-server-error` envelope. */
export function describeDevServerError(error: DevServerError): string {
  const where = error.file ? ` (${error.file})` : '';
  return (
    `The dev server is showing a build error${where}, so the page is not rendering your app: ` +
    `${error.message} ` +
    'Fix the build (or wait for whoever is editing to fix it) and retry. ' +
    'If another agent is working in this same worktree, the error may be theirs, not yours.'
  );
}
