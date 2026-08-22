/**
 * Getting text into a React-controlled input WITHOUT going through the keyboard.
 *
 * Two features need this and neither can type. Dictation streams a transcript
 * into whatever the user is focused in, and the Browser pane's note input is a
 * plain `<input>` rather than a terminal. The agent-drive keystroke interception
 * (`agent-input-focus-guard.ts`) catches a key before the guest page sees it and
 * has to re-deliver it; when the user was in that same note input it used to
 * DROP the key, because the only delivery mechanism it had was PTY bytes and
 * writing someone's prose into a live shell is worse than losing it.
 *
 * IT WORKS WHEREVER THE USER CAN TYPE. Any focused text field is a target: a
 * new-task title, a search box, a rename field, the Browser pane's note. The
 * first version required an opt-in marker per field, which is safer to reason
 * about and wrong in practice - every new field would silently do nothing until
 * someone remembered to mark it, and there is no version of "dictation works
 * here but not there" a user can predict.
 *
 * The exclusions are therefore structural rather than a list to maintain: a
 * `type` that does not hold prose (`password` above all), disabled, read-only,
 * xterm's hidden textarea, and an explicit `data-no-text-target` opt-out. See
 * `isTextTarget`.
 *
 * WHY THE NATIVE SETTER. React tracks a controlled input's value on the DOM node
 * itself (`_valueTracker`). Assigning `element.value = next` updates the node AND
 * the tracker, so React compares them, sees no change, and never fires
 * `onChange` - the component's state stays stale and the next render wipes the
 * write. Going through the prototype's own setter updates the node but not the
 * tracker, so the `input` event dispatched after it reaches React's root
 * delegation and becomes a real `onChange`.
 *
 * The decision-shaped exports here are PURE over primitives so the unit tier,
 * which runs without jsdom, can pin them directly. Only `writeTextTarget` and
 * `submitTextTarget` touch the DOM.
 */

/**
 * Opt OUT: marks a field that must never receive dictated or re-routed text.
 *
 * The default is ALLOW - anywhere the user can type, dictation works - so this
 * is the escape hatch for a field where that would be wrong. It is honoured on
 * the field itself or on any ancestor, so a whole subtree can be excluded at
 * once. Nothing in the app needs it today; the hazards that exist are structural
 * (a password field, xterm's hidden textarea) and are denied by rule below,
 * where they cannot be forgotten.
 */
export const TEXT_TARGET_DENY_ATTRIBUTE = 'data-no-text-target';

/**
 * xterm's own hidden textarea. It exists so an IME can compose at the cursor,
 * and it is a real `<textarea>`, so an allow-by-default rule matches it.
 *
 * It must NOT: a terminal already has a delivery path (PTY bytes over IPC), and
 * treating it as a DOM target would write the transcript into a hidden element
 * that xterm clears on the next keystroke - the words would vanish and the shell
 * would never see them. This is the single most important exclusion here, and it
 * is by class rather than by marker precisely because it is xterm's element and
 * we do not render it.
 */
const XTERM_HELPER_CLASS = 'xterm-helper-textarea';

export type TextTargetElement = HTMLInputElement | HTMLTextAreaElement;
/** A `contenteditable` host. Not a `TextTargetElement`: it has no `.value` and
 *  no `selectionStart`, so every write path for it is separate. */
export type ContentEditableTarget = HTMLElement;

/**
 * The minimum an element must look like to be classified. Typed structurally
 * rather than as `Element` so the unit tier can pass a plain object; the runtime
 * checks below are all attribute, class, and property reads.
 */
interface TextTargetCandidate {
  tagName?: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** True for a `contenteditable` host. Read from the live DOM property rather
   *  than the attribute, so an inherited `contenteditable` on an ancestor counts
   *  the same way the browser counts it. */
  isContentEditable?: boolean;
  classList?: { contains: (token: string) => boolean };
  closest?: (selector: string) => unknown;
}

/**
 * Input `type`s that take free text a person could dictate.
 *
 * A bare `<input>` has no `type` attribute and defaults to text, hence the empty
 * string. Everything absent is absent for a reason: `password` because a spoken
 * secret is a hazard, and `number` / `date` / `color` / `range` / `file` and the
 * button-likes because they do not hold prose and a transcript would be rejected
 * or mangled by the control itself.
 */
const ACCEPTED_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'email', 'tel', 'textarea',
]);

