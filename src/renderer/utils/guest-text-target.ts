/**
 * Reaching a text field INSIDE a Browser pane's guest page.
 *
 * The guest is a separate renderer process, so none of `text-target.ts` applies
 * to it directly: the host cannot touch the guest's DOM, and from the host side
 * `document.activeElement` is only ever the `<webview>` element itself - it
 * cannot say which field inside has focus.
 *
 * WHAT MAKES THIS CHEAP. `<webview>.executeJavaScript` runs a string in the
 * guest and resolves with its value, straight from the renderer. Measured
 * against a live guest: 1ms to read the focused element, 2ms to write into it.
 * That is NOT the CDP driver - it does not go through `withGuest`, does not
 * emit the agent-input signal, and so never flashes "Agent typing here" or arms
 * the focus guard on the user's own dictation. `BrowserPane` already uses the
 * same call for Inspect mode.
 *
 * WHAT IS DELIBERATELY NOT DONE IN THE GUEST. The injected scripts are as small
 * as they can be: read some facts, or write one exact string. Every decision -
 * is this field eligible, may it auto-submit, what should the value become -
 * stays host-side in `text-target.ts`, so there is one implementation of each
 * rule rather than a second copy living in a template literal where no test can
 * reach it.
 *
 * DICTATION NEVER SUBMITS IN A GUEST - there is deliberately no submit script
 * here, only probe and write. Auto-submit means pressing Enter, and in someone
 * else's page that commits a form we know nothing about: a login, a payment, a
 * "type DELETE to confirm". An earlier version ran the host's multi-field rule
 * on the guest's own form, which was strictly worse than not trying - it is our
 * INFERENCE about a page we do not control, and a single-field form is not
 * automatically safe. Filling the field and letting the person press Enter costs
 * one keystroke and removes the whole class of wrong guesses.
 *
 * KNOWN LIMITATION: `executeJavaScript` runs in the guest's TOP frame only, so a
 * field inside a cross-origin iframe is unreachable. That is a property of the
 * API, not a gap to close later.
 */

import type { WebviewElement } from '../components/browser/webview-types';

/**
 * What the host needs to know about the guest's focused field.
 *
 * OPTIONAL IS NOT COSMETIC HERE. `executeJavaScript` returns whatever the guest
 * hands back, and the generic on the call is an assertion, not a check - so this
 * type is the only thing standing between a refusal and a `TypeError`. The
 * script's refusal branches genuinely omit most of these (`none` before a field
 * is even identified carries nothing at all), so they are declared the way they
 * actually arrive and every reader is forced to narrow on `eligible` first.
 */
/** The field's rect in GUEST viewport coordinates, for anchoring the chip. The
 *  host converts to its own space. */
export interface GuestFieldRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface GuestFieldAccepted {
  eligible: true;
  reason: 'ok';
  /** The field's value and selection at probe time, so the host can compose
   *  revisions against a stable anchor. */
  value: string;
  selectionStart: number;
  selectionEnd: number;
  rect: GuestFieldRect;
  /** True when the field is a `contenteditable` host rather than an input. It
   *  is written by a different route (Selection + `insertText`) and never
   *  auto-submits, because Enter in a rich-text editor means newline. */
  richText: boolean;
}

interface GuestFieldRefused {
  eligible: false;
  /** `password` is the one the user must be TOLD about: they focused a real
   *  field and we are declining on purpose, which is a different thing from
   *  having focused nothing. */
  reason: 'password' | 'not-text' | 'none';
  /** Present whenever the refusal named a FIELD (`password`, `not-text`), so the
   *  chip can sit against it while it explains itself. A `none` refusal found
   *  nothing to anchor to and carries no rect. */
  rect?: GuestFieldRect;
}

export type GuestFieldProbe = GuestFieldAccepted | GuestFieldRefused;

