/**
 * Permission policy for the first-party renderer (the Kangentic app window).
 *
 * The app window is trusted UI, not arbitrary web content, so it is granted the
 * handful of web-platform permissions it actually uses:
 *
 *  - `media`: getUserMedia microphone access for voice-to-text dictation.
 *  - `clipboard-read` / `clipboard-sanitized-write`: the async Clipboard API used
 *    by terminal copy/paste and the various "copy to clipboard" affordances
 *    (copy task id, copy login command, copy session id, copy file path, ...).
 *    Without these, `navigator.clipboard.readText()` / `writeText()` throw
 *    `NotAllowedError` and the actions silently no-op. The permission strings are
 *    Electron's exact values for both `setPermissionCheckHandler` and
 *    `setPermissionRequestHandler`.
 *
 * Everything else (geolocation, notifications, openExternal, ...) stays denied.
 *
 * The embedded browser webview is untrusted guest content with its own, far
 * tighter policy - `isEmbeddedBrowserPermissionAllowed` below.
 */
const ALLOWED_FIRST_PARTY_PERMISSIONS = new Set<string>([
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
]);

/**
 * Returns true when the first-party renderer is allowed to use `permission`.
 * Used by both the default session's permission check and request handlers so
 * the two stay in lockstep.
 */
export function isFirstPartyPermissionAllowed(permission: string): boolean {
  return ALLOWED_FIRST_PARTY_PERMISSIONS.has(permission);
}

/**
 * Permissions the embedded Browser pane - and the popups it opens, which share
 * its `Session` - may use.
 *
 * The pane is untrusted web content that an AGENT can navigate, so this stays far
 * tighter than the first-party set: camera, microphone, geolocation,
 * notifications, MIDI, serial, HID, USB, and fullscreen all stay denied, per
 * `docs/embedded-browser.md` decision 5.
 *
 * `clipboard-sanitized-write` is the one grant, and it is here for a specific
 * reason rather than as a convenience. This pass added a permission CHECK handler
 * where the pane previously had only a REQUEST handler, so synchronous checks now
 * consult this predicate instead of falling through to Electron's default. A
 * blanket deny would therefore NEWLY break `navigator.clipboard.writeText()` in
 * the user's own dev server - a regression dressed up as hardening. The
 * permission is gesture-gated, cannot READ the clipboard, and is what a real
 * browser allows without prompting. Clipboard READ stays denied.
 *
 * See `docs/embedded-browser.md` decision 14.
 */
const ALLOWED_EMBEDDED_BROWSER_PERMISSIONS = new Set<string>([
  'clipboard-sanitized-write',
]);

export function isEmbeddedBrowserPermissionAllowed(permission: string): boolean {
  return ALLOWED_EMBEDDED_BROWSER_PERMISSIONS.has(permission);
}
