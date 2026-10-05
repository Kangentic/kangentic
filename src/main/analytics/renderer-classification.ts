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
 * Three kinds of surface hold a user's page: a `<webview>` guest (the visible
 * Browser pane), a popup the page opened with `window.open` (a chromed
 * BrowserWindow, window-open-policy.ts), and a lane, an offscreen BrowserWindow
 * an agent drives when no pane can mount. The code that creates each one marks
 * its webContents here (`markBrowserGuestWebContents`) at creation, so this
 * module depends on nothing in the browser layer.
 *
 * The mark is never removed, because the SDK names a crashed renderer LATE. Its
 * live crash path calls getRendererName only once the dump has been written and
 * stopped changing, which its minidump loader polls for up to 5 s. A surface
 * closed inside that window is gone from every live registry, and a destroyed
 * guest throws on `getType()`, so a lookup of live surfaces would let exactly
 * that crash ship its page. Electron documents a webContents id as unique among
 * all WebContents of the app, so a kept mark cannot misname one of our own
 * windows, and the set grows by one number per surface opened.
 *
 * Kangentic's own windows (the main window, pop-outs) return undefined. The
 * SDK's breadcrumb and abnormal-exit paths turn that into their default
 * ('window', 'renderer'), so those are unchanged. Its live native-crash path
 * turns it into 'unknown' instead, and beforeSend puts 'renderer' back
 * (restoreOwnRendererProcessTag in native-crash-event.ts).
 */

import type { WebContents } from 'electron';

/** The `event.process` tag, and the name in `'<name>' process exited with ...`. */
export const BROWSER_GUEST_RENDERER_NAME = 'browser-guest';

const browserGuestWebContentsIds = new Set<number>();

/** Called by the code that creates a guest, a pane popup, or a lane, with its webContents id. */
export function markBrowserGuestWebContents(webContentsId: number): void {
  browserGuestWebContentsIds.add(webContentsId);
}

/**
 * The SDK's `getRendererName`. Must never throw: the SDK calls it from inside
 * its crash and breadcrumb handlers, and an exception there would cost the event.
 */
export function rendererNameForReporting(contents: Pick<WebContents, 'id' | 'getType'>): string | undefined {
  try {
    if (contents.getType() === 'webview') return BROWSER_GUEST_RENDERER_NAME;
  } catch {
    // A destroyed WebContents throws on getType(); the mark below still answers.
  }
  try {
    if (browserGuestWebContentsIds.has(contents.id)) return BROWSER_GUEST_RENDERER_NAME;
  } catch {
    // An unreadable id leaves the renderer ours.
  }
  return undefined;
}

/** For tests: forget every mark. */
export function resetRendererClassificationForTests(): void {
  browserGuestWebContentsIds.clear();
}