/**
 * A password box, which must never receive dictated text.
 *
 * WHY, concretely rather than by reflex. Dictation's Cloud refinement option
 * (`remote-openai-engine.ts`) POSTs the RAW AUDIO to a configured endpoint with
 * the user's API key - so with that engine selected, dictating here would send a
 * spoken credential to a third party. On the default on-device engines nothing
 * leaves the machine and this is prudence rather than active protection, but the
 * refusal is unconditional on purpose: making it depend on the engine setting
 * would mean the same field behaves differently for reasons invisible from the
 * field, which is the unpredictability the allow-by-default inversion exists to
 * avoid. The cost of refusing is close to zero either way, since a password is
 * usually a random string that transcribes badly.
 *
 * Split out from `isTextTarget` because "not a target" is not enough on its own:
 * the dictation chain falls THROUGH a rejected element to the terminal tiers, so
 * a password field that merely fails eligibility ends up routing the user's
 * spoken password into a shell. It has to REFUSE the whole resolution, and the
 * caller needs to know why in order to say so.
 *
 * TWINNED, unavoidably, with the `type === 'password'` check inside
 * `guest-text-target.ts`'s `PROBE_SCRIPT`: that copy is a string evaluated in
 * another process and cannot import this one. It is the only exclusion here that
 * exists for a security reason rather than a structural one, so if this rule
 * ever grows (an `autocomplete="current-password"` heuristic, say), the guest
 * copy has to grow with it or the guest becomes the weaker path.
 */
export function isPasswordField(element: TextTargetCandidate | null | undefined): boolean {
  if (!element) return false;
  if (element.tagName?.toUpperCase() !== 'INPUT') return false;
  return (element.type ?? '').toLowerCase() === 'password';
}

/**
 * Whether this element may receive non-keyboard text.
 *
 * ALLOW BY DEFAULT: any focused text field in the app is a dictation target -
 * a new-task title, a search box, a rename field, the Browser pane's note. This
 * started as an opt-in marker and was inverted deliberately, because the opt-in
 * meant every new field silently did nothing until someone remembered to mark
 * it, and "it works where I type" is the behaviour people expect.
 *
 * What that inversion costs is that the exclusions now have to be right, so they
 * are structural rather than a list someone maintains: not a text-shaped `type`,
 * disabled, read-only, xterm's hidden textarea, or an explicit
 * `data-no-text-target` on the field or an ancestor.
 *
 * PURE apart from the ancestor lookup (which is the element's own `closest`), so
 * the dictation resolver and the focus guard share one answer and the unit tier
 * can exercise every rejection without a DOM.
 */
export function isContentEditableTarget(
  element: TextTargetCandidate | null | undefined,
): boolean {
  if (!element?.isContentEditable) return false;
  if (element.closest?.(`[${TEXT_TARGET_DENY_ATTRIBUTE}]`)) return false;
  return true;
}

export function isTextTarget(element: TextTargetCandidate | null | undefined): boolean {
  if (!element) return false;
  // A rich-text host qualifies too, but it is written by a different mechanism
  // (Selection + insertText, not a value setter) - see `writeContentEditable`.
  if (isContentEditableTarget(element)) return true;
  const tagName = element.tagName?.toUpperCase();
  if (tagName !== 'INPUT' && tagName !== 'TEXTAREA') return false;
  // Writing to either would show the user a value the app will never accept.
  if (element.disabled === true || element.readOnly === true) return false;
  if (element.classList?.contains(XTERM_HELPER_CLASS)) return false;
  if (element.closest?.(`[${TEXT_TARGET_DENY_ATTRIBUTE}]`)) return false;
  // A textarea has no meaningful `type`; an input defaults to text when the
  // attribute is absent, which reads back as '' on a plain object and 'text' on
  // a real element.
  const type = tagName === 'TEXTAREA' ? 'textarea' : (element.type ?? '').toLowerCase();
  return ACCEPTED_INPUT_TYPES.has(type);
}

/**
 * The focused element, when it is an eligible text target. Takes the element
 * rather than reading `document.activeElement` itself so callers can resolve
 * focus at exactly the moment they mean to (dictation resolves inside the
 * capture-phase press handler, before the press can move focus) and so this
 * stays unit-testable.
 */
export function resolveFocusedTextTarget(active: Element | null): TextTargetElement | null {
  if (!active) return null;
  // No cast: `TextTargetCandidate`'s members are all optional, and `Element`
  // already satisfies the ones it declares.
  //
  // A contenteditable is a text target but NOT a `TextTargetElement`; callers
  // that need it ask `resolveFocusedContentEditable` instead, so this stays
  // honest about what it returns.
  if (isContentEditableTarget(active)) return null;
  return isTextTarget(active) ? (active as TextTargetElement) : null;
}

