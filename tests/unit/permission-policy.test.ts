/**
 * Unit tests for the first-party renderer permission policy, and the separate,
 * far tighter policy for the embedded Browser pane's guest session.
 *
 * Regression guard for the clipboard bug: the default-session permission handlers
 * used to allow only 'media', so navigator.clipboard.readText()/writeText() threw
 * NotAllowedError and Ctrl+V paste plus every "copy to clipboard" button silently
 * no-op'd. The policy must grant the clipboard permissions while keeping unrelated
 * permissions (geolocation, notifications, ...) denied.
 *
 * isEmbeddedBrowserPermissionAllowed is covered here directly (the actual
 * allow/deny decisions), complementing tests/unit/window-open-policy.test.ts's
 * static scan of src/main/index.ts, which only proves BOTH the permission
 * request and check handlers read this one predicate - not what the predicate
 * itself decides.
 */
import { describe, it, expect } from 'vitest';
import { isFirstPartyPermissionAllowed, isEmbeddedBrowserPermissionAllowed } from '../../src/main/permission-policy';

describe('first-party renderer permission policy', () => {
  it('allows microphone media access for voice dictation', () => {
    expect(isFirstPartyPermissionAllowed('media')).toBe(true);
  });

  it('allows clipboard read and sanitized write for copy/paste', () => {
    // These are Electron's exact permission strings for the async Clipboard API.
    expect(isFirstPartyPermissionAllowed('clipboard-read')).toBe(true);
    expect(isFirstPartyPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it('denies every other permission', () => {
    const deniedPermissions = [
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'openExternal',
      'display-capture',
      'fullscreen',
      'idle-detection',
      'pointerLock',
      'fileSystem',
      'usb',
      'hid',
      'serial',
      // clipboard-write (unsanitized) is deliberately NOT granted; only the
      // sanitized variant (clipboard-sanitized-write) is in the allow-set.
      'clipboard-write',
      'unknown',
    ];
    for (const permission of deniedPermissions) {
      expect(isFirstPartyPermissionAllowed(permission)).toBe(false);
    }
  });
});

describe('embedded browser guest permission policy', () => {
  it('allows sanitized clipboard write (gesture-gated, write-only)', () => {
    // Electron's exact permission string for the async
    // navigator.clipboard.writeText() API. Adding a permission CHECK handler
    // for the guest (this change) means a blanket deny would newly break this
    // in the user's own dev server loaded in the pane - see the "far tighter
    // policy" comment on the source function for the full reasoning.
    expect(isEmbeddedBrowserPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it('denies clipboard READ, unlike the first-party policy', () => {
    // The one deliberate divergence from isFirstPartyPermissionAllowed above,
    // which DOES grant clipboard-read for the trusted app window. The
    // embedded pane is untrusted, agent-navigable web content, so it may only
    // WRITE to the clipboard, never read it.
    expect(isEmbeddedBrowserPermissionAllowed('clipboard-read')).toBe(false);
  });

  it('denies every other permission, including camera/mic/geo/notifications and the device APIs', () => {
    const deniedPermissions = [
      'media',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'openExternal',
      'display-capture',
      'fullscreen',
      'idle-detection',
      'pointerLock',
      'fileSystem',
      'usb',
      'hid',
      'serial',
      // Unsanitized clipboard write is deliberately NOT granted here either;
      // only the sanitized variant is in the allow-set.
      'clipboard-write',
      'unknown',
    ];
    for (const permission of deniedPermissions) {
      expect(isEmbeddedBrowserPermissionAllowed(permission)).toBe(false);
    }
  });
});
