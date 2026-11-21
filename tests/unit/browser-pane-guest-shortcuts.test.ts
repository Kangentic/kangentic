/**
 * Which keys typed INTO a Browser pane's page main takes for the pane's tools.
 *
 * A key the guest holds never reaches the app's document, so main matches the
 * Select element and Draw shortcuts at the guest and keeps them from the page.
 * Taking a key the page needs (text undo, form submit) breaks every page, and
 * missing one leaves the tool deaf right after a click in the page.
 */
import { describe, expect, it } from 'vitest';
import {
  GUEST_INTERCEPTED_BROWSER_SHORTCUTS,
  guestShortcutFor,
  type GuestKeyInput,
} from '../../src/shared/browser-pane-guest-shortcuts';
import { getKeybinding } from '../../src/shared/keybindings';

function keyDown(key: string, modifiers: Partial<GuestKeyInput> = {}): GuestKeyInput {
  return {
    type: 'keyDown',
    key,
    code: `Key${key.toUpperCase()}`,
    control: false,
    meta: false,
    shift: false,
    alt: false,
    isComposing: false,
    ...modifiers,
  };
}

describe('guestShortcutFor', () => {
  it('takes Ctrl+Shift+D and Ctrl+Shift+C off macOS', () => {
    expect(guestShortcutFor(keyDown('D', { control: true, shift: true }), 'win32')).toBe('browser.draw');
    expect(guestShortcutFor(keyDown('C', { control: true, shift: true }), 'linux')).toBe('browser.inspect');
  });

  it('takes Cmd on macOS and leaves Ctrl there to the page', () => {
    expect(guestShortcutFor(keyDown('D', { meta: true, shift: true }), 'darwin')).toBe('browser.draw');
    expect(guestShortcutFor(keyDown('D', { control: true, shift: true }), 'darwin')).toBeNull();
    expect(guestShortcutFor(keyDown('D', { meta: true, control: true, shift: true }), 'darwin')).toBeNull();
  });

  it('needs exactly the combo: no Shift, an extra Alt, or no modifier stays with the page', () => {
    expect(guestShortcutFor(keyDown('d', { control: true }), 'win32')).toBeNull();
    expect(guestShortcutFor(keyDown('D', { control: true, shift: true, alt: true }), 'win32')).toBeNull();
    expect(guestShortcutFor(keyDown('D', { shift: true }), 'win32')).toBeNull();
    expect(guestShortcutFor(keyDown('D', { meta: true, shift: true }), 'win32')).toBeNull();
  });

  it('matches by character, so a layout that puts D elsewhere still works', () => {
    expect(guestShortcutFor(keyDown('D', { control: true, shift: true, code: 'KeyH' }), 'win32')).toBe('browser.draw');
    expect(guestShortcutFor(keyDown('E', { control: true, shift: true, code: 'KeyD' }), 'win32')).toBeNull();
  });

  it('never takes a key mid-composition or a key release', () => {
    expect(guestShortcutFor(keyDown('D', { control: true, shift: true, isComposing: true }), 'win32')).toBeNull();
    expect(guestShortcutFor({ ...keyDown('D', { control: true, shift: true }), type: 'keyUp' }, 'win32')).toBeNull();
  });

  it('takes only shortcuts no user can rebind, since main reads no overrides', () => {
    for (const shortcutId of GUEST_INTERCEPTED_BROWSER_SHORTCUTS) {
      expect(getKeybinding(shortcutId)?.rebindable, shortcutId).toBe(false);
    }
  });

  it('leaves Undo and Send to the page, whose text fields use them', () => {
    expect(guestShortcutFor(keyDown('z', { control: true }), 'win32')).toBeNull();
    expect(guestShortcutFor({ ...keyDown('Enter', { control: true }), code: 'Enter' }, 'win32')).toBeNull();
    expect(guestShortcutFor(keyDown('z', { meta: true }), 'darwin')).toBeNull();
  });
});
