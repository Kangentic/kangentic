import type { Session } from 'electron';
import { isEmbeddedBrowserPermissionAllowed } from '../permission-policy';
import { installWebviewDownloadPolicy } from './webview-download-policy';

/**
 * The policy every Session that holds a user's page needs, wherever that page is
 * rendered: the visible Browser pane's `<webview>` guest, and the offscreen lane
 * that stands in for it when no pane can mount.
 *
 * - Permission requests AND checks go through one predicate
 *   (`isEmbeddedBrowserPermissionAllowed`), so an agent-navigated page cannot get
 *   camera, microphone, geolocation or notifications. With no handler installed,
 *   Electron GRANTS every request, which is why this cannot be left to whichever
 *   surface happens to touch the partition first.
 * - Downloads save to the OS Downloads folder instead of opening Chromium's
 *   native save dialog, which would block an agent-driven page.
 *
 * Both install on the Session, so popups that share it inherit them. Calling this
 * again for the same Session is harmless: the permission handlers are setters
 * and the download policy guards itself per Session.
 *
 * It lived inline in the `<webview>` branch of `web-contents-created` until a
 * lane turned out to bypass it: a lane is a BrowserWindow, never a `<webview>`,
 * so a lane opened before any pane had used its task's partition in this run
 * ran with Electron's grant-everything default.
 */
export function installEmbeddedBrowserSessionPolicy(guestSession: Session): void {
  guestSession.setPermissionRequestHandler((_requestingContents, permission, callback) =>
    callback(isEmbeddedBrowserPermissionAllowed(permission)));
  guestSession.setPermissionCheckHandler((_requestingContents, permission) =>
    isEmbeddedBrowserPermissionAllowed(permission));
  installWebviewDownloadPolicy(guestSession);
}
