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
 * This policy governs ONLY the default session (the first-party app window). The
 * embedded browser webview is untrusted guest content and is governed by its own
 * deny-all handler in `index.ts`; it is not covered here.
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