/**
 * Read the guest's focused field.
 *
 * The eligibility rules mirror `isTextTarget`'s, and are written out rather than
 * imported because this string is evaluated in another process. The pairing that
 * matters most: `password` is excluded here for the same reason it is in
 * `isPasswordField`, and a guest login form is precisely where that would
 * otherwise bite - so those two must change together. The host's other two
 * exclusions have no twin here on purpose: xterm's helper textarea and
 * `data-no-text-target` are both OUR markup, and neither can occur in a page we
 * did not render.
 */
const PROBE_SCRIPT = `(() => {
  const active = document.activeElement;
  if (!active) return { eligible: false, reason: 'none' };
  const tag = active.tagName;
  const rect = active.getBoundingClientRect();
  // A rich-text host qualifies, and is reported before the input checks below
  // because it has neither a tagName nor a type they would recognise.
  if (active.isContentEditable) {
    return {
      eligible: true,
      reason: 'ok',
      richText: true,
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }
  // The rect comes back even on a refusal, so the chip can sit against the field
  // the user is actually looking at while it explains why nothing is happening.
  const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return { eligible: false, reason: 'none' };
  const type = tag === 'TEXTAREA' ? 'textarea' : (active.type || '').toLowerCase();
  if (type === 'password') return { eligible: false, reason: 'password', rect: box };
  if (active.disabled || active.readOnly) return { eligible: false, reason: 'not-text', rect: box };
  const accepted = ['', 'text', 'search', 'url', 'email', 'tel', 'textarea'];
  if (accepted.indexOf(type) === -1) return { eligible: false, reason: 'not-text', rect: box };
  return {
    eligible: true,
    reason: 'ok',
    richText: false,
    value: active.value == null ? '' : String(active.value),
    selectionStart: active.selectionStart == null ? String(active.value || '').length : active.selectionStart,
    selectionEnd: active.selectionEnd == null ? String(active.value || '').length : active.selectionEnd,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
})()`;

/**
 * Probe the guest's focused field. Returns the whole result, INCLUDING refusals,
 * because the caller has to tell "declined a real field" from "found nothing" -
 * the first deserves an explanation on screen and a chip anchored to the field.
 */
export async function probeGuestField(webview: WebviewElement): Promise<GuestFieldProbe | null> {
  try {
    return await webview.executeJavaScript<GuestFieldProbe>(PROBE_SCRIPT);
  } catch {
    // The guest navigated, crashed, or is not attached. Indistinguishable from
    // "nothing focused" as far as the caller is concerned.
    return null;
  }
}

/**
 * Write an exact value into the guest's focused field.
 *
 * Uses the same native-setter-plus-`input`-event technique as the host path, and
 * for the same reason: the guest page may itself be a React app, and a plain
 * `.value` assignment would leave its state stale and be reverted on the next
 * render. Re-checks the tag inside the guest, because focus can move between the
 * probe and the write.
 */
const WRITE_SCRIPT = `(value, caret, previousLength) => {
  const active = document.activeElement;
  if (!active) return false;
  if (active.isContentEditable) {
    // Same route as the host path: select back over our own last insertion and
    // replace it, so a revised partial does not stack up. setting textContent
    // would wreck the surrounding markup and tell no framework anything.
    const selection = window.getSelection();
    if (!selection) return false;
    for (let index = 0; index < previousLength; index += 1) {
      selection.modify('extend', 'backward', 'character');
    }
    if (!value) {
      if (previousLength > 0) document.execCommand('delete');
      return true;
    }
    return document.execCommand('insertText', false, value);
  }
  const tag = active.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  const prototype = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  setter.call(active, value);
  try { active.setSelectionRange(caret, caret); } catch (error) { /* type refuses selection */ }
  active.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}`;

export async function writeGuestField(
  webview: WebviewElement,
  value: string,
  caret: number,
  previousLength = 0,
): Promise<boolean> {
  try {
    return await webview.executeJavaScript<boolean>(
      `(${WRITE_SCRIPT})(${JSON.stringify(value)}, ${JSON.stringify(caret)}, ${JSON.stringify(previousLength)})`,
    );
  } catch {
    return false;
  }
}
