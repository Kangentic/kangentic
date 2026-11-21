import { effectiveCombo } from './keybindings';
import { keyStateMatchesCombo } from './keyboard-combo-match';

// The Browser pane's tool shortcuts, matched in main against a key typed INTO
// the page. A key typed into a `<webview>` guest goes to the page and never
// reaches the app's own document, so `useKeybinding` cannot see it: right after
// a click in the page (opening the menu the user wants to mark), Select element
// and Draw would not answer their keys at all. Main matches these at the guest's
// `before-input-event`, keeps them from the page, and pushes them to the pane
// (`IPC.BROWSER_PANE_SHORTCUT`).
//
// Only the two tool toggles. Undo (`Mod+Z`) and Send (`Mod+Enter`) are the
// page's own keys in its text fields, so taking them would break text undo and
// form submit in every page. The two that are taken cost a page its own use of
// them: a web terminal that copies on Ctrl+Shift+C does not get that key while
// its page has focus.
//
// Both are `rebindable: false`, and main reads no user overrides, so the combo
// main matches is always the one the pane binds.

export const GUEST_INTERCEPTED_BROWSER_SHORTCUTS = ['browser.inspect', 'browser.draw'] as const;

export type GuestBrowserShortcut = (typeof GUEST_INTERCEPTED_BROWSER_SHORTCUTS)[number];

/** The fields of Electron's `Input` this reads. */
export interface GuestKeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  isComposing?: boolean;
}

/** Whether a keyDown satisfies a canonical keyboard combo, `Mod` resolved for the platform. */
function inputMatchesCombo(input: GuestKeyInput, combo: string, platform: string): boolean {
  if (!combo) return false;
  const isMac = platform === 'darwin';
  // Exactly the primary modifier the combo asks for: Ctrl+Cmd+Shift+D is not
  // Cmd+Shift+D. The shared match allows the other one, so it is checked here.
  if (combo.split('+').some((part) => part.toLowerCase() === 'mod') && (isMac ? input.control : input.meta)) {
    return false;
  }
  return keyStateMatchesCombo({
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    altKey: input.alt,
    shiftKey: input.shift,
  }, combo, isMac);
}

/** The tool shortcut a key typed into the page is, or null when the page keeps it. */
export function guestShortcutFor(input: GuestKeyInput, platform: string): GuestBrowserShortcut | null {
  if (input.type !== 'keyDown') return null;
  // An IME builds a character over several keystrokes; never take one of them.
  if (input.isComposing) return null;
  for (const shortcutId of GUEST_INTERCEPTED_BROWSER_SHORTCUTS) {
    if (inputMatchesCombo(input, effectiveCombo(shortcutId), platform)) return shortcutId;
  }
  return null;
}