/** The focused element when it is a writable rich-text host. */
export function resolveFocusedContentEditable(active: Element | null): ContentEditableTarget | null {
  if (!active) return null;
  return isContentEditableTarget(active) ? (active as ContentEditableTarget) : null;
}

/**
 * Replace the last `previousLength` characters before the caret with `text`,
 * inside a `contenteditable`.
 *
 * A rich-text host has no `.value`, so the native-setter trick does not apply
 * and setting `textContent` would both destroy the surrounding markup and leave
 * any framework watching it unaware. The route that works is the one a real
 * keystroke takes: select what should be replaced, then `insertText`, which
 * emits genuine `beforeinput` / `input` events, participates in the browser's
 * own undo stack, and is what React (or any editor) is already listening for.
 *
 * `execCommand` is formally deprecated and remains the only API that does this;
 * there is no Selection-based replacement that produces the same events.
 */
export function writeContentEditable(
  element: ContentEditableTarget,
  text: string,
  previousLength: number,
): boolean {
  if (!element.isConnected) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  // Extend backward over our own previous insertion so `insertText` replaces it
  // rather than appending a second copy of a revised sentence.
  for (let index = 0; index < previousLength; index += 1) {
    // `modify` is non-standard but is Chromium's own API, which is the only
    // engine Electron runs.
    (selection as Selection & {
      modify: (alter: string, direction: string, granularity: string) => void;
    }).modify('extend', 'backward', 'character');
  }
  try {
    if (text.length === 0) {
      // `insertText` with an empty string is a no-op in Chromium, so an erase
      // has to be its own command.
      if (previousLength > 0) document.execCommand('delete');
      return true;
    }
    return document.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

export interface ComposeTextTargetInput {
  /** The field's value at the moment the write session started. */
  baseValue: string;
  /** Selection range at that same moment. A collapsed caret has start === end;
   *  a real selection is REPLACED, matching what typing would have done. */
  anchorStart: number;
  anchorEnd: number;
  /** The full text this session has produced so far, replacing whatever the
   *  previous call put there. */
  text: string;
}

export interface ComposedTextTarget {
  value: string;
  /** Where the caret belongs afterwards: at the end of what was just written. */
  caret: number;
}

/**
 * Compose the field's next value. PURE.
 *
 * This is the input-side analogue of the terminal path's "send N backspaces,
 * then type": anchor once when the session starts, then rewrite that span on
 * every revision. Rewriting a span rather than appending is what makes a live
 * dictation partial revise itself in place instead of stuttering the sentence
 * out three times, and it is why the anchor is captured once rather than read
 * back from the element (which has already moved by then).
 *
 * The anchor is clamped to the base value so a stale or out-of-range selection
 * degrades to an append at the end rather than throwing or silently truncating.
 */
export function composeTextTargetValue(input: ComposeTextTargetInput): ComposedTextTarget {
  const { baseValue, text } = input;
  const start = Math.max(0, Math.min(input.anchorStart, baseValue.length));
  const end = Math.max(start, Math.min(input.anchorEnd, baseValue.length));
  return {
    value: baseValue.slice(0, start) + text + baseValue.slice(end),
    caret: start + text.length,
  };
}

/**
 * Cached native value setters, one per element type. Read from the prototype
 * because the instance's own `value` property is what React's tracker shadows;
 * see the module header.
 */
function nativeValueSetter(element: TextTargetElement): ((value: string) => void) | null {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  const setter = descriptor?.set;
  if (!setter) return null;
  return (value: string) => setter.call(element, value);
}

/**
 * Write `value` into a controlled input and tell React about it.
 *
 * Returns false when the element has left the document, which is not an error:
 * a Browser pane can close mid-dictation, and writing to a detached node would
 * silently do nothing while the caller believed the text landed.
 */
export function writeTextTarget(element: TextTargetElement, value: string, caret: number): boolean {
  if (!element.isConnected) return false;
  const setValue = nativeValueSetter(element);
  if (!setValue) return false;
  setValue(value);
  const position = Math.max(0, Math.min(caret, value.length));
  try {
    element.setSelectionRange(position, position);
  } catch {
    // Some input types refuse selection APIs. The value still landed, which is
    // the part that matters.
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Text-carrying fields, for counting how many commit together in one form. */
const FORM_FIELD_SELECTOR = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=hidden]):not([type=file])';

/**
 * Whether releasing push-to-talk may COMMIT this field, rather than only filling
 * it.
 *
 * Auto-submit means pressing Enter, and Enter's blast radius is a property of
 * the field's surroundings, not of the field. In a standalone box - the board
 * search, the Browser pane's note, a rename - Enter does the one scoped thing
 * the user expects. In a multi-field form it submits EVERY field at once, so
 * dictating a title into the New Task dialog would create the task the instant
 * the user let go of the key, with the rest of the form still empty.
 *
 * The distinction is structural, which is why it needs no markers to maintain: a
 * `<form>` IS the declaration that its fields commit together. One text input
 * inside it (the Browser pane's URL bar) is still a standalone box wearing a
 * form; two or more is the case to refuse. A field in no form at all cannot
 * submit anything but itself.
 *
 * Refusing only downgrades release to "insert the text and leave it" - the words
 * still land, the user presses the button. The opposite error commits work they
 * have not finished writing.
 */
export function mayAutoSubmit(element: TextTargetCandidate | null | undefined): boolean {
  const form = element?.closest?.('form');
  if (!form) return true;
  const fields = (form as { querySelectorAll?: (selector: string) => { length: number } })
    .querySelectorAll?.(FORM_FIELD_SELECTOR);
  if (!fields) return true;
  return fields.length <= 1;
}

/**
 * Commit the field, by pressing Enter on it.
 *
 * Deliberately NOT a callback the surface registers. Each surface already owns
 * what Enter means for it - the Browser pane's note input maps it to "send the
 * capture to the agent", with its own in-flight guard - so dispatching the key
 * makes "release the dictation hotkey" and "press Enter" the same act by
 * construction, rather than a second implementation that can drift.
 *
 * The event is untrusted, which is correct: the agent-drive focus guard only
 * disarms on `event.isTrusted`, so this cannot be mistaken for the user
 * choosing a different target.
 */
export function submitTextTarget(element: TextTargetElement): boolean {
  if (!element.isConnected) return false;
  element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
  return true;
}

/** What an intercepted keystroke's terminal bytes mean for a text field. */
export type TextTargetEdit =
  | { kind: 'insert'; text: string }
  | { kind: 'deleteBackward' };

/**
 * Decode intercepted-keystroke bytes back into an edit. PURE.
 *
 * The interception path encodes the user's key with `encodeTerminalKey`
 * (`src/shared/terminal-key-encoding.ts`) because its original destination was a
 * PTY. When the destination turns out to be a text field instead, that has to be
 * undone - and only for the cases that are unambiguous.
 *
 * Deliberately as small as the encoder it mirrors, and for the same reason: a
 * dropped keystroke is recoverable, a wrong one is not. Everything else returns
 * null, meaning DROP, which is exactly what the whole non-terminal case did
 * before this existed.
 *
 * `\r` is in the drop set on purpose. Enter in the note input SENDS the capture
 * and the note to the agent; firing that off the back of a keystroke the user
 * aimed at a web page - during a drive that lasts tens of milliseconds - would
 * post a half-written note and a screenshot with no way to take it back.
 */
export function decodeBytesForTextTarget(bytes: string): TextTargetEdit | null {
  if (bytes === '\x7f' || bytes === '\b') return { kind: 'deleteBackward' };
  // A single printable character. Control codes (below 0x20) and DEL are
  // excluded, which leaves ESC, Tab, Enter, and every CSI sequence (which is
  // multi-character anyway) in the drop set.
  if (bytes.length === 1 && bytes.charCodeAt(0) >= 0x20 && bytes.charCodeAt(0) !== 0x7f) {
    return { kind: 'insert', text: bytes };
  }
  return null;
}

/**
 * Apply intercepted-keystroke bytes to a text field, at its live caret.
 *
 * Reads the selection from the element rather than from a stored anchor,
 * because unlike a dictation session these arrive one at a time with the user
 * free to move the caret between them.
 *
 * Returns false when the bytes had no safe meaning or the element is gone.
 */
export function applyBytesToTextTarget(element: TextTargetElement, bytes: string): boolean {
  if (!element.isConnected) return false;
  const edit = decodeBytesForTextTarget(bytes);
  if (!edit) return false;

  const value = element.value;
  const start = element.selectionStart ?? value.length;
  const end = element.selectionEnd ?? start;

  if (edit.kind === 'insert') {
    return writeTextTarget(element, value.slice(0, start) + edit.text + value.slice(end), start + edit.text.length);
  }
  // Backspace over a selection deletes the selection; with a collapsed caret at
  // the very start there is nothing to delete.
  if (start !== end) {
    return writeTextTarget(element, value.slice(0, start) + value.slice(end), start);
  }
  if (start === 0) return false;
  return writeTextTarget(element, value.slice(0, start - 1) + value.slice(start), start - 1);
}
