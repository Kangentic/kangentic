/**
 * Unit tests for the first-party renderer permission policy.
 *
 * Regression guard for the clipboard bug: the default-session permission handlers
 * used to allow only 'media', so navigator.clipboard.readText()/writeText() threw
 * NotAllowedError and Ctrl+V paste plus every "copy to clipboard" button silently
 * no-op'd. The policy must grant the clipboard permissions while keeping unrelated
 * permissions (geolocation, notifications, ...) denied.
 */
import { describe, it, expect } from 'vitest';
import { isFirstPartyPermissionAllowed } from '../../src/main/permission-policy';

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
