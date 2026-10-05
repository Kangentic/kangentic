/**
 * Names the renderers the Sentry SDK reports on (its `getRendererName` option),
 * so a crash in a Browser pane page can be told apart from a crash in
 * Kangentic's own UI.
 *
 * Both kinds of process are Kangentic.exe running Chromium, so the minidump's
 * module list says "ours" for either (native-crash-event.ts). What differs is
 * whose CONTENT they hold. A pane guest runs the user's dev app, and its crash
 * event carries that page: `contexts.electron.crashed_url` names the page, and
 * since Electron 42 (electron/electron#50043) a guest nearing its V8 heap limit
 * writes its JavaScript stack into a Crashpad annotation, which the SDK turns
 * into exception frames. native-crash-event.ts reduces such an event to a
 * grouped warning that keeps the counts and drops the page; this module is
 * what lets it find one.
 *
 * Two kinds of surface hold a user's page: a `<webview>` guest (the visible
 * Browser pane) and a lane, an offscreen BrowserWindow an agent drives when no
 * pane can mount. The first identifies itself through `getType()`. The second is
 * a plain 'window', so the lane manager answers for it through a predicate
 * registered from index.ts, which keeps this analytics module free of a
 * dependency on the browser layer.
 *
 * Kangentic's own windows (the main window, pop-outs) return undefined, which
 * the SDK turns into its default 'renderer', so their events and issue titles
 * are unchanged.
 */

import type { WebContents } from 'electron';

/** The `event.process` tag, and the name in `'<name>' process exited with ...`. */
export const BROWSER_GUEST_RENDERER_NAME = 'browser-guest';

type LaneWebContentsPredicate = (webContentsId: number) => boolean;

let isLaneWebContents: LaneWebContentsPredicate = () => false;

/** Registered once from index.ts with the lane manager's lookup. */
export function setLaneWebContentsPredicate(predicate: LaneWebContentsPredicate): void {
  isLaneWebContents = predicate;
}

/**
 * The SDK's `getRendererName`. Must never throw: the SDK calls it from inside
 * its crash and breadcrumb handlers, and an exception there would cost the event.
 */
export function rendererNameForReporting(contents: Pick<WebContents, 'id' | 'getType'>): string | undefined {
  try {
    if (contents.getType() === 'webview') return BROWSER_GUEST_RENDERER_NAME;
    if (isLaneWebContents(contents.id)) return BROWSER_GUEST_RENDERER_NAME;
  } catch {
    // A destroyed WebContents can throw on getType(); report it as ours.
  }
  return undefined;
}

/** For tests: forget the registered lane predicate. */
export function resetRendererClassificationForTests(): void {
  isLaneWebContents = () => false;
}
